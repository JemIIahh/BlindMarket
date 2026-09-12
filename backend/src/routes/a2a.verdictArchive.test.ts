import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Verdict-archiving invariant: a task must never settle without its result
 * and reasons recorded off-chain. Task #19 (manual, pre-A2A state) completed
 * with an empty detail page — nothing to show because nothing was archived.
 * Going forward every terminal path must persist its records:
 *   - POST /submit        → resultData (the deliverable)
 *   - POST /finalize      → verificationResult with autoVerify reasons
 *   - POST /tasks/:id/verify  → verificationResult with the poster's reasons
 *   - POST /tasks/:id/verdict → verificationResult with the verifier's reasons
 * Mounts the real a2aRouter with store/chain/bridge mocked and asserts on
 * the updateState patches each route writes.
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
  getVerifierTasks: vi.fn(),
  browseAgentTasks: vi.fn(),
  getIndexedHashes: vi.fn(),
  getOffer: vi.fn(() => Promise.resolve(undefined)),
  checkOffer: vi.fn(() => Promise.resolve(false)),
  clearOffer: vi.fn(() => Promise.resolve()),
  setOffer: vi.fn(() => Promise.resolve()),
  clearCascade: vi.fn(() => Promise.resolve()),
  tryExpire: vi.fn(() => Promise.resolve({ ok: true })),
  listOpenTasks: vi.fn(() => Promise.resolve([])),
  cacheDeadline: vi.fn(() => Promise.resolve()),
  getCachedDeadline: vi.fn(() => Promise.resolve(null)),
  acquireAcceptLock: vi.fn(() => Promise.resolve(true)),
  releaseAcceptLock: vi.fn(() => Promise.resolve()),
  logAcceptAttempt: vi.fn(() => Promise.resolve()),
  getAcceptAttempts: vi.fn(() => Promise.resolve([])),
  startSettlementDeadline: vi.fn(() => Promise.resolve()),
  clearSettlementDeadline: vi.fn(() => Promise.resolve()),
  getSettlementDeadlineTTL: vi.fn(() => Promise.resolve(-2)),
}));

vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn() }));

vi.mock('../services/deployedAgentStore.js', () => ({
  loadAgentByWallet: vi.fn(() => Promise.resolve(null)),
  loadAgentBySmartAccount: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../services/keyCustodyService.js', () => ({
  getKeyCustodyService: vi.fn(() => null),
  isKeyCustodyEnabled: vi.fn(() => false),
}));

vi.mock('../services/a2aSettlement.js', () => ({
  settleAssignment: vi.fn(() => Promise.resolve({ success: true, txHash: '0xtx' })),
  settleVerification: vi.fn(() => Promise.resolve({ success: true, txHash: '0xtx' })),
  // Default: no smart account — executor submits as its EOA (legacy path).
  resolveAssignee: vi.fn(async (executor: string) => executor),
}));

// Import-side-effect-heavy modules (Redis / chain / DB). Mock so importing the
// router is pure.
vi.mock('../services/redis.js', () => ({
  redis: { set: vi.fn(), get: vi.fn(), exists: vi.fn(), pipeline: vi.fn() },
}));
vi.mock('../services/chain.js', () => ({
  provider: {},
  escrow: { interface: {}, getAddress: vi.fn() },
}));
vi.mock('../services/escrow.js', () => ({
  getTask: vi.fn(),
  feeBps: vi.fn(),
  getTaskVerifier: vi.fn(),
  getTaskOn: vi.fn(),
  getTaskVerifierOn: vi.fn(),
  buildSubmitEvidenceOn: vi.fn(() => Promise.resolve({ to: '0xescrow', data: '0x', from: '0xexec', chainId: 84532 })),
}));
vi.mock('../services/escrowEvents.js', () => ({
  getTaskIdByHash: vi.fn(),
  getCachedTaskIdByHash: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../services/autoVerify.js', () => ({ autoVerify: vi.fn() }));
vi.mock('../services/accountingService.js', () => ({}));
vi.mock('../services/reputation.js', () => ({}));
vi.mock('../services/reputationDecay.js', () => ({}));
vi.mock('../services/bidsStore.js', () => ({}));
vi.mock('../services/workerPayout.js', () => ({
  recordWorkerPayout: vi.fn(() => Promise.resolve()),
  recordWorkerDispute: vi.fn(() => Promise.resolve()),
}));
vi.mock('../services/railwaySandbox.js', () => ({
  consumePendingCost: vi.fn(() => 0),
}));
vi.mock('../services/webhookStore.js', () => ({
  fireWebhooks: vi.fn(() => Promise.resolve()),
}));

vi.mock('../services/taskChain.js', () => ({
  resolveTaskByHash: vi.fn(),
  resolveTaskChainById: vi.fn(),
}));

import { a2aRouter } from './a2a.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as a2aStore from '../services/a2aStore.js';
import * as taskChain from '../services/taskChain.js';
import * as escrowService from '../services/escrow.js';
import * as settlement from '../services/a2aSettlement.js';
import { autoVerify } from '../services/autoVerify.js';

const app = express();
app.use(express.json());
app.use('/api/v1/a2a', a2aRouter);
app.use(globalErrorHandler);

const EXEC = '0x1111111111111111111111111111111111111111';
const POSTER = '0x2222222222222222222222222222222222222222';
const VERIFIER = '0x3333333333333333333333333333333333333333';
const HASH = '0x' + 'ab'.repeat(32);
const RESULT = { output: 'the deliverable text, long enough to pass any min_length' };

function patchesFor(status: string) {
  return vi.mocked(a2aStore.updateState).mock.calls
    .map((c) => c[1])
    .filter((p) => p && (p as any).status === status);
}

describe('verdict-archiving invariant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(taskChain.resolveTaskByHash).mockResolvedValue({ taskId: '9', chain: 'base' } as any);
  });

  it("POST /submit persists the deliverable (resultData)", async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: HASH, verificationMode: 'auto', requiredCapabilities: [] } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({ taskId: HASH, status: 'accepted', executorAddress: EXEC } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue({ worker: EXEC, submissionAttempts: 0, status: 1 } as any);

    const res = await request(app)
      .post(`/api/v1/a2a/tasks/${HASH}/submit`)
      .set('x-test-address', EXEC)
      .send({ resultData: RESULT });
    expect(res.status).toBe(200);

    const patches = patchesFor('submitted');
    expect(patches).toHaveLength(1);
    expect((patches[0] as any).resultData).toEqual(RESULT);
  });

  it("POST /finalize persists autoVerify reasons", async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({
      taskId: HASH, verificationMode: 'auto', verificationCriteria: { min_length: 5 }, requiredCapabilities: [],
    } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({
      taskId: HASH, status: 'submitted', executorAddress: EXEC, resultData: RESULT,
    } as any);
    vi.mocked(autoVerify).mockReturnValue({ passed: true, reasons: ['All verification criteria met'], score: 100, breakdown: [], errors: {} } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue({ worker: EXEC, submissionAttempts: 1, status: 2, amount: 1000000n } as any);
    vi.mocked(settlement.settleVerification).mockResolvedValue({ success: true, txHash: '0xtx' } as any);

    const res = await request(app)
      .post(`/api/v1/a2a/tasks/${HASH}/finalize`)
      .set('x-test-address', EXEC)
      .send({});
    expect(res.status).toBe(200);

    const patches = patchesFor('verified');
    expect(patches).toHaveLength(1);
    expect((patches[0] as any).verificationResult).toMatchObject({ passed: true, reasons: ['All verification criteria met'] });
  });

  it("POST /verify persists the poster's reasons", async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({
      taskId: HASH, verificationMode: 'manual', posterAddress: POSTER, requiredCapabilities: [],
    } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({
      taskId: HASH, status: 'submitted', executorAddress: EXEC, resultData: RESULT,
    } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue({ worker: EXEC, submissionAttempts: 1, status: 2, amount: 1000000n } as any);
    vi.mocked(settlement.settleVerification).mockResolvedValue({ success: true, txHash: '0xtx' } as any);

    const res = await request(app)
      .post(`/api/v1/a2a/tasks/${HASH}/verify`)
      .set('x-test-address', POSTER)
      .send({ passed: true, reasons: ['poster reviewed and approved'] });
    expect(res.status).toBe(200);

    const patches = patchesFor('verified');
    expect(patches).toHaveLength(1);
    expect((patches[0] as any).verificationResult).toMatchObject({ passed: true, reasons: ['poster reviewed and approved'] });
  });

  it("POST /verdict persists the verifier's reasons", async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({
      taskId: HASH, verificationMode: 'agent', verifierAddress: VERIFIER, requiredCapabilities: [],
    } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({
      taskId: HASH, status: 'awaiting_verification', executorAddress: EXEC, resultData: RESULT, submissionRound: 1,
    } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue({ worker: EXEC, submissionAttempts: 1, status: 4, amount: 1000000n } as any);
    vi.mocked(escrowService.getTaskVerifierOn).mockResolvedValue(VERIFIER);

    const res = await request(app)
      .post(`/api/v1/a2a/tasks/${HASH}/verdict`)
      .set('x-test-address', VERIFIER)
      .send({ passed: true, reasons: ['verifier judged correct'] });
    expect(res.status).toBe(200);

    const patches = patchesFor('verified');
    expect(patches).toHaveLength(1);
    expect((patches[0] as any).verificationResult).toMatchObject({ passed: true, reasons: ['verifier judged correct'] });
  });
});
