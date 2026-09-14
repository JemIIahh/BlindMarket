import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * M5 regression: cancel/timeout wrote 'confirmed' refund rows at
 * UNSIGNED-TX-BUILD time — abandoned builds masqueraded as reclaimed funds.
 * Builds now write status 'pending'; POST /:id/confirm-tx flips to confirmed
 * only after the receipt proves this task's TaskCancelled/DeadlineExpired
 * event from the chain's escrow.
 */

const AGENT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ESCROW = '0xcccccccccccccccccccccccccccccccccccccccc';

vi.mock('../middleware/auth.js', () => {
  const gate = (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || AGENT };
    next();
  };
  return { requireAuth: gate, optionalAuth: gate };
});

const resolveTaskChainById = vi.fn();
vi.mock('../services/taskChain.js', () => ({ resolveTaskChainById: (...a: unknown[]) => resolveTaskChainById(...a) }));

vi.mock('../services/escrow.js', () => ({
  getTaskOn: vi.fn(async () => ({ token: '0x0000000000000000000000000000000000000000', amount: 100n })),
  buildCancelTaskOn: vi.fn(async () => ({ to: ESCROW, data: '0xcancel' })),
  buildClaimTimeoutOn: vi.fn(async () => ({ to: ESCROW, data: '0xtimeout' })),
}));

const getReceipt = vi.fn();
const parseLog = vi.fn();

vi.mock('../services/chain.js', () => ({
  getTokenDecimals: vi.fn(async () => 18),
  provider: { getTransactionReceipt: (...a: unknown[]) => getReceipt(...a) },
  baseProvider: null,
  escrow: {
    getAddress: async () => ESCROW,
    interface: { parseLog: (...a: unknown[]) => parseLog(...a) },
  },
  baseEscrow: null,
}));

vi.mock('../services/accountingService.js', () => ({
  recordTransaction: vi.fn(async () => ({})),
  confirmPendingTransactions: vi.fn(async () => ({ confirmed: 1 })),
}));

vi.mock('../services/socket.js', () => ({
  rooms: { tasks: vi.fn(), platform: vi.fn() },
}));

vi.mock('../services/a2aStore.js', () => ({}));

import { tasksRouter } from './tasks.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as accountingService from '../services/accountingService.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/tasks', tasksRouter);
  a.use(globalErrorHandler);
  return a;
}

const as = (addr: string) => ({ 'x-test-address': addr });

beforeEach(() => {
  vi.clearAllMocks();
  resolveTaskChainById.mockResolvedValue('0g');
});

describe('M5: build-time rows are pending, confirm flips on proof', () => {
  it('cancel writes a PENDING refund row at build time', async () => {
    const res = await request(app()).post('/api/v1/tasks/7/cancel').set(as(AGENT)).send({});
    expect(res.status).toBe(200);
    expect(accountingService.recordTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'refund', status: 'pending', taskId: '7' }),
    );
  });

  it('confirm-tx flips on a real TaskCancelled receipt', async () => {
    getReceipt.mockResolvedValue({ status: 1, logs: [{ address: ESCROW }] });
    parseLog.mockReturnValue({ name: 'TaskCancelled', args: { taskId: 7n, refundAmount: 100n } });
    const res = await request(app()).post('/api/v1/tasks/7/confirm-tx')
      .set(as(AGENT)).send({ txHash: '0x' + '11'.repeat(32) });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ confirmed: true, alreadyConfirmed: false });
    expect(accountingService.confirmPendingTransactions).toHaveBeenCalledWith('7', ['refund']);
  });

  it('confirm-tx accepts DeadlineExpired for timeout reclaims', async () => {
    getReceipt.mockResolvedValue({ status: 1, logs: [{ address: ESCROW }] });
    parseLog.mockReturnValue({ name: 'DeadlineExpired', args: { taskId: 7n, refundAmount: 100n } });
    const res = await request(app()).post('/api/v1/tasks/7/confirm-tx')
      .set(as(AGENT)).send({ txHash: '0x' + '22'.repeat(32) });
    expect(res.status).toBe(200);
    expect(accountingService.confirmPendingTransactions).toHaveBeenCalled();
  });

  it('confirm-tx refuses reverted receipts with no flip', async () => {
    getReceipt.mockResolvedValue({ status: 0, logs: [] });
    const res = await request(app()).post('/api/v1/tasks/7/confirm-tx')
      .set(as(AGENT)).send({ txHash: '0x' + '33'.repeat(32) });
    expect(res.status).toBe(409);
    expect(accountingService.confirmPendingTransactions).not.toHaveBeenCalled();
  });

  it('confirm-tx refuses receipts without this task’s escrow event', async () => {
    getReceipt.mockResolvedValue({ status: 1, logs: [{ address: OTHER }] });
    const res = await request(app()).post('/api/v1/tasks/7/confirm-tx')
      .set(as(AGENT)).send({ txHash: '0x' + '44'.repeat(32) });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_SETTLEMENT_EVENT');
    expect(parseLog).not.toHaveBeenCalled();
    expect(accountingService.confirmPendingTransactions).not.toHaveBeenCalled();
  });

  it('confirm-tx gates non-agents', async () => {
    resolveTaskChainById.mockResolvedValue(null);
    const res = await request(app()).post('/api/v1/tasks/7/confirm-tx')
      .set(as(OTHER)).send({ txHash: '0x' + '55'.repeat(32) });
    expect(res.status).toBe(403);
  });
});
