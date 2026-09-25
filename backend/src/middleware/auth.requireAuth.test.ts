import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * An unknown API key sent as X-API-Key used to answer 500 AUTH_ERROR: the 401
 * requireAuth throws inside its promise chain landed in the chain's catch,
 * which wrapped every error as a 500. A client can't tell "wrong key" from
 * "server broken" that way. Only a genuine lookup failure is a 500.
 */

// A plain function in front of the spy: a rejection returned straight from a
// vi.fn implementation is reported against the test by vitest even though
// requireAuth handles it, so the failure case bypasses the spy.
const lookup = vi.hoisted(() => ({ fn: vi.fn(), failWith: null as Error | null }));
vi.mock('../services/apiKeyStore.js', () => ({
  lookupApiKey: (...args: unknown[]) => (lookup.failWith ? Promise.reject(lookup.failWith) : lookup.fn(...args)),
}));
vi.mock('../services/redis.js', () => ({ redis: { get: vi.fn(async () => null), exists: vi.fn(async () => 0) } }));

const { requireAuth } = await import('./auth.js');
const { globalErrorHandler } = await import('./errorHandler.js');

function app() {
  const a = express();
  a.get('/private', requireAuth, (req, res) => res.json({ success: true, data: { address: (req as { user?: { address: string } }).user?.address } }));
  a.use(globalErrorHandler);
  return a;
}

beforeEach(() => {
  lookup.fn.mockReset();
  lookup.failWith = null;
});

describe('requireAuth with X-API-Key', () => {
  it('answers 401 UNAUTHORIZED for an unknown key', async () => {
    lookup.fn.mockResolvedValue(null);
    const res = await request(app()).get('/private').set('X-API-Key', 'sk_unknown');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('lets a known key through as its owner', async () => {
    lookup.fn.mockResolvedValue({ ownerAddress: '0x1111111111111111111111111111111111111111' });
    const res = await request(app()).get('/private').set('X-API-Key', 'sk_known');
    expect(res.status).toBe(200);
    expect(res.body.data.address).toBe('0x1111111111111111111111111111111111111111');
  });

  it('still answers 500 AUTH_ERROR when the key lookup itself fails', async () => {
    lookup.failWith = new Error('database unreachable');
    const res = await request(app()).get('/private').set('X-API-Key', 'sk_any');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('AUTH_ERROR');
  });
});

describe('requireAuth hides infrastructure errors (audit run 1, C23)', () => {
  it('a failed key lookup names no database host, and the original is logged', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    lookup.failWith = new Error('getaddrinfo EAI_AGAIN ep-dummy-fixture-000000-pooler.us-east-2.aws.neon.tech');
    const res = await request(app()).get('/private').set('X-API-Key', 'sk_any');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('AUTH_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('neon.tech');
    expect(error.mock.calls.flat().map(String).join(' ')).toContain('neon.tech');
    error.mockRestore();
  });
});
