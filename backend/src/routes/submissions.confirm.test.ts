import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * H4 regression: POST /submissions/verify used to credit the ledger +
 * reputation at UNSIGNED-TX-BUILD time — phantom payouts whenever the caller
 * never broadcast, double payouts whenever A2A /finalize settled the same
 * task. Credit now happens only in POST /submissions/confirm, after the
 * receipt is verified to carry this task's settlement event from the escrow.
 */

const POSTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WORKER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ESCROW = '0xcccccccccccccccccccccccccccccccccccccccc';
const ZERO = '0x0000000000000000000000000000000000000000';
// /confirm reads the 0G escrow, whose only token is native 0G.
const TOKEN = '0x0000000000000000000000000000000000000000';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || POSTER };
    next();
  },
}));

vi.mock('../services/escrow.js', () => ({
  getTask: vi.fn(async () => ({
    taskId: '7', agent: POSTER, worker: WORKER, token: TOKEN, amount: 100n,
    taskHash: '0xhash', evidenceHash: '0xev', status: 2,
  })),
  getTaskVerifier: vi.fn(async () => ZERO),
  buildCompleteVerification: vi.fn(async () => ({ to: ESCROW, data: '0xver' })),
}));

const getReceipt = vi.fn();
const parseLog = vi.fn();

vi.mock('../services/chain.js', () => ({
  provider: { getTransactionReceipt: (...a: unknown[]) => getReceipt(...a) },
  escrow: {
    getAddress: async () => ESCROW,
    interface: { parseLog: (...a: unknown[]) => parseLog(...a) },
  },
}));

vi.mock('../services/redis.js', () => ({
  redis: { set: vi.fn(async () => 'OK'), del: vi.fn(async () => 1) },
}));

vi.mock('../services/workerPayout.js', () => ({
  recordWorkerPayout: vi.fn(async () => undefined),
  recordWorkerDispute: vi.fn(async () => undefined),
}));

vi.mock('../services/accountingService.js', () => ({
  recordTransaction: vi.fn(async () => ({})),
}));

import { submissionsRouter } from './submissions.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as workerPayout from '../services/workerPayout.js';
import * as accountingService from '../services/accountingService.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/submissions', submissionsRouter);
  a.use(globalErrorHandler);
  return a;
}

const as = (addr: string) => ({ 'x-test-address': addr });
const okReceipt = (logs: unknown[]) => ({ status: 1, logs });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('H4: no credit at unsigned-build time', () => {
  it('/verify returns the tx but writes nothing', async () => {
    const res = await request(app()).post('/api/v1/submissions/verify')
      .set(as(POSTER)).send({ taskId: 7, passed: true });
    expect(res.status).toBe(200);
    expect(res.body.data.unsignedTx).toBeTruthy();
    expect(workerPayout.recordWorkerPayout).not.toHaveBeenCalled();
    expect(accountingService.recordTransaction).not.toHaveBeenCalled();
  });

  it('/verify still gates non-posters', async () => {
    const res = await request(app()).post('/api/v1/submissions/verify')
      .set(as(WORKER)).send({ taskId: 7, passed: true });
    expect(res.status).toBe(403);
  });
});

describe('POST /submissions/confirm', () => {
  it('credits via the shared payout path on a real TaskCompleted', async () => {
    getReceipt.mockResolvedValue(okReceipt([{ address: ESCROW }]));
    parseLog.mockReturnValue({ name: 'TaskCompleted', args: { taskId: 7n, workerPayout: 90n, platformFee: 10n } });
    const res = await request(app()).post('/api/v1/submissions/confirm')
      .set(as(POSTER)).send({ taskId: 7, txHash: '0x' + '11'.repeat(32) });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ confirmed: true, passed: true });
    expect(workerPayout.recordWorkerPayout).toHaveBeenCalledTimes(1);
    expect(workerPayout.recordWorkerPayout).toHaveBeenCalledWith('0xhash', WORKER, '7', 100n, { chain: '0g', token: TOKEN });
  });

  it('refuses a reverted receipt with no writes', async () => {
    getReceipt.mockResolvedValue({ status: 0, logs: [] });
    const res = await request(app()).post('/api/v1/submissions/confirm')
      .set(as(POSTER)).send({ taskId: 7, txHash: '0x' + '22'.repeat(32) });
    expect(res.status).toBe(409);
    expect(workerPayout.recordWorkerPayout).not.toHaveBeenCalled();
    expect(accountingService.recordTransaction).not.toHaveBeenCalled();
  });

  it('refuses a receipt with no escrow settlement event for this task', async () => {
    getReceipt.mockResolvedValue(okReceipt([{ address: ESCROW }]));
    parseLog.mockReturnValue({ name: 'TaskCompleted', args: { taskId: 8n, workerPayout: 1n, platformFee: 0n } });
    const res = await request(app()).post('/api/v1/submissions/confirm')
      .set(as(POSTER)).send({ taskId: 7, txHash: '0x' + '33'.repeat(32) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_SETTLEMENT_EVENT');
    expect(workerPayout.recordWorkerPayout).not.toHaveBeenCalled();
  });

  it('ignores lookalike events not emitted by the escrow', async () => {
    getReceipt.mockResolvedValue(okReceipt([{ address: WORKER }]));
    const res = await request(app()).post('/api/v1/submissions/confirm')
      .set(as(POSTER)).send({ taskId: 7, txHash: '0x' + '44'.repeat(32) });
    expect(res.status).toBe(409);
    expect(parseLog).not.toHaveBeenCalled();
    expect(workerPayout.recordWorkerPayout).not.toHaveBeenCalled();
  });

  it('records one dispute per failed broadcast (repeat confirm is a duplicate)', async () => {
    getReceipt.mockResolvedValue(okReceipt([{ address: ESCROW }]));
    parseLog.mockReturnValue({ name: 'VerificationCompleted', args: { taskId: 7n, passed: false } });
    const { redis } = await import('../services/redis.js');
    let claimed = false;
    vi.mocked(redis.set).mockImplementation(async () => (claimed ? null : (claimed = true, 'OK' as never)));
    const body = { taskId: 7, txHash: '0x' + '55'.repeat(32) };
    const r1 = await request(app()).post('/api/v1/submissions/confirm').set(as(POSTER)).send(body);
    expect(r1.status).toBe(200);
    expect(r1.body.data).toMatchObject({ confirmed: true, passed: false });
    const r2 = await request(app()).post('/api/v1/submissions/confirm').set(as(POSTER)).send(body);
    expect(r2.body.data.duplicate).toBe(true);
    expect(workerPayout.recordWorkerDispute).toHaveBeenCalledTimes(1);
  });
});
