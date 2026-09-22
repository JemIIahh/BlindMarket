import { afterEach, describe, expect, it } from 'vitest';
import { resetSettlement } from '../config/settlement';
import { formatEarnings, formatPaymentAmount, parsePaymentAmount, sumEarnings } from './paymentUnits';

afterEach(() => resetSettlement());

describe('sumEarnings', () => {
  it('adds per-currency totals without mixing them', () => {
    expect(sumEarnings([
      { totalEarnedUsdc: '1.5', totalEarnedNative: '0.2' },
      { totalEarnedUsdc: '2', totalEarnedNative: '0' },
    ])).toEqual({ totalEarnedUsdc: '3.5', totalEarnedNative: '0.2' });
  });

  it('keeps a legacy row (only totalEarned) under the payment token instead of dropping it', () => {
    // The testnet build pays in USDC.
    expect(sumEarnings([{ totalEarned: '5' }, { totalEarnedUsdc: '1', totalEarnedNative: '0' }])).toEqual({
      totalEarnedUsdc: '6',
      totalEarnedNative: '0',
    });
  });

  it('stays legacy-shaped when every row is legacy', () => {
    expect(sumEarnings([{ totalEarned: '1' }, { totalEarned: '2' }])).toEqual({ totalEarned: '3' });
  });
});

describe('formatEarnings and amounts follow the payment unit', () => {
  it('formats one amount per currency, and the legacy total in the payment symbol', () => {
    expect(formatEarnings({ totalEarnedUsdc: '12.5', totalEarnedNative: '0.3' })).toBe('12.5 USDC · 0.3 0G');
    expect(formatEarnings({ totalEarned: '4' })).toBe('4 USDC');
    expect(formatEarnings({ totalEarnedUsdc: '0', totalEarnedNative: '0' })).toBe('0 USDC');
  });

  it('parses and formats in the posting chain’s decimals', () => {
    expect(parsePaymentAmount('1')).toBe(1_000_000n);
    expect(formatPaymentAmount('1500000')).toBe('1.5');
  });
});
