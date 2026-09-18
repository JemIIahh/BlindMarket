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
const TASK_HASH = '0x' + 'ab'.repeat(32);

vi.mock('../middleware/auth.js', () => {
  const gate = (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || AGENT };
    next();
  };
  return { requireAuth: gate, optionalAuth: gate };
});

const resolveTaskChainById = vi.fn();
const resolveCachedTaskByHash = vi.fn();
vi.mock('../services/taskChain.js', () => ({
  resolveTaskChainById: (...a: unknown[]) => resolveTaskChainById(...a),
  resolveCachedTaskByHash: (...a: unknown[]) => resolveCachedTaskByHash(...a),
}));

vi.mock('../services/escrow.js', () => ({
  getTaskOn: vi.fn(async () => ({ token: '0x0000000000000000000000000000000000000000', amount: 100n, taskHash: TASK_HASH })),
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

const getState = vi.fn();
const getMeta = vi.fn();
const tryCloseOnChainTerminal = vi.fn();
vi.mock('../services/a2aStore.js', () => ({
  getState: (...a: unknown[]) => getState(...a),
  getMeta: (...a: unknown[]) => getMeta(...a),
  tryCloseOnChainTerminal: (...a: unknown[]) => tryCloseOnChainTerminal(...a),
  clearOffer: vi.fn(async () => {}),
  clearCascade: vi.fn(async () => {}),
}));

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
  getState.mockResolvedValue(undefined);
  // The A2A task under TASK_HASH is AGENT's, backed by 0G escrow task 7.
  getMeta.mockResolvedValue({ taskId: TASK_HASH, posterAddress: AGENT.toUpperCase().replace('0X', '0x') });
  resolveCachedTaskByHash.mockResolvedValue({ taskId: '7', chain: '0g' });
  tryCloseOnChainTerminal.mockResolvedValue({ ok: true, previousStatus: 'open' });
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

describe('H-04/H-07: a confirmed reclaim closes the A2A state', () => {
  const confirm = (hash: string) =>
    request(app()).post('/api/v1/tasks/7/confirm-tx').set(as(AGENT)).send({ txHash: '0x' + hash.repeat(32) });

  it('closes as cancelled on TaskCancelled', async () => {
    getState.mockResolvedValue({ taskId: TASK_HASH, status: 'open' });
    getReceipt.mockResolvedValue({ status: 1, logs: [{ address: ESCROW }] });
    parseLog.mockReturnValue({ name: 'TaskCancelled', args: { taskId: 7n } });
    const res = await confirm('61');
    expect(res.status).toBe(200);
    expect(tryCloseOnChainTerminal).toHaveBeenCalledWith(TASK_HASH, 'cancelled');
  });

  it('closes an in-flight task as expired on DeadlineExpired', async () => {
    getState.mockResolvedValue({ taskId: TASK_HASH, status: 'awaiting_verification' });
    getReceipt.mockResolvedValue({ status: 1, logs: [{ address: ESCROW }] });
    parseLog.mockReturnValue({ name: 'DeadlineExpired', args: { taskId: 7n } });
    const res = await confirm('62');
    expect(res.status).toBe(200);
    expect(tryCloseOnChainTerminal).toHaveBeenCalledWith(TASK_HASH, 'expired');
  });

  it('never closes on an unproven tx', async () => {
    getState.mockResolvedValue({ taskId: TASK_HASH, status: 'open' });
    getReceipt.mockResolvedValue(null);
    expect((await confirm('63')).status).toBe(409);
    getReceipt.mockResolvedValue({ status: 1, logs: [{ address: OTHER }] });
    expect((await confirm('64')).status).toBe(409);
    expect(tryCloseOnChainTerminal).not.toHaveBeenCalled();
  });

  it('skips tasks with no A2A state and still confirms the refund', async () => {
    getReceipt.mockResolvedValue({ status: 1, logs: [{ address: ESCROW }] });
    parseLog.mockReturnValue({ name: 'TaskCancelled', args: { taskId: 7n } });
    const res = await confirm('65');
    expect(res.status).toBe(200);
    expect(tryCloseOnChainTerminal).not.toHaveBeenCalled();
  });

  it('a failing close does not block the refund confirmation', async () => {
    getState.mockResolvedValue({ taskId: TASK_HASH, status: 'accepted' });
    tryCloseOnChainTerminal.mockRejectedValue(new Error('redis down'));
    getReceipt.mockResolvedValue({ status: 1, logs: [{ address: ESCROW }] });
    parseLog.mockReturnValue({ name: 'TaskCancelled', args: { taskId: 7n } });
    const res = await confirm('66');
    expect(res.status).toBe(200);
    expect(accountingService.confirmPendingTransactions).toHaveBeenCalledWith('7', ['refund']);
  });

  // The escrow does not enforce unique taskHashes and A2A state is keyed by
  // hash alone: an attacker creates escrow task 9 reusing the victim's hash,
  // cancels it (instant refund) and confirms. Everything about that receipt is
  // genuine — only the A2A task is not theirs.
  describe('duplicate taskHash on another escrow task', () => {
    // AGENT (the real poster) confirming a genuine cancel of escrow task 7.
    const posterConfirm = (hash: string) => {
      getReceipt.mockResolvedValue({ status: 1, logs: [{ address: ESCROW }] });
      parseLog.mockReturnValue({ name: 'TaskCancelled', args: { taskId: 7n } });
      return confirm(hash);
    };
    const attackerConfirm = () => {
      getReceipt.mockResolvedValue({ status: 1, logs: [{ address: ESCROW }] });
      parseLog.mockReturnValue({ name: 'TaskCancelled', args: { taskId: 9n } });
      return request(app()).post('/api/v1/tasks/9/confirm-tx')
        .set(as(OTHER)).send({ txHash: '0x' + '71'.repeat(32) });
    };

    it("does not close the victim's live A2A task, and still confirms the attacker's own refund", async () => {
      getState.mockResolvedValue({ taskId: TASK_HASH, status: 'submitted' });
      const res = await attackerConfirm();
      expect(res.status).toBe(200);
      expect(tryCloseOnChainTerminal).not.toHaveBeenCalled();
      expect(accountingService.confirmPendingTransactions).toHaveBeenCalledWith('9', ['refund']);
    });

    it('holds even after the attacker’s TaskCreated overwrote the last-writer-wins hash index', async () => {
      getState.mockResolvedValue({ taskId: TASK_HASH, status: 'submitted' });
      resolveCachedTaskByHash.mockResolvedValue({ taskId: '9', chain: '0g' });
      expect((await attackerConfirm()).status).toBe(200);
      expect(tryCloseOnChainTerminal).not.toHaveBeenCalled();
    });

    it('does not close when the A2A task has no recorded poster', async () => {
      getState.mockResolvedValue({ taskId: TASK_HASH, status: 'open' });
      getMeta.mockResolvedValue({ taskId: TASK_HASH });
      expect((await posterConfirm('72')).status).toBe(200);
      expect(tryCloseOnChainTerminal).not.toHaveBeenCalled();
    });

    it("does not close the poster's own A2A task from a different escrow task of theirs", async () => {
      getState.mockResolvedValue({ taskId: TASK_HASH, status: 'accepted' });
      resolveCachedTaskByHash.mockResolvedValue({ taskId: '3', chain: 'base' });
      expect((await posterConfirm('73')).status).toBe(200);
      expect(tryCloseOnChainTerminal).not.toHaveBeenCalled();
    });

    it('the legitimate poster still closes, including when the hash index is cold', async () => {
      getState.mockResolvedValue({ taskId: TASK_HASH, status: 'submitted' });
      expect((await posterConfirm('74')).status).toBe(200);
      expect(tryCloseOnChainTerminal).toHaveBeenCalledWith(TASK_HASH, 'cancelled');

      tryCloseOnChainTerminal.mockClear();
      resolveCachedTaskByHash.mockResolvedValue(null);
      expect((await posterConfirm('75')).status).toBe(200);
      expect(tryCloseOnChainTerminal).toHaveBeenCalledWith(TASK_HASH, 'cancelled');
    });
  });
});
