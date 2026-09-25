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
// /confirm reads the posting chain (Base), whose settlement token is USDC.
const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

vi.mock('../config.js', () => ({
  config: { baseEscrowAddress: '0xcccccccccccccccccccccccccccccccccccccccc', baseChainId: 84532, arcEscrowAddress: '' },
}));

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
// The escrow's task as of a block: /confirm reads the failed round's attempt
// count at the settlement block.
const getTaskAt = vi.fn();

vi.mock('../services/chain.js', () => ({
  baseProvider: { getTransactionReceipt: (...a: unknown[]) => getReceipt(...a) },
  baseEscrow: {
    getAddress: async () => ESCROW,
    interface: { parseLog: (...a: unknown[]) => parseLog(...a) },
    getTask: (...a: unknown[]) => getTaskAt(...a),
  },
}));

vi.mock('../services/workerPayout.js', () => ({
  recordWorkerPayout: vi.fn(async () => undefined),
  recordWorkerDispute: vi.fn(async () => true),
}));

vi.mock('../services/accountingService.js', () => ({
  recordTransaction: vi.fn(async () => ({})),
}));

// Task 7 is the task its hash is listed for unless a test says otherwise.
vi.mock('../services/taskChain.js', () => ({
  isListedTask: vi.fn(async () => true),
}));

vi.mock('../services/a2aStore.js', () => ({
  getMeta: vi.fn(async () => ({ taskId: '0xhash', posterAddress: POSTER })),
}));

import { submissionsRouter } from './submissions.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as workerPayout from '../services/workerPayout.js';
import * as accountingService from '../services/accountingService.js';
import * as taskChain from '../services/taskChain.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/submissions', submissionsRouter);
  a.use(globalErrorHandler);
  return a;
}

const as = (addr: string) => ({ 'x-test-address': addr });
const okReceipt = (logs: unknown[]) => ({ status: 1, blockNumber: 123, logs });

beforeEach(() => {
  vi.clearAllMocks();
  getTaskAt.mockResolvedValue({ submissionAttempts: 2n });
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
    expect(workerPayout.recordWorkerPayout).toHaveBeenCalledWith('0xhash', WORKER, '7', 100n, { chain: 'base', token: TOKEN });
  });

  it("credits nothing for a duplicate funded under another task's hash (it would set that hash's once-only marker)", async () => {
    getReceipt.mockResolvedValue(okReceipt([{ address: ESCROW }]));
    parseLog.mockReturnValue({ name: 'TaskCompleted', args: { taskId: 7n, workerPayout: 90n, platformFee: 10n } });
    vi.mocked(taskChain.isListedTask).mockResolvedValueOnce(false);
    const res = await request(app()).post('/api/v1/submissions/confirm')
      .set(as(POSTER)).send({ taskId: 7, txHash: '0x' + '44'.repeat(32) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HASH_NOT_THIS_TASK');
    expect(taskChain.isListedTask).toHaveBeenCalledWith('base', 7, '0xhash', POSTER, POSTER);
    expect(workerPayout.recordWorkerPayout).not.toHaveBeenCalled();
    expect(workerPayout.recordWorkerDispute).not.toHaveBeenCalled();
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

  it('records one dispute per failed round (repeat confirm is a duplicate)', async () => {
    getReceipt.mockResolvedValue(okReceipt([{ address: ESCROW }]));
    parseLog.mockReturnValue({ name: 'VerificationCompleted', args: { taskId: 7n, passed: false } });
    // recordWorkerDispute holds the per-round gate (workerPayout.test.ts).
    vi.mocked(workerPayout.recordWorkerDispute).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const body = { taskId: 7, txHash: '0x' + '55'.repeat(32) };
    const r1 = await request(app()).post('/api/v1/submissions/confirm').set(as(POSTER)).send(body);
    expect(r1.status).toBe(200);
    expect(r1.body.data).toMatchObject({ confirmed: true, passed: false });
    expect(r1.body.data.duplicate).toBeUndefined();
    const r2 = await request(app()).post('/api/v1/submissions/confirm').set(as(POSTER)).send(body);
    expect(r2.body.data.duplicate).toBe(true);
    expect(accountingService.recordTransaction).toHaveBeenCalledTimes(1);
  });

  /**
   * A failed round an A2A route (/finalize, /verify, /verdict) already
   * recorded must not be recorded again when its settlement tx is replayed
   * here: /confirm used to guard only with a marker keyed on the tx hash,
   * which only it wrote (security audit run 1, C21). It now names the round
   * the way the A2A routes do: chain, on-chain id, and the attempt count at
   * the settlement block.
   */
  it('keys the dispute on the round at the settlement block, the same key the A2A routes use', async () => {
    getReceipt.mockResolvedValue(okReceipt([{ address: ESCROW }]));
    parseLog.mockReturnValue({ name: 'VerificationCompleted', args: { taskId: 7n, passed: false } });
    const res = await request(app()).post('/api/v1/submissions/confirm')
      .set(as(POSTER)).send({ taskId: 7, txHash: '0x' + '66'.repeat(32) });
    expect(res.status).toBe(200);
    expect(getTaskAt).toHaveBeenCalledWith(7, { blockTag: 123 });
    expect(workerPayout.recordWorkerDispute).toHaveBeenCalledWith(
      '0xhash', WORKER, { chain: 'base', taskId: '7', attempt: 2 }, { rethrow: true },
    );
  });

  it('adds no dispute and no slash row for a round an A2A route already recorded', async () => {
    getReceipt.mockResolvedValue(okReceipt([{ address: ESCROW }]));
    parseLog.mockReturnValue({ name: 'VerificationCompleted', args: { taskId: 7n, passed: false } });
    vi.mocked(workerPayout.recordWorkerDispute).mockResolvedValueOnce(false);
    const res = await request(app()).post('/api/v1/submissions/confirm')
      .set(as(POSTER)).send({ taskId: 7, txHash: '0x' + '77'.repeat(32) });
    expect(res.body.data).toMatchObject({ confirmed: true, passed: false, duplicate: true });
    expect(accountingService.recordTransaction).not.toHaveBeenCalled();
  });

  it('without historical state, reads the round from the current state while the task still sits in Verified', async () => {
    getReceipt.mockResolvedValue(okReceipt([{ address: ESCROW }]));
    parseLog.mockReturnValue({ name: 'VerificationCompleted', args: { taskId: 7n, passed: false } });
    getTaskAt.mockRejectedValueOnce(new Error('missing trie node'));
    getTaskAt.mockResolvedValueOnce({ status: 3n, submissionAttempts: 2n });
    const res = await request(app()).post('/api/v1/submissions/confirm')
      .set(as(POSTER)).send({ taskId: 7, txHash: '0x' + '99'.repeat(32) });
    expect(res.status).toBe(200);
    expect(workerPayout.recordWorkerDispute).toHaveBeenCalledWith(
      '0xhash', WORKER, { chain: 'base', taskId: '7', attempt: 2 }, { rethrow: true },
    );
  });

  it('refuses with a retryable 503 when there is no historical state and the task has moved on', async () => {
    getReceipt.mockResolvedValue(okReceipt([{ address: ESCROW }]));
    parseLog.mockReturnValue({ name: 'VerificationCompleted', args: { taskId: 7n, passed: false } });
    getTaskAt.mockRejectedValueOnce(new Error('missing trie node'));
    const res = await request(app()).post('/api/v1/submissions/confirm')
      .set(as(POSTER)).send({ taskId: 7, txHash: '0x' + '88'.repeat(32) });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ROUND_UNAVAILABLE');
    expect(workerPayout.recordWorkerDispute).not.toHaveBeenCalled();
  });
});
