import { describe, it, expect } from 'vitest';
import { addPayout, executorFor, reconcileEarnings, type ChainEarnings } from './earningsReconcile.js';

const A = '0xaaaa000000000000000000000000000000000001';
const B = '0xbbbb000000000000000000000000000000000002';
const ONE_0G = 10n ** 18n;

function row(address: string, tasksCompleted: number, totalEarnedRaw: string, totalEarnedUsdcRaw = '0') {
  return { address, tasksCompleted, totalEarnedRaw, totalEarnedUsdcRaw };
}

describe('addPayout', () => {
  it('keeps each currency in its own total and counts every payout', () => {
    const totals = new Map<string, ChainEarnings>();
    addPayout(totals, A.toUpperCase().replace('0X', '0x'), '0G', ONE_0G);
    addPayout(totals, A, 'USDC', 4_500_000n);
    addPayout(totals, A, 'USDC', 500_000n);
    expect(totals.get(A)).toEqual({ native: ONE_0G, usdc: 5_000_000n, tasks: 3 });
  });
});

describe('executorFor', () => {
  it('books a smart account payout to its wallet, and anything else to itself', () => {
    const smart = '0x5555000000000000000000000000000000000005';
    const bySmart = new Map([[smart, A]]);
    expect(executorFor(smart.toUpperCase().replace('0X', '0x'), bySmart)).toBe(A);
    expect(executorFor(B, bySmart)).toBe(B);
  });
});

describe('reconcileEarnings', () => {
  it('moves USDC that was added into the 0G total into its own total', () => {
    // 1 0G and 4.5 USDC were both added into total_earned_raw.
    const mixed = (ONE_0G + 4_500_000n).toString();
    const chain = new Map([[A, { native: ONE_0G, usdc: 4_500_000n, tasks: 2 }]]);
    const { fixes, unchanged } = reconcileEarnings([row(A, 2, mixed)], chain);
    expect(unchanged).toBe(0);
    expect(fixes).toEqual([{
      address: A,
      stored: { address: A, tasksCompleted: 2, totalEarnedRaw: mixed, totalEarnedUsdcRaw: '0' },
      to: { tasksCompleted: 2, totalEarnedRaw: ONE_0G.toString(), totalEarnedUsdcRaw: '4500000' },
    }]);
  });

  it('restores earnings that a restart reset to 0', () => {
    const chain = new Map([[A, { native: 0n, usdc: 900_000n, tasks: 1 }]]);
    const { fixes } = reconcileEarnings([row(A, 1, '0')], chain);
    expect(fixes[0].to).toEqual({ tasksCompleted: 1, totalEarnedRaw: '0', totalEarnedUsdcRaw: '900000' });
  });

  it('never lowers the task count', () => {
    const chain = new Map([[A, { native: 0n, usdc: 1n, tasks: 1 }]]);
    const { fixes } = reconcileEarnings([row(A, 5, '0')], chain);
    expect(fixes[0].to.tasksCompleted).toBe(5);
  });

  it('leaves a correct row alone, including one with no payouts', () => {
    const chain = new Map([[A, { native: ONE_0G, usdc: 7n, tasks: 3 }]]);
    const { fixes, unchanged } = reconcileEarnings([row(A, 3, ONE_0G.toString(), '7'), row(B, 0, '0')], chain);
    expect(fixes).toEqual([]);
    expect(unchanged).toBe(2);
  });

  it('treats an unreadable stored amount as wrong instead of throwing, and keeps it as stored', () => {
    const { fixes } = reconcileEarnings([row(A, 0, '', 'abc')], new Map());
    expect(fixes[0]).toMatchObject({ stored: { totalEarnedRaw: '', totalEarnedUsdcRaw: 'abc' }, to: { totalEarnedRaw: '0', totalEarnedUsdcRaw: '0' } });
  });

  it('lists workers paid on-chain who have no executor row', () => {
    const chain = new Map([[B, { native: 1n, usdc: 0n, tasks: 1 }], [A, { native: 0n, usdc: 0n, tasks: 0 }]]);
    expect(reconcileEarnings([row(A, 0, '0')], chain).unregistered).toEqual([B]);
  });

  it('keeps a mixed-case stored address for the update, and keys the fix in lowercase', () => {
    const mixedCase = A.toUpperCase().replace('0X', '0x');
    const chain = new Map([[A, { native: 0n, usdc: 5n, tasks: 1 }]]);
    const [fix] = reconcileEarnings([row(mixedCase, 1, '0')], chain).fixes;
    expect(fix.address).toBe(A);
    expect(fix.stored.address).toBe(mixedCase);
  });

  it('matches stored addresses in any letter case', () => {
    const chain = new Map([[A, { native: 0n, usdc: 1n, tasks: 1 }]]);
    const { fixes, unregistered } = reconcileEarnings([row(A.toUpperCase().replace('0X', '0x'), 1, '0', '1')], chain);
    expect(fixes).toEqual([]);
    expect(unregistered).toEqual([]);
  });
});
