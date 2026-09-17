import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * recordWorkerPayout credits the executor through updateAgentStats, which
 * writes only the counters. Before, it saved the whole record through
 * registerAgent, the same upsert a booting worker uses. When the executor is
 * gone by the time of the write, nothing else happens and the credit stays
 * retryable.
 */

const { store, redisMock, sideEffects } = vi.hoisted(() => ({
  store: { getAgent: vi.fn(), updateAgentStats: vi.fn(), registerAgent: vi.fn() },
  redisMock: { set: vi.fn(), del: vi.fn() },
  sideEffects: {
    recordTransaction: vi.fn(),
    incrementSoldCount: vi.fn(async () => undefined),
    recordTaskCompletion: vi.fn(async () => undefined),
    recordDispute: vi.fn(async () => undefined),
  },
}));

vi.mock('./agentStore.js', () => store);
vi.mock('./redis.js', () => ({ redis: redisMock }));
vi.mock('./escrow.js', () => ({ feeBps: vi.fn(async () => 1000) }));
vi.mock('./accountingService.js', () => ({ recordTransaction: sideEffects.recordTransaction }));
vi.mock('./serviceStore.js', () => ({ incrementSoldCount: sideEffects.incrementSoldCount }));
vi.mock('./reputationDecay.js', () => ({
  recordTaskCompletion: sideEffects.recordTaskCompletion,
  recordDispute: sideEffects.recordDispute,
}));
vi.mock('./a2aStore.js', () => ({ getMeta: vi.fn(async () => undefined) }));
vi.mock('./semanticProof.js', () => ({ resolveProofSkillSlug: vi.fn(async () => null), mergeProofKeys: vi.fn(() => []) }));
vi.mock('./skillStatsStore.js', () => ({ recordCompletion: vi.fn(async () => []), recordFailure: vi.fn(async () => []) }));
vi.mock('./badgeStore.js', () => ({ grantEarnedBadge: vi.fn(async () => false) }));
vi.mock('./semanticMatch.js', () => ({ recordShadowOutcome: vi.fn(async () => undefined) }));

const { recordWorkerPayout, recordWorkerDispute } = await import('./workerPayout.js');

const EXEC = '0xecec000000000000000000000000000000000001';
const TASK = '0x' + 'ab'.repeat(32);

function agent() {
  return {
    address: EXEC, displayName: 'w', capabilities: [], publicKey: '04', registeredAt: '',
    reputation: 50, tasksCompleted: 2, totalEarnedRaw: '1000',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.set.mockResolvedValue('OK');
  redisMock.del.mockResolvedValue(1);
  store.getAgent.mockResolvedValue(agent());
  store.updateAgentStats.mockResolvedValue(true);
});

describe('recordWorkerPayout', () => {
  it('writes the counters through updateAgentStats, never the registration upsert', async () => {
    await recordWorkerPayout(TASK, EXEC, '7', 1_000_000n, { decimals: 6, serviceId: 3 });

    // 90% of 1,000,000 at feeBps 1000, added to the stored 1000.
    expect(store.updateAgentStats).toHaveBeenCalledWith(EXEC, expect.objectContaining({
      reputation: 51, tasksCompleted: 3, totalEarnedRaw: '901000',
    }));
    expect(store.registerAgent).not.toHaveBeenCalled();
    expect(sideEffects.incrementSoldCount).toHaveBeenCalledWith(3);
    expect(sideEffects.recordTransaction).toHaveBeenCalledTimes(1);
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it('does nothing else and releases the marker when the executor is gone at write time', async () => {
    store.updateAgentStats.mockResolvedValue(false);
    await recordWorkerPayout(TASK, EXEC, '7', 1_000_000n, { decimals: 6, serviceId: 3 });

    expect(redisMock.del).toHaveBeenCalledWith(`a2a:credited:${TASK}`);
    expect(sideEffects.incrementSoldCount).not.toHaveBeenCalled();
    expect(sideEffects.recordTransaction).not.toHaveBeenCalled();
    expect(sideEffects.recordTaskCompletion).not.toHaveBeenCalled();
  });

  it('skips a task that another path already credited', async () => {
    redisMock.set.mockResolvedValue(null);
    await recordWorkerPayout(TASK, EXEC, '7', 1_000_000n, { decimals: 6 });
    expect(store.getAgent).not.toHaveBeenCalled();
    expect(store.updateAgentStats).not.toHaveBeenCalled();
  });
});

describe('recordWorkerDispute', () => {
  it('lowers reputation through updateAgentStats', async () => {
    await recordWorkerDispute(TASK, EXEC);
    expect(store.updateAgentStats).toHaveBeenCalledWith(EXEC, expect.objectContaining({ reputation: 40 }));
    expect(store.registerAgent).not.toHaveBeenCalled();
  });
});
