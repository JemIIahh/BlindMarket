import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Router } from 'express';
import request from 'supertest';

/**
 * Route tests for the public waitlist API. The REAL router is mounted the way
 * index.ts mounts it — with no app-wide json parser or CORS in front — so its
 * own cors / body parser / limits are what's exercised. Only the store and
 * config are mocked; the ranking SQL is exercised against real Postgres, not
 * here.
 */

const { cfg, store } = vi.hoisted(() => ({
  cfg: {
    databaseUrl: 'postgres://test',
    nodeEnv: 'test',
    waitlistCorsOrigin: ['https://waitlist.example'],
  },
  store: {
    joinWaitlist: vi.fn(),
    getStandingByToken: vi.fn(),
    addTaskByToken: vi.fn(),
    getWaitlistTotal: vi.fn(),
    getLeaderboard: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({ config: cfg }));

vi.mock('../services/waitlistStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/waitlistStore.js')>()),
  ...store,
}));

// A fresh module instance per test → fresh rate limiters, so the join budget
// one test spends can't 429 the next.
async function makeApp() {
  vi.resetModules();
  const { waitlistRouter } = await import('./waitlist.js');
  const { globalErrorHandler } = await import('../middleware/errorHandler.js');
  const a = express();
  a.use('/api/v1/waitlist', waitlistRouter as Router);
  a.use(globalErrorHandler);
  return a;
}

let app: express.Express;
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
  cfg.databaseUrl = 'postgres://test';
  app = await makeApp();
});

describe('GET /api/v1/waitlist/stats', () => {
  it('returns the total', async () => {
    store.getWaitlistTotal.mockResolvedValueOnce(42);
    const res = await request(app).get('/api/v1/waitlist/stats');
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
    const res = await request(app).get('/api/v1/waitlist/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { entries } });
  });

  it('refuses with 503 when no database is configured', async () => {
    cfg.databaseUrl = '';
    const res = await request(app).get('/api/v1/waitlist/leaderboard');
    expect(res.status).toBe(503);
    expect(store.getLeaderboard).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/waitlist/join', () => {
  it('creates a signup with a normalized email and deduped tasks, ignoring any client-sent points', async () => {
    store.joinWaitlist.mockResolvedValueOnce({ token: TOKEN, standing: STANDING });
    const res = await request(app)
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

  it('returns the existing standing — and no token — for a repeat email', async () => {
    store.joinWaitlist.mockResolvedValueOnce({ token: null, standing: STANDING });
    const res = await request(app).post('/api/v1/waitlist/join').send(JOIN);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ...STANDING, alreadyJoined: true });
    expect(res.body.data).not.toHaveProperty('token');
  });

  it('passes a referral code through, normalized to lowercase', async () => {
    store.joinWaitlist.mockResolvedValueOnce({ token: TOKEN, standing: STANDING });
    const res = await request(app).post('/api/v1/waitlist/join').send({ ...JOIN, ref: ' K7M2P9QA ' });
    expect(res.status).toBe(201);
    expect(store.joinWaitlist).toHaveBeenCalledWith(expect.objectContaining({ ref: 'k7m2p9qa' }));
  });

  it('drops a malformed referral code instead of failing the signup', async () => {
    store.joinWaitlist.mockResolvedValueOnce({ token: TOKEN, standing: STANDING });
    const res = await request(app).post('/api/v1/waitlist/join').send({ ...JOIN, ref: 'k7m2"><script>' });
    expect(res.status).toBe(201);
    expect(store.joinWaitlist).toHaveBeenCalledWith(expect.objectContaining({ ref: undefined }));
  });

  it('requires an X handle', async () => {
    const res = await request(app).post('/api/v1/waitlist/join').send({ email: 'ada@example.com' });
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
    const res = await request(app).post('/api/v1/waitlist/join').send({ email: 'ada@example.com', xHandle });
    expect(res.status).toBe(400);
    expect(store.joinWaitlist).not.toHaveBeenCalled();
  });

  it('rejects an invalid email without touching the store', async () => {
    const res = await request(app).post('/api/v1/waitlist/join').send({ email: 'not-an-email', xHandle: 'ada_l' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(store.joinWaitlist).not.toHaveBeenCalled();
  });

  it('rejects an unknown task', async () => {
    const res = await request(app)
      .post('/api/v1/waitlist/join')
      .send({ ...JOIN, tasks: ['follow', 'bribe'] });
    expect(res.status).toBe(400);
    expect(store.joinWaitlist).not.toHaveBeenCalled();
  });

  it('answers malformed JSON with 400, not a 500', async () => {
    const res = await request(app)
      .post('/api/v1/waitlist/join')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('refuses with 503 instead of faking success when no database is configured', async () => {
    cfg.databaseUrl = '';
    const res = await request(app).post('/api/v1/waitlist/join').send(JOIN);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('WAITLIST_UNAVAILABLE');
    expect(store.joinWaitlist).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/waitlist/me', () => {
  it('requires a bearer token', async () => {
    const res = await request(app).get('/api/v1/waitlist/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WAITLIST_TOKEN_INVALID');
  });

  it('rejects an unknown token', async () => {
    store.getStandingByToken.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/v1/waitlist/me').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(401);
  });

  it('returns the standing for a known token', async () => {
    store.getStandingByToken.mockResolvedValueOnce(STANDING);
    const res = await request(app).get('/api/v1/waitlist/me').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(STANDING);
    expect(store.getStandingByToken).toHaveBeenCalledWith(TOKEN);
  });
});

describe('POST /api/v1/waitlist/me/tasks', () => {
  it('records a task', async () => {
    const after = { ...STANDING, points: 6, tasks: [...STANDING.tasks, 'comment'] };
    store.addTaskByToken.mockResolvedValueOnce(after);
    const res = await request(app)
      .post('/api/v1/waitlist/me/tasks')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ task: 'comment' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(after);
    expect(store.addTaskByToken).toHaveBeenCalledWith(TOKEN, 'comment');
  });

  it('rejects an unknown task', async () => {
    const res = await request(app)
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
    const res = await request(app).get('/api/v1/waitlist/stats').set('Origin', 'https://waitlist.example');
    expect(res.headers['access-control-allow-origin']).toBe('https://waitlist.example');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not allow any other origin', async () => {
    store.getWaitlistTotal.mockResolvedValueOnce(1);
    const res = await request(app).get('/api/v1/waitlist/stats').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers the JSON + Authorization preflight itself', async () => {
    const res = await request(app)
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
      const ok = await request(app).post('/api/v1/waitlist/join').send({ email: `u${i}@example.com`, xHandle: `u${i}` });
      expect(ok.status).toBe(201);
    }
    const res = await request(app).post('/api/v1/waitlist/join').send({ email: 'u10@example.com', xHandle: 'u10' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMIT');
  });

  it('gives the cached public reads their own, looser budget', async () => {
    store.getWaitlistTotal.mockResolvedValue(1);
    store.getStandingByToken.mockResolvedValue(STANDING);

    // 70 page loads' worth of public reads would blow the 60/min /me budget if they shared it.
    for (let i = 0; i < 70; i++) {
      expect((await request(app).get('/api/v1/waitlist/stats')).status).toBe(200);
    }
    const me = await request(app).get('/api/v1/waitlist/me').set('Authorization', `Bearer ${TOKEN}`);
    expect(me.status).toBe(200);
  });
});
