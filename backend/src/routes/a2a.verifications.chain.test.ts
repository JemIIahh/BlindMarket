import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /api/v1/a2a/verifications must tell a verifier agent WHICH chain each
 * pending task settles on, so its completeVerification tx is signed for and
 * broadcast to that escrow. Mounts the real a2aRouter with the store and
 * taskChain resolver mocked: one Base task, one 0G task, and one whose hash
 * cannot be resolved (chain: null — the worker then falls back to 0G).
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
  tryReleaseAccepted: vi.fn(() => Promise.resolve({ ok: true })),
  setMeta: vi.fn(),
  getState: vi.fn(),
  updateState: vi.fn(),
  getPosterTasks: vi.fn(),
  getExecutorTasks: vi.fn(),
  getVerifierTasks: vi.fn(),
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
  // Accept lock + attempt logging (Part 1)
  acquireAcceptLock: vi.fn(() => Promise.resolve(true)),
  releaseAcceptLock: vi.fn(() => Promise.resolve()),
  logAcceptAttempt: vi.fn(() => Promise.resolve()),
  getAcceptAttempts: vi.fn(() => Promise.resolve([])),
  // Gas-liveness (Part 3)
  startSettlementDeadline: vi.fn(() => Promise.resolve()),
  clearSettlementDeadline: vi.fn(() => Promise.resolve()),
  getSettlementDeadlineTTL: vi.fn(() => Promise.resolve(-2)),
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

vi.mock('../services/taskChain.js', () => ({
  resolveTaskByHash: vi.fn(),
  resolveTaskChainById: vi.fn(),
}));

import { a2aRouter } from './a2a.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as a2aStore from '../services/a2aStore.js';
import * as taskChain from '../services/taskChain.js';

/**
 * /verifications resolves each pending task's on-chain id so the verifier-role
 * worker can settle it itself. It used to keep only the id and drop the CHAIN
 * the resolver reported — so the worker settled every task against its 0G
 * escrow, and a Base task's numeric id would name an unrelated 0G task there.
 * The chain must travel with the id.
 */
const app = express();
app.use(express.json());
app.use('/api/v1/a2a', a2aRouter);
app.use(globalErrorHandler);

const VERIFIER = '0xverifier0000000000000000000000000000001';
const HASH_BASE = '0x' + 'ba'.repeat(32);
const HASH_OG = '0x' + '0a'.repeat(32);

const pending = (taskId: string) => ({
  meta: { taskId, posterAddress: '0xposter', verifierAddress: VERIFIER, requiredCapabilities: [] },
  state: { taskId, status: 'awaiting_verification', executorAddress: '0xexec' },
});

describe('GET /a2a/verifications — chain travels with the on-chain id', () => {
  beforeEach(() => {
    vi.mocked(a2aStore.getVerifierTasks).mockResolvedValue([pending(HASH_BASE), pending(HASH_OG)] as any);
    vi.mocked(taskChain.resolveTaskByHash).mockImplementation(async (h: string) =>
      h === HASH_BASE ? { taskId: '7', chain: 'base' } : { taskId: '7', chain: '0g' });
  });

  it('reports which chain holds each task alongside its id', async () => {
    const res = await request(app).get('/api/v1/a2a/verifications').set('x-test-address', VERIFIER);
    expect(res.status).toBe(200);
    const byHash = Object.fromEntries(res.body.data.verifications.map((v: any) => [v.meta.taskId, v]));
    // Same numeric id on both chains — only `chain` tells them apart.
    expect(byHash[HASH_BASE]).toMatchObject({ onChainId: '7', chain: 'base' });
    expect(byHash[HASH_OG]).toMatchObject({ onChainId: '7', chain: '0g' });
  });

  it('degrades to null id AND null chain when the hash is not indexed yet', async () => {
    vi.mocked(taskChain.resolveTaskByHash).mockResolvedValue(null);
    const res = await request(app).get('/api/v1/a2a/verifications').set('x-test-address', VERIFIER);
    for (const v of res.body.data.verifications) {
      expect(v.onChainId).toBeNull();
      expect(v.chain).toBeNull();
    }
  });
});
