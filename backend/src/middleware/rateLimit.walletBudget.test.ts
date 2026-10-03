import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Posting routes are limited per wallet, not per IP, for authenticated calls
 * (docs/BULK-POSTING.md), so a bulk run doesn't starve the other users behind
 * the same IP; unauthenticated calls keep the per-IP limit. Runs the real
 * limiters in front of a stand-in requireAuth: `Bearer good-<wallet>`
 * authenticates as <wallet>, any other token fails.
 *
 * Run: npx vitest run src/middleware/rateLimit.walletBudget.test.ts
 */

// The limiters read hosted-agent tokens through auth.js, whose imports
// connect to Redis and the database on load.
vi.mock('../services/redis.js', () => ({ redis: { get: vi.fn(async () => null) } }));
vi.mock('../services/apiKeyStore.js', () => ({ lookupApiKey: vi.fn(async () => null) }));

const {
  batchWeight,
  createPostingAuthLimiter,
  createPostingIpBudget,
  createRateLimiter,
  createWalletBudget,
  isCredentialedPosting,
  IP_POSTING_BUDGET_PER_MIN,
} = await import('./rateLimit.js');
const { AppError, globalErrorHandler } = await import('./errorHandler.js');

const auth = vi.fn((req: any, _res: any, next: any) => {
  const token = typeof req.headers.authorization === 'string' ? req.headers.authorization.slice(7) : '';
  if (token.startsWith('good-')) {
    req.user = { address: token.slice(5) };
    next();
    return;
  }
  next(new AppError(401, 'INVALID_TOKEN', 'Invalid or expired token'));
});

/** The app's limiters in index.ts order, and a posting route behind requireAuth and a wallet budget. */
function makeApp(perMinute = 120) {
  const app = express();
  app.use(createRateLimiter());
  app.use(createPostingAuthLimiter());
  app.use(express.json());
  const budget = createWalletBudget({ name: 'task builds', perMinute, weight: batchWeight('tasks') });
  app.post('/api/v1/tasks', auth, budget, (_req, res) => { res.json({ success: true }); });
  app.post('/api/v1/tasks/batch', auth, budget, (_req, res) => { res.json({ success: true }); });
  app.get('/api/v1/stats', (_req, res) => { res.json({ success: true }); });
  app.use(globalErrorHandler);
  return app;
}

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const build = (app: express.Express, who: string) =>
  request(app).post('/api/v1/tasks').set('Authorization', `Bearer good-${who}`).send({});
const buildBatch = (app: express.Express, who: string, n: number) =>
  request(app).post('/api/v1/tasks/batch').set('Authorization', `Bearer good-${who}`).send({ tasks: Array(n).fill({}) });

afterEach(() => {
  vi.useRealTimers();
  auth.mockClear();
});

describe('wallet budget on the posting routes', () => {
  it('limits each wallet on its own: one spending its budget leaves another behind the same IP untouched', async () => {
    // A frozen clock: nothing refills while the test runs.
    vi.useFakeTimers({ toFake: ['Date'] });
    const app = makeApp();
    for (let i = 0; i < 120; i++) expect((await build(app, wallet(1))).status).toBe(200);
    const refused = await build(app, wallet(1));
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMIT');
    expect(refused.body.error.message).toContain('this wallet');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await build(app, wallet(2))).status).toBe(200);
  });

  it('spends one per task of a batch, and a refused request spends nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const app = makeApp();
    expect((await buildBatch(app, wallet(3), 50)).status).toBe(200);
    expect((await buildBatch(app, wallet(3), 50)).status).toBe(200);
    const refused = await buildBatch(app, wallet(3), 50);
    expect(refused.status).toBe(429);
    // 20 left; 30 more come back at 2 a second.
    expect(Number(refused.headers['retry-after'])).toBe(15);
    expect(refused.headers['ratelimit-remaining']).toBe('20');
    expect((await buildBatch(app, wallet(3), 20)).status).toBe(200);
    expect((await build(app, wallet(3))).status).toBe(429);
  });

  it('refills steadily, so a client backing off a few seconds gets through', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const app = makeApp();
    expect((await buildBatch(app, wallet(4), 120)).status).toBe(200);
    expect((await build(app, wallet(4))).status).toBe(429);
    vi.setSystemTime(Date.now() + 10_000);
    expect((await buildBatch(app, wallet(4), 20)).status).toBe(200);
    expect((await build(app, wallet(4))).status).toBe(429);
  });

  it('never charges a request more than the whole budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const app = makeApp();
    expect((await buildBatch(app, wallet(5), 500)).status).toBe(200);
    expect((await build(app, wallet(5))).status).toBe(429);
  });
});

describe('per-IP limits around the posting routes', () => {
  it('skips the global per-IP limit for posting calls that present credentials', async () => {
    const app = makeApp();
    // 150 wallets behind one IP, past the global 100 a minute.
    for (let i = 0; i < 150; i++) expect((await build(app, wallet(100 + i))).status).toBe(200);
    // Every other route still counts per IP.
    for (let i = 0; i < 100; i++) expect((await request(app).get('/api/v1/stats')).status).toBe(200);
    expect((await request(app).get('/api/v1/stats')).status).toBe(429);
  });

  it('counts a posting call without credentials against the global per-IP limit', async () => {
    const app = makeApp();
    for (let i = 0; i < 100; i++) await request(app).get('/api/v1/stats');
    const res = await request(app).post('/api/v1/tasks').send({});
    expect(res.status).toBe(429);
    expect(auth).not.toHaveBeenCalled();
  });

  it('keeps a per-IP limit on posting calls whose credentials fail, refused before authentication runs', async () => {
    const app = makeApp();
    for (let i = 0; i < 100; i++) {
      expect((await request(app).post('/api/v1/tasks').set('Authorization', 'Bearer forged').send({})).status).toBe(401);
    }
    auth.mockClear();
    const res = await request(app).post('/api/v1/tasks').set('Authorization', 'Bearer forged').send({});
    expect(res.status).toBe(429);
    expect(auth).not.toHaveBeenCalled();
  });

  it('does not count authenticated calls toward that limit', async () => {
    const app = makeApp(1_000);
    for (let i = 0; i < 150; i++) expect((await build(app, wallet(7))).status).toBe(200);
    expect((await request(app).post('/api/v1/tasks').set('Authorization', 'Bearer forged').send({})).status).toBe(401);
  });
});

// A per-IP ceiling over the wallet budgets (security review): one address
// minting keys can't multiply the per-wallet budget.
describe('per-IP ceiling across the posting routes', () => {
  /** Two posting families, each with its own wallet budget, sharing one IP ceiling, as the routes mount them. */
  function ceilingApp() {
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    const ip = createPostingIpBudget();
    const builds = createWalletBudget({ name: 'task builds', perMinute: 120, weight: batchWeight('tasks') });
    const uploads = createWalletBudget({ name: 'uploads', perMinute: 120, weight: batchWeight('items') });
    app.post('/api/v1/tasks/batch', auth, builds, ip, (_req, res) => { res.json({ success: true }); });
    app.post('/api/v1/storage/upload-batch', auth, uploads, ip, (_req, res) => { res.json({ success: true }); });
    app.use(globalErrorHandler);
    return app;
  }
  const post = (app: express.Express, path: string, who: string, field: string, n: number, ip = '203.0.113.7') =>
    request(app).post(path).set('Authorization', `Bearer good-${who}`).set('X-Forwarded-For', ip).send({ [field]: Array(n).fill({}) });

  it(`caps one IP at ${IP_POSTING_BUDGET_PER_MIN} items a minute across routes and wallets, each under its own budget`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(IP_POSTING_BUDGET_PER_MIN).toBe(600);
    const app = ceilingApp();
    // Ten wallets, 60 items each, split between two families: 600 in all.
    for (let i = 0; i < 10; i++) {
      expect((await post(app, '/api/v1/tasks/batch', wallet(300 + i), 'tasks', 30)).status).toBe(200);
      expect((await post(app, '/api/v1/storage/upload-batch', wallet(300 + i), 'items', 30)).status).toBe(200);
    }
    const refused = await post(app, '/api/v1/tasks/batch', wallet(399), 'tasks', 1);
    expect(refused.status).toBe(429);
    expect(refused.body.error.message).toContain('from this network address');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // Another IP is not affected.
    expect((await post(app, '/api/v1/tasks/batch', wallet(399), 'tasks', 1, '198.51.100.9')).status).toBe(200);
  });

  it('refuses a wallet over its own budget without spending the IP ceiling', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const app = ceilingApp();
    expect((await post(app, '/api/v1/tasks/batch', wallet(500), 'tasks', 120)).status).toBe(200);
    for (let i = 0; i < 20; i++) {
      const res = await post(app, '/api/v1/tasks/batch', wallet(500), 'tasks', 50);
      expect(res.body.error.message).toContain('this wallet');
    }
    // 480 of the IP's 600 are still there for the other wallets behind it.
    expect((await post(app, '/api/v1/tasks/batch', wallet(501), 'tasks', 120)).status).toBe(200);
    expect((await post(app, '/api/v1/storage/upload-batch', wallet(502), 'items', 120)).status).toBe(200);
    expect((await post(app, '/api/v1/storage/upload-batch', wallet(503), 'items', 120)).status).toBe(200);
    expect((await post(app, '/api/v1/tasks/batch', wallet(504), 'tasks', 120)).status).toBe(200);
    expect((await post(app, '/api/v1/tasks/batch', wallet(505), 'tasks', 1)).status).toBe(429);
  });
});

describe('bucket memory', () => {
  it('keeps at most maxBuckets, dropping the least recently used first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const budget = createWalletBudget({ name: 'task builds', perMinute: 5, maxBuckets: 3 });
    const app = express();
    app.post('/x', auth, budget, (_req, res) => { res.json({ success: true }); });
    const hit = (who: string) => request(app).post('/x').set('Authorization', `Bearer good-${who}`);
    for (let i = 0; i < 5; i++) await hit('a');
    expect((await hit('a')).status).toBe(429);
    // b, c, d: four buckets for a cap of three, so a, the least recently used, goes.
    await hit('b');
    await hit('c');
    await hit('d');
    expect((await hit('a')).status).toBe(200);
  });

  it('keeps a bucket in use over older ones', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const budget = createWalletBudget({ name: 'task builds', perMinute: 5, maxBuckets: 3 });
    const app = express();
    app.post('/x', auth, budget, (_req, res) => { res.json({ success: true }); });
    const hit = (who: string) => request(app).post('/x').set('Authorization', `Bearer good-${who}`);
    for (let i = 0; i < 5; i++) await hit('a');
    await hit('b');
    await hit('c');
    expect((await hit('a')).status).toBe(429); // a is now the most recently used
    await hit('d'); // evicts b, the least recently used
    expect((await hit('a')).status).toBe(429);
  });
});

describe('isCredentialedPosting', () => {
  const req = (method: string, path: string, headers: Record<string, string> = { authorization: 'Bearer x' }) =>
    ({ method, baseUrl: '', path, headers }) as any;

  it.each([
    '/api/v1/tasks', '/api/v1/tasks/batch', '/api/v1/a2a/tasks/index', '/api/v1/a2a/tasks/index-batch',
    '/api/v1/storage/upload', '/api/v1/storage/upload-batch', '/API/V1/Tasks/', '/api/v1/tasks/batch//',
  ])('matches POST %s with credentials', (path) => {
    expect(isCredentialedPosting(req('POST', path))).toBe(true);
    expect(isCredentialedPosting(req('POST', path, { 'x-api-key': 'sk_x' }))).toBe(true);
  });

  it.each([
    ['GET', '/api/v1/tasks', { authorization: 'Bearer x' }],
    ['POST', '/api/v1/tasks/1/cancel', { authorization: 'Bearer x' }],
    ['POST', '/api/v1/tasks', {}],
    ['POST', '/api/v1/tasks', { authorization: 'Bearer ' }],
    ['POST', '/api/v1/tasks', { authorization: 'Basic x' }],
  ])('does not match %s %s with %j', (method, path, headers) => {
    expect(isCredentialedPosting(req(method, path, headers as Record<string, string>))).toBe(false);
  });
});
