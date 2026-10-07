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
 * notification or the sweep that triggered it. Alerts go out through a
 * per-chat outbox that merges a burst into one message and paces sends (see
 * "Outbox" below).
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
  type TelegramType,
} from './telegramStore.js';

/** Types whose body text is generic (no agent address, no task content). */
const BODY_TYPES = new Set(['deadline_soon', 'expired', 'submissions']);

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
 *
 * `refresh` runs before each retry and returns the text to send now, or null
 * to drop the message: a retry can come a minute later.
 */
export async function sendTelegram(
  chatId: string,
  text: string,
  opts: {
    sleep?: (ms: number) => Promise<void>;
    maxRetryAfterSec?: number;
    refresh?: () => Promise<string | null>;
  } = {},
): Promise<SendResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetryAfterSec = opts.maxRetryAfterSec ?? 5;
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1 && opts.refresh) {
      const current = await opts.refresh();
      if (current === null) return 'failed';
      text = current;
    }
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
        await sleep(Math.min(maxRetryAfterSec, body.parameters?.retry_after ?? 1) * 1000);
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

// ── Outbox ───────────────────────────────────────────────────────────────────
//
// Telegram takes about one message a second per chat and about 30 a second per
// bot, and answers more with 429 and a retry_after. Bursts are normal here:
// bulk-posted tasks share a deadline, so their reminders and expiry notices
// fall due in the same sweep tick. Sent one by one, with a 429 wait capped at
// 5 s, most of such a burst was dropped (delta audit 2026-10-06, tg-2).
//
// So a chat's alerts wait in an outbox until the burst stops arriving (a quiet
// gap of quietMs, at most maxWaitMs after the first), then go out as one
// message per (type, title): a lone alert reads as before, several become one
// message listing their tasks. Messages to a chat are chatGapMs apart, sends
// from this process globalGapMs apart, and a 429 is waited out for up to
// maxRetryAfterSec.
//
// Waiting must not outlive consent. Just before each message, the chat's
// linked wallets and preferences are read again: after /stop nothing more
// goes out, a switched-off type is skipped, and a wallet moved to another chat
// is no longer reported here. A newer alert for the same task and wallet
// replaces a waiting one of another kind, so a task's alerts never go out of
// order ("Payout credited" is not followed by a stale "Submission didn't pass").
//
// The outbox lives in memory, so delivery stays best effort and at most once:
// a restart drops what is waiting (at most maxWaitMs of alerts), and the in-app
// feed still has every notice. Each process (api, indexer) paces its own
// sends; Telegram's retry_after covers the overlap.

/** A wait that does not hold the process open: at exit, waiting alerts are dropped anyway. */
const idleSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());
/** Monotonic: a wall-clock step must not stall an outbox. */
const clock = () => performance.now();

const timing = {
  quietMs: 5_000,
  maxWaitMs: 30_000,
  chatGapMs: 1_100,
  globalGapMs: 40,
  maxRetryAfterSec: 60,
  /** Waits between retries of one message. */
  retrySleep: idleSleep,
};

/** Tests: shorten the outbox timings, and forget the last send slot. */
export function _setOutboxTiming(t: Partial<typeof timing>): void {
  Object.assign(timing, t);
  nextGlobalSlot = -Infinity;
}

/** Tasks a merged message lists; the rest are counted. */
const LISTED_MAX = 10;
/** Task ids remembered per group, so a repeat is not counted twice. */
const TRACKED_MAX = 500;

/** Alerts with the same type and title, waiting to go out as one message. */
interface Group {
  type: TelegramType;
  title: string;
  body?: string;
  /** False once two alerts in the group had different bodies. */
  sameBody: boolean;
  /** Task id → the wallets it was sent for (all linked to this chat when queued). */
  tasks: Map<string, Set<string>>;
  /** Per wallet, alerts with no task id or past TRACKED_MAX. */
  untracked: Map<string, number>;
}

interface Outbox {
  /** Insertion order is send order. */
  groups: Map<string, Group>;
  firstAt: number;
  lastAt: number;
  lastSentAt: number;
  done: Promise<void> | null;
}

const outboxes = new Map<string, Outbox>();
let nextGlobalSlot = -Infinity;

function enqueue(chatId: string, wallet: string, n: Notification & { type: TelegramType }): void {
  let box = outboxes.get(chatId);
  if (!box) {
    box = { groups: new Map(), firstAt: 0, lastAt: 0, lastSentAt: -Infinity, done: null };
    outboxes.set(chatId, box);
  }
  const now = clock();
  if (box.groups.size === 0) box.firstAt = now;
  box.lastAt = now;

  const key = `${n.type}\n${n.title}`;
  let g = box.groups.get(key);
  if (!g) {
    g = { type: n.type, title: n.title, body: n.body, sameBody: true, tasks: new Map(), untracked: new Map() };
    box.groups.set(key, g);
  } else if (g.body !== n.body) {
    g.sameBody = false;
  }

  const taskId = n.taskId;
  if (taskId) {
    // This alert supersedes a waiting one of another kind for the same task and wallet.
    for (const [k, other] of box.groups) {
      const wallets = other === g ? undefined : other.tasks.get(taskId);
      if (!wallets?.delete(wallet) || wallets.size > 0) continue;
      other.tasks.delete(taskId);
      if (other.tasks.size === 0 && other.untracked.size === 0) box.groups.delete(k);
    }
  }
  const wallets = taskId ? g.tasks.get(taskId) : undefined;
  if (wallets) wallets.add(wallet);
  else if (taskId && g.tasks.size < TRACKED_MAX) g.tasks.set(taskId, new Set([wallet]));
  else g.untracked.set(wallet, (g.untracked.get(wallet) ?? 0) + 1);

  if (!box.done) box.done = drain(chatId, box);
}

/** Wait for this process's next send slot. */
async function globalSlot(): Promise<void> {
  const now = clock();
  const at = Math.max(now, nextGlobalSlot);
  nextGlobalSlot = at + timing.globalGapMs;
  if (at > now) await idleSleep(at - now);
}

async function drain(chatId: string, box: Outbox): Promise<void> {
  try {
    while (box.groups.size > 0) {
      // Let the burst finish arriving.
      for (;;) {
        const wait = Math.min(box.lastAt + timing.quietMs, box.firstAt + timing.maxWaitMs) - clock();
        if (wait <= 0) break;
        await idleSleep(wait);
      }
      const groups = [...box.groups.values()];
      box.groups.clear();
      for (const g of groups) {
        const gap = box.lastSentAt + timing.chatGapMs - clock();
        if (gap > 0) await idleSleep(gap);
        const text = await consentedText(chatId, g);
        if (text === null) continue;
        // After the consent read, so nothing slow sits between the slot and the send.
        await globalSlot();
        const result = await sendTelegram(chatId, text, {
          sleep: timing.retrySleep,
          maxRetryAfterSec: timing.maxRetryAfterSec,
          refresh: () => consentedText(chatId, g),
        });
        box.lastSentAt = clock();
        if (result === 'blocked') {
          await unlinkChat(chatId);
          console.log('[telegram] chat unreachable — unlinked');
          return;
        }
      }
    }
  } catch (err) {
    console.warn(`[telegram] delivery failed (non-fatal): ${redact(String((err as Error)?.message ?? err))}`);
  } finally {
    // Empty after a normal run. After an unlink or an error, what arrived in
    // the meantime is for a chat that is gone or failing: drop it.
    box.groups.clear();
    box.done = null;
    // The chat's next outbox waits quietMs (more than chatGapMs) before its
    // first send, which also spaces it from this one's last.
    if (outboxes.get(chatId) === box) outboxes.delete(chatId);
  }
}

/**
 * The group's message as the chat's consent stands now (see above): null
 * after /stop, for a type switched off, or when none of its wallets is still
 * linked here. Read before the first try and before every retry.
 */
async function consentedText(chatId: string, g: Group): Promise<string | null> {
  const linked = new Set(await walletsOfChat(chatId));
  if (linked.size === 0 || !isTypeEnabled(await getPrefs(chatId), g.type)) return null;
  return formatGroup(g, linked);
}

/**
 * One message for a group, counting only alerts for wallets still linked to
 * the chat: the usual text for a lone alert, a task list for several. null
 * when none is left.
 */
function formatGroup(g: Group, linked: Set<string>): string | null {
  const ids = [...g.tasks].filter(([, wallets]) => [...wallets].some((w) => linked.has(w))).map(([id]) => id);
  let untracked = 0;
  for (const [w, n] of g.untracked) if (linked.has(w)) untracked += n;
  const count = ids.length + untracked;
  if (count === 0) return null;
  if (count === 1) return formatNotification({ type: g.type, title: g.title, body: g.body, taskId: ids[0] });
  const lines = [`${g.title} (${count} tasks)`];
  if (g.body && g.sameBody && BODY_TYPES.has(g.type)) lines.push(g.body);
  lines.push('');
  const listed = ids.slice(0, LISTED_MAX);
  for (const id of listed) lines.push(`Task ${id.slice(0, 10)}… ${config.publicAppUrl}/tasks/${id}`);
  if (count > listed.length) {
    lines.push(`…and ${count - listed.length} more. All of them are in your BlindMarket notifications: ${config.publicAppUrl}`);
  }
  return lines.join('\n');
}

/** Tests: resolves once every outbox has been sent. */
export async function _outboxesIdle(): Promise<void> {
  while (outboxes.size > 0) await Promise.all([...outboxes.values()].map((b) => b.done));
}

/**
 * Called by notify() for every notification. Queues the alert in its chat's
 * outbox; resolves before it is sent. Never throws.
 */
export async function deliverToTelegram(address: string, n: Notification): Promise<void> {
  if (!telegramEnabled() || !isTelegramType(n.type)) return;
  try {
    const link = await getLink(address);
    if (!link) return;
    if (!isTypeEnabled(await getPrefs(link.chatId), n.type)) return;
    enqueue(link.chatId, address.toLowerCase(), { ...n, type: n.type });
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
