import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Two lifecycle seams:
 *
 * - The executor's earnings credit lands BEFORE the state write that ends
 *   retries. It used to run after `status: 'verified'`, so a failed credit was
 *   lost for good: the retry got 409 / alreadyRecorded while the worker had
 *   been paid on-chain.
 * - An agent that cannot take an exclusive offer (no gas on the task's chain)
 *   hands it back via /decline, instead of holding the task for the rest of
 *   its window.
 */

const { AGENT, VERIFIER, OTHER } = vi.hoisted(() => ({
  AGENT: '0xagent0000000000000000000000000000000001',
  VERIFIER: '0xverifier00000000000000000000000000000002',
  OTHER: '0xother000000000000000000000000000000000003',
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || AGENT };
    next();
  },
}));

vi.mock('../services/a2aStore.js', () => ({
  getMeta: vi.fn(),
  getState: vi.fn(),
  updateState: vi.fn(async () => undefined),
  getOffer: vi.fn(async () => undefined),
  setOffer: vi.fn(async () => undefined),
  clearOffer: vi.fn(async () => undefined),
  getCascade: vi.fn(async () => undefined),
  advanceCascade: vi.fn(async () => null),
  clearCascade: vi.fn(async () => undefined),
  CASCADE_OFFER_MS: 12_000,
}));
vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn() }));
vi.mock('../services/bidsStore.js', () => ({}));
vi.mock('../services/agentEmbedding.js', () => ({ recomputeForWalletBestEffort: vi.fn() }));
vi.mock('../services/taskChain.js', () => ({ resolveTaskByHash: vi.fn(), seedTaskId: vi.fn() }));
vi.mock('../services/keyCustodyService.js', () => ({ getKeyCustodyService: vi.fn(() => null), isKeyCustodyEnabled: vi.fn(() => false) }));
vi.mock('../services/a2aSettlement.js', () => ({
  settleAssignment: vi.fn(),
  settleVerification: vi.fn(async () => ({ success: true })),
  resolveAssignee: vi.fn(async (a: string) => a),
}));
vi.mock('../services/redis.js', () => ({ redis: { set: vi.fn(), get: vi.fn(), exists: vi.fn(), pipeline: vi.fn() } }));
vi.mock('../services/chain.js', () => ({ provider: {}, escrow: { interface: {}, getAddress: vi.fn() }, baseEscrow: null }));
vi.mock('../services/escrow.js', () => ({ getTaskOn: vi.fn(), getTaskVerifierOn: vi.fn() }));
vi.mock('../services/escrowEvents.js', () => ({ getTaskIdByHash: vi.fn(), getCachedTaskIdByHash: vi.fn(async () => null) }));
vi.mock('../services/autoVerify.js', () => ({ autoVerify: vi.fn(() => ({ passed: true, reasons: [] })) }));
vi.mock('../services/accountingService.js', () => ({}));
vi.mock('../services/reputation.js', () => ({}));
vi.mock('../services/reputationDecay.js', () => ({}));
vi.mock('../services/workerPayout.js', () => ({ recordWorkerPayout: vi.fn(), recordWorkerDispute: vi.fn() }));
vi.mock('../services/notificationStore.js', () => ({ notifyLifecycle: vi.fn(async () => undefined), notify: vi.fn(async () => null) }));
vi.mock('../services/socket.js', () => ({ emitTaskOffer: vi.fn(), emitTaskAvailable: vi.fn(), hasAgentSocket: vi.fn() }));

const { a2aRouter } = await import('./a2a.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');
const a2aStore = await import('../services/a2aStore.js');
const taskChain = await import('../services/taskChain.js');
const escrow = await import('../services/escrow.js');
const { recordWorkerPayout } = await import('../services/workerPayout.js');
const { emitTaskOffer, emitTaskAvailable } = await import('../services/socket.js');

const TASK = '0xtaskhash';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return a;
}

const onChain = (status: number) => ({ status, amount: 100n, token: '0xusdc', submissionAttempts: 1 });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(taskChain.resolveTaskByHash).mockResolvedValue({ taskId: '7', chain: 'arc' } as any);
});

describe('POST /verdict credits before recording the verdict', () => {
  const verdict = () => request(app()).post(`/api/v1/a2a/tasks/${TASK}/verdict`)
    .set('x-test-address', VERIFIER).send({ passed: true, reasons: ['ok'] });

  beforeEach(() => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, verificationMode: 'agent', verifierAddress: VERIFIER } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'awaiting_verification', executorAddress: AGENT } as any);
    vi.mocked(escrow.getTaskOn).mockResolvedValue(onChain(4) as any);
  });

  it('a failed credit is a retryable 503 and leaves the state for the retry', async () => {
    vi.mocked(recordWorkerPayout).mockRejectedValueOnce(new Error('db down'));
    const res = await verdict();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CREDIT_FAILED');
    expect(a2aStore.updateState).not.toHaveBeenCalled();
    expect(recordWorkerPayout).toHaveBeenCalledWith(TASK, AGENT, '7', 100n, { chain: 'arc', token: '0xusdc' },
      expect.objectContaining({ rethrow: true }));

    // The retry (state still awaiting_verification) credits, then records.
    const again = await verdict();
    expect(again.status).toBe(200);
    expect(recordWorkerPayout).toHaveBeenCalledTimes(2);
    expect(a2aStore.updateState).toHaveBeenCalledWith(TASK, expect.objectContaining({ status: 'verified' }));
    expect(vi.mocked(recordWorkerPayout).mock.invocationCallOrder[1])
      .toBeLessThan(vi.mocked(a2aStore.updateState).mock.invocationCallOrder[0]);
  });
});

describe('POST /finalize credits before the verified state write', () => {
  const finalize = () => request(app()).post(`/api/v1/a2a/tasks/${TASK}/finalize`).set('x-test-address', AGENT);

  beforeEach(() => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, verificationMode: 'auto', verificationCriteria: { min_length: 1 } } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'submitted', executorAddress: AGENT, resultData: { output: 'x' } } as any);
  });

  it('a failed credit after settling 503s with state submitted; the retry reconciles and credits', async () => {
    vi.mocked(escrow.getTaskOn).mockResolvedValueOnce(onChain(2) as any);
    vi.mocked(recordWorkerPayout).mockRejectedValueOnce(new Error('db down'));
    const res = await finalize();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CREDIT_FAILED');
    expect(a2aStore.updateState).not.toHaveBeenCalled();

    // Settled on-chain by the first call: the retry takes the reconcile branch.
    vi.mocked(escrow.getTaskOn).mockResolvedValueOnce(onChain(4) as any);
    const again = await finalize();
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ status: 'verified', reconciled: true });
    expect(recordWorkerPayout).toHaveBeenCalledTimes(2);
    expect(a2aStore.updateState).toHaveBeenCalledWith(TASK, expect.objectContaining({ status: 'verified' }));
  });
});

describe('POST /decline', () => {
  const decline = (who = AGENT) => request(app()).post(`/api/v1/a2a/tasks/${TASK}/decline`).set('x-test-address', who);

  beforeEach(() => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, requiredCapabilities: [], chain: 'arc' } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'open' } as any);
    vi.mocked(a2aStore.getOffer).mockResolvedValue({ address: AGENT, score: 1, expiresAt: Date.now() + 10_000 } as any);
  });

  it('lets the holder pass the offer to the next ranked agent now', async () => {
    vi.mocked(a2aStore.advanceCascade).mockResolvedValue({ address: OTHER, score: 0.5, displayName: 'o', position: 1 } as any);
    const res = await decline();
    expect(res.status).toBe(200);
    expect(a2aStore.clearOffer).toHaveBeenCalledWith(TASK);
    expect(a2aStore.setOffer).toHaveBeenCalledWith(TASK, expect.objectContaining({ address: OTHER }));
    expect(emitTaskOffer).toHaveBeenCalledWith(OTHER, TASK, expect.objectContaining({ chain: 'arc' }), 0.5, expect.any(Number));
  });

  it('broadcasts when the cascade is exhausted', async () => {
    vi.mocked(a2aStore.advanceCascade).mockResolvedValue(null);
    const res = await decline();
    expect(res.status).toBe(200);
    expect(emitTaskAvailable).toHaveBeenCalledWith(TASK, expect.objectContaining({ chain: 'arc' }));
  });

  it('refuses anyone but the current holder', async () => {
    const res = await decline(OTHER);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_OFFER_HOLDER');
    expect(a2aStore.clearOffer).not.toHaveBeenCalled();
    expect(a2aStore.advanceCascade).not.toHaveBeenCalled();
  });

  it('refuses once the task is no longer open', async () => {
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'accepted', executorAddress: OTHER } as any);
    const res = await decline();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
    expect(a2aStore.clearOffer).not.toHaveBeenCalled();
  });
});
