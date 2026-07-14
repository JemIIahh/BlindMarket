import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Integration test for POST /api/v1/a2a/tasks/:id/accept — specifically the
 * key-custody self-heal branch and the regression-critical paths around it
 * (docs/TEE-REWRAP-SPEC.md §5.2). We mount the REAL a2aRouter so route wiring,
 * status codes, and the response shape are exercised; only the store, custody,
 * settlement, and auth modules are mocked so the test drives pure handler
 * logic with no Redis / chain / Privy.
 *
 * The matrix:
 *   1. own-slice fast path (custody off)        → 200, returns post-time slice, no rewrap
 *   2. encrypted + no slice + custody OFF        → 403 NEEDS_WRAP, CAS never runs  (production default)
 *   3. self-heal win (custody on)                → 200, rewrap → slice, merge + settle
 *   4. CAS loser (custody on)                    → 409, NO key, no rewrap, no settle
 *   5. rewrap failure (custody on)               → 503, task released, no settle
 *
 * Plus the batch-4 gates: rotated custody key (403 NEEDS_WRAP before the CAS,
 * never reaches rewrap) and the pre-CAS deadline check (409 TASK_EXPIRED;
 * terminal tryExpire only past the grace window).
 */

// ── Mocks (hoisted by vitest above the imports below) ────────────────────────

vi.mock('../middleware/auth.js', () => ({
  // Inject the authenticated address from a header so each request can pick its
  // caller. Bypasses Privy/JWT entirely.
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || '0xagent' };
    next();
  },
}));

vi.mock('../services/a2aStore.js', () => ({
  getMeta: vi.fn(),
  tryAccept: vi.fn(),
  mergeWrappedKeys: vi.fn(),
  releaseToOpen: vi.fn(),
  setMeta: vi.fn(),
  getState: vi.fn(),
  updateState: vi.fn(),
  getPosterTasks: vi.fn(),
  getExecutorTasks: vi.fn(),
  browseAgentTasks: vi.fn(),
  getIndexedHashes: vi.fn(),
  // Offer ops — default to "no offer" so existing tests pass unchanged
  getOffer: vi.fn(() => Promise.resolve(undefined)),
  checkOffer: vi.fn(() => Promise.resolve(false)),
  clearOffer: vi.fn(() => Promise.resolve()),
  setOffer: vi.fn(() => Promise.resolve()),
  // Cascade ops
  clearCascade: vi.fn(() => Promise.resolve()),
  // Expiry ops (batch-4)
  tryExpire: vi.fn(() => Promise.resolve({ ok: true })),
  listOpenTasks: vi.fn(() => Promise.resolve([])),
  cacheDeadline: vi.fn(() => Promise.resolve()),
  getCachedDeadline: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn() }));

vi.mock('../services/keyCustodyService.js', () => ({
  getKeyCustodyService: vi.fn(() => null),
  isKeyCustodyEnabled: vi.fn(() => false),
}));

vi.mock('../services/a2aSettlement.js', () => ({
  settleAssignment: vi.fn(() => Promise.resolve({ success: true, txHash: '0xtx' })),
  // settleVerification now returns a SettleResult that /finalize and /verify
  // gate on — an undefined resolution would TypeError inside the route.
  settleVerification: vi.fn(() => Promise.resolve({ success: true, txHash: '0xtx' })),
}));

// Import-side-effect-heavy modules (Redis / chain / DB). Mock so importing the
// router is pure. /accept touches none of these, so minimal stubs suffice.
vi.mock('../services/redis.js', () => ({
  redis: { set: vi.fn(), get: vi.fn(), exists: vi.fn(), pipeline: vi.fn() },
}));
vi.mock('../services/chain.js', () => ({
  provider: {},
  escrow: { interface: {}, getAddress: vi.fn() },
}));
vi.mock('../services/escrow.js', () => ({ getTask: vi.fn(), feeBps: vi.fn(), getTaskVerifier: vi.fn() }));
vi.mock('../services/escrowEvents.js', () => ({
  getTaskIdByHash: vi.fn(),
  getCachedTaskIdByHash: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../services/autoVerify.js', () => ({ autoVerify: vi.fn() }));
vi.mock('../services/accountingService.js', () => ({}));
vi.mock('../services/reputation.js', () => ({}));
vi.mock('../services/reputationDecay.js', () => ({}));
vi.mock('../services/bidsStore.js', () => ({}));

import { a2aRouter } from './a2a.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as a2aStore from '../services/a2aStore.js';
import * as agentStore from '../services/agentStore.js';
import * as keyCustody from '../services/keyCustodyService.js';
import { settleAssignment } from '../services/a2aSettlement.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const AGENT = '0xagent0000000000000000000000000000000001'; // lowercase: matches addrLc lookups
const TASK = '0xtaskhash';
const PUBKEY = '04' + 'ab'.repeat(64); // 130-char uncompressed secp256k1 hex
const ROOT = '0xroot';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return a;
}

function accept() {
  return request(app()).post(`/api/v1/a2a/tasks/${TASK}/accept`).set('x-test-address', AGENT);
}

/** A registered, capability-passing agent record. */
function agentRecord(overrides: Partial<any> = {}) {
  return { address: AGENT, capabilities: [], publicKey: PUBKEY, reputation: 50, tasksCompleted: 0, registeredAt: '', displayName: 'a', ...overrides };
}

/** Task meta with no capability gate. Pass rootHash/wrappedKeys/keyCustodyBlob per case. */
function meta(overrides: Partial<any> = {}) {
  return { taskId: TASK, requiredCapabilities: [], ...overrides };
}

/**
 * A mock custody service whose rewrap returns `slice` (or throws if `fail`).
 * activeKeyId defaults to the fixtures' blob keyId ('kid') so canSelfHeal's
 * active-key check passes; pass a different id to simulate a rotated key.
 */
function custody(slice: string, fail = false, activeKeyId = 'kid') {
  return {
    getActiveKey: vi.fn(() => Promise.resolve({ keyId: activeKeyId, publicKey: '04' + '00'.repeat(64) })),
    getAttestation: vi.fn(),
    rewrap: fail
      ? vi.fn(() => Promise.reject(new Error('boom')))
      : vi.fn(() => Promise.resolve(slice)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-establish the default: custody disabled. Custody tests override.
  vi.mocked(keyCustody.getKeyCustodyService).mockReturnValue(null);
  vi.mocked(agentStore.getAgent).mockResolvedValue(agentRecord() as any);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /accept — key custody', () => {
  it('1) own-slice fast path: returns the post-time slice, no re-wrap, custody off', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ rootHash: ROOT, wrappedKeys: { [AGENT]: 'deadbeef' } }) as any,
    );
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);

    const res = await accept();

    expect(res.status).toBe(200);
    expect(res.body.data.wrappedKey).toBe('deadbeef');
    expect(res.body.data.rootHash).toBe(ROOT);
    expect(settleAssignment).toHaveBeenCalledWith(TASK, AGENT);
    expect(a2aStore.mergeWrappedKeys).not.toHaveBeenCalled();
  });

  it('2) encrypted + no slice + custody OFF: 403 NEEDS_WRAP before the CAS (production default)', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue(meta({ rootHash: ROOT, wrappedKeys: {} }) as any);

    const res = await accept();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NEEDS_WRAP');
    expect(a2aStore.tryAccept).not.toHaveBeenCalled(); // never burned the transition
    expect(settleAssignment).not.toHaveBeenCalled();
  });

  it('3) self-heal win: re-wraps from custody, persists slice, settles', async () => {
    const svc = custody('reslice');
    vi.mocked(keyCustody.getKeyCustodyService).mockReturnValue(svc as any);
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ rootHash: ROOT, wrappedKeys: {}, keyCustodyBlob: { keyId: 'kid', blob: 'abcd' } }) as any,
    );
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);

    const res = await accept();

    expect(res.status).toBe(200);
    expect(res.body.data.wrappedKey).toBe('reslice');
    expect(svc.rewrap).toHaveBeenCalledWith('kid', 'abcd', PUBKEY);
    expect(a2aStore.mergeWrappedKeys).toHaveBeenCalledWith(TASK, { [AGENT]: 'reslice' });
    expect(settleAssignment).toHaveBeenCalledWith(TASK, AGENT);
  });

  it('4) CAS loser gets nothing: 409, no re-wrap, no settle', async () => {
    const svc = custody('reslice');
    vi.mocked(keyCustody.getKeyCustodyService).mockReturnValue(svc as any);
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ rootHash: ROOT, wrappedKeys: {}, keyCustodyBlob: { keyId: 'kid', blob: 'abcd' } }) as any,
    );
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: false, currentStatus: 'accepted' } as any);

    const res = await accept();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_OPEN');
    expect(svc.rewrap).not.toHaveBeenCalled(); // no decryption-oracle for losers
    expect(a2aStore.mergeWrappedKeys).not.toHaveBeenCalled();
    expect(settleAssignment).not.toHaveBeenCalled();
  });

  it('5) re-wrap failure: releases the task, 503, never settles on chain', async () => {
    const svc = custody('reslice', /* fail */ true);
    vi.mocked(keyCustody.getKeyCustodyService).mockReturnValue(svc as any);
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ rootHash: ROOT, wrappedKeys: {}, keyCustodyBlob: { keyId: 'kid', blob: 'abcd' } }) as any,
    );
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);

    const res = await accept();

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('REWRAP_FAILED');
    expect(a2aStore.releaseToOpen).toHaveBeenCalledWith(TASK);
    expect(settleAssignment).not.toHaveBeenCalled(); // no undecryptable worker on chain
  });

  it('keyless agent cannot self-heal: 403 NEEDS_WRAP before the CAS', async () => {
    const svc = custody('reslice');
    vi.mocked(keyCustody.getKeyCustodyService).mockReturnValue(svc as any);
    vi.mocked(agentStore.getAgent).mockResolvedValue(agentRecord({ publicKey: undefined }) as any);
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ rootHash: ROOT, wrappedKeys: {}, keyCustodyBlob: { keyId: 'kid', blob: 'abcd' } }) as any,
    );

    const res = await accept();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NEEDS_WRAP');
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
    expect(svc.rewrap).not.toHaveBeenCalled();
  });

  it('rotated custody key: 403 NEEDS_WRAP before the CAS — never wins the CAS just to fail rewrap', async () => {
    // Blob sealed to 'kid', but the live custody key is 'newkid'. Pre-batch-4
    // this passed canSelfHeal, won the CAS, threw inside rewrap, released, and
    // bounced open↔accepted forever.
    const svc = custody('reslice', false, 'newkid');
    vi.mocked(keyCustody.getKeyCustodyService).mockReturnValue(svc as any);
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ rootHash: ROOT, wrappedKeys: {}, keyCustodyBlob: { keyId: 'kid', blob: 'abcd' } }) as any,
    );

    const res = await accept();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NEEDS_WRAP');
    expect(res.body.error.message).toContain('rotated');
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
    expect(svc.rewrap).not.toHaveBeenCalled();
    expect(a2aStore.releaseToOpen).not.toHaveBeenCalled();
  });

  it('custody backend read failure is NOT diagnosed as rotation: generic NEEDS_WRAP message', async () => {
    const svc = custody('reslice');
    svc.getActiveKey = vi.fn(() => Promise.reject(new Error('custody backend down')));
    vi.mocked(keyCustody.getKeyCustodyService).mockReturnValue(svc as any);
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ rootHash: ROOT, wrappedKeys: {}, keyCustodyBlob: { keyId: 'kid', blob: 'abcd' } }) as any,
    );

    const res = await accept();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NEEDS_WRAP');
    expect(res.body.error.message).not.toContain('rotated'); // don't tell the poster to cancel/repost on a blip
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
  });
});

// ── Security closeout: self-accept + settlement worker-match ─────────────────
describe('POST /accept — self-accept + settlement worker-match', () => {
  it('poster cannot execute own task: 403 SELF_ACCEPT before the CAS', async () => {
    // posterAddress equals the caller — would let one wallet wash-trade
    // reputation + recycle its own escrow. Refuse before any state change.
    vi.mocked(a2aStore.getMeta).mockResolvedValue(meta({ posterAddress: AGENT }) as any);

    const res = await accept();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SELF_ACCEPT');
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
    expect(settleAssignment).not.toHaveBeenCalled();
  });

  it('on-chain assigned to a DIFFERENT worker: 409 ASSIGNED_ELSEWHERE, no key, reconciles to chain truth', async () => {
    const OTHER = '0xother00000000000000000000000000000000ff';
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ rootHash: ROOT, wrappedKeys: { [AGENT]: 'deadbeef' } }) as any,
    );
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);
    vi.mocked(settleAssignment).mockResolvedValueOnce({
      success: false, workerMismatch: true, onChainWorker: OTHER,
    } as any);

    const res = await accept();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ASSIGNED_ELSEWHERE');
    expect(res.body.data?.wrappedKey).toBeUndefined(); // no key material to a refused poacher
    // Reconciles executorAddress to the real on-chain worker (updateState then
    // moves the executor index off the refused caller). NOT released — that
    // would bounce every future /accept off the same revert.
    expect(a2aStore.updateState).toHaveBeenCalledWith(TASK, { executorAddress: OTHER });
    expect(a2aStore.releaseToOpen).not.toHaveBeenCalled();
  });

  it('cancelled on-chain (no worker): 409 TASK_CANCELLED, closed off-chain, not reconciled to 0x0', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ rootHash: ROOT, wrappedKeys: { [AGENT]: 'deadbeef' } }) as any,
    );
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);
    vi.mocked(settleAssignment).mockResolvedValueOnce({ success: false, cancelled: true } as any);

    const res = await accept();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_CANCELLED');
    expect(a2aStore.updateState).toHaveBeenCalledWith(
      TASK, { status: 'failed', failedReason: 'cancelled', executorAddress: undefined },
    );
    expect(a2aStore.releaseToOpen).not.toHaveBeenCalled();
  });
});

// ── Deadline pre-check (batch-4) ─────────────────────────────────────────────
//
// The authoritative deadline gate is on-chain (marketplaceAssign reverts
// DeadlineReached); this pre-CAS check just refuses early so expired tasks
// don't burn the open→accepted CAS plus a settle round-trip. The terminal
// off-chain close (tryExpire) only fires past the grace window so server-clock
// drift can never close a task the contract would still assign.
describe('POST /accept — deadline pre-check', () => {
  it('expired beyond grace: 409 TASK_EXPIRED, task closed, CAS never runs', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ deadline: Math.floor(Date.now() / 1000) - 120 }) as any, // grace is 60s
    );

    const res = await accept();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_EXPIRED');
    expect(a2aStore.tryExpire).toHaveBeenCalledWith(TASK, 'expired');
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
    expect(settleAssignment).not.toHaveBeenCalled();
  });

  it('expired but inside grace: 409 refusal WITHOUT the terminal close (clock-drift safety)', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ deadline: Math.floor(Date.now() / 1000) - 10 }) as any,
    );

    const res = await accept();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_EXPIRED');
    expect(a2aStore.tryExpire).not.toHaveBeenCalled();
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
  });

  it('future deadline: flows through to a normal 200 accept', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ deadline: Math.floor(Date.now() / 1000) + 3600 }) as any,
    );
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);

    const res = await accept();

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('accepted');
    expect(a2aStore.tryExpire).not.toHaveBeenCalled();
    expect(settleAssignment).toHaveBeenCalledWith(TASK, AGENT);
  });
});

// ── Capability gate (superset / ALL-of match) ──────────────────────────────
//
// Regression guard for the ANY-match -> superset-match flip (a2a.ts accept
// gate). The key-custody suite above uses requiredCapabilities:[], which
// short-circuits the gate (a2a.ts: `if (meta.requiredCapabilities.length > 0)`)
// and therefore provides ZERO coverage of the predicate — it would pass under
// BOTH some() and every(). These cases drive the predicate directly. We use
// tasks with NO rootHash so the handler skips the NEEDS_WRAP / custody branch
// and the capability decision alone determines the outcome.
describe('POST /accept — capability gate (superset match)', () => {
  it('partial overlap is REJECTED: agent has one of two required caps → 403 CAPABILITY_MISMATCH', async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(
      agentRecord({ capabilities: ['data_processing'] }) as any,
    );
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ requiredCapabilities: ['data_processing', 'code_execution'] }) as any,
    );

    const res = await accept();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CAPABILITY_MISMATCH');
    expect(a2aStore.tryAccept).not.toHaveBeenCalled(); // gated before the CAS
    expect(settleAssignment).not.toHaveBeenCalled();
  });

  it('disjoint caps are REJECTED: 403 CAPABILITY_MISMATCH', async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(
      agentRecord({ capabilities: ['translation'] }) as any,
    );
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ requiredCapabilities: ['data_processing', 'code_execution'] }) as any,
    );

    const res = await accept();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CAPABILITY_MISMATCH');
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
  });

  it('superset is ACCEPTED: agent has all required caps plus extras → 200', async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(
      agentRecord({ capabilities: ['data_processing', 'code_execution', 'translation'] }) as any,
    );
    // No rootHash → skips NEEDS_WRAP/custody; the capability gate is the only filter.
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ requiredCapabilities: ['data_processing', 'code_execution'] }) as any,
    );
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);

    const res = await accept();

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('accepted');
    expect(settleAssignment).toHaveBeenCalledWith(TASK, AGENT);
  });

  it('exact match is ACCEPTED: agent caps equal required caps → 200', async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(
      agentRecord({ capabilities: ['data_processing', 'code_execution'] }) as any,
    );
    vi.mocked(a2aStore.getMeta).mockResolvedValue(
      meta({ requiredCapabilities: ['data_processing', 'code_execution'] }) as any,
    );
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);

    const res = await accept();

    expect(res.status).toBe(200);
    expect(settleAssignment).toHaveBeenCalledWith(TASK, AGENT);
  });
});

// ── Pinned target executor (rent-your-agent Phase 2 "Use now") ──────────────
//
// A per-call "Use now" invocation pins the task to one agent (meta.targetExecutor)
// so only that agent can execute it. The gate runs after the registration check
// and before the CAS. No rootHash → skips the wrap gate so the pin alone decides.
describe('POST /accept — pinned target executor', () => {
  it('non-target caller is REJECTED: 403 NOT_TARGET_EXECUTOR before the CAS', async () => {
    const OTHER = '0xother00000000000000000000000000000000ff';
    vi.mocked(a2aStore.getMeta).mockResolvedValue(meta({ targetExecutor: OTHER }) as any);

    const res = await accept();

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_TARGET_EXECUTOR');
    expect(a2aStore.tryAccept).not.toHaveBeenCalled(); // gated before the CAS
    expect(settleAssignment).not.toHaveBeenCalled();
  });

  it('the pinned target is ACCEPTED: 200', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue(meta({ targetExecutor: AGENT }) as any);
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);

    const res = await accept();

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('accepted');
    expect(settleAssignment).toHaveBeenCalledWith(TASK, AGENT);
  });
});
