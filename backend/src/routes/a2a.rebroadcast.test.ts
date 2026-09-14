import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

/**
 * Integration test for POST /api/v1/a2a/tasks/:id/rebroadcast — the heal for
 * the submit-then-crash gap (off-chain 'submitted', on-chain still
 * Assigned(1) because the submitEvidence broadcast died). Mounts the REAL
 * a2aRouter; stores, settlement, and auth are mocked.
 *
 * Matrix:
 *   1. non-executor caller                    → 403 FORBIDDEN
 *   2. state not 'submitted'                  → 409 INVALID_STATE
 *   3. 'submitted' but no resultData          → 400 NO_RESULT_DATA
 *   4. on-chain status already Submitted(2)   → 409 ALREADY_SUBMITTED, no tx built
 *   5. status Assigned(1), worker matches     → 200 + deterministic evidenceHash
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
  updateState: vi.fn(),
}));

vi.mock('../services/redis.js', () => ({
  redis: { set: vi.fn(), get: vi.fn(), exists: vi.fn(), pipeline: vi.fn() },
}));

vi.mock('../services/chain.js', () => ({
  provider: {},
  baseEscrow: null,
  escrow: { interface: {}, getAddress: vi.fn() },
}));

vi.mock('../services/escrow.js', () => ({
  getTaskOn: vi.fn(),
  buildSubmitEvidenceOn: vi.fn(),
}));

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
  settleVerification: vi.fn(),
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

import { a2aRouter } from './a2a.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as a2aStore from '../services/a2aStore.js';
import * as escrowService from '../services/escrow.js';

const EXEC = '0xecec000000000000000000000000000000000001';
const OTHER = '0x0000000000000000000000000000000000000002';
const TASK = '0x' + 'ab'.repeat(32);
const RESULT = { output: 'the deliverable' };

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return a;
}

function rebroadcast(caller: string = EXEC) {
  return request(app()).post(`/api/v1/a2a/tasks/${TASK}/rebroadcast`).set('x-test-address', caller);
}

function onChainTask(overrides: Record<string, unknown> = {}) {
  return {
    status: 1,
    worker: EXEC,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    submissionAttempts: 0,
    amount: 100n,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, posterAddress: '0xposter' } as any);
});

describe('POST /rebroadcast', () => {
  it('1) non-executor caller → 403 FORBIDDEN', async () => {
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'submitted', executorAddress: EXEC, resultData: RESULT } as any);
    const res = await rebroadcast(OTHER);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('2) state not submitted → 409 INVALID_STATE', async () => {
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'accepted', executorAddress: EXEC } as any);
    const res = await rebroadcast();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
  });

  it('3) submitted without resultData → 400 NO_RESULT_DATA', async () => {
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'submitted', executorAddress: EXEC } as any);
    const res = await rebroadcast();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_RESULT_DATA');
  });

  it('4) on-chain already Submitted(2) → 409 ALREADY_SUBMITTED, no tx built', async () => {
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'submitted', executorAddress: EXEC, resultData: RESULT } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue(onChainTask({ status: 2 }) as any);
    const res = await rebroadcast();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_SUBMITTED');
    expect(escrowService.buildSubmitEvidenceOn).not.toHaveBeenCalled();
  });

  it('5) Assigned(1) + recorded worker → 200 with deterministic evidenceHash', async () => {
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'submitted', executorAddress: EXEC, resultData: RESULT } as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue(onChainTask() as any);
    vi.mocked(escrowService.buildSubmitEvidenceOn).mockResolvedValue({ to: '0xescrow', data: '0xdead' } as any);
    const res = await rebroadcast();
    expect(res.status).toBe(200);
    expect(res.body.data.evidenceHash).toBe(ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(RESULT))));
    expect(res.body.data.unsignedSubmitEvidence).toEqual({ to: '0xescrow', data: '0xdead' });
    expect(res.body.data.chain).toBe('0g');
  });
});
