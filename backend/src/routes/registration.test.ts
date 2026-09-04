import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { ethers } from 'ethers';

/**
 * Integration tests for the registration device-flow write routes
 * (POST /session, POST /confirm/:token) and the trust chain that consumes
 * their tokens (verifyRegistrationToken / requireFounder in middleware/auth.ts).
 *
 * Structural pattern borrowed from routes/a2a.accept.test.ts: mount the REAL
 * routers so route wiring, status codes, and the response shape are exercised;
 * only redis and config are mocked, so the tests drive real signature
 * verification and real JWT minting/checking with no actual Redis.
 *
 * Case 1 and case 4 are the security regressions this plan (007) fixes —
 * both fail against the pre-fix code.
 */

// ── Mocks (hoisted by vitest above the imports below) ────────────────────────

// In-memory fake Redis so the /session -> /confirm flow round-trips for real
// within a test, instead of stubbing each call with canned return values.
// JWT_SECRET lives here too — vi.mock factories are hoisted above ALL
// top-level code, so anything they reference must be hoisted alongside them.
const { store, JWT_SECRET } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  JWT_SECRET: 'test-registration-secret',
}));

vi.mock('../services/redis.js', () => ({
  redis: {
    get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: vi.fn((k: string, v: string) => { store.set(k, v); return Promise.resolve('OK'); }),
  },
}));

vi.mock('../config.js', () => ({
  config: {
    registrationEnabled: true,
    jwtSecret: JWT_SECRET,
    corsOrigin: ['http://localhost:5173'],
  },
}));

vi.mock('../services/apiKeyStore.js', () => ({
  lookupApiKey: vi.fn(() => Promise.resolve(null)),
}));

import { registrationRouter, agentRegistrationMessage } from './registration.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireFounder, verifyRegistrationToken } from '../middleware/auth.js';
import type { AuthRequest } from '../types.js';

// ── Test app ─────────────────────────────────────────────────────────────────

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/registration', registrationRouter);

  // A minimal founder-gated route standing in for /admin/* etc., so the
  // trust chain (requireAuth -> requireFounder) is exercised end-to-end
  // exactly as it runs in production.
  const protectedRouter = Router();
  protectedRouter.get('/protected', requireAuth, requireFounder, (_req: AuthRequest, res) => {
    res.json({ success: true, data: { ok: true } });
  });
  a.use('/test', protectedRouter);

  a.use(globalErrorHandler);
  return a;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Confirm message — must stay byte-identical to registration.ts:146. */
function confirmMessage(agentName: string, agentWallet: string, token: string): string {
  return `Register agent "${agentName}" (${agentWallet}) to BlindMarket.\n\nToken: ${token}`;
}

async function openSession(opts: {
  agentName: string;
  agentWallet: ethers.HDNodeWallet;
  agentPublicKey?: string;
  signer?: ethers.HDNodeWallet;
}) {
  const signer = opts.signer ?? opts.agentWallet;
  const agentPublicKey = opts.agentPublicKey ?? opts.agentWallet.publicKey;
  const agentSignature = await signer.signMessage(
    agentRegistrationMessage(opts.agentName, opts.agentWallet.address, agentPublicKey),
  );
  return request(app()).post('/api/v1/registration/session').send({
    agentName: opts.agentName,
    agentWallet: opts.agentWallet.address,
    agentPublicKey,
    agentSignature,
  });
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  delete process.env.FOUNDER_ADDRESSES;
  delete process.env.REGISTRATION_TOKEN_MIN_IAT;
});

afterEach(() => {
  delete process.env.FOUNDER_ADDRESSES;
  delete process.env.REGISTRATION_TOKEN_MIN_IAT;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /registration/session — proof of control', () => {
  it('1) [regression] an agentWallet the caller cannot sign for is rejected: 401 INVALID_AGENT_SIGNATURE', async () => {
    const victim = ethers.Wallet.createRandom();
    const attacker = ethers.Wallet.createRandom();

    // Attacker names the victim's wallet as agentWallet but can only sign
    // with their own key — this is the exact bypass plan 007 closes.
    const res = await openSession({
      agentName: 'evil-agent',
      agentWallet: victim,
      signer: attacker,
    });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_AGENT_SIGNATURE');
    expect(store.size).toBe(0); // no session was ever persisted
  });

  it('2) a correctly signed session succeeds and returns a token', async () => {
    const wallet = ethers.Wallet.createRandom();

    const res = await openSession({ agentName: 'good-agent', agentWallet: wallet });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.token).toBe('string');
    expect(res.body.data.token.length).toBeGreaterThan(0);
    expect(res.body.data.url).toContain(res.body.data.token);
  });

  it('3) agentPublicKey that does not derive to agentWallet: 400 PUBKEY_MISMATCH', async () => {
    const wallet = ethers.Wallet.createRandom();
    const otherWallet = ethers.Wallet.createRandom();

    // wallet signs the challenge for itself (passes the signature check),
    // but the declared pubkey belongs to a different wallet entirely.
    const res = await openSession({
      agentName: 'mismatched-agent',
      agentWallet: wallet,
      agentPublicKey: otherWallet.publicKey,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PUBKEY_MISMATCH');
  });
});

describe('registration-minted tokens vs the founder gate', () => {
  it('4) [regression] a minted token carries typ: agent-registration, and requireFounder rejects it even when its address is a founder', async () => {
    const agentWallet = ethers.Wallet.createRandom();
    const ownerWallet = ethers.Wallet.createRandom();

    const sessionRes = await openSession({ agentName: 'founder-shaped-agent', agentWallet });
    expect(sessionRes.status).toBe(200);
    const { token } = sessionRes.body.data;

    const ownerSignature = await ownerWallet.signMessage(
      confirmMessage('founder-shaped-agent', agentWallet.address, token),
    );
    const confirmRes = await request(app())
      .post(`/api/v1/registration/confirm/${token}`)
      .send({ ownerAddress: ownerWallet.address, signature: ownerSignature });

    expect(confirmRes.status).toBe(200);
    const { apiKey } = confirmRes.body.data;

    // The minted token really does carry the issuer marker.
    const decoded = jwt.decode(apiKey) as Record<string, unknown>;
    expect(decoded.typ).toBe('agent-registration');
    expect(decoded.address).toBe(agentWallet.address);

    // Name this exact address as a founder — the privilege-escalation case.
    process.env.FOUNDER_ADDRESSES = agentWallet.address;

    const protectedRes = await request(app())
      .get('/test/protected')
      .set('Authorization', `Bearer ${apiKey}`);

    expect(protectedRes.status).toBe(403);
    expect(protectedRes.body.error.code).toBe('FORBIDDEN');
  });
});

describe('verifyRegistrationToken — REGISTRATION_TOKEN_MIN_IAT epoch', () => {
  it('5) a token issued before REGISTRATION_TOKEN_MIN_IAT is rejected', () => {
    const nowS = Math.floor(Date.now() / 1000);
    const oldIat = nowS - 100 * 24 * 60 * 60; // 100 days ago
    const minIat = nowS - 50 * 24 * 60 * 60; // revoke anything older than 50 days

    // exp = iat + 365d stays comfortably in the future, so this is rejected
    // specifically by the MIN_IAT check, not by ordinary jwt expiry.
    const token = jwt.sign(
      { address: '0xabc', ownerAddress: '0xdef', typ: 'agent-registration', iat: oldIat },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '365d' },
    );

    process.env.REGISTRATION_TOKEN_MIN_IAT = String(minIat);
    expect(verifyRegistrationToken(token)).toBeNull();

    // Sanity: the same token verifies fine with no epoch configured.
    delete process.env.REGISTRATION_TOKEN_MIN_IAT;
    expect(verifyRegistrationToken(token)).not.toBeNull();
  });
});
