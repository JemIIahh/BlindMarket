import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import express, { type Router } from 'express';
import request from 'supertest';

/**
 * Route tests for the public waitlist API. The REAL router is mounted bare —
 * no json parser or CORS in front — so its own cors / body parser / limits are
 * what's exercised. Only the store and config are mocked; the ranking SQL is
 * exercised against real Postgres, not here.
 */

const { cfg, store } = vi.hoisted(() => ({
  cfg: {
    nodeEnv: 'test',
    port: 0,
    databaseUrl: 'postgres://test',
    corsOrigin: ['https://waitlist.example'],
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

// A fresh module instance per test → fresh rate limiters, so the join budget
// one test spends can't 429 the next.
async function makeApp() {
  vi.resetModules();
  const { waitlistRouter } = await import('./router.js');
  const { globalErrorHandler } = await import('../middleware/errorHandler.js');
  const a = express();
  a.use('/api/v1/waitlist', waitlistRouter as Router);
  a.use(globalErrorHandler);
  return a;
}

let server: http.Server;
const TOKEN = 'wl_abcdefghijklmnopqrstuvwxyz012345';
const STANDING = {
  position: 7,
  total: 12,
  points: 7,
  taskPoints: 3,
  referrals: 2,
  referralCode: 'k7m2p9qa',
  xHandle: 'ada_l',
  tasks: ['follow', 'like', 'repost'],
};
const JOIN = { email: 'ada@example.com', xHandle: 'ada_l' };

beforeEach(async () => {
  vi.clearAllMocks();
  server = await listen(await makeApp());
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

describe('GET /api/v1/waitlist/stats', () => {
  it('returns the total', async () => {
    store.getWaitlistTotal.mockResolvedValueOnce(42);
    const res = await request(server).get('/api/v1/waitlist/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { total: 42 } });
  });
});

describe('GET /api/v1/waitlist/leaderboard', () => {
  it('returns the entries from the store', async () => {
    const entries = [
      { rank: 1, handle: 'ada_l', points: 9, referrals: 3 },
      { rank: 2, handle: null, points: 3, referrals: 0 },
    ];
    store.getLeaderboard.mockResolvedValueOnce(entries);
    const res = await request(server).get('/api/v1/waitlist/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { entries } });
  });
});

describe('POST /api/v1/waitlist/join', () => {
  it('creates a signup with a normalized email and deduped tasks, ignoring any client-sent points', async () => {
    store.joinWaitlist.mockResolvedValueOnce({ token: TOKEN, standing: STANDING });
    const res = await request(server)
      .post('/api/v1/waitlist/join')
      .send({ email: '  Ada@Example.COM ', xHandle: ' @ada_l ', tasks: ['follow', 'like', 'repost', 'like'], points: 999 });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ ...STANDING, token: TOKEN, alreadyJoined: false });
    expect(store.joinWaitlist).toHaveBeenCalledWith({
      email: 'ada@example.com',
      xHandle: 'ada_l',
      tasks: ['follow', 'like', 'repost'],
      ref: undefined,
    });
  });

  it('tells a repeat email only that it is already on the list — no token, handle or standing', async () => {
    store.joinWaitlist.mockResolvedValueOnce({ token: null, standing: null, referralCredited: false });
    const res = await request(server).post('/api/v1/waitlist/join').send(JOIN);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { alreadyJoined: true } });
  });

  it('credits at most 5 referrals per connection per day — later signups still get in', async () => {
    store.joinWaitlist.mockResolvedValue({ token: TOKEN, standing: STANDING, referralCredited: true });
    for (let i = 0; i < 6; i++) {
      const res = await request(server).post('/api/v1/waitlist/join').send({ email: `f${i}@example.com`, xHandle: `f${i}`, ref: 'k7m2p9qa' });
      expect(res.status).toBe(201);
    }
    const refsSent = store.joinWaitlist.mock.calls.map(([input]) => input.ref);
    expect(refsSent).toEqual(['k7m2p9qa', 'k7m2p9qa', 'k7m2p9qa', 'k7m2p9qa', 'k7m2p9qa', undefined]);
  });

  it('only spends the referral budget when a referral was actually credited', async () => {
    // e.g. an unknown code, or an address already on the list
    store.joinWaitlist.mockResolvedValue({ token: TOKEN, standing: STANDING, referralCredited: false });
    for (let i = 0; i < 7; i++) {
      await request(server).post('/api/v1/waitlist/join').send({ email: `g${i}@example.com`, xHandle: `g${i}`, ref: 'zzzzzzzz' });
    }
    expect(store.joinWaitlist.mock.calls.every(([input]) => input.ref === 'zzzzzzzz')).toBe(true);
  });

  it('passes a referral code through, normalized to lowercase', async () => {
    store.joinWaitlist.mockResolvedValueOnce({ token: TOKEN, standing: STANDING });
    const res = await request(server).post('/api/v1/waitlist/join').send({ ...JOIN, ref: ' K7M2P9QA ' });
    expect(res.status).toBe(201);
    expect(store.joinWaitlist).toHaveBeenCalledWith(expect.objectContaining({ ref: 'k7m2p9qa' }));
  });

  it('drops a malformed referral code instead of failing the signup', async () => {
    store.joinWaitlist.mockResolvedValueOnce({ token: TOKEN, standing: STANDING });
    const res = await request(server).post('/api/v1/waitlist/join').send({ ...JOIN, ref: 'k7m2"><script>' });
    expect(res.status).toBe(201);
    expect(store.joinWaitlist).toHaveBeenCalledWith(expect.objectContaining({ ref: undefined }));
  });

  it('requires an X handle', async () => {
    const res = await request(server).post('/api/v1/waitlist/join').send({ email: 'ada@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(store.joinWaitlist).not.toHaveBeenCalled();
  });

  it.each([
    ['too long', 'a_sixteen_chars_'],
    ['bad characters', 'ada.lovelace'],
    ['markup', '<b>ada</b>'],
    ['bare @', '@'],
  ])('rejects an X handle with %s', async (_why, xHandle) => {
    const res = await request(server).post('/api/v1/waitlist/join').send({ email: 'ada@example.com', xHandle });
    expect(res.status).toBe(400);
    expect(store.joinWaitlist).not.toHaveBeenCalled();
  });

  it('rejects an invalid email without touching the store', async () => {
    const res = await request(server).post('/api/v1/waitlist/join').send({ email: 'not-an-email', xHandle: 'ada_l' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(store.joinWaitlist).not.toHaveBeenCalled();
  });

  it('rejects an unknown task', async () => {
    const res = await request(server)
      .post('/api/v1/waitlist/join')
      .send({ ...JOIN, tasks: ['follow', 'bribe'] });
    expect(res.status).toBe(400);
    expect(store.joinWaitlist).not.toHaveBeenCalled();
  });

  it('answers malformed JSON with 400, not a 500', async () => {
    const res = await request(server)
      .post('/api/v1/waitlist/join')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('GET /api/v1/waitlist/me', () => {
  it('requires a bearer token', async () => {
    const res = await request(server).get('/api/v1/waitlist/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WAITLIST_TOKEN_INVALID');
  });

  it('rejects an unknown token', async () => {
    store.getStandingByToken.mockResolvedValueOnce(null);
    const res = await request(server).get('/api/v1/waitlist/me').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(401);
  });

  it('returns the standing for a known token', async () => {
    store.getStandingByToken.mockResolvedValueOnce(STANDING);
    const res = await request(server).get('/api/v1/waitlist/me').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(STANDING);
    expect(store.getStandingByToken).toHaveBeenCalledWith(TOKEN);
  });
});

describe('POST /api/v1/waitlist/me/tasks', () => {
  it('records a task', async () => {
    const after = { ...STANDING, points: 6, tasks: [...STANDING.tasks, 'comment'] };
    store.addTaskByToken.mockResolvedValueOnce(after);
    const res = await request(server)
      .post('/api/v1/waitlist/me/tasks')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ task: 'comment' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(after);
    expect(store.addTaskByToken).toHaveBeenCalledWith(TOKEN, 'comment');
  });

  it('rejects an unknown task', async () => {
    const res = await request(server)
      .post('/api/v1/waitlist/me/tasks')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ task: 'points' });
    expect(res.status).toBe(400);
    expect(store.addTaskByToken).not.toHaveBeenCalled();
  });
});

describe('CORS', () => {
  it('allows the configured origin, without credentials', async () => {
    store.getWaitlistTotal.mockResolvedValueOnce(1);
    const res = await request(server).get('/api/v1/waitlist/stats').set('Origin', 'https://waitlist.example');
    expect(res.headers['access-control-allow-origin']).toBe('https://waitlist.example');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not allow any other origin', async () => {
    store.getWaitlistTotal.mockResolvedValueOnce(1);
    const res = await request(server).get('/api/v1/waitlist/stats').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers the JSON + Authorization preflight itself', async () => {
    const res = await request(server)
      .options('/api/v1/waitlist/me/tasks')
      .set('Origin', 'https://waitlist.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://waitlist.example');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
  });
});

describe('rate limiting', () => {
  it('caps signups at 10 per IP per window', async () => {
    store.joinWaitlist.mockResolvedValue({ token: TOKEN, standing: STANDING });

    for (let i = 0; i < 10; i++) {
      const ok = await request(server).post('/api/v1/waitlist/join').send({ email: `u${i}@example.com`, xHandle: `u${i}` });
      expect(ok.status).toBe(201);
    }
    const res = await request(server).post('/api/v1/waitlist/join').send({ email: 'u10@example.com', xHandle: 'u10' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMIT');
  });

  it('gives the cached public reads their own, looser budget', async () => {
    store.getWaitlistTotal.mockResolvedValue(1);
    store.getStandingByToken.mockResolvedValue(STANDING);

    // 70 page loads' worth of public reads would blow the 60/min /me budget if they shared it.
    for (let i = 0; i < 70; i++) {
      expect((await request(server).get('/api/v1/waitlist/stats')).status).toBe(200);
    }
    const me = await request(server).get('/api/v1/waitlist/me').set('Authorization', `Bearer ${TOKEN}`);
    expect(me.status).toBe(200);
  });
});

describe('connectionKey', () => {
  it('keys IPv4 (and IPv4-mapped IPv6) by address, and IPv6 by its /64', async () => {
    const { connectionKey } = await import('./router.js');
    expect(connectionKey('203.0.113.7')).toBe('203.0.113.7');
    expect(connectionKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(connectionKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    // Same /64 written out in full, with leading zeros and a different host part.
    expect(connectionKey('2001:0db8:0001:0002:ffff:0:0:9')).toBe('2001:db8:1:2::/64');
    expect(connectionKey('2001:db8:1:3::1')).not.toBe(connectionKey('2001:db8:1:2::1'));
  });
});
