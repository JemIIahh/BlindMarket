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
  baseProvider: null,
  baseEscrow: null,
  escrow: { interface: {}, getAddress: vi.fn() },
}));

vi.mock('../services/escrow.js', () => ({ getTaskOn: vi.fn(), getTask: vi.fn() }));

vi.mock('../services/escrowEvents.js', () => ({
  getCachedTaskIdByHash: vi.fn(() => Promise.resolve('7')),
  getTaskIdByHash: vi.fn(() => Promise.resolve('7')),
}));

vi.mock('../services/baseEscrowEvents.js', () => ({
  getBaseTaskIdByHash: vi.fn(() => Promise.resolve(null)),
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
import { provider } from '../services/chain.js';
import { settleAssignment, settleVerification } from '../services/a2aSettlement.js';
import { recordWorkerDispute } from '../services/workerPayout.js';
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
    expect(provider.getTransactionReceipt).not.toHaveBeenCalled();
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

  it("'auto' with a real check passes the gate", async () => {
    vi.mocked(provider.getTransactionReceipt).mockRejectedValue(new Error('past the gate'));
    const res = await index({ verificationMode: 'auto', verificationCriteria: { min_length: 20 } });
    expect(res.body.error?.code).not.toBe('AUTO_CRITERIA_REQUIRED');
    expect(provider.getTransactionReceipt).toHaveBeenCalled();
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

describe('return-to-open is announced', () => {
  it('/release → task:available with the task caps + chain', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({
      taskId: TASK, posterAddress: POSTER, requiredCapabilities: ['coding'], chain: 'base',
    } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'accepted', executorAddress: EXEC } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue(onChainTask({ status: 0 }) as any);

    const res = await post(`/tasks/${TASK}/release`, EXEC);

    expect(res.status).toBe(200);
    expect(a2aStore.releaseToOpen).toHaveBeenCalledWith(TASK);
    expect(emitTaskAvailable).toHaveBeenCalledWith(TASK, { requiredCapabilities: ['coding'], chain: 'base' });
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
    expect(a2aStore.releaseToOpen).toHaveBeenCalledWith(TASK);
    expect(emitTaskAvailable).toHaveBeenCalledWith(TASK, {});
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
    vi.mocked(a2aStore.releaseToOpen).mockRejectedValueOnce(new Error('redis down'));

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
