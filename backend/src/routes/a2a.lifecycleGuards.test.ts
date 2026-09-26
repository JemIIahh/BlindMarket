import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Guards around a task's settle/reopen lifecycle. Mounts the REAL a2aRouter;
 * stores, chain, settlement, socket, and auth are mocked.
 *
 *   index    — modes no route can settle are refused before any chain read
 *   finalize — a chain status from a PREVIOUS submission round is not reconciled
 *   verify   — same gate on the poster's manual path
 *   reopen   — every return-to-open is announced on the tasks room
 *   cascade  — offer queue holds only live agents, capped
 */

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || '0xagent' };
    next();
  },
}));

vi.mock('../services/a2aStore.js', () => ({
  getMeta: vi.fn(),
  getState: vi.fn(),
  updateState: vi.fn(() => Promise.resolve()),
  releaseToOpen: vi.fn(() => Promise.resolve()),
  tryReleaseAccepted: vi.fn(() => Promise.resolve({ ok: true })),
  tryAccept: vi.fn(),
  getOffer: vi.fn(() => Promise.resolve(undefined)),
  clearOffer: vi.fn(() => Promise.resolve()),
  clearCascade: vi.fn(() => Promise.resolve()),
  tryExpire: vi.fn(() => Promise.resolve({ ok: true })),
  cacheDeadline: vi.fn(() => Promise.resolve()),
  getCachedDeadline: vi.fn(() => Promise.resolve(null)),
  acquireAcceptLock: vi.fn(() => Promise.resolve(true)),
  releaseAcceptLock: vi.fn(() => Promise.resolve()),
  logAcceptAttempt: vi.fn(() => Promise.resolve()),
  startSettlementDeadline: vi.fn(() => Promise.resolve()),
  clearSettlementDeadline: vi.fn(() => Promise.resolve()),
}));

vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn() }));

vi.mock('../services/keyCustodyService.js', () => ({
  getKeyCustodyService: vi.fn(() => null),
  isKeyCustodyEnabled: vi.fn(() => false),
}));

vi.mock('../services/redis.js', () => ({
  redis: { set: vi.fn(), get: vi.fn(), exists: vi.fn(), pipeline: vi.fn() },
  isAlive: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../services/deployedAgentStore.js', () => ({
  loadAgentBySmartAccount: vi.fn(() => Promise.resolve(null)),
  loadAgentByWallet: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../services/socket.js', () => ({
  emitTaskOffer: vi.fn(),
  emitTaskAvailable: vi.fn(),
  hasAgentSocket: vi.fn(() => false),
}));

vi.mock('../services/chain.js', () => ({
  provider: { getTransactionReceipt: vi.fn() },
  baseProvider: { getTransactionReceipt: vi.fn() },
  baseEscrow: { interface: {}, getAddress: vi.fn() },
  // Arc testnet has a generated escrow record, so it is the posting chain and
  // /tasks/index polls its receipt first.
  arcProvider: { getTransactionReceipt: vi.fn() },
  arcEscrow: { interface: {}, getAddress: vi.fn() },
}));

vi.mock('../services/escrow.js', () => ({ getTaskOn: vi.fn(), getTask: vi.fn() }));

vi.mock('../services/arcEscrowEvents.js', () => ({
  getArcTaskIdByHash: vi.fn(() => Promise.resolve('7')),
  forceArcTick: vi.fn(() => Promise.resolve()),
}));

vi.mock('../services/baseEscrowEvents.js', () => ({
  getBaseTaskIdByHash: vi.fn(() => Promise.resolve('7')),
  forceBaseTick: vi.fn(() => Promise.resolve()),
}));

vi.mock('../services/a2aSettlement.js', () => ({
  settleAssignment: vi.fn(),
  settleVerification: vi.fn(() => Promise.resolve({ success: true, txHash: '0xtx' })),
  resolveAssignee: vi.fn(async (addr: string) => addr),
}));

vi.mock('../services/notificationStore.js', () => ({
  notifyLifecycle: vi.fn(() => Promise.resolve()),
  notify: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../services/workerPayout.js', () => ({
  recordWorkerPayout: vi.fn(() => Promise.resolve()),
  recordWorkerDispute: vi.fn(() => Promise.resolve()),
}));

vi.mock('../services/autoVerify.js', () => ({
  autoVerify: vi.fn(() => ({ passed: true, reasons: [] })),
}));

import { a2aRouter, liveCascadeEntries } from './a2a.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as a2aStore from '../services/a2aStore.js';
import * as agentStore from '../services/agentStore.js';
import * as escrowService from '../services/escrow.js';
import { baseProvider, arcProvider } from '../services/chain.js';
import { settleAssignment, settleVerification } from '../services/a2aSettlement.js';
import { recordWorkerDispute } from '../services/workerPayout.js';
import { autoVerify } from '../services/autoVerify.js';
import { emitTaskAvailable, hasAgentSocket } from '../services/socket.js';
import { isAlive } from '../services/redis.js';
import { loadAgentByWallet } from '../services/deployedAgentStore.js';

const EXEC = '0xecec000000000000000000000000000000000001';
const POSTER = '0x9090000000000000000000000000000000000002';
const TASK = '0x' + 'ab'.repeat(32);

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return a;
}

function post(path: string, caller: string, body: Record<string, unknown> = {}) {
  return request(app()).post(`/api/v1/a2a${path}`).set('x-test-address', caller).send(body);
}

function onChainTask(overrides: Record<string, unknown> = {}) {
  return { status: 2, worker: EXEC, submissionAttempts: 1, amount: 100n, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasAgentSocket).mockReturnValue(false);
  vi.mocked(isAlive).mockResolvedValue(false);
  vi.mocked(loadAgentByWallet).mockResolvedValue(null);
});

describe('POST /tasks/index — unsettleable verification modes', () => {
  const index = (body: Record<string, unknown>) =>
    post('/tasks/index', POSTER, { txHash: '0xtx', taskHash: TASK, ...body });

  it("'oracle' → 400 VERIFICATION_MODE_UNSUPPORTED before any chain read", async () => {
    const res = await index({ verificationMode: 'oracle' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VERIFICATION_MODE_UNSUPPORTED');
    expect(baseProvider.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("'auto' with no criteria → 400 AUTO_CRITERIA_REQUIRED naming the checks", async () => {
    const res = await index({ verificationMode: 'auto' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUTO_CRITERIA_REQUIRED');
    expect(res.body.error.message).toContain('min_length');
  });

  it("'auto' with only non-checking criteria (pass_threshold, empty lists) → 400", async () => {
    const res = await index({
      verificationMode: 'auto',
      verificationCriteria: { pass_threshold: 50, max_length: 10, contains_keywords: [], acceptance: 'be good' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUTO_CRITERIA_REQUIRED');
  });

  it('a rootHash that is not a storage id → 400 before any chain read (audit run 1, C24)', async () => {
    const res = await index({ rootHash: '../a2a/semantic-candidates' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(baseProvider.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("'auto' with a real check passes the gate", async () => {
    vi.mocked(arcProvider.getTransactionReceipt).mockRejectedValue(new Error('past the gate'));
    const res = await index({ verificationMode: 'auto', verificationCriteria: { min_length: 20 } });
    expect(res.body.error?.code).not.toBe('AUTO_CRITERIA_REQUIRED');
    expect(arcProvider.getTransactionReceipt).toHaveBeenCalled();
  });
});

describe('retry round not yet on chain', () => {
  it('/finalize (auto): chain still shows round-1 failure → 503, no second fail/dock', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({
      taskId: TASK, posterAddress: POSTER, verificationMode: 'auto', verificationCriteria: { min_length: 1 },
    } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({
      status: 'submitted', executorAddress: EXEC, resultData: { output: 'x' }, submissionRound: 2,
    } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue(onChainTask({ status: 3, submissionAttempts: 1 }) as any);

    const res = await post(`/tasks/${TASK}/finalize`, EXEC);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NOT_SUBMITTED_ON_CHAIN');
    expect(a2aStore.updateState).not.toHaveBeenCalled();
    expect(recordWorkerDispute).not.toHaveBeenCalled();
  });

  it('/finalize (auto): same-round settled status still reconciles', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({
      taskId: TASK, posterAddress: POSTER, verificationMode: 'auto', verificationCriteria: { min_length: 1 },
    } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({
      status: 'submitted', executorAddress: EXEC, resultData: { output: 'x' }, submissionRound: 2,
    } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue(onChainTask({ status: 3, submissionAttempts: 2 }) as any);

    const res = await post(`/tasks/${TASK}/finalize`, EXEC);

    expect(res.status).toBe(200);
    expect(res.body.data.reconciled).toBe(true);
    expect(recordWorkerDispute).toHaveBeenCalledTimes(1);
    // Keyed on the settled round, like every other observer of it (C21).
    expect(vi.mocked(recordWorkerDispute).mock.calls[0][2]).toMatchObject({ taskId: '7', attempt: 2 });
  });

  it('/verify (manual): chain still shows round-1 failure → 503, nothing settled or written', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({
      taskId: TASK, posterAddress: POSTER, verificationMode: 'manual',
    } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({
      status: 'submitted', executorAddress: EXEC, resultData: { output: 'x' }, submissionRound: 2,
    } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue(onChainTask({ status: 3, submissionAttempts: 1 }) as any);

    const res = await post(`/tasks/${TASK}/verify`, POSTER, { passed: false });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NOT_SUBMITTED_ON_CHAIN');
    expect(settleVerification).not.toHaveBeenCalled();
    expect(a2aStore.updateState).not.toHaveBeenCalled();
    expect(recordWorkerDispute).not.toHaveBeenCalled();
  });
});

/**
 * Every observer of a failed round names it the same way, chain + on-chain id
 * + submissionAttempts at settlement, so recordWorkerDispute records it once
 * (security audit run 1, C21; /submissions/confirm derives the same key).
 */
describe('failed rounds are recorded under their round', () => {
  it('/finalize (auto) failing autoVerify passes the round it settled', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({
      taskId: TASK, posterAddress: POSTER, verificationMode: 'auto', verificationCriteria: { min_length: 1 },
    } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({
      status: 'submitted', executorAddress: EXEC, resultData: { output: 'x' }, submissionRound: 3,
    } as any);
    vi.mocked(autoVerify).mockReturnValueOnce({ passed: false, reasons: ['too short'] } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue(onChainTask({ status: 2, submissionAttempts: 3 }) as any);

    const res = await post(`/tasks/${TASK}/finalize`, EXEC);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('failed');
    expect(recordWorkerDispute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordWorkerDispute).mock.calls[0].slice(0, 3)).toEqual([
      TASK, EXEC, expect.objectContaining({ taskId: '7', attempt: 3 }),
    ]);
  });

  it('/verdict (agent) recording a failure passes the round it settled', async () => {
    const VERIFIER = '0x7e7e000000000000000000000000000000000003';
    vi.mocked(a2aStore.getMeta).mockResolvedValue({
      taskId: TASK, posterAddress: POSTER, verificationMode: 'agent', verifierAddress: VERIFIER,
    } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({
      status: 'awaiting_verification', executorAddress: EXEC, resultData: { output: 'x' }, submissionRound: 2,
    } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue(onChainTask({ status: 3, submissionAttempts: 2 }) as any);

    const res = await post(`/tasks/${TASK}/verdict`, VERIFIER, { passed: false, reasons: ['wrong answer'] });

    expect(res.status).toBe(200);
    expect(vi.mocked(recordWorkerDispute).mock.calls[0].slice(0, 3)).toEqual([
      TASK, EXEC, expect.objectContaining({ taskId: '7', attempt: 2 }),
    ]);
  });
});

describe('return-to-open is announced', () => {
  it('/release → task:available with the task caps + chain', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({
      taskId: TASK, posterAddress: POSTER, requiredCapabilities: ['coding'], chain: 'base',
    } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'accepted', executorAddress: EXEC } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue(onChainTask({ status: 0 }) as any);

    const res = await post(`/tasks/${TASK}/release`, EXEC);

    expect(res.status).toBe(200);
    // Compare-and-set against exactly what the route read; never the
    // unconditional releaseToOpen.
    expect(a2aStore.tryReleaseAccepted).toHaveBeenCalledWith(TASK, {
      executorAddress: EXEC, assignTxHash: undefined, status: 'accepted',
    });
    expect(a2aStore.releaseToOpen).not.toHaveBeenCalled();
    expect(emitTaskAvailable).toHaveBeenCalledWith(TASK, { requiredCapabilities: ['coding'], chain: 'base' });
  });

  it('/release passes the status and assign tx it read (submitted task, broadcast tx)', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, posterAddress: POSTER, requiredCapabilities: [] } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'submitted', executorAddress: EXEC, assignTxHash: '0xtx' } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue(onChainTask({ status: 0 }) as any);

    const res = await post(`/tasks/${TASK}/release`, POSTER);

    expect(res.status).toBe(200);
    expect(a2aStore.tryReleaseAccepted).toHaveBeenCalledWith(TASK, {
      executorAddress: EXEC, assignTxHash: '0xtx', status: 'submitted',
    });
  });

  it('/release that loses the compare-and-set → 409 STATE_CHANGED, not announced, not reported open', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, posterAddress: POSTER, requiredCapabilities: [] } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'accepted', executorAddress: EXEC } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue(onChainTask({ status: 0 }) as any);
    vi.mocked(a2aStore.tryReleaseAccepted).mockResolvedValueOnce({ ok: false, currentStatus: 'submitted' });

    const res = await post(`/tasks/${TASK}/release`, EXEC);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('STATE_CHANGED');
    expect(res.body.data).toBeUndefined();
    expect(emitTaskAvailable).not.toHaveBeenCalled();
    expect(a2aStore.releaseToOpen).not.toHaveBeenCalled();
  });

  it('/release beaten by another release → noop success, not announced a second time', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, posterAddress: POSTER, requiredCapabilities: [] } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'accepted', executorAddress: EXEC } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue(onChainTask({ status: 0 }) as any);
    vi.mocked(a2aStore.tryReleaseAccepted).mockResolvedValueOnce({ ok: false, currentStatus: 'open' });

    const res = await post(`/tasks/${TASK}/release`, EXEC);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ taskId: TASK, status: 'open', noop: true });
    expect(emitTaskAvailable).not.toHaveBeenCalled();
  });

  it('/accept SETTLEMENT_FAILED → released and announced', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, posterAddress: POSTER, requiredCapabilities: [] } as any);
    vi.mocked(agentStore.getAgent).mockResolvedValue({ address: EXEC, capabilities: [], publicKey: '04' } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue(null as any);
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);
    vi.mocked(settleAssignment).mockResolvedValue({ success: false, error: 'rpc down' } as any);

    const res = await post(`/tasks/${TASK}/accept`, EXEC);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SETTLEMENT_FAILED');
    // No tx was broadcast, so the compare-and-set expects none on the state.
    expect(a2aStore.tryReleaseAccepted).toHaveBeenCalledWith(TASK, { executorAddress: EXEC, assignTxHash: undefined });
    expect(a2aStore.releaseToOpen).not.toHaveBeenCalled();
    expect(res.body.error.message).toContain('Task released');
    expect(emitTaskAvailable).toHaveBeenCalledWith(TASK, {});
  });

  it('/accept SETTLEMENT_FAILED after a reverted assign tx → compare-and-set names that tx', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, posterAddress: POSTER, requiredCapabilities: [] } as any);
    vi.mocked(agentStore.getAgent).mockResolvedValue({ address: EXEC, capabilities: [], publicKey: '04' } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue(null as any);
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);
    vi.mocked(settleAssignment).mockResolvedValue({ success: false, error: 'reverted', txHash: '0xtx' } as any);

    await post(`/tasks/${TASK}/accept`, EXEC);

    expect(a2aStore.tryReleaseAccepted).toHaveBeenCalledWith(TASK, { executorAddress: EXEC, assignTxHash: '0xtx' });
  });

  it('/accept SETTLEMENT_FAILED that loses the compare-and-set → not announced, not reported released', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, posterAddress: POSTER, requiredCapabilities: [] } as any);
    vi.mocked(agentStore.getAgent).mockResolvedValue({ address: EXEC, capabilities: [], publicKey: '04' } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue(null as any);
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);
    vi.mocked(settleAssignment).mockResolvedValue({ success: false, error: 'rpc down' } as any);
    vi.mocked(a2aStore.tryReleaseAccepted).mockResolvedValueOnce({ ok: false, currentStatus: 'accepted' });

    const res = await post(`/tasks/${TASK}/accept`, EXEC);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SETTLEMENT_FAILED');
    expect(res.body.error.message).not.toContain('released');
    expect(emitTaskAvailable).not.toHaveBeenCalled();
    expect(a2aStore.releaseToOpen).not.toHaveBeenCalled();
  });

  it('/accept with a still-confirming assign tx → 503 ASSIGNMENT_PENDING, NOT released or announced', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, posterAddress: POSTER, requiredCapabilities: [] } as any);
    vi.mocked(agentStore.getAgent).mockResolvedValue({ address: EXEC, capabilities: [], publicKey: '04' } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue(null as any);
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);
    vi.mocked(settleAssignment).mockResolvedValue({ success: false, pending: true, error: 'not confirmed', txHash: '0xtx' } as any);

    const res = await post(`/tasks/${TASK}/accept`, EXEC);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ASSIGNMENT_PENDING');
    expect(a2aStore.releaseToOpen).not.toHaveBeenCalled();
    expect(a2aStore.updateState).not.toHaveBeenCalled();
    expect(emitTaskAvailable).not.toHaveBeenCalled();
  });

  it('re-accept while the assign tx is still confirming → 503 ASSIGNMENT_PENDING', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, posterAddress: POSTER, requiredCapabilities: [] } as any);
    vi.mocked(agentStore.getAgent).mockResolvedValue({ address: EXEC, capabilities: [], publicKey: '04' } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'accepted', executorAddress: EXEC } as any);
    vi.mocked(settleAssignment).mockResolvedValue({ success: false, pending: true, error: 'not confirmed', txHash: '0xtx' } as any);

    const res = await post(`/tasks/${TASK}/accept`, EXEC);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ASSIGNMENT_PENDING');
    expect(a2aStore.releaseToOpen).not.toHaveBeenCalled();
  });

  it('a failed release is not announced', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, posterAddress: POSTER, requiredCapabilities: [] } as any);
    vi.mocked(agentStore.getAgent).mockResolvedValue({ address: EXEC, capabilities: [], publicKey: '04' } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue(null as any);
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);
    vi.mocked(settleAssignment).mockResolvedValue({ success: false, error: 'rpc down' } as any);
    vi.mocked(a2aStore.tryReleaseAccepted).mockRejectedValueOnce(new Error('redis down'));

    const res = await post(`/tasks/${TASK}/accept`, EXEC);

    expect(res.body.error.code).toBe('SETTLEMENT_FAILED');
    expect(emitTaskAvailable).not.toHaveBeenCalled();
  });
});

describe('liveCascadeEntries', () => {
  const entry = (n: number) => ({ address: `0x${String(n).padStart(40, '0')}`, score: 100 - n, displayName: `a${n}` });

  it('drops agents with no socket and no heartbeat, keeping ranked order', async () => {
    const entries = [entry(1), entry(2), entry(3)];
    vi.mocked(hasAgentSocket).mockImplementation((a) => a === entries[2].address);
    vi.mocked(loadAgentByWallet).mockImplementation(async (a) => (a === entries[0].address ? ({ id: 'dep-1' } as any) : null));
    vi.mocked(isAlive).mockImplementation(async (id) => id === 'dep-1');

    expect(await liveCascadeEntries(entries)).toEqual([entries[0], entries[2]]);
  });

  it('nobody live → empty queue (caller broadcasts)', async () => {
    expect(await liveCascadeEntries([entry(1), entry(2)])).toEqual([]);
  });

  it('a liveness lookup failure counts as not live', async () => {
    vi.mocked(loadAgentByWallet).mockRejectedValue(new Error('pg down'));
    expect(await liveCascadeEntries([entry(1)])).toEqual([]);
  });

  it('caps the queue at CASCADE_MAX_POSITIONS (default 8)', async () => {
    vi.mocked(hasAgentSocket).mockReturnValue(true);
    const entries = Array.from({ length: 20 }, (_, i) => entry(i + 1));
    expect(await liveCascadeEntries(entries)).toEqual(entries.slice(0, 8));
  });
});
