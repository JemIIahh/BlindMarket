import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Oct 2026: Neon refused every query (plan quota, SQLSTATE 53000), and every
 * signed-in request answered 500 AUTH_ERROR, My Tasks included, though that
 * route only reads Redis. requireAuth tried the database API-key lookup first
 * for every bearer token. Only an `sk_` key can be an API key, so any other
 * token must authenticate without touching the database.
 *
 * The real requireAuth and lookupApiKey; the pool rejects as Neon did.
 *
 * Run: npx vitest run src/middleware/auth.databaseDown.test.ts
 */

const SECRET = vi.hoisted(() => {
  process.env.JWT_SECRET = 'database-down-test-secret';
  process.env.DATABASE_URL = 'postgres://fixture.invalid/db';
  return 'database-down-test-secret';
});
const pool = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock('../services/neonDb.js', () => ({ getPool: () => pool.getPool() }));
vi.mock('../services/redis.js', () => ({ redis: { get: vi.fn(async () => null) } }));

const { requireAuth } = await import('./auth.js');
const { globalErrorHandler } = await import('./errorHandler.js');
const { lookupApiKey } = await import('../services/apiKeyStore.js');

const WORKER = '0x2222222222222222222222222222222222222222';
const OWNER = '0x3333333333333333333333333333333333333333';

function app() {
  const a = express();
  a.get('/private', requireAuth, (req, res) => res.json({ success: true, data: { address: (req as { user?: { address: string } }).user?.address } }));
  a.use(globalErrorHandler);
  return a;
}

beforeEach(() => {
  pool.getPool.mockReset();
  pool.getPool.mockImplementation(async () => {
    throw Object.assign(new Error('Your account or project has exceeded the quota. Upgrade your plan to increase limits.'), { code: '53000' });
  });
});

describe('requireAuth while the database refuses queries', () => {
  it('lets a worker JWT through without querying the database', async () => {
    const token = jwt.sign({ address: WORKER, ownerAddress: OWNER, typ: 'agent-platform' }, SECRET, { algorithm: 'HS256' });
    const res = await request(app()).get('/private').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.address).toBe(WORKER);
    expect(pool.getPool).not.toHaveBeenCalled();
  });

  it('still answers 500 AUTH_ERROR for an sk_ key it cannot check', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app()).get('/private').set('X-API-Key', `sk_${'a'.repeat(64)}`);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('AUTH_ERROR');
    expect(pool.getPool).toHaveBeenCalledTimes(1);
  });
});

describe('lookupApiKey', () => {
  it('returns null for a non-sk_ value without querying the database', async () => {
    await expect(lookupApiKey('eyJhbGciOiJFUzI1NiJ9.e30.sig')).resolves.toBeNull();
    expect(pool.getPool).not.toHaveBeenCalled();
  });
});
