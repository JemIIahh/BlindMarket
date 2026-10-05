/**
 * Telegram delivery of task notifications, and the bot's webhook commands.
 *
 * Privacy: a Telegram message leaves the platform's access control, so it is
 * built from a whitelist, never from the whole notification. It carries the
 * notice's fixed title, a short task id and a link into the app (which needs a
 * sign-in). It never carries a brief, a task title, a result, or an agent
 * address: bodies are included only for the types whose copy is generic. The
 * same text goes out for public and private tasks.
 *
 * All sends are best-effort: a Telegram failure must never block the in-app
 * notification or the sweep that triggered it.
 */

import { config } from '../config.js';
import { egressFetch } from './egressGuard.js';
import type { Notification } from './notificationStore.js';
import {
  claimUpdate,
  consumeLinkNonce,
  getLink,
  getPrefs,
  isTelegramType,
  isTypeEnabled,
  linkChat,
  peekLinkNonce,
  unlinkChat,
  walletsOfChat,
} from './telegramStore.js';

/** Types whose body text is generic (no agent address, no task content). */
const BODY_TYPES = new Set(['deadline_soon', 'expired']);

export function telegramEnabled(): boolean {
  return config.telegramBotToken !== '';
}

/** The webhook is only served when it can be authenticated. */
export function telegramWebhookReady(): boolean {
  return telegramEnabled() && config.telegramWebhookSecret !== '';
}

function redact(message: string): string {
  const token = config.telegramBotToken;
  return token ? message.split(token).join('[token]') : message;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type SendResult = 'sent' | 'blocked' | 'failed';

const MAX_ATTEMPTS = 3;

/**
 * Send a plain-text message (no parse mode, so nothing needs escaping).
 * 'blocked' means the chat can no longer be reached (the user blocked the bot
 * or deleted the chat): the caller should unlink it.
 */
export async function sendTelegram(
  chatId: string,
  text: string,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<SendResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await egressFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        await res.body?.cancel().catch(() => {});
        return 'sent';
      }
      const body = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
      if (res.status === 403 || res.status === 400) return 'blocked';
      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        await sleep(Math.min(5, body.parameters?.retry_after ?? 1) * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        await sleep(500 * attempt * attempt);
        continue;
      }
      console.warn(`[telegram] send failed: HTTP ${res.status}`);
      return 'failed';
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        await sleep(500 * attempt * attempt);
        continue;
      }
      console.warn(`[telegram] send failed: ${redact(String((err as Error)?.message ?? err))}`);
      return 'failed';
    }
  }
  return 'failed';
}

/** The message text for a notification: whitelisted fields only. */
export function formatNotification(n: Pick<Notification, 'type' | 'title' | 'body' | 'taskId'>): string {
  const lines = [n.title];
  if (n.body && BODY_TYPES.has(n.type)) lines.push(n.body);
  if (n.taskId) {
    lines.push('');
    lines.push(`Task ${n.taskId.slice(0, 10)}…`);
    lines.push(`${config.publicAppUrl}/tasks/${n.taskId}`);
  }
  return lines.join('\n');
}

/** Called by notify() for every notification. Never throws. */
export async function deliverToTelegram(address: string, n: Notification): Promise<void> {
  if (!telegramEnabled() || !isTelegramType(n.type)) return;
  try {
    const link = await getLink(address);
    if (!link) return;
    if (!isTypeEnabled(await getPrefs(link.chatId), n.type)) return;
    const result = await sendTelegram(link.chatId, formatNotification(n));
    if (result === 'blocked') {
      await unlinkChat(link.chatId);
      console.log('[telegram] chat unreachable — unlinked');
    }
  } catch (err) {
    console.warn(`[telegram] delivery failed (non-fatal): ${redact(String((err as Error)?.message ?? err))}`);
  }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const HELP =
  'BlindMarket task alerts.\n\n' +
  '/status — see whether this chat is connected\n' +
  '/stop — disconnect and stop all alerts\n\n' +
  'To connect, open Settings in BlindMarket and press "Connect Telegram".';

interface TelegramUpdate {
  update_id?: number;
  message?: { text?: string; chat?: { id?: number | string; type?: string } };
}

/** Handle one webhook update from Telegram. Never throws. */
export async function handleTelegramUpdate(update: unknown): Promise<void> {
  try {
    const u = update as TelegramUpdate;
    if (typeof u?.update_id === 'number' && !(await claimUpdate(u.update_id))) return;
    const msg = u?.message;
    const chatId = msg?.chat?.id;
    if (!msg || chatId === undefined || typeof msg.text !== 'string') return;
    // Alerts are personal: a group would show them to everyone in it.
    if (msg.chat?.type !== 'private') return;
    const chat = String(chatId);

    const m = /^\/(\w+)(?:@\w+)?(?:\s+(\S+))?/.exec(msg.text.trim());
    if (!m) return;
    const [, command, arg] = m;

    if (command === 'start' && arg) {
      // A chat already connected to other wallets is not switched by a link:
      // someone could send this user their own link and take over their alerts.
      const incoming = await peekLinkNonce(arg);
      const current = await walletsOfChat(chat);
      if (incoming && current.some((w) => !incoming.includes(w))) {
        await sendTelegram(
          chat,
          `This chat is already connected to ${current.map(short).join(', ')}. To connect a different wallet, send /stop first, then open the link again.`,
        );
        return;
      }
      const wallets = await consumeLinkNonce(arg);
      if (!wallets) {
        await sendTelegram(chat, 'That link has expired or was already used. Open Settings in BlindMarket and press "Connect Telegram" again.');
        return;
      }
      await linkChat(chat, wallets);
      await sendTelegram(
        chat,
        `Connected to ${wallets.map(short).join(', ')}. You will get alerts for those wallets' BlindMarket tasks here: deadlines, results and payouts.\n\nNot your wallet? Send /stop.`,
      );
    } else if (command === 'start' || command === 'help') {
      await sendTelegram(chat, HELP);
    } else if (command === 'stop') {
      const n = await unlinkChat(chat);
      await sendTelegram(chat, n > 0 ? 'Disconnected. No more alerts will be sent here.' : 'This chat was not connected.');
    } else if (command === 'status') {
      const wallets = await walletsOfChat(chat);
      await sendTelegram(
        chat,
        wallets.length > 0 ? `Connected to ${wallets.map(short).join(', ')}.` : 'This chat is not connected.',
      );
    }
  } catch (err) {
    console.warn(`[telegram] update handling failed (non-fatal): ${redact(String((err as Error)?.message ?? err))}`);
  }
}
