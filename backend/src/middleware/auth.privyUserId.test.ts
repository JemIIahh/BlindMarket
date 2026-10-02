import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * A Privy session carries the user's id (a DID) in the access token's `sub`.
 * requireAuth puts it on req.user.privyUserId, which a deploy records on the
 * agent (per-person limits key on it later). Other principals have none.
 */

const verified = vi.hoisted(() => ({ payload: {} as Record<string, unknown> }));
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => 'jwks'),
  jwtVerify: vi.fn(async () => ({ payload: verified.payload })),
}));
vi.mock('../services/apiKeyStore.js', () => ({
  lookupApiKey: vi.fn(async (k: string) => (k === 'sk_known' ? { ownerAddress: '0x1111111111111111111111111111111111111111' } : null)),
}));
vi.mock('../services/redis.js', () => ({ redis: { get: vi.fn(async () => null), exists: vi.fn(async () => 0) } }));

const { requireAuth, privyUserIdOf } = await import('./auth.js');
const { globalErrorHandler } = await import('./errorHandler.js');

function app() {
  const a = express();
  a.get('/me', requireAuth, (req, res) => res.json({ data: (req as { user?: unknown }).user }));
  a.use(globalErrorHandler);
  return a;
}

const WALLET = '0x2222222222222222222222222222222222222222';

beforeEach(() => {
  // getJWKS probes Privy's JWKS URL once per process.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('privyUserIdOf', () => {
  it("reads a Privy DID from `sub`", () => {
    expect(privyUserIdOf({ sub: 'did:privy:cm0abc123' })).toBe('did:privy:cm0abc123');
  });

  it('ignores anything else', () => {
    expect(privyUserIdOf({ sub: WALLET })).toBeUndefined();
    expect(privyUserIdOf({ sub: 'did:web:example.com' })).toBeUndefined();
    expect(privyUserIdOf({ sub: 42 })).toBeUndefined();
    expect(privyUserIdOf({})).toBeUndefined();
    expect(privyUserIdOf({ sub: 'did:privy:' + 'x'.repeat(300) })).toBeUndefined();
  });
});

describe('requireAuth', () => {
  it('puts the Privy user id on req.user for a Privy session', async () => {
    verified.payload = { sub: 'did:privy:cm0abc123', wallet_address: WALLET };
    const res = await request(app()).get('/me').set('Authorization', 'Bearer privy.jwt.token');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ address: WALLET, privyUserId: 'did:privy:cm0abc123' });
  });

  it('sets none for an API key', async () => {
    const res = await request(app()).get('/me').set('X-API-Key', 'sk_known');
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('privyUserId');
  });
});
