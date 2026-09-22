import { describe, it, expect, vi, beforeEach } from 'vitest';

const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const NATIVE = '0x0000000000000000000000000000000000000000';
const cfg = vi.hoisted(() => ({ baseEscrowAddress: '0xescrow' as string, baseUsdcAddress: '' as string, arcUsdcAddress: '0x3600000000000000000000000000000000000000' }));
vi.mock('../config.js', () => ({ config: cfg }));

const { normalizeSettlementAmount, pricingUnit, payoutCurrency, nativeWeiToTokenUnits, clientPricingWarnings, sameUnit } =
  await import('./settlementUnits.js');

beforeEach(() => {
  cfg.baseEscrowAddress = '0xescrow';
  cfg.baseUsdcAddress = BASE_USDC;
});

describe('normalizeSettlementAmount (Base escrow configured)', () => {
  it.each([
    ['1000000000000000000', '1000000'],            // 1 in 18 decimals -> 1 USDC
    ['500000000000000', '500'],                    // 0.0005
    ['1000000000000', '1'],                        // exactly 10^12
    ['1000000000001', '2'],                        // rounds up, never down to free
    ['123456789012345678901234567890', '123456789012345679'],
  ])('converts old 18-decimal %s to %s', (raw, expected) => {
    expect(normalizeSettlementAmount(raw)).toBe(expected);
  });

  it.each(['0', '1', '2500000', '999999999999'])('leaves USDC amount %s unchanged', (raw) => {
    expect(normalizeSettlementAmount(raw)).toBe(raw);
  });

  it('prices in USDC with 6 decimals', () => {
    expect(pricingUnit()).toEqual({ symbol: 'USDC', decimals: 6 });
  });
});

describe('clientPricingWarnings', () => {
  it('says nothing on a stack that posts on Base', () => {
    expect(clientPricingWarnings()).toEqual([]);
  });
});

describe('payoutCurrency', () => {
  it('books the configured USDC on Base with 6 decimals, in any letter case', () => {
    expect(payoutCurrency('base', BASE_USDC)).toEqual({ symbol: 'USDC', decimals: 6 });
    expect(payoutCurrency('base', BASE_USDC.toLowerCase())).toEqual({ symbol: 'USDC', decimals: 6 });
  });

  it('books the configured USDC on Arc with 6 decimals', () => {
    expect(payoutCurrency('arc', ARC_USDC)).toEqual({ symbol: 'USDC', decimals: 6 });
  });

  it('refuses native value on a USDC settlement chain', () => {
    expect(payoutCurrency('base', NATIVE)).toBeNull();
    expect(payoutCurrency('arc', NATIVE)).toBeNull();
  });

  it('refuses a chain it does not know instead of guessing', () => {
    expect(payoutCurrency('0g' as never, NATIVE)).toBeNull();
  });
});

describe('sameUnit', () => {
  it('compares symbol and decimals, not name alone', () => {
    expect(sameUnit({ symbol: 'USDC', decimals: 6 }, { symbol: 'USDC', decimals: 6 })).toBe(true);
    expect(sameUnit({ symbol: 'USDC', decimals: 6 }, { symbol: 'USDC', decimals: 18 })).toBe(false);
  });
});

describe('nativeWeiToTokenUnits', () => {
  const E = 10n ** 18n;

  it('converts an 18-decimal native amount to a 6-decimal token, rounding up', () => {
    expect(nativeWeiToTokenUnits(3n * E / 10_000n, 6)).toBe(300n); // 0.0003 -> 0.000300
    expect(nativeWeiToTokenUnits(10n ** 12n, 6)).toBe(1n);
    expect(nativeWeiToTokenUnits(10n ** 12n + 1n, 6)).toBe(2n);
    expect(nativeWeiToTokenUnits(1n, 6)).toBe(1n);
    expect(nativeWeiToTokenUnits(0n, 6)).toBe(0n);
  });

  it('leaves an 18-decimal token as it is', () => {
    expect(nativeWeiToTokenUnits(5n, 18)).toBe(5n);
  });
});