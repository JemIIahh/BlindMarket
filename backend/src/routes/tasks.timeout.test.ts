import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * POST /api/v1/tasks/:id/timeout asks the escrow whether the poster's
 * claimTimeout would go through, and says what it does. On an upgraded escrow
 * a Submitted task (work delivered before the deadline, never judged) is sent
 * for review instead of refunded (security audit run 1, C18); the deadline
 * moves by the time the escrow spent paused, and a paused escrow refuses the
 * claim (C36).
 */

const AGENT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ESCROW = '0xcccccccccccccccccccccccccccccccccccccccc';
const PAST = 1_000n;

vi.mock('../middleware/auth.js', () => {
  const gate = (req: any, _res: any, next: any) => {
    req.user = { address: AGENT };
    next();
  };
  return { requireAuth: gate, optionalAuth: gate };
});

vi.mock('../services/taskChain.js', () => ({
  resolvePosterTask: vi.fn(async (_id: number, callers: string[]) => ({ chain: 'arc', poster: callers[0] })),
  resolveCachedTaskByHash: vi.fn(async () => null),
}));

const escrow = vi.hoisted(() => ({
  getTaskOn: vi.fn(),
  buildClaimTimeoutOn: vi.fn(),
  claimTimeoutRevertOn: vi.fn(),
  escalatesUnjudgedWorkOn: vi.fn(),
  effectiveDeadlineOn: vi.fn(),
}));
vi.mock('../services/escrow.js', () => escrow);

vi.mock('../services/chain.js', () => ({ getTokenDecimals: vi.fn(async () => 6) }));
vi.mock('../services/accountingService.js', () => ({
  recordTransaction: vi.fn(async () => ({})),
  confirmPendingTransactions: vi.fn(async () => ({ confirmed: 1 })),
}));
vi.mock('../services/socket.js', () => ({ rooms: { tasks: vi.fn(), platform: vi.fn() } }));
vi.mock('../services/a2aStore.js', () => ({}));

import { tasksRouter } from './tasks.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as accountingService from '../services/accountingService.js';

const ASSIGNED = 1;
const SUBMITTED = 2;
const VERIFIED = 3;
const FUNDED = 0;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/tasks', tasksRouter);
  a.use(globalErrorHandler);
  return a;
}

const claim = () => request(app()).post('/api/v1/tasks/7/timeout').send({ chain: 'arc' });

function task(status: number, deadline = PAST) {
  return {
    taskId: '7',
    agent: AGENT,
    worker: '0x2222222222222222222222222222222222222222',
    token: '0x3600000000000000000000000000000000000000',
    amount: 5_000_000n,
    taskHash: '0x' + 'ab'.repeat(32),
    evidenceHash: '0x' + '00'.repeat(32),
    status,
    createdAt: 1n,
    deadline,
    submissionAttempts: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  escrow.getTaskOn.mockResolvedValue(task(ASSIGNED));
  escrow.buildClaimTimeoutOn.mockResolvedValue({ to: ESCROW, data: '0xtimeout' });
  escrow.claimTimeoutRevertOn.mockResolvedValue(null);
  escrow.escalatesUnjudgedWorkOn.mockResolvedValue(true);
  escrow.effectiveDeadlineOn.mockResolvedValue(null);
});

describe('what a timeout claim does', () => {
  it('refunds an assigned task nobody delivered, and records the refund as pending', async () => {
    const res = await claim();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ outcome: 'refund', unsignedTx: { data: '0xtimeout' } });
    expect(res.body.data.message).toBeUndefined();
    expect(escrow.claimTimeoutRevertOn).toHaveBeenCalledWith('arc', AGENT, 7);
    expect(accountingService.recordTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'refund', status: 'pending', taskId: '7', amount: 5 }),
    );
  });

  it('sends delivered, unjudged work for review on an upgraded escrow, recording no refund', async () => {
    escrow.getTaskOn.mockResolvedValue(task(SUBMITTED));
    const res = await claim();
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('escalate');
    expect(res.body.data.message).toMatch(/sends it for review instead of refunding you/);
    expect(accountingService.recordTransaction).not.toHaveBeenCalled();
  });

  it('still reports a refund for a submitted task on an escrow from before the upgrade', async () => {
    escrow.getTaskOn.mockResolvedValue(task(SUBMITTED));
    escrow.escalatesUnjudgedWorkOn.mockResolvedValue(false);
    const res = await claim();
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('refund');
    expect(accountingService.recordTransaction).toHaveBeenCalledWith(expect.objectContaining({ type: 'refund' }));
  });

  it('refuses before the raw deadline without asking the escrow', async () => {
    escrow.getTaskOn.mockResolvedValue(task(ASSIGNED, BigInt(Math.floor(Date.now() / 1000) + 3600)));
    const res = await claim();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DEADLINE_NOT_REACHED');
    expect(escrow.claimTimeoutRevertOn).not.toHaveBeenCalled();
    expect(escrow.buildClaimTimeoutOn).not.toHaveBeenCalled();
  });
});

describe('a claim the escrow would reject is refused with the reason', () => {
  it.each([
    ['EnforcedPause', ASSIGNED, 409, 'ESCROW_PAUSED'],
    ['AppealWindowActive', VERIFIED, 409, 'APPEAL_WINDOW_ACTIVE'],
    ['EscalatedForAdjudication', 6, 409, 'ESCALATED_FOR_ADJUDICATION'],
    ['DisputeWindowActive', 6, 409, 'DISPUTE_WINDOW_ACTIVE'],
    ['NotAgent', ASSIGNED, 403, 'FORBIDDEN'],
    ['InvalidStatus', FUNDED, 409, 'USE_CANCEL'],
    ['InvalidStatus', 4, 409, 'INVALID_STATUS'],
    ['reverted', ASSIGNED, 409, 'CLAIM_TIMEOUT_REJECTED'],
  ])('%s (status %i) → %i %s, with nothing built or recorded', async (revert, status, http, code) => {
    escrow.getTaskOn.mockResolvedValue(task(status));
    escrow.claimTimeoutRevertOn.mockResolvedValue(revert);
    const res = await claim();
    expect(res.status).toBe(http);
    expect(res.body.error.code).toBe(code);
    expect(escrow.buildClaimTimeoutOn).not.toHaveBeenCalled();
    expect(accountingService.recordTransaction).not.toHaveBeenCalled();
  });

  it('names the deadline a pause moved', async () => {
    escrow.claimTimeoutRevertOn.mockResolvedValue('DeadlineNotReached');
    escrow.effectiveDeadlineOn.mockResolvedValue(4_102_444_800n); // 2100-01-01
    const res = await claim();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DEADLINE_NOT_REACHED');
    expect(res.body.error.message).toContain('2100-01-01T00:00:00.000Z');
  });
});
