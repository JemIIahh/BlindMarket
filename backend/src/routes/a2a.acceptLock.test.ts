import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * POST /accept runs its read-only prechecks BEFORE taking the per-task accept
 * lock. It used to take the lock first: a non-target agent's accept on a
 * pinned task held the lock while it was being refused, and the target's own
 * accept got 409 ACCEPT_LOCKED and waited for its next feed scan (5 min 12 s
 * in a local run). Same mocks as a2a.accept.test.ts, except the lock, which
 * is a real SET NX over a Map so concurrent requests contend for it.
 */

const lockStore = vi.hoisted(() => new Map<string, string>());

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || '0xagent' };
    next();
  },
}));

vi.mock('../services/a2aStore.js', () => ({
  getMeta: vi.fn(),
  tryAccept: vi.fn(),
  mergeWrappedKeys: vi.fn(),
  tryReleaseAccepted: vi.fn(() => Promise.resolve({ ok: true })),
  getState: vi.fn(),
  updateState: vi.fn(),
  getOffer: vi.fn(() => Promise.resolve(undefined)),
  clearOffer: vi.fn(() => Promise.resolve()),
  clearCascade: vi.fn(() => Promise.resolve()),
  tryExpire: vi.fn(() => Promise.resolve({ ok: true })),
  acquireAcceptLock: vi.fn(async (taskId: string, agent: string) => {
    if (lockStore.has(taskId)) return false;
    lockStore.set(taskId, agent);
    return true;
  }),
  releaseAcceptLock: vi.fn(async (taskId: string) => { lockStore.delete(taskId); }),
  logAcceptAttempt: vi.fn(() => Promise.resolve()),
  startSettlementDeadline: vi.fn(() => Promise.resolve()),
  clearSettlementDeadline: vi.fn(() => Promise.resolve()),
}));

vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn() }));
vi.mock('../services/delegationGuard.js', () => ({
  sameOwnerSubtask: vi.fn(async () => false),
  refuseUnapprovedDelegation: vi.fn(async () => {}),
}));
vi.mock('../services/keyCustodyService.js', () => ({
  getKeyCustodyService: vi.fn(() => null),
  isKeyCustodyEnabled: vi.fn(() => false),
}));
vi.mock('../services/a2aSettlement.js', () => ({
  settleAssignment: vi.fn(() => Promise.resolve({ success: true, txHash: '0xtx' })),
  settleVerification: vi.fn(() => Promise.resolve({ success: true, txHash: '0xtx' })),
}));
vi.mock('../services/redis.js', () => ({
  redis: { set: vi.fn(), get: vi.fn(), exists: vi.fn(), pipeline: vi.fn() },
}));
vi.mock('../services/chain.js', () => ({
  provider: {},
  escrow: { interface: {}, getAddress: vi.fn() },
}));
vi.mock('../services/escrow.js', () => ({ getTask: vi.fn(), getTaskOn: vi.fn(), feeBps: vi.fn(), getTaskVerifier: vi.fn() }));
vi.mock('../services/autoVerify.js', () => ({ autoVerify: vi.fn() }));
vi.mock('../services/accountingService.js', () => ({}));
vi.mock('../services/reputation.js', () => ({}));
vi.mock('../services/reputationDecay.js', () => ({}));
vi.mock('../services/bidsStore.js', () => ({ clearBids: vi.fn(async () => undefined) }));
vi.mock('../services/socket.js', () => ({
  emitTaskOffer: vi.fn(),
  emitTaskAvailable: vi.fn(),
  hasAgentSocket: vi.fn(() => false),
}));

import { a2aRouter } from './a2a.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as a2aStore from '../services/a2aStore.js';
import * as agentStore from '../services/agentStore.js';
import { pricingUnit } from '../services/settlementUnits.js';
import { sameOwnerSubtask } from '../services/delegationGuard.js';

const TARGET = '0xa000000000000000000000000000000000000001';
const STRANGER = '0xb000000000000000000000000000000000000002';
const TASK = '0xtaskhash';

function accept(as: string) {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return request(a).post(`/api/v1/a2a/tasks/${TASK}/accept`).set('x-test-address', as);
}

const executor = (address: string, extra: Record<string, unknown> = {}) =>
  ({ address, capabilities: [], publicKey: '04' + 'ab'.repeat(64), reputation: 50, tasksCompleted: 0, registeredAt: '', displayName: 'x', supportedChains: ['arc'], ...extra });
const openTask = (extra: Record<string, unknown> = {}) =>
  ({ taskId: TASK, requiredCapabilities: [], privacy: 'public', chain: 'arc', ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  lockStore.clear();
  vi.mocked(agentStore.getAgent).mockImplementation(async (a: string) => executor(a) as any);
  vi.mocked(a2aStore.getState).mockResolvedValue({ taskId: TASK, status: 'open' } as any);
  vi.mocked(a2aStore.getOffer).mockResolvedValue(undefined);
  vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);
  vi.mocked(sameOwnerSubtask).mockResolvedValue(false);
});

describe('POST /accept — a refused precheck never takes the accept lock', () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  it.each([
    ['NOT_FOUND', 404, () => vi.mocked(a2aStore.getMeta).mockResolvedValue(undefined)],
    ['TASK_EXPIRED', 409, () => vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask({ deadline: past }) as any)],
    ['SELF_ACCEPT', 403, () => vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask({ posterAddress: STRANGER }) as any)],
    ['IS_VERIFIER', 403, () => vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask({ verifierAddress: STRANGER }) as any)],
    ['NOT_REGISTERED', 403, () => {
      vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask() as any);
      vi.mocked(agentStore.getAgent).mockResolvedValue(undefined);
    }],
    ['NOT_TARGET_EXECUTOR', 403, () => vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask({ targetExecutor: TARGET }) as any)],
    ['SAME_OWNER', 403, () => {
      vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask({ posterAddress: TARGET }) as any);
      vi.mocked(sameOwnerSubtask).mockResolvedValue(true);
    }],
    ['NEEDS_WRAP', 403, () => vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask({ privacy: undefined, rootHash: '0xroot', wrappedKeys: {} }) as any)],
    ['OFFER_HELD', 409, () => {
      vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask() as any);
      vi.mocked(a2aStore.getOffer).mockResolvedValue({ address: TARGET, score: 1, expiresAt: Date.now() + 60_000 });
    }],
    ['CHAIN_UNSUPPORTED', 409, () => {
      vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask() as any);
      vi.mocked(agentStore.getAgent).mockResolvedValue(executor(STRANGER, { supportedChains: ['base'] }) as any);
    }],
    ['BELOW_MIN_REWARD', 403, () => {
      vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask({ reward: { amount: '1', unit: pricingUnit() } }) as any);
      vi.mocked(agentStore.getAgent).mockResolvedValue(executor(STRANGER, { minReward: '5000000' }) as any);
    }],
  ] as const)('%s', async (code, status, arrange) => {
    arrange();
    const res = await accept(STRANGER);
    expect({ status: res.status, code: res.body.error?.code }).toEqual({ status, code });
    expect(a2aStore.acquireAcceptLock).not.toHaveBeenCalled();
    expect(a2aStore.releaseAcceptLock).not.toHaveBeenCalled();
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
  });
});

describe('POST /accept — a pinned task', () => {
  it("a non-target's accept in flight does not lock out the target", async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask({ targetExecutor: TARGET }) as any);
    // Hold the stranger's request mid-way, at its registration read.
    let releaseStranger!: () => void;
    const strangerParked = new Promise<void>((r) => { releaseStranger = r; });
    vi.mocked(agentStore.getAgent).mockImplementation(async (a: string) => {
      if (a === STRANGER) await strangerParked;
      return executor(a) as any;
    });

    const stranger = accept(STRANGER).then((r) => r);
    await vi.waitFor(() => expect(agentStore.getAgent).toHaveBeenCalledWith(STRANGER));

    const target = await accept(TARGET);
    expect(target.status).toBe(200);
    expect(target.body.data.status).toBe('accepted');

    releaseStranger();
    const refused = await stranger;
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('NOT_TARGET_EXECUTOR');
    // The target's accept lets the lock go once its post-response work ends.
    await vi.waitFor(() => expect(lockStore.size).toBe(0));
  });
});

describe('POST /accept — the executor gates and the lock', () => {
  it('re-checks the executor gates under the lock when the task was released since the precheck', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask() as any);
    // It no longer signs on arc, but held the task, so the precheck let it by.
    vi.mocked(agentStore.getAgent).mockResolvedValue(executor(STRANGER, { supportedChains: ['base'] }) as any);
    vi.mocked(a2aStore.getState)
      .mockResolvedValueOnce({ taskId: TASK, status: 'accepted', executorAddress: STRANGER } as any)
      .mockResolvedValue({ taskId: TASK, status: 'open' } as any);

    const res = await accept(STRANGER);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHAIN_UNSUPPORTED');
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
    expect(lockStore.size).toBe(0);
  });

  it('a lost compare-and-set still gives the lock back', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask() as any);
    vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: false, currentStatus: 'accepted' } as any);
    const res = await accept(STRANGER);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_OPEN');
    expect(a2aStore.acquireAcceptLock).toHaveBeenCalledTimes(1);
    expect(lockStore.size).toBe(0);
  });
});
