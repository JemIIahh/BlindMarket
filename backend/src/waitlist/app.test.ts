import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type express from 'express';

/**
 * The standalone waitlist service as a whole: health check, nothing but the
 * waitlist mounted, per-visitor rate limits behind the host's proxy — and
 * proof that loading it never pulls in marketplace code.
 */

const { cfg, store } = vi.hoisted(() => ({
  cfg: {
    nodeEnv: 'production',
    port: 0,
    databaseUrl: 'postgres://test',
    corsOrigin: ['https://waitlist.blindmarket.xyz'],
    trustProxy: 1,
  },
  store: {
    joinWaitlist: vi.fn(),
    getStandingByToken: vi.fn(),
    addTaskByToken: vi.fn(),
    getWaitlistTotal: vi.fn(),
    getLeaderboard: vi.fn(),
  },
}));

vi.mock('./config.js', () => ({ waitlistConfig: cfg }));
vi.mock('./store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store.js')>()),
  ...store,
}));

// Tripwires: the marketplace config demands marketplace secrets at load and the
// marketplace database runs marketplace migrations. If anything in the
// waitlist service imports either, these factories throw and every test fails.
vi.mock('../config.js', () => {
  throw new Error('waitlist service imported the marketplace config');
});
vi.mock('../services/neonDb.js', () => {
  throw new Error('waitlist service imported the marketplace database');
});

const TOKEN = 'wl_abcdefghijklmnopqrstuvwxyz012345';
const STANDING = {
  position: 1,
  total: 1,
  points: 3,
  taskPoints: 3,
  referrals: 0,
  referralCode: 'k7m2p9qa',
  xHandle: 'ada_l',
  tasks: ['follow', 'like', 'repost'],
};

let server: http.Server;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules(); // fresh rate limiters per test
  const { createWaitlistApp } = await import('./app.js');
  server = await listen(createWaitlistApp());
});

// One server per test, bound to 127.0.0.1 and held open until the test ends.
// supertest's default is a fresh wildcard-bound server per request on a random
// port, and it always connects to 127.0.0.1 — on macOS another process's
// 127.0.0.1 bind on that port wins the connection, so a request could land on
// someone else's server (seen as a 401 from /stats). An open, specific bind
// can't be taken over.
function listen(a: express.Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = a.listen(0, '127.0.0.1', () => resolve(s));
  });
}

afterEach(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
);

describe('waitlist service', () => {
  it('answers its health check', async () => {
    const res = await request(server).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('serves only the waitlist — marketplace paths are 404s', async () => {
    for (const path of ['/', '/api/v1/tasks', '/api/v1/agents', '/api/v1/analytics/events', '/mcp']) {
      const res = await request(server).get(path);
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('sends security headers', async () => {
    const res = await request(server).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows the page origin in production, and nothing else — localhost included', async () => {
    store.getWaitlistTotal.mockResolvedValue(1);
    const page = await request(server).get('/api/v1/waitlist/stats').set('Origin', 'https://waitlist.blindmarket.xyz');
    expect(page.headers['access-control-allow-origin']).toBe('https://waitlist.blindmarket.xyz');
    const local = await request(server).get('/api/v1/waitlist/stats').set('Origin', 'http://localhost:8791');
    expect(local.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rate-limits each visitor behind the host proxy, not everyone as one', async () => {
    store.joinWaitlist.mockResolvedValue({ token: TOKEN, standing: STANDING });
    const join = (ip: string, i: number) =>
      request(server).post('/api/v1/waitlist/join').set('X-Forwarded-For', ip).send({ email: `u${i}@example.com`, xHandle: `u${i}` });

    for (let i = 0; i < 10; i++) expect((await join('203.0.113.7', i)).status).toBe(201);
    expect((await join('203.0.113.7', 10)).status).toBe(429);
    // A different visitor through the same proxy still gets in.
    expect((await join('198.51.100.4', 11)).status).toBe(201);
  });

  it('counts referral credits per visitor behind the proxy — and per /64 for IPv6', async () => {
    store.joinWaitlist.mockResolvedValue({ token: TOKEN, standing: STANDING, referralCredited: true });
    let n = 0;
    const statuses: number[] = [];
    // Addresses no other test uses, so no signup budget is shared with them.
    const join = async (ip: string) => {
      const res = await request(server)
        .post('/api/v1/waitlist/join')
        .set('X-Forwarded-For', ip)
        .send({ email: `r${n}@example.com`, xHandle: `r${n++}`, ref: 'k7m2p9qa' });
      statuses.push(res.status);
    };

    for (let i = 0; i < 6; i++) await join('192.0.2.10'); // 6th from the same visitor: no credit
    await join('192.0.2.20'); // someone else: credited
    for (let i = 1; i <= 6; i++) await join(`2001:db8:9:9::${i}`); // one /64 — the 6th: no credit

    // Every signup gets in; only the referral credit is withheld.
    expect(statuses).toEqual(Array<number>(13).fill(201));
    const refs = store.joinWaitlist.mock.calls.map(([input]) => input.ref);
    const credited = Array<string>(5).fill('k7m2p9qa');
    expect(refs).toEqual([...credited, undefined, 'k7m2p9qa', ...credited, undefined]);
  });
});
