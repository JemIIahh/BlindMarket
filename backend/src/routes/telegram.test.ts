import '../middleware/asyncErrors.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * /api/v1/telegram: the webhook is authenticated by Telegram's secret header
 * (no session), the rest by the signed-in wallet. Real store, fake redis.
 *
 * Run:  npx vitest run src/routes/telegram.test.ts
 */

const cfg = vi.hoisted(() => ({
  openSubmissionEnabled: false,
  telegramBotToken: '123:TOKEN',
  telegramWebhookSecret: 'whsec',
  telegramBotUsername: 'BlindMarketBot',
  publicAppUrl: 'https://app.example',
}));
vi.mock('../config.js', () => ({ config: cfg }));

const principal = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = principal.current;
    next();
  },
}));

const handleUpdate = vi.hoisted(() => vi.fn(async (_u: unknown) => {}));
vi.mock('../services/telegram.js', () => ({
  handleTelegramUpdate: handleUpdate,
  telegramEnabled: () => cfg.telegramBotToken !== '',
  telegramWebhookReady: () => cfg.telegramBotToken !== '' && cfg.telegramWebhookSecret !== '',
}));

const mem = vi.hoisted(() => ({ kv: new Map<string, string>(), sets: new Map<string, Set<string>>() }));
vi.mock('../services/redis.js', () => ({
  redis: {
    get: async (k: string) => mem.kv.get(k) ?? null,
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

import { telegramRouter } from './telegram.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import { consumeLinkNonce, getLink, linkChat } from '../services/telegramStore.js';

const WALLET = '0x' + 'a'.repeat(40);
const OTHER = '0x' + 'b'.repeat(40);

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/telegram', telegramRouter);
  a.use(globalErrorHandler);
  return a;
}

beforeEach(() => {
  mem.kv.clear();
  mem.sets.clear();
  handleUpdate.mockClear();
  cfg.telegramBotToken = '123:TOKEN';
  cfg.telegramWebhookSecret = 'whsec';
  cfg.telegramBotUsername = 'BlindMarketBot';
  principal.current = { address: WALLET };
});

describe('POST /webhook', () => {
  it('handles an update that carries the right secret', async () => {
    const res = await request(app())
      .post('/api/v1/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', 'whsec')
      .send({ update_id: 1 });
    expect(res.status).toBe(200);
    expect(handleUpdate).toHaveBeenCalledWith({ update_id: 1 });
  });

  it.each([
    ['a wrong secret', 'nope'],
    ['an empty secret', ''],
    ['a secret of the wrong length', 'whsec-but-longer'],
  ])('refuses %s without handling the update', async (_label, secret) => {
    const res = await request(app())
      .post('/api/v1/telegram/webhook')
      .set('X-Telegram-Bot-Api-Secret-Token', secret)
      .send({ update_id: 1 });
    expect(res.status).toBe(401);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('refuses a request with no secret header', async () => {
    const res = await request(app()).post('/api/v1/telegram/webhook').send({ update_id: 1 });
    expect(res.status).toBe(401);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('is unavailable when the secret is not configured, even if the header is empty', async () => {
    cfg.telegramWebhookSecret = '';
    const res = await request(app()).post('/api/v1/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', '').send({});
    expect(res.status).toBe(503);
    expect(handleUpdate).not.toHaveBeenCalled();
  });

  it('is unavailable when the bot is not configured', async () => {
    cfg.telegramBotToken = '';
    const res = await request(app()).post('/api/v1/telegram/webhook').set('X-Telegram-Bot-Api-Secret-Token', 'whsec').send({});
    expect(res.status).toBe(503);
  });
});

describe('POST /link', () => {
  it('returns a deep link whose nonce is bound to the session wallet', async () => {
    const res = await request(app()).post('/api/v1/telegram/link');
    expect(res.status).toBe(200);
    const { url, expiresInSec } = res.body.data;
    expect(expiresInSec).toBe(600);
    const m = /^https:\/\/t\.me\/BlindMarketBot\?start=([a-f0-9]{32})$/.exec(url);
    expect(m).not.toBeNull();
    expect(await consumeLinkNonce(m![1])).toEqual([WALLET]);
  });

  it('binds every wallet linked to the account', async () => {
    principal.current = { address: WALLET, addresses: [OTHER] };
    const res = await request(app()).post('/api/v1/telegram/link');
    const nonce = /start=([a-f0-9]{32})/.exec(res.body.data.url)![1];
    expect((await consumeLinkNonce(nonce))!.sort()).toEqual([WALLET, OTHER].sort());
  });

  it('refuses the legacy shared agent key, which has no wallet to alert', async () => {
    principal.current = { address: 'agent' };
    const res = await request(app()).post('/api/v1/telegram/link');
    expect(res.status).toBe(401);
  });

  it('is unavailable when Telegram is not configured', async () => {
    cfg.telegramBotToken = '';
    expect((await request(app()).post('/api/v1/telegram/link')).status).toBe(503);
    cfg.telegramBotToken = '123:TOKEN';
    cfg.telegramBotUsername = '';
    expect((await request(app()).post('/api/v1/telegram/link')).status).toBe(503);
  });
});

describe('GET /status and PUT /prefs', () => {
  it('reports unlinked with every type on', async () => {
    const res = await request(app()).get('/api/v1/telegram/status');
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.linked).toBe(false);
    expect(Object.values(res.body.data.types).every((v) => v === true)).toBe(true);
  });

  it('offers the Submissions toggle only while open submission is on', async () => {
    const offered = async () => Object.keys((await request(app()).get('/api/v1/telegram/status')).body.data.types);
    cfg.openSubmissionEnabled = false;
    expect(await offered()).not.toContain('submissions');
    expect(await offered()).toContain('deadline_soon');
    cfg.openSubmissionEnabled = true;
    expect(await offered()).toContain('submissions');
    cfg.openSubmissionEnabled = false;
  });

  it('reports linked, and reflects a changed preference', async () => {
    await linkChat('42', [WALLET]);
    const put = await request(app()).put('/api/v1/telegram/prefs').send({ types: { deadline_soon: false } });
    expect(put.status).toBe(200);
    expect(put.body.data.types.deadline_soon).toBe(false);
    expect(put.body.data.types.completed).toBe(true);
    const res = await request(app()).get('/api/v1/telegram/status');
    expect(res.body.data.linked).toBe(true);
    expect(res.body.data.types.deadline_soon).toBe(false);
  });

  it('rejects unknown types and non-boolean values', async () => {
    await linkChat('42', [WALLET]);
    expect((await request(app()).put('/api/v1/telegram/prefs').send({ types: { nope: true } })).status).toBe(400);
    expect((await request(app()).put('/api/v1/telegram/prefs').send({ types: { expired: 'yes' } })).status).toBe(400);
    expect((await request(app()).put('/api/v1/telegram/prefs').send({})).status).toBe(400);
  });

  it('refuses prefs when nothing is linked', async () => {
    const res = await request(app()).put('/api/v1/telegram/prefs').send({ types: { expired: false } });
    expect(res.status).toBe(409);
  });

  it("does not show or change another wallet's chat", async () => {
    await linkChat('42', [OTHER]);
    const status = await request(app()).get('/api/v1/telegram/status');
    expect(status.body.data.linked).toBe(false);
    expect((await request(app()).put('/api/v1/telegram/prefs').send({ types: { expired: false } })).status).toBe(409);
  });
});

describe('DELETE /link', () => {
  it('unlinks the session wallets', async () => {
    await linkChat('42', [WALLET]);
    const res = await request(app()).delete('/api/v1/telegram/link');
    expect(res.status).toBe(200);
    expect(res.body.data.unlinked).toBe(1);
    expect(await getLink(WALLET)).toBeNull();
  });

  it('is safe when nothing is linked, and leaves other wallets alone', async () => {
    await linkChat('99', [OTHER]);
    const res = await request(app()).delete('/api/v1/telegram/link');
    expect(res.body.data.unlinked).toBe(0);
    expect(await getLink(OTHER)).not.toBeNull();
  });
});
