import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

/**
 * Hosted agents call the API from this server (BACKEND_URL is localhost), so
 * keyed by IP every agent shared one 100/min bucket. A request carrying a
 * verified agent platform token is now limited per agent; a forged, expired,
 * revoked or device-flow token, a Privy token and no token at all stay per
 * IP. Real tokens, signed as agentRunner signs them, through the real
 * verifyRegistrationToken; Redis (the revocation list) is stubbed.
 *
 * Run: npx vitest run src/middleware/rateLimit.hostedAgents.test.ts
 */

const SECRET = vi.hoisted(() => {
  process.env.JWT_SECRET = 'rate-limit-test-secret';
  return 'rate-limit-test-secret';
});
const revoked = vi.hoisted(() => new Set<string>());
vi.mock('../services/redis.js', () => ({
  redis: { get: vi.fn(async (key: string) => (revoked.has(key.replace('revoked:jwt:', '')) ? '1' : null)) },
}));
vi.mock('../services/apiKeyStore.js', () => ({ lookupApiKey: vi.fn(async () => null) }));

const {
  AGENT_REQUESTS_PER_MIN,
  IP_POSTING_BUDGET_PER_MIN,
  createPostingAuthLimiter,
  createPostingIpBudget,
  createRateLimiter,
  hostedAgentOf,
} = await import('./rateLimit.js');
const { AppError, globalErrorHandler } = await import('./errorHandler.js');

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const OWNER = wallet(0xabc);

/** A worker token, claims as agentRunner mints them. */
function platformToken(address: string, { secret = SECRET, expiresIn = '365d' as string | number, typ = 'agent-platform', jti = randomUUID() } = {}) {
  return jwt.sign({ address, ownerAddress: OWNER, agentName: 'a', jti, typ }, secret, { algorithm: 'HS256', expiresIn } as jwt.SignOptions);
}

/** The global limiter as index.ts mounts it, in front of a route with no auth of its own. */
function makeApp() {
  const app = express();
  app.use(createRateLimiter());
  app.get('/api/v1/a2a/tasks', (_req, res) => { res.json({ success: true }); });
  app.use(globalErrorHandler);
  return app;
}

const get = (app: express.Express, token?: string) => {
  const r = request(app).get('/api/v1/a2a/tasks');
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};

/** Sends `n` requests one after another, returning their statuses. */
async function send(n: number, one: () => request.Test): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await one()).status);
  return statuses;
}

const count = (statuses: number[], status: number) => statuses.filter((s) => s === status).length;

beforeEach(() => {
  revoked.clear();
});

describe('hosted agents on the global limiter', () => {
  it('gives each agent its own bucket: 3 agents behind one IP send 300 requests, three times the per-IP limit', async () => {
    const app = makeApp();
    for (const n of [1, 2, 3]) {
      const token = platformToken(wallet(n));
      expect(count(await send(100, () => get(app, token)), 200)).toBe(100);
    }
  });

  it('limits each agent on its own, at AGENT_REQUESTS_PER_MIN', async () => {
    const app = makeApp();
    const a = platformToken(wallet(1));
    const b = platformToken(wallet(2));
    expect(count(await send(AGENT_REQUESTS_PER_MIN, () => get(app, a)), 200)).toBe(AGENT_REQUESTS_PER_MIN);
    const refused = await get(app, a);
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMIT');
    expect(refused.headers['ratelimit-limit']).toBe(String(AGENT_REQUESTS_PER_MIN));
    // Another agent, and the IP itself, are untouched by a's spending.
    expect((await get(app, b)).status).toBe(200);
    expect((await get(app)).status).toBe(200);
  });

  it("keys an agent by its wallet: a rotated token keeps the agent's bucket", async () => {
    const app = makeApp();
    await send(AGENT_REQUESTS_PER_MIN, () => get(app, platformToken(wallet(5))));
    expect((await get(app, platformToken(wallet(5)))).status).toBe(429);
  });

  it("does not count an agent's requests toward its IP's 100", async () => {
    const app = makeApp();
    await send(150, () => get(app, platformToken(wallet(6))));
    expect(count(await send(100, () => get(app)), 200)).toBe(100);
    expect((await get(app)).status).toBe(429);
  });
});

describe('tokens that are not a verified platform token stay per IP', () => {
  // Each request carries a different token, so a token that bought its own
  // bucket would never be refused.
  const cases: Array<[string, () => string]> = [
    ['forged (wrong signing key)', () => platformToken(wallet(Math.floor(Math.random() * 1e9)), { secret: 'not-the-secret' })],
    ['expired', () => platformToken(wallet(Math.floor(Math.random() * 1e9)), { expiresIn: -60 })],
    ['device-flow (typ agent-registration)', () => platformToken(wallet(Math.floor(Math.random() * 1e9)), { typ: 'agent-registration' })],
    ['a Privy-style token', () => `eyJhbGciOiJFUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: 'did:privy:x', typ: 'agent-platform' })).toString('base64url')}.sig`],
    ['not a JWT', () => `garbage-${randomUUID()}`],
  ];
  for (const [name, token] of cases) {
    it(`${name}: refused at the IP's 100th request`, async () => {
      const app = makeApp();
      const statuses = await send(101, () => get(app, token()));
      expect(count(statuses, 200)).toBe(100);
      expect(statuses[100]).toBe(429);
    });
  }

  it('revoked: refused at the IP\'s 100th request', async () => {
    const app = makeApp();
    const statuses = await send(101, () => {
      const jti = randomUUID();
      revoked.add(jti);
      return get(app, platformToken(wallet(Math.floor(Math.random() * 1e9)), { jti }));
    });
    expect(count(statuses, 200)).toBe(100);
    expect(statuses[100]).toBe(429);
  });

  it('a revoked token loses its bucket at the next request', async () => {
    const jti = randomUUID();
    const token = platformToken(wallet(7), { jti });
    const req = { headers: { authorization: `Bearer ${token}` } } as express.Request;
    expect(await hostedAgentOf(req)).toBe(wallet(7));
    revoked.add(jti);
    expect(await hostedAgentOf({ headers: { authorization: `Bearer ${token}` } } as express.Request)).toBeNull();
  });
});

describe('users and unauthenticated traffic are unchanged', () => {
  it('limits an IP with no token at 100 a minute, with the same 429 body and headers', async () => {
    const app = makeApp();
    const statuses = await send(100, () => get(app));
    expect(count(statuses, 200)).toBe(100);
    const refused = await get(app);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ success: false, error: { code: 'RATE_LIMIT', message: 'Too many requests, please try again later' } });
    expect(refused.headers['ratelimit-limit']).toBe('100');
  });

  it('counts a logged-in user (a non-platform Bearer token) against their IP', async () => {
    const app = makeApp();
    await send(60, () => get(app, 'privy-session-token'));
    await send(40, () => get(app));
    expect((await get(app, 'privy-session-token')).status).toBe(429);
  });
});

describe('posting routes and hosted agents', () => {
  /** createPostingAuthLimiter in index.ts order, in front of a requireAuth stand-in that fails every call. */
  function postingApp() {
    const app = express();
    app.use(createRateLimiter());
    app.use(createPostingAuthLimiter());
    app.post('/api/v1/storage/upload', (_req, _res, next) => next(new AppError(401, 'INVALID_TOKEN', 'Invalid or expired token')));
    app.use(globalErrorHandler);
    return app;
  }
  const upload = (app: express.Express, token: string) =>
    request(app).post('/api/v1/storage/upload').set('Authorization', `Bearer ${token}`).send({});

  it('keeps the per-IP limit on posting calls whose credentials fail', async () => {
    const app = postingApp();
    const statuses = await send(101, () => upload(app, platformToken(wallet(Math.floor(Math.random() * 1e9)), { secret: 'not-the-secret' })));
    expect(count(statuses, 401)).toBe(100);
    expect(statuses[100]).toBe(429);
  });

  it("does not count a hosted agent's posting calls toward that limit", async () => {
    const app = postingApp();
    const statuses = await send(150, () => upload(app, platformToken(wallet(Math.floor(Math.random() * 1e9)))));
    expect(count(statuses, 429)).toBe(0);
  });

  /** The posting ceiling behind a stand-in requireAuth that attaches `user` from the test. */
  function ceilingApp() {
    const app = express();
    app.use(express.json());
    const ceiling = createPostingIpBudget();
    app.post('/api/v1/storage/upload-batch', (req, _res, next) => {
      (req as { user?: unknown }).user = req.body.user;
      next();
    }, ceiling, (_req, res) => { res.json({ success: true }); });
    app.use(globalErrorHandler);
    return app;
  }
  const batch = (app: express.Express, user: object, n: number) =>
    request(app).post('/api/v1/storage/upload-batch').send({ user, items: Array(n).fill({}) });

  it("caps a hosted agent owner's agents together, not the server's address", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const app = ceilingApp();
      const agentOf = (owner: string, n: number) => ({ address: wallet(n), ownerAddress: owner, typ: 'agent-platform' });
      // One owner's agents spend that owner's ceiling between them.
      expect((await batch(app, agentOf(wallet(0x100), 1), IP_POSTING_BUDGET_PER_MIN / 2)).status).toBe(200);
      expect((await batch(app, agentOf(wallet(0x100), 2), IP_POSTING_BUDGET_PER_MIN / 2)).status).toBe(200);
      const refused = await batch(app, agentOf(wallet(0x100), 3), 1);
      expect(refused.status).toBe(429);
      expect(refused.body.error.message).toContain("this owner's hosted agents");
      // Another owner's agents and a user behind the same IP are not refused.
      expect((await batch(app, agentOf(wallet(0x200), 4), IP_POSTING_BUDGET_PER_MIN)).status).toBe(200);
      expect((await batch(app, { address: wallet(9) }, IP_POSTING_BUDGET_PER_MIN)).status).toBe(200);
      const user = await batch(app, { address: wallet(10) }, 1);
      expect(user.status).toBe(429);
      expect(user.body.error.message).toContain('from this network address');
    } finally {
      vi.useRealTimers();
    }
  });
});
