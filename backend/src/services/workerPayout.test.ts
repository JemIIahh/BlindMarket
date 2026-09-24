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
  store: { creditPayoutOnce: vi.fn(), adjustReputation: vi.fn(), registerAgent: vi.fn(), hasEarningsTotal: vi.fn() },
  redisMock: { set: vi.fn(), del: vi.fn(), sadd: vi.fn() },
  // Each chain's escrow has its own fee; the tests below pin that the split
  // follows the task's chain.
  escrowMock: { feeBps: vi.fn(async () => 1000), feeBpsOn: vi.fn(async (_chain: string) => 1000) },
  // The durable credit row (creditLedger.ts) behind the Redis marker. It is
  // claimed inside agentStore.creditPayoutOnce; releaseCredit must never run.
  ledger: {
    claimCredit: vi.fn(async () => true),
    releaseCredit: vi.fn(async () => undefined),
    isCredited: vi.fn(async () => false),
  },
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
  // mockReset: a once-value a failing test left unconsumed must not leak on.
  redisMock.set.mockReset().mockResolvedValue('OK');
  redisMock.del.mockResolvedValue(1);
  store.creditPayoutOnce.mockReset().mockResolvedValue('credited');
  store.adjustReputation.mockResolvedValue(true);
  store.hasEarningsTotal.mockReturnValue(true);
  escrowMock.feeBpsOn.mockImplementation(async () => 1000);
  ledger.isCredited.mockReset().mockResolvedValue(false);
});

const USDC_UNIT = { symbol: 'USDC', decimals: 6 };
const claimOn = (chain: string, taskHash = TASK) => ({ taskHash, chain });

describe('recordWorkerPayout', () => {
  it('credits a Base USDC payout to the USDC total, and mirrors it to the ledger in USDC', async () => {
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { serviceId: 3 });

    // 90% of 5 USDC at feeBps 1000, claimed and credited in one transaction.
    expect(store.creditPayoutOnce).toHaveBeenCalledWith(claimOn('base'), EXEC, USDC_UNIT, 4_500_000n);
    expect(store.registerAgent).not.toHaveBeenCalled();
    expect(sideEffects.incrementSoldCount).toHaveBeenCalledWith(3);
    expect(sideEffects.recordTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: 5, fee: 0.5, net: 4.5, unit: 'USDC' }));
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it('credits an Arc USDC payout to the USDC total', async () => {
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onArc);
    expect(store.creditPayoutOnce).toHaveBeenCalledWith(claimOn('arc'), EXEC, USDC_UNIT, 4_500_000n);
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
    expect(store.creditPayoutOnce).toHaveBeenNthCalledWith(1, claimOn('base'), EXEC, USDC_UNIT, 920_000n);
    expect(store.creditPayoutOnce).toHaveBeenNthCalledWith(2, claimOn('arc', '0x' + 'ac'.repeat(32)), EXEC, USDC_UNIT, 4_500_000n);
    expect(store.creditPayoutOnce).toHaveBeenNthCalledWith(3, claimOn('base', '0x' + 'ad'.repeat(32)), EXEC, USDC_UNIT, 920_000n);
    expect(escrowMock.feeBpsOn.mock.calls.map(([c]) => c)).toEqual(['base', 'arc']);
    expect(sideEffects.recordTransaction).toHaveBeenNthCalledWith(1, expect.objectContaining({ fee: 0.08, net: 0.92 }));
  });

  it('stops at the database credit row when the Redis marker is gone (a snapshot restore)', async () => {
    store.creditPayoutOnce.mockResolvedValueOnce('duplicate');
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase);
    expect(sideEffects.recordTransaction).not.toHaveBeenCalled();
    expect(sideEffects.recordTaskCompletion).not.toHaveBeenCalled();
    // Both gates agree the task is credited: the marker stays.
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it('drops only its own marker when the claim-and-credit throws, and rethrows for the listener', async () => {
    store.creditPayoutOnce.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { rethrow: true })).rejects.toThrow('db down');
    // This call set the marker, so it goes and a retry can credit; the
    // transaction rolled back, so there is no row to give back.
    expect(redisMock.del).toHaveBeenCalledWith(`a2a:credited:${TASK}`);
    expect(ledger.releaseCredit).not.toHaveBeenCalled();
    expect(sideEffects.recordTaskCompletion).not.toHaveBeenCalled();
  });

  it('still pays a USDC worker when there is a compute cost (it used to be scaled as 0G and zero the share)', async () => {
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { computeCostMicroUnits: 1000 });
    const [, , , share] = store.creditPayoutOnce.mock.calls[0] as [unknown, string, unknown, bigint];
    expect(share).toBe(((5_000_000n - 1000n) * 9000n) / 10000n);
    expect(share > 0n).toBe(true);
  });

  it('scales a compute cost to Arc USDC units on Arc', async () => {
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onArc, { computeCostMicroUnits: 1000 });
    expect(store.creditPayoutOnce).toHaveBeenCalledWith(claimOn('arc'), EXEC, USDC_UNIT, ((5_000_000n - 1000n) * 9000n) / 10000n);
  });

  it('does nothing else and releases the marker when the executor is not registered', async () => {
    store.creditPayoutOnce.mockResolvedValue('unregistered');
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { serviceId: 3 });

    expect(redisMock.del).toHaveBeenCalledWith(`a2a:credited:${TASK}`);
    expect(ledger.releaseCredit).not.toHaveBeenCalled();
    expect(sideEffects.incrementSoldCount).not.toHaveBeenCalled();
    expect(sideEffects.recordTransaction).not.toHaveBeenCalled();
    expect(sideEffects.recordTaskCompletion).not.toHaveBeenCalled();
  });

  it('skips a task that another path already credited', async () => {
    redisMock.set.mockResolvedValue(null);
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase);
    expect(store.creditPayoutOnce).not.toHaveBeenCalled();
  });

  it.each([
    ['native value on Arc', { chain: 'arc' as const, token: NATIVE }],
    ['native value on Base', { chain: 'base' as const, token: NATIVE }],
  ])('parks %s instead of crediting it, and does not throw even with rethrow', async (_label, settlement) => {
    await expect(recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, settlement, { rethrow: true, serviceId: 3 })).resolves.toBeUndefined();

    expect(store.creditPayoutOnce).not.toHaveBeenCalled();
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
    expect(store.creditPayoutOnce).not.toHaveBeenCalled();
    expect(redisMock.sadd).toHaveBeenCalledWith('a2a:uncredited:all', TASK);
  });

  it('keeps the credit and does not throw when the ledger write fails', async () => {
    sideEffects.recordTransaction.mockRejectedValueOnce(new Error('db down'));
    await expect(recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { rethrow: true })).resolves.toBeUndefined();
    expect(store.creditPayoutOnce).toHaveBeenCalledTimes(1);
    expect(redisMock.del).not.toHaveBeenCalled();
    expect(sideEffects.recordTaskCompletion).toHaveBeenCalled();
  });
});

/**
 * A settled task can be observed again after it was credited (a repeat
 * /submissions/confirm, a /finalize or /verdict retry, a DisputeResolved
 * re-scan). If that re-observation hit a Redis or database fault, the catch
 * used to delete the credited_payouts row and the marker the EARLIER credit
 * wrote, and the next observation credited the task a second time (security
 * audit run 1, C34). A failed observation now undoes only what it did.
 */
describe('recordWorkerPayout: a faulted re-observation never releases an earlier credit', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('keeps both gates when the marker SET fails on an already-credited task', async () => {
    redisMock.set.mockRejectedValueOnce(new Error('Reached the max retries per request limit'));
    store.creditPayoutOnce.mockResolvedValueOnce('duplicate');
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { rethrow: true });
    expect(ledger.releaseCredit).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
    expect(sideEffects.recordTransaction).not.toHaveBeenCalled();
  });

  it('still credits through the database claim when the marker SET fails on a new task', async () => {
    redisMock.set.mockRejectedValueOnce(new Error('OOM command not allowed'));
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase);
    expect(store.creditPayoutOnce).toHaveBeenCalledTimes(1);
    expect(sideEffects.recordTaskCompletion).toHaveBeenCalledTimes(1);
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it('never deletes the earlier credit row when the claim throws after the marker was lost', async () => {
    store.creditPayoutOnce.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    await expect(recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase, { rethrow: true })).rejects.toThrow('Connection terminated');
    expect(ledger.releaseCredit).not.toHaveBeenCalled();
  });

  it.each([
    ['a credit row stands behind it', async () => true, false],
    ['the row check fails too', async () => { throw new Error('db down'); }, false],
    ['no credit row stands behind it', async () => false, true],
  ])('with the SET and the credit both failing, drops the marker only when %s', async (_label, credited, dropped) => {
    redisMock.set.mockRejectedValueOnce(new Error('socket closed'));
    store.creditPayoutOnce.mockRejectedValueOnce(new Error('db down'));
    ledger.isCredited.mockImplementationOnce(credited);
    await recordWorkerPayout(TASK, EXEC, '7', 5_000_000n, onBase);
    expect(ledger.releaseCredit).not.toHaveBeenCalled();
    if (dropped) expect(redisMock.del).toHaveBeenCalledWith(`a2a:credited:${TASK}`);
    else expect(redisMock.del).not.toHaveBeenCalled();
  });
});

describe('recordWorkerDispute', () => {
  const round = (attempt: number | 'ruling', taskId = '7') => ({ chain: 'arc' as const, taskId, attempt });

  it('lowers reputation by 10 without touching the other counters', async () => {
    expect(await recordWorkerDispute(TASK, EXEC, round(1))).toBe(true);
    expect(store.adjustReputation).toHaveBeenCalledWith(EXEC, -10);
    expect(store.creditPayoutOnce).not.toHaveBeenCalled();
    expect(store.registerAgent).not.toHaveBeenCalled();
  });

  /**
   * One failed round is one dispute, however many observers see it: an A2A
   * route (/finalize, /verify, /verdict) and a replay of the round's
   * settlement tx to /submissions/confirm used to record it twice (security
   * audit run 1, C21). Every observer passes the same round key.
   */
  describe('at most once per failed round', () => {
    const keys = new Map<string, string>();
    beforeEach(() => {
      keys.clear();
      redisMock.set.mockImplementation(async (k: string, v: string, mode?: string) => {
        if (mode === 'NX' && keys.has(k)) return null;
        keys.set(k, v);
        return 'OK';
      });
      redisMock.del.mockImplementation(async (k: string) => Number(keys.delete(k)));
    });

    it('records a round once, and a later round again', async () => {
      expect(await recordWorkerDispute(TASK, EXEC, round(1))).toBe(true);
      expect(await recordWorkerDispute(TASK, EXEC.toUpperCase().replace('0X', '0x'), round(1))).toBe(false);
      expect(await recordWorkerDispute(TASK, EXEC, round(2))).toBe(true);
      expect(await recordWorkerDispute(TASK, EXEC, round(1, '8'))).toBe(true);
      expect(await recordWorkerDispute(TASK, EXEC, round('ruling'))).toBe(true);
      expect(store.adjustReputation).toHaveBeenCalledTimes(4);
      expect(sideEffects.recordDispute).toHaveBeenCalledTimes(4);
      expect([...keys.keys()]).toContain('a2a:dispute-round:arc:7:1');
    });

    it('gives the round back when recording fails, so a later observer records it', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      sideEffects.recordDispute.mockRejectedValueOnce(new Error('db down'));
      await expect(recordWorkerDispute(TASK, EXEC, round(1), { rethrow: true })).rejects.toThrow('db down');
      expect(keys.has('a2a:dispute-round:arc:7:1')).toBe(false);
      expect(await recordWorkerDispute(TASK, EXEC, round(1))).toBe(true);
    });

    it('records nothing, and deletes nothing, when the round key cannot be taken', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      keys.set('a2a:dispute-round:arc:7:1', EXEC);
      redisMock.set.mockRejectedValueOnce(new Error('socket closed'));
      expect(await recordWorkerDispute(TASK, EXEC, round(1))).toBe(false);
      expect(store.adjustReputation).not.toHaveBeenCalled();
      expect(keys.has('a2a:dispute-round:arc:7:1')).toBe(true);
    });
  });
});
