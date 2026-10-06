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
import {
  _outboxesIdle,
  _setOutboxTiming,
  deliverToTelegram,
  formatNotification,
  handleTelegramUpdate,
  sendTelegram,
  telegramEnabled,
  telegramWebhookReady,
} from './telegram.js';
import { consumeLinkNonce, createLinkNonce, getLink, linkChat, setPrefs, unlinkChat } from './telegramStore.js';

const WALLET = '0x' + 'a'.repeat(40);
const AGENT = '0x' + '9'.repeat(40);
const TASK = '0x' + 'ab'.repeat(32);

const note = (over: Partial<Notification> = {}): Notification => ({
  id: 'n1', type: 'assigned', title: 'Task accepted', body: `${AGENT.slice(0, 6)}…${AGENT.slice(-4)} accepted your task.`,
  taskId: TASK, createdAt: new Date().toISOString(), read: false, ...over,
});

const ok = () => new Response('{}', { status: 200 });
/** Queue an alert and wait until its outbox has been sent. */
async function deliver(address: string, n: Notification) {
  await deliverToTelegram(address, n);
  await _outboxesIdle();
}
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
  _setOutboxTiming({ quietMs: 0, maxWaitMs: 1_000, chatGapMs: 0, globalGapMs: 0, retrySleep: noSleep });
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

  it('waits out a longer retry_after when the caller allows it', async () => {
    const sleep = vi.fn(async () => {});
    egressFetch.mockImplementationOnce(async () => fail(429, { parameters: { retry_after: 30 } })).mockImplementation(async () => ok());
    await sendTelegram('42', 'hi', { sleep, maxRetryAfterSec: 60 });
    expect(sleep).toHaveBeenCalledWith(30_000);
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
    await deliver(WALLET, note());
    expect(egressFetch).not.toHaveBeenCalled();
  });

  it('does nothing for a wallet that is not linked', async () => {
    await deliver(WALLET, note());
    expect(egressFetch).not.toHaveBeenCalled();
  });

  it('sends to the linked chat', async () => {
    await linkChat('42', [WALLET]);
    await deliver(WALLET, note());
    expect(sent()).toHaveLength(1);
    expect(sent()[0].body.chat_id).toBe('42');
  });

  it('matches the wallet case-insensitively', async () => {
    await linkChat('42', [WALLET]);
    await deliver(WALLET.toUpperCase().replace('0X', '0x'), note());
    expect(sent()).toHaveLength(1);
  });

  it('respects a switched-off type, and still sends the others', async () => {
    await linkChat('42', [WALLET]);
    await setPrefs('42', { deadline_soon: false });
    await deliver(WALLET, note({ type: 'deadline_soon', title: 'Deadline approaching' }));
    expect(egressFetch).not.toHaveBeenCalled();
    await deliver(WALLET, note({ type: 'completed', title: 'Task completed — escrow released' }));
    expect(sent()).toHaveLength(1);
  });

  it('skips types that are not for Telegram', async () => {
    await linkChat('42', [WALLET]);
    await deliver(WALLET, note({ type: 'review_received' }));
    await deliver(WALLET, note({ type: 'agent_stopped' }));
    expect(egressFetch).not.toHaveBeenCalled();
  });

  it('unlinks a chat that can no longer be reached', async () => {
    await linkChat('42', [WALLET]);
    egressFetch.mockImplementation(async () => fail(403));
    await deliver(WALLET, note());
    expect(await getLink(WALLET)).toBeNull();
  });

  it('keeps the link on a transient failure', async () => {
    await linkChat('42', [WALLET]);
    egressFetch.mockImplementation(async () => fail(500));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deliver(WALLET, note());
    expect(await getLink(WALLET)).not.toBeNull();
  });

  it('never throws when redis fails', async () => {
    mem.failGet = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(deliverToTelegram(WALLET, note())).resolves.toBeUndefined();
  });
});

describe('outbox: bursts and pacing', () => {
  const taskId = (i: number) => '0x' + i.toString(16).padStart(64, '0');
  const reminder = (i: number, body = 'Your task closes in about an hour and no agent has taken it yet.') =>
    note({ id: `r${i}`, type: 'deadline_soon', title: 'Deadline approaching', body, taskId: taskId(i) });

  /** Send times, as Date.now() at each call. */
  function recordTimes(): number[] {
    const times: number[] = [];
    egressFetch.mockImplementation(async () => {
      times.push(Date.now());
      return ok();
    });
    return times;
  }

  it('sends a burst of reminders for one chat as one message (tg-2)', async () => {
    _setOutboxTiming({ quietMs: 30 });
    await linkChat('42', [WALLET]);
    // Bulk-posted tasks share a deadline: every reminder falls due in one tick.
    await Promise.all(Array.from({ length: 20 }, (_, i) => deliverToTelegram(WALLET, reminder(i))));
    await _outboxesIdle();
    expect(sent()).toHaveLength(1);
    const text = sent()[0].body.text;
    expect(text).toContain('Deadline approaching (20 tasks)');
    expect(text).toContain('Your task closes in about an hour');
    for (let i = 0; i < 10; i++) expect(text).toContain(`https://app.example/tasks/${taskId(i)}`);
    expect(text).not.toContain(taskId(10));
    expect(text).toContain('…and 10 more');
  });

  it('sends a lone alert exactly as before', async () => {
    await linkChat('42', [WALLET]);
    await deliver(WALLET, note());
    expect(sent().map((c) => c.body.text)).toEqual([formatNotification(note())]);
  });

  it('sends the same alert once when two wallets of a chat both get it', async () => {
    _setOutboxTiming({ quietMs: 30 });
    const other = '0x' + 'b'.repeat(40);
    await linkChat('42', [WALLET, other]);
    const ruling = note({ type: 'disputed', title: 'Dispute ruled — escrow refunded' });
    await Promise.all([deliverToTelegram(WALLET, ruling), deliverToTelegram(other, ruling)]);
    await _outboxesIdle();
    expect(sent().map((c) => c.body.text)).toEqual([formatNotification(ruling)]);
  });

  it('keeps different notices apart, in arrival order, and drops a body that differs within a group', async () => {
    await linkChat('42', [WALLET]);
    _setOutboxTiming({ quietMs: 30 });
    await Promise.all([
      deliverToTelegram(WALLET, reminder(1, 'Your task closes in about 2 hours and no agent has taken it yet.')),
      deliverToTelegram(WALLET, note({ type: 'completed', title: 'Payout credited', taskId: taskId(9) })),
      deliverToTelegram(WALLET, reminder(2, "Your task's deadline is in about 2 hours. The assigned agent is still working on it.")),
    ]);
    await _outboxesIdle();
    const texts = sent().map((c) => c.body.text);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/^Deadline approaching \(2 tasks\)\n\n/);
    expect(texts[0]).not.toContain('Your task');
    expect(texts[1]).toBe(formatNotification(note({ type: 'completed', title: 'Payout credited', taskId: taskId(9) })));
  });

  it('never puts an agent address or a non-generic body into a merged message', async () => {
    await linkChat('42', [WALLET]);
    _setOutboxTiming({ quietMs: 30 });
    await Promise.all([1, 2, 3].map((i) => deliverToTelegram(WALLET, note({ taskId: taskId(i) }))));
    await _outboxesIdle();
    const [{ body }] = sent();
    expect(body.text).toContain('Task accepted (3 tasks)');
    expect(body.text).not.toContain(AGENT.slice(0, 6));
    expect(body.text).not.toContain('accepted your task');
  });

  it('spaces messages to one chat by the chat gap', async () => {
    _setOutboxTiming({ chatGapMs: 60 });
    await linkChat('42', [WALLET]);
    const times = recordTimes();
    await deliverToTelegram(WALLET, note({ type: 'completed', title: 'Payout credited' }));
    await deliverToTelegram(WALLET, note({ type: 'failed', title: "Submission didn't pass" }));
    await deliverToTelegram(WALLET, reminder(1));
    await _outboxesIdle();
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(55);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(55);
  });

  it('spaces sends across chats by the global gap, one message per chat', async () => {
    _setOutboxTiming({ quietMs: 20, globalGapMs: 40 });
    const wallets = [1, 2, 3].map((i) => '0x' + String(i).repeat(40));
    for (const [i, w] of wallets.entries()) await linkChat(String(100 + i), [w]);
    const times = recordTimes();
    await Promise.all(wallets.flatMap((w) => [1, 2, 3].map((i) => deliverToTelegram(w, reminder(i)))));
    await _outboxesIdle();
    expect(new Set(sent().map((c) => c.body.chat_id))).toEqual(new Set(['100', '101', '102']));
    expect(sent()).toHaveLength(3);
    times.sort((a, b) => a - b);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(35);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(35);
  });

  it('does not hold a steady stream back past the maximum wait', async () => {
    _setOutboxTiming({ quietMs: 50, maxWaitMs: 120 });
    await linkChat('42', [WALLET]);
    const times = recordTimes();
    const start = Date.now();
    // An alert every 20 ms for 400 ms never leaves a 50 ms quiet gap.
    for (let i = 0; i < 20; i++) {
      await deliverToTelegram(WALLET, reminder(i));
      await new Promise((r) => setTimeout(r, 20));
    }
    await _outboxesIdle();
    expect(times[0] - start).toBeLessThan(300);
    const counted = sent().reduce((n, c) => n + Number(/\((\d+) tasks\)/.exec(c.body.text)?.[1] ?? 1), 0);
    expect(counted).toBe(20);
  });

  it('waits out a long retry_after instead of dropping the alert', async () => {
    const retrySleep = vi.fn(async () => {});
    _setOutboxTiming({ retrySleep });
    await linkChat('42', [WALLET]);
    egressFetch.mockImplementationOnce(async () => fail(429, { parameters: { retry_after: 30 } })).mockImplementation(async () => ok());
    await deliver(WALLET, reminder(1));
    expect(retrySleep).toHaveBeenCalledWith(30_000);
    expect(egressFetch).toHaveBeenCalledTimes(2);
  });

  it('drops an alert when the chat disconnects during a 429 wait', async () => {
    await linkChat('42', [WALLET]);
    _setOutboxTiming({ retrySleep: async () => { await unlinkChat('42'); } });
    egressFetch.mockImplementationOnce(async () => fail(429, { parameters: { retry_after: 30 } })).mockImplementation(async () => ok());
    await deliver(WALLET, reminder(1));
    expect(egressFetch).toHaveBeenCalledTimes(1);
  });

  it('drops an alert whose type is switched off during a 429 wait', async () => {
    await linkChat('42', [WALLET]);
    _setOutboxTiming({ retrySleep: async () => { await setPrefs('42', { deadline_soon: false }); } });
    egressFetch.mockImplementationOnce(async () => fail(429, { parameters: { retry_after: 30 } })).mockImplementation(async () => ok());
    await deliver(WALLET, reminder(1));
    expect(egressFetch).toHaveBeenCalledTimes(1);
  });

  it('stops sending to a chat that blocked the bot, and unlinks it', async () => {
    _setOutboxTiming({ chatGapMs: 10 });
    await linkChat('42', [WALLET]);
    egressFetch.mockImplementation(async () => fail(403));
    await deliverToTelegram(WALLET, note({ type: 'completed', title: 'Payout credited' }));
    await deliverToTelegram(WALLET, note({ type: 'failed', title: "Submission didn't pass" }));
    await _outboxesIdle();
    expect(egressFetch).toHaveBeenCalledTimes(1);
    expect(await getLink(WALLET)).toBeNull();
  });

  it('sends nothing more after /stop, even what was already waiting', async () => {
    _setOutboxTiming({ quietMs: 40 });
    await linkChat('42', [WALLET]);
    await deliverToTelegram(WALLET, note());
    await handleTelegramUpdate(update(900, '/stop'));
    await _outboxesIdle();
    expect(sent().map((c) => c.body.text)).toEqual(['Disconnected. No more alerts will be sent here.']);
  });

  it('skips a waiting alert whose type was switched off meanwhile, and sends the rest', async () => {
    _setOutboxTiming({ quietMs: 40 });
    await linkChat('42', [WALLET]);
    await deliverToTelegram(WALLET, reminder(1));
    await deliverToTelegram(WALLET, note({ type: 'completed', title: 'Payout credited' }));
    await setPrefs('42', { deadline_soon: false });
    await _outboxesIdle();
    expect(sent().map((c) => c.body.text)).toEqual([formatNotification(note({ type: 'completed', title: 'Payout credited' }))]);
  });

  it('does not report a wallet to a chat it was moved away from meanwhile', async () => {
    _setOutboxTiming({ quietMs: 40 });
    const other = '0x' + 'b'.repeat(40);
    await linkChat('42', [WALLET, other]);
    await deliverToTelegram(WALLET, note({ taskId: taskId(1) }));
    await deliverToTelegram(other, note({ taskId: taskId(2) }));
    await linkChat('77', [WALLET]);
    await _outboxesIdle();
    const texts = sent().map((c) => c.body);
    expect(texts).toEqual([{ chat_id: '42', text: formatNotification(note({ taskId: taskId(2) })), disable_web_page_preview: true }]);
  });

  it("lets a task's newer alert replace a waiting older one, so they never arrive out of order", async () => {
    _setOutboxTiming({ quietMs: 40 });
    await linkChat('42', [WALLET]);
    const payout = (i: number) => note({ type: 'completed', title: 'Payout credited', taskId: taskId(i) });
    await deliverToTelegram(WALLET, payout(0));
    await deliverToTelegram(WALLET, note({ type: 'failed', title: "Submission didn't pass", taskId: taskId(1) }));
    await deliverToTelegram(WALLET, payout(1));
    await _outboxesIdle();
    const texts = sent().map((c) => c.body.text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/^Payout credited \(2 tasks\)/);
  });

  it("keeps both sides of one task when a chat holds the poster's and the worker's wallet", async () => {
    _setOutboxTiming({ quietMs: 40 });
    const worker = '0x' + 'b'.repeat(40);
    await linkChat('42', [WALLET, worker]);
    const done = note({ type: 'completed', title: 'Task completed — escrow released' });
    const paid = note({ type: 'completed', title: 'Payout credited' });
    await deliverToTelegram(WALLET, done);
    await deliverToTelegram(worker, paid);
    await _outboxesIdle();
    expect(sent().map((c) => c.body.text)).toEqual([formatNotification(done), formatNotification(paid)]);
  });

  it('counts a very large burst exactly while listing only ten', async () => {
    _setOutboxTiming({ quietMs: 50 });
    await linkChat('42', [WALLET]);
    await Promise.all(Array.from({ length: 1_200 }, (_, i) => deliverToTelegram(WALLET, reminder(i))));
    await _outboxesIdle();
    expect(sent()).toHaveLength(1);
    const text = sent()[0].body.text;
    expect(text).toContain('Deadline approaching (1200 tasks)');
    expect(text).toContain('…and 1190 more');
    expect(text.length).toBeLessThan(4096);
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

  it("does not let someone else's link take over a chat that is already connected", async () => {
    const OTHER = '0x' + 'c'.repeat(40);
    await linkChat('42', [WALLET]);
    const theirs = await createLinkNonce([OTHER]);
    await handleTelegramUpdate(update(1, `/start ${theirs}`));
    expect((await getLink(WALLET))?.chatId).toBe('42');
    expect(await getLink(OTHER)).toBeNull();
    expect(sent()[0].body.text).toMatch(/already connected to 0xaaaa…aaaa/);
    // Not consumed: the owner of that link can still use it in their own chat.
    expect(await consumeLinkNonce(theirs)).toEqual([OTHER]);
  });

  it('lets the same account connect again, also with an extra wallet', async () => {
    const EXTRA = '0x' + 'd'.repeat(40);
    await linkChat('42', [WALLET]);
    const nonce = await createLinkNonce([WALLET, EXTRA]);
    await handleTelegramUpdate(update(1, `/start ${nonce}`));
    expect((await getLink(EXTRA))?.chatId).toBe('42');
    expect(sent()[0].body.text).toMatch(/^Connected to/);
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
