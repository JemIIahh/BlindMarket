import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * POST /accept applies the executor's minReward (security audit run 1, C05).
 * Same mocks as a2a.accept.test.ts, plus the on-chain read for rows indexed
 * before meta carried the reward.
 */

vi.mock('../middleware/auth.js', () => ({
  // Inject the authenticated address from a header so each request can pick its
  // caller. Bypasses Privy/JWT entirely.
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || '0xagent' };
    next();
  },
}));

vi.mock('../services/a2aStore.js', () => ({
  getMeta: vi.fn(),
  tryAccept: vi.fn(),
  mergeWrappedKeys: vi.fn(),
  releaseToOpen: vi.fn(),
  tryReleaseAccepted: vi.fn(() => Promise.resolve({ ok: true })),
  setMeta: vi.fn(),
  getState: vi.fn(),
  updateState: vi.fn(),
  getPosterTasks: vi.fn(),
  getExecutorTasks: vi.fn(),
  browseAgentTasks: vi.fn(),
  getIndexedHashes: vi.fn(),
  // Offer ops — default to "no offer" so existing tests pass unchanged
  getOffer: vi.fn(() => Promise.resolve(undefined)),
  checkOffer: vi.fn(() => Promise.resolve(false)),
  clearOffer: vi.fn(() => Promise.resolve()),
  setOffer: vi.fn(() => Promise.resolve()),
  // Cascade ops
  clearCascade: vi.fn(() => Promise.resolve()),
  // Expiry ops (batch-4)
  tryExpire: vi.fn(() => Promise.resolve({ ok: true })),
  listOpenTasks: vi.fn(() => Promise.resolve([])),
  cacheDeadline: vi.fn(() => Promise.resolve()),
  getCachedDeadline: vi.fn(() => Promise.resolve(null)),
  // Accept lock + attempt logging (Part 1)
  acquireAcceptLock: vi.fn(() => Promise.resolve(true)),
  releaseAcceptLock: vi.fn(() => Promise.resolve()),
  logAcceptAttempt: vi.fn(() => Promise.resolve()),
  getAcceptAttempts: vi.fn(() => Promise.resolve([])),
  // Gas-liveness (Part 3)
  startSettlementDeadline: vi.fn(() => Promise.resolve()),
  clearSettlementDeadline: vi.fn(() => Promise.resolve()),
  getSettlementDeadlineTTL: vi.fn(() => Promise.resolve(-2)),
}));

vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn() }));

vi.mock('../services/keyCustodyService.js', () => ({
  getKeyCustodyService: vi.fn(() => null),
  isKeyCustodyEnabled: vi.fn(() => false),
}));

vi.mock('../services/a2aSettlement.js', () => ({
  settleAssignment: vi.fn(() => Promise.resolve({ success: true, txHash: '0xtx' })),
  // settleVerification now returns a SettleResult that /finalize and /verify
  // gate on — an undefined resolution would TypeError inside the route.
  settleVerification: vi.fn(() => Promise.resolve({ success: true, txHash: '0xtx' })),
}));

// Import-side-effect-heavy modules (Redis / chain / DB). Mock so importing the
// router is pure. /accept touches none of these, so minimal stubs suffice.
vi.mock('../services/redis.js', () => ({
  redis: { set: vi.fn(), get: vi.fn(), exists: vi.fn(), pipeline: vi.fn() },
}));
vi.mock('../services/chain.js', () => ({
  provider: {},
  escrow: { interface: {}, getAddress: vi.fn() },
}));
vi.mock('../services/escrow.js', () => ({ getTask: vi.fn(), getTaskOn: vi.fn(), feeBps: vi.fn(), getTaskVerifier: vi.fn() }));
vi.mock('../services/taskChain.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/taskChain.js')>()),
  resolveTaskByHash: vi.fn(async () => ({ chain: 'arc', taskId: '7' })),
}));
vi.mock('../services/escrowEvents.js', () => ({
  getTaskIdByHash: vi.fn(),
  getCachedTaskIdByHash: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../services/autoVerify.js', () => ({ autoVerify: vi.fn() }));
vi.mock('../services/accountingService.js', () => ({}));
vi.mock('../services/reputation.js', () => ({}));
vi.mock('../services/reputationDecay.js', () => ({}));
vi.mock('../services/bidsStore.js', () => ({ clearBids: vi.fn(async () => undefined) }));
// Observed, not just silenced: a re-opened task is announced on the tasks room,
// and a lost compare-and-set release must NOT be.
vi.mock('../services/socket.js', () => ({
  emitTaskOffer: vi.fn(),
  emitTaskAvailable: vi.fn(),
  hasAgentSocket: vi.fn(() => false),
}));

import { a2aRouter } from './a2a.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as a2aStore from '../services/a2aStore.js';
import * as agentStore from '../services/agentStore.js';
import * as keyCustody from '../services/keyCustodyService.js';
import * as escrowService from '../services/escrow.js';
import { pricingUnit, payoutCurrency } from '../services/settlementUnits.js';
import { settlementChainConfig } from '../services/settlementChains.js';

const AGENT = '0xagent0000000000000000000000000000000001';
const TASK = '0xtaskhash';

function accept() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return request(a).post(`/api/v1/a2a/tasks/${TASK}/accept`).set('x-test-address', AGENT);
}

const USDC = pricingUnit();
const floored = { address: AGENT, capabilities: [], publicKey: '04' + 'ab'.repeat(64), reputation: 50, tasksCompleted: 0, registeredAt: '', displayName: 'a', minReward: '5000000' };
const openTask = (extra: Record<string, unknown> = {}) => ({ taskId: TASK, requiredCapabilities: [], privacy: 'public', ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(keyCustody.getKeyCustodyService).mockReturnValue(null);
  vi.mocked(agentStore.getAgent).mockResolvedValue(floored as any);
  vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: false, currentStatus: 'accepted' } as any);
});

describe('POST /accept — executor minimum reward', () => {
  it('refuses a task below the floor with 403 BELOW_MIN_REWARD, before the compare-and-set', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask({ reward: { amount: '1', unit: USDC } }) as any);
    const res = await accept();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BELOW_MIN_REWARD');
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
  });

  it('lets a task at the floor through to the compare-and-set', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask({ reward: { amount: '5000000', unit: USDC } }) as any);
    await accept();
    expect(a2aStore.tryAccept).toHaveBeenCalled();
  });

  it('exempts a rental: the owner priced that service', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask({ reward: { amount: '1', unit: USDC }, serviceId: 3, targetExecutor: AGENT }) as any);
    await accept();
    expect(a2aStore.tryAccept).toHaveBeenCalled();
  });

  it('reads the escrow from the chain for a row indexed before meta carried the reward', async () => {
    const arcToken = settlementChainConfig('arc').token.address!;
    expect(payoutCurrency('arc', arcToken)).not.toBeNull();
    vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask() as any);
    vi.mocked(escrowService.getTaskOn).mockResolvedValue({ amount: 1n, token: arcToken } as any);
    const res = await accept();
    expect(res.body.error.code).toBe('BELOW_MIN_REWARD');
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
  });

  it('answers a retryable 503 when the legacy reward cannot be read', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask() as any);
    vi.mocked(escrowService.getTaskOn).mockRejectedValue(new Error('rpc down'));
    const res = await accept();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('REWARD_UNAVAILABLE');
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
  });

  it('does nothing for an agent with no floor', async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue({ ...floored, minReward: undefined } as any);
    vi.mocked(a2aStore.getMeta).mockResolvedValue(openTask({ reward: { amount: '1', unit: USDC } }) as any);
    await accept();
    expect(a2aStore.tryAccept).toHaveBeenCalled();
    expect(escrowService.getTaskOn).not.toHaveBeenCalled();
  });
});
