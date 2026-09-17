import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * recordWorkerPayout credits the worker's share to the earnings total of the
 * task's currency (native 0G or USDC), never both, through agentStore's
 * counter-only writes. A task in a token BlindMarket doesn't settle in is
 * parked instead of credited, without throwing: every caller has already
 * recorded the on-chain settlement by then.
 */

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NATIVE = '0x0000000000000000000000000000000000000000';

const { store, redisMock, sideEffects } = vi.hoisted(() => ({
  store: { creditPayout: vi.fn(), adjustReputation: vi.fn(), registerAgent: vi.fn(), hasEarningsTotal: vi.fn() },
  redisMock: { set: vi.fn(), del: vi.fn(), sadd: vi.fn() },
  sideEffects: {
    recordTransaction: vi.fn(),
    incrementSoldCount: vi.fn(async () => undefined),
    recordTaskCompletion: vi.fn(async () => undefined),
    recordDispute: vi.fn(async () => undefined),
  },
}));

vi.mock('../config.js', () => ({ config: { baseEscrowAddress: '0xescrow', baseUsdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' } }));
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
const onBase = { chain: 'base' as const, token: USDC };
const onZeroG = { chain: '0g' as const, token: NATIVE };

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.set.mockResolvedValue('OK');
  redisMock.del.mockResolvedValue(1);
  store.creditPayout.mockResolvedValue(true);
  store.adjustReputation.mockResolvedValue(true);
  store.hasEarningsTotal.mockReturnValue(true);
});

describe('recordWorkerPayout', () => {
  it('credits a Base USDC payout to the USDC total, and mirrors it to the ledger in USDC', async () => {
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { serviceId: 3 });

    // 90% of 5 USDC at feeBps 1000.
    expect(store.creditPayout).toHaveBeenCalledWith(EXEC, { symbol: 'USDC', decimals: 6 }, 4_500_000n);
    expect(store.registerAgent).not.toHaveBeenCalled();
    expect(sideEffects.incrementSoldCount).toHaveBeenCalledWith(3);
    expect(sideEffects.recordTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: 5, fee: 0.5, net: 4.5 }));
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it('credits a native 0G payout to the 0G total', async () => {
    await recordWorkerPayout(TASK, EXEC, '7', 10n ** 18n, onZeroG);
    expect(store.creditPayout).toHaveBeenCalledWith(EXEC, { symbol: '0G', decimals: 18 }, 9n * 10n ** 17n);
    expect(sideEffects.recordTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: 1, net: 0.9 }));
  });

  it('still pays a USDC worker when there is a compute cost (it used to be scaled as 0G and zero the share)', async () => {
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { computeCostMicroUnits: 1000 });
    const [, , share] = store.creditPayout.mock.calls[0] as [string, string, bigint];
    expect(share).toBe(((5_000_000n - 1000n) * 9000n) / 10000n);
    expect(share > 0n).toBe(true);
  });

  it('scales a compute cost to 0G units on 0G', async () => {
    await recordWorkerPayout(TASK, EXEC, '7', 10n ** 18n, onZeroG, { computeCostMicroUnits: 1000 });
    expect(store.creditPayout).toHaveBeenCalledWith(EXEC, { symbol: '0G', decimals: 18 }, ((10n ** 18n - 1000n * 10n ** 12n) * 9000n) / 10000n);
  });

  it('does nothing else and releases the marker when the executor is not registered', async () => {
    store.creditPayout.mockResolvedValue(false);
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { serviceId: 3 });

    expect(redisMock.del).toHaveBeenCalledWith(`a2a:credited:${TASK}`);
    expect(sideEffects.incrementSoldCount).not.toHaveBeenCalled();
    expect(sideEffects.recordTransaction).not.toHaveBeenCalled();
    expect(sideEffects.recordTaskCompletion).not.toHaveBeenCalled();
  });

  it('skips a task that another path already credited', async () => {
    redisMock.set.mockResolvedValue(null);
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase);
    expect(store.creditPayout).not.toHaveBeenCalled();
  });

  it.each([
    ['an ERC-20 on 0G', { chain: '0g' as const, token: USDC }],
    ['native value on Base', { chain: 'base' as const, token: NATIVE }],
  ])('parks %s instead of crediting it, and does not throw even with rethrow', async (_label, settlement) => {
    await expect(recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, settlement, { rethrow: true, serviceId: 3 })).resolves.toBeUndefined();

    expect(store.creditPayout).not.toHaveBeenCalled();
    expect(sideEffects.incrementSoldCount).not.toHaveBeenCalled();
    expect(sideEffects.recordTransaction).not.toHaveBeenCalled();
    // Not marked as credited, so a later build that knows the token can.
    expect(redisMock.set).not.toHaveBeenCalledWith(`a2a:credited:${TASK}`, expect.anything(), 'NX');
    expect(redisMock.set).toHaveBeenCalledWith(`a2a:uncredited:${TASK}`, expect.stringContaining('"grossAmount":"5000000"'));
    expect(redisMock.sadd).toHaveBeenCalledWith('a2a:uncredited:all', TASK);
  });

  it('parks a unit that no earnings total holds as-is, instead of throwing inside a listener', async () => {
    store.hasEarningsTotal.mockReturnValue(false);
    await expect(recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { rethrow: true })).resolves.toBeUndefined();
    expect(store.creditPayout).not.toHaveBeenCalled();
    expect(redisMock.sadd).toHaveBeenCalledWith('a2a:uncredited:all', TASK);
  });

  it('keeps the credit and does not throw when the ledger write fails', async () => {
    sideEffects.recordTransaction.mockRejectedValueOnce(new Error('db down'));
    await expect(recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { rethrow: true })).resolves.toBeUndefined();
    expect(store.creditPayout).toHaveBeenCalledTimes(1);
    expect(redisMock.del).not.toHaveBeenCalled();
    expect(sideEffects.recordTaskCompletion).toHaveBeenCalled();
  });
});

describe('recordWorkerDispute', () => {
  it('lowers reputation by 10 without touching the other counters', async () => {
    await recordWorkerDispute(TASK, EXEC);
    expect(store.adjustReputation).toHaveBeenCalledWith(EXEC, -10);
    expect(store.creditPayout).not.toHaveBeenCalled();
    expect(store.registerAgent).not.toHaveBeenCalled();
  });
});
