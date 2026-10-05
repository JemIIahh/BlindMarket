/**
 * telegram service: message privacy, sending with retries, delivery from
 * notify(), and the bot's webhook commands.
 *
 * Run:  npx vitest run src/services/telegram.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  telegramBotToken: '123:SECRET-TOKEN',
  telegramWebhookSecret: 'whsec',
  telegramBotUsername: 'BlindMarketBot',
  publicAppUrl: 'https://app.example',
}));
vi.mock('../config.js', () => ({ config: cfg }));

const egressFetch = vi.hoisted(() => vi.fn());
vi.mock('./egressGuard.js', () => ({ egressFetch }));

const mem = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  sets: new Map<string, Set<string>>(),
  failGet: false,
}));
vi.mock('./redis.js', () => ({
  redis: {
    get: async (k: string) => {
      if (mem.failGet) throw new Error('redis down');
      return mem.kv.get(k) ?? null;
    },
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && mem.kv.has(k)) return null;
      mem.kv.set(k, v);
      return 'OK';
    },
    del: async (k: string) => (mem.kv.delete(k) || mem.sets.delete(k) ? 1 : 0),
    sadd: async (k: string, m: string) => {
      const s = mem.sets.get(k) ?? new Set<string>();
      s.add(m);
      mem.sets.set(k, s);
      return 1;
    },
    srem: async (k: string, m: string) => {
      const s = mem.sets.get(k);
      if (!s) return 0;
      const had = s.delete(m);
      if (s.size === 0) mem.sets.delete(k);
      return had ? 1 : 0;
    },
    smembers: async (k: string) => [...(mem.sets.get(k) ?? [])],
  },
}));

import type { Notification } from './notificationStore.js';
import { deliverToTelegram, formatNotification, handleTelegramUpdate, sendTelegram, telegramEnabled, telegramWebhookReady } from './telegram.js';
import { consumeLinkNonce, createLinkNonce, getLink, linkChat, setPrefs } from './telegramStore.js';

const WALLET = '0x' + 'a'.repeat(40);
const AGENT = '0x' + '9'.repeat(40);
const TASK = '0x' + 'ab'.repeat(32);

const note = (over: Partial<Notification> = {}): Notification => ({
  id: 'n1', type: 'assigned', title: 'Task accepted', body: `${AGENT.slice(0, 6)}…${AGENT.slice(-4)} accepted your task.`,
  taskId: TASK, createdAt: new Date().toISOString(), read: false, ...over,
});

const ok = () => new Response('{}', { status: 200 });
const fail = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
const noSleep = async () => {};

/** What was sent to Telegram, by call. */
function sent() {
  return egressFetch.mock.calls.map(([url, init]) => ({
    url: String(url),
    body: JSON.parse(String((init as RequestInit).body)) as { chat_id: string; text: string },
  }));
}

beforeEach(() => {
  mem.kv.clear();
  mem.sets.clear();
  mem.failGet = false;
  egressFetch.mockReset();
  egressFetch.mockImplementation(async () => ok());
  cfg.telegramBotToken = '123:SECRET-TOKEN';
  cfg.telegramWebhookSecret = 'whsec';
});

describe('enablement', () => {
  it('is off without a token, and the webhook also needs its secret', () => {
    expect(telegramEnabled()).toBe(true);
    expect(telegramWebhookReady()).toBe(true);
    cfg.telegramWebhookSecret = '';
    expect(telegramWebhookReady()).toBe(false);
    cfg.telegramBotToken = '';
    expect(telegramEnabled()).toBe(false);
  });
});

describe('formatNotification: what may leave the platform', () => {
  it('carries the title, a short task id and an app link', () => {
    const text = formatNotification(note());
    expect(text).toContain('Task accepted');
    expect(text).toContain(`Task ${TASK.slice(0, 10)}…`);
    expect(text).toContain(`https://app.example/tasks/${TASK}`);
  });

  it('never carries an agent address, even when the in-app body does', () => {
    for (const type of ['assigned', 'submitted', 'failed', 'completed', 'disputed'] as const) {
      const text = formatNotification(note({ type }));
      expect(text).not.toContain(AGENT.slice(0, 6));
      expect(text).not.toContain(AGENT.slice(-4));
      expect(text).not.toContain('accepted your task');
    }
  });

  it('includes the body only for the generic-copy types', () => {
    const soon = formatNotification(note({ type: 'deadline_soon', title: 'Deadline approaching', body: 'Your task closes in about 1 hour.' }));
    expect(soon).toContain('Your task closes in about 1 hour.');
    const expired = formatNotification(note({ type: 'expired', title: 'Your task expired unclaimed', body: 'No agent took it before the deadline.' }));
    expect(expired).toContain('No agent took it before the deadline.');
  });

  it('cannot leak a brief or title: only whitelisted fields are read', () => {
    const hostile = { ...note({ type: 'completed' }), brief: 'SECRET BRIEF', taskTitle: 'SECRET TITLE', result: 'SECRET RESULT' } as Notification;
    const text = formatNotification(hostile);
    expect(text).not.toMatch(/SECRET/);
  });

  it('works without a task id', () => {
    expect(formatNotification(note({ taskId: undefined }))).toBe('Task accepted');
  });
});

describe('sendTelegram', () => {
  it('posts to the Bot API as plain text', async () => {
    expect(await sendTelegram('42', 'hi', { sleep: noSleep })).toBe('sent');
    const [call] = sent();
    expect(call.url).toBe('https://api.telegram.org/bot123:SECRET-TOKEN/sendMessage');
    expect(call.body).toMatchObject({ chat_id: '42', text: 'hi' });
    expect(egressFetch.mock.calls[0][1].body).not.toContain('parse_mode');
  });

  it('reports a blocked chat without retrying', async () => {
    egressFetch.mockImplementation(async () => fail(403, { description: 'bot was blocked by the user' }));
    expect(await sendTelegram('42', 'hi', { sleep: noSleep })).toBe('blocked');
    expect(egressFetch).toHaveBeenCalledTimes(1);
  });

  it('waits out a 429 then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    egressFetch.mockImplementationOnce(async () => fail(429, { parameters: { retry_after: 2 } })).mockImplementation(async () => ok());
    expect(await sendTelegram('42', 'hi', { sleep })).toBe('sent');
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('caps a long retry_after', async () => {
    const sleep = vi.fn(async () => {});
    egressFetch.mockImplementationOnce(async () => fail(429, { parameters: { retry_after: 600 } })).mockImplementation(async () => ok());
    await sendTelegram('42', 'hi', { sleep });
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('retries a server error twice then gives up', async () => {
    egressFetch.mockImplementation(async () => fail(502));
    expect(await sendTelegram('42', 'hi', { sleep: noSleep })).toBe('failed');
    expect(egressFetch).toHaveBeenCalledTimes(3);
  });

  it('retries a network error, and never logs the bot token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    egressFetch.mockImplementation(async () => { throw new Error(`connect ECONNRESET https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`); });
    expect(await sendTelegram('42', 'hi', { sleep: noSleep })).toBe('failed');
    expect(egressFetch).toHaveBeenCalledTimes(3);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('[token]');
    expect(logged).not.toContain('SECRET-TOKEN');
    warn.mockRestore();
  });
});

describe('deliverToTelegram', () => {
  it('does nothing when Telegram is not configured', async () => {
    cfg.telegramBotToken = '';
    await linkChat('42', [WALLET]);
    await deliverToTelegram(WALLET, note());
    expect(egressFetch).not.toHaveBeenCalled();
  });

  it('does nothing for a wallet that is not linked', async () => {
    await deliverToTelegram(WALLET, note());
    expect(egressFetch).not.toHaveBeenCalled();
  });

  it('sends to the linked chat', async () => {
    await linkChat('42', [WALLET]);
    await deliverToTelegram(WALLET, note());
    expect(sent()).toHaveLength(1);
    expect(sent()[0].body.chat_id).toBe('42');
  });

  it('matches the wallet case-insensitively', async () => {
    await linkChat('42', [WALLET]);
    await deliverToTelegram(WALLET.toUpperCase().replace('0X', '0x'), note());
    expect(sent()).toHaveLength(1);
  });

  it('respects a switched-off type, and still sends the others', async () => {
    await linkChat('42', [WALLET]);
    await setPrefs('42', { deadline_soon: false });
    await deliverToTelegram(WALLET, note({ type: 'deadline_soon', title: 'Deadline approaching' }));
    expect(egressFetch).not.toHaveBeenCalled();
    await deliverToTelegram(WALLET, note({ type: 'completed', title: 'Task completed — escrow released' }));
    expect(sent()).toHaveLength(1);
  });

  it('skips types that are not for Telegram', async () => {
    await linkChat('42', [WALLET]);
    await deliverToTelegram(WALLET, note({ type: 'review_received' }));
    await deliverToTelegram(WALLET, note({ type: 'agent_stopped' }));
    expect(egressFetch).not.toHaveBeenCalled();
  });

  it('unlinks a chat that can no longer be reached', async () => {
    await linkChat('42', [WALLET]);
    egressFetch.mockImplementation(async () => fail(403));
    await deliverToTelegram(WALLET, note());
    expect(await getLink(WALLET)).toBeNull();
  });

  it('keeps the link on a transient failure', async () => {
    await linkChat('42', [WALLET]);
    egressFetch.mockImplementation(async () => fail(500));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deliverToTelegram(WALLET, note());
    expect(await getLink(WALLET)).not.toBeNull();
  });

  it('never throws when redis fails', async () => {
    mem.failGet = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(deliverToTelegram(WALLET, note())).resolves.toBeUndefined();
  });
});

const update = (id: number, text: string, chat: { id?: number; type?: string } = {}) => ({
  update_id: id,
  message: { text, chat: { id: 42, type: 'private', ...chat } },
});

describe('handleTelegramUpdate', () => {
  it('links the chat when /start carries a valid nonce', async () => {
    const nonce = await createLinkNonce([WALLET]);
    await handleTelegramUpdate(update(1, `/start ${nonce}`));
    expect((await getLink(WALLET))?.chatId).toBe('42');
    expect(sent()[0].body.text).toMatch(/^Connected to 0xaaaa…aaaa/);
    expect(sent()[0].body.text).toContain('Not your wallet? Send /stop');
    expect(await consumeLinkNonce(nonce)).toBeNull();
  });

  it('refuses an unknown, used or expired nonce and links nothing', async () => {
    await handleTelegramUpdate(update(1, `/start ${'0'.repeat(32)}`));
    expect(await getLink(WALLET)).toBeNull();
    expect(sent()[0].body.text).toMatch(/expired or was already used/);
  });

  it('accepts the /start@BotName form', async () => {
    const nonce = await createLinkNonce([WALLET]);
    await handleTelegramUpdate(update(1, `/start@BlindMarketBot ${nonce}`));
    expect(await getLink(WALLET)).not.toBeNull();
  });

  it('does not link from a group chat', async () => {
    const nonce = await createLinkNonce([WALLET]);
    await handleTelegramUpdate(update(1, `/start ${nonce}`, { type: 'group' }));
    expect(await getLink(WALLET)).toBeNull();
    expect(egressFetch).not.toHaveBeenCalled();
    // The nonce is untouched, so the real owner can still use it in a private chat.
    expect(await consumeLinkNonce(nonce)).toEqual([WALLET]);
  });

  it('ignores a redelivered update', async () => {
    const nonce = await createLinkNonce([WALLET]);
    await handleTelegramUpdate(update(5, `/start ${nonce}`));
    await handleTelegramUpdate(update(5, `/start ${nonce}`));
    expect(sent()).toHaveLength(1);
  });

  it('/stop disconnects', async () => {
    await linkChat('42', [WALLET]);
    await handleTelegramUpdate(update(1, '/stop'));
    expect(await getLink(WALLET)).toBeNull();
    expect(sent()[0].body.text).toMatch(/Disconnected/);
  });

  it('/stop on an unlinked chat says so', async () => {
    await handleTelegramUpdate(update(1, '/stop'));
    expect(sent()[0].body.text).toMatch(/not connected/);
  });

  it('/status shows shortened wallets, never full addresses', async () => {
    await linkChat('42', [WALLET]);
    await handleTelegramUpdate(update(1, '/status'));
    const text = sent()[0].body.text;
    expect(text).toContain('0xaaaa…aaaa');
    expect(text).not.toContain(WALLET);
  });

  it('ignores non-commands and malformed updates without throwing', async () => {
    await handleTelegramUpdate(update(1, 'hello there'));
    await handleTelegramUpdate({});
    await handleTelegramUpdate(null);
    await handleTelegramUpdate({ update_id: 9, message: { chat: { id: 1, type: 'private' } } });
    expect(egressFetch).not.toHaveBeenCalled();
  });
});
