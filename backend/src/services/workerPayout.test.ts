import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * recordWorkerPayout credits the worker's share to the earnings total of the
 * task's currency (native 0G or USDC), never both, through agentStore's
 * counter-only writes. A task in a token BlindMarket doesn't settle in is
 * parked instead of credited, without throwing: every caller has already
 * recorded the on-chain settlement by then.
 */

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const NATIVE = '0x0000000000000000000000000000000000000000';

const { store, redisMock, sideEffects, escrowMock, ledger } = vi.hoisted(() => ({
  store: { creditPayout: vi.fn(), adjustReputation: vi.fn(), registerAgent: vi.fn(), hasEarningsTotal: vi.fn() },
  redisMock: { set: vi.fn(), del: vi.fn(), sadd: vi.fn() },
  // Each chain's escrow has its own fee; the tests below pin that the split
  // follows the task's chain.
  escrowMock: { feeBps: vi.fn(async () => 1000), feeBpsOn: vi.fn(async (_chain: string) => 1000) },
  // The durable credit row (creditLedger.ts) behind the Redis marker.
  ledger: { claimCredit: vi.fn(async () => true), releaseCredit: vi.fn(async () => undefined) },
  sideEffects: {
    recordTransaction: vi.fn(),
    incrementSoldCount: vi.fn(async () => undefined),
    recordTaskCompletion: vi.fn(async () => undefined),
    recordDispute: vi.fn(async () => undefined),
  },
}));

vi.mock('../config.js', () => ({ config: { baseEscrowAddress: '0xescrow', baseUsdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', arcEscrowAddress: '0xarcEscrow', arcUsdcAddress: '0x3600000000000000000000000000000000000000' } }));
vi.mock('./agentStore.js', () => store);
vi.mock('./redis.js', () => ({ redis: redisMock }));
vi.mock('./escrow.js', () => escrowMock);
vi.mock('./creditLedger.js', () => ledger);
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
const onArc = { chain: 'arc' as const, token: ARC_USDC };

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.set.mockResolvedValue('OK');
  redisMock.del.mockResolvedValue(1);
  store.creditPayout.mockResolvedValue(true);
  store.adjustReputation.mockResolvedValue(true);
  store.hasEarningsTotal.mockReturnValue(true);
  escrowMock.feeBpsOn.mockImplementation(async () => 1000);
  ledger.claimCredit.mockResolvedValue(true);
});

describe('recordWorkerPayout', () => {
  it('credits a Base USDC payout to the USDC total, and mirrors it to the ledger in USDC', async () => {
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { serviceId: 3 });

    // 90% of 5 USDC at feeBps 1000.
    expect(store.creditPayout).toHaveBeenCalledWith(EXEC, { symbol: 'USDC', decimals: 6 }, 4_500_000n);
    expect(store.registerAgent).not.toHaveBeenCalled();
    expect(sideEffects.incrementSoldCount).toHaveBeenCalledWith(3);
    expect(sideEffects.recordTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: 5, fee: 0.5, net: 4.5, unit: 'USDC' }));
    expect(redisMock.del).not.toHaveBeenCalled();
    expect(ledger.claimCredit).toHaveBeenCalledWith(TASK, 'base', EXEC);
  });

  it('credits an Arc USDC payout to the USDC total', async () => {
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onArc);
    expect(store.creditPayout).toHaveBeenCalledWith(EXEC, { symbol: 'USDC', decimals: 6 }, 4_500_000n);
    expect(sideEffects.recordTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: 5, net: 4.5, unit: 'USDC' }));
  });

  it("splits with the fee of the task's OWN chain's escrow, cached per chain", async () => {
    // A fresh module: the fee cache is per process.
    vi.resetModules();
    const fresh = await import('./workerPayout.js');
    escrowMock.feeBpsOn.mockImplementation(async (chain: string) => (chain === 'base' ? 800 : 1000));
    await fresh.recordWorkerPayout(TASK, EXEC, '7', 1_000_000n, onBase);
    await fresh.recordWorkerPayout('0x' + 'ac'.repeat(32), EXEC, '8', 5_000_000n, onArc);
    await fresh.recordWorkerPayout('0x' + 'ad'.repeat(32), EXEC, '9', 1_000_000n, onBase);
    // 800 bps on Base → 92%; 1000 bps on Arc → 90%.
    expect(store.creditPayout).toHaveBeenNthCalledWith(1, EXEC, { symbol: 'USDC', decimals: 6 }, 920_000n);
    expect(store.creditPayout).toHaveBeenNthCalledWith(2, EXEC, { symbol: 'USDC', decimals: 6 }, 4_500_000n);
    expect(store.creditPayout).toHaveBeenNthCalledWith(3, EXEC, { symbol: 'USDC', decimals: 6 }, 920_000n);
    expect(escrowMock.feeBpsOn.mock.calls.map(([c]) => c)).toEqual(['base', 'arc']);
    expect(sideEffects.recordTransaction).toHaveBeenNthCalledWith(1, expect.objectContaining({ fee: 0.08, net: 0.92 }));
  });

  it('stops at the database credit row when the Redis marker is gone (a snapshot restore)', async () => {
    ledger.claimCredit.mockResolvedValueOnce(false);
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase);
    expect(store.creditPayout).not.toHaveBeenCalled();
    expect(sideEffects.recordTransaction).not.toHaveBeenCalled();
    // Both gates agree the task is credited: the marker stays.
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it('treats a database failure while claiming the row as a failed credit', async () => {
    ledger.claimCredit.mockRejectedValueOnce(new Error('connection refused'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase);
    expect(store.creditPayout).not.toHaveBeenCalled();
    expect(redisMock.del).toHaveBeenCalledWith(`a2a:credited:${TASK}`);
    expect(ledger.releaseCredit).toHaveBeenCalledWith(TASK);
  });

  it('releases the row and the marker when the credit throws, and rethrows for the listener', async () => {
    store.creditPayout.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { rethrow: true })).rejects.toThrow('db down');
    expect(ledger.releaseCredit).toHaveBeenCalledWith(TASK);
    expect(redisMock.del).toHaveBeenCalledWith(`a2a:credited:${TASK}`);
  });

  it('still pays a USDC worker when there is a compute cost (it used to be scaled as 0G and zero the share)', async () => {
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { computeCostMicroUnits: 1000 });
    const [, , share] = store.creditPayout.mock.calls[0] as [string, string, bigint];
    expect(share).toBe(((5_000_000n - 1000n) * 9000n) / 10000n);
    expect(share > 0n).toBe(true);
  });

  it('scales a compute cost to Arc USDC units on Arc', async () => {
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onArc, { computeCostMicroUnits: 1000 });
    expect(store.creditPayout).toHaveBeenCalledWith(EXEC, { symbol: 'USDC', decimals: 6 }, ((5_000_000n - 1000n) * 9000n) / 10000n);
  });

  it('does nothing else and releases the marker when the executor is not registered', async () => {
    store.creditPayout.mockResolvedValue(false);
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { serviceId: 3 });

    expect(redisMock.del).toHaveBeenCalledWith(`a2a:credited:${TASK}`);
    expect(ledger.releaseCredit).toHaveBeenCalledWith(TASK);
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
    ['native value on Arc', { chain: 'arc' as const, token: NATIVE }],
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
    expect(ledger.claimCredit).not.toHaveBeenCalled();
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
