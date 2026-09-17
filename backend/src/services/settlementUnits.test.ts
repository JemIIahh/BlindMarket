import { describe, it, expect, vi, beforeEach } from 'vitest';

const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const cfg = vi.hoisted(() => ({ baseEscrowAddress: '0xescrow' as string, baseUsdcAddress: '' as string, postingChain: '' }));
vi.mock('../config.js', () => ({ config: cfg }));

const { normalizeSettlementAmount, settlementToken, payoutCurrency, assertPostingUnitMatchesPricing, nativeWeiToTokenUnits } =
  await import('./settlementUnits.js');

beforeEach(() => {
  cfg.baseEscrowAddress = '0xescrow';
  cfg.baseUsdcAddress = BASE_USDC;
  cfg.postingChain = '';
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

  it('reports USDC with 6 decimals', () => {
    expect(settlementToken()).toEqual({ symbol: 'USDC', decimals: 6 });
  });
});

describe('0G-only deployment (no Base escrow)', () => {
  it('keeps 18-decimal amounts, which are correct there', () => {
    cfg.baseEscrowAddress = '';
    expect(normalizeSettlementAmount('1000000000000000000')).toBe('1000000000000000000');
    expect(settlementToken()).toEqual({ symbol: '0G', decimals: 18 });
  });
});

describe('payoutCurrency', () => {
  const NATIVE = '0x0000000000000000000000000000000000000000';
  const TYPO_USDC = '0x036CbD53842c5426634C4923a64805772f97d1b6';

  it('books native 0G on 0G with 18 decimals', () => {
    expect(payoutCurrency('0g', NATIVE)).toEqual({ symbol: '0G', decimals: 18 });
  });

  it('books the configured USDC on Base with 6 decimals, in any letter case', () => {
    expect(payoutCurrency('base', BASE_USDC)).toEqual({ symbol: 'USDC', decimals: 6 });
    expect(payoutCurrency('base', BASE_USDC.toLowerCase())).toEqual({ symbol: 'USDC', decimals: 6 });
  });

  it.each([
    ['0g', BASE_USDC, 'an ERC-20 on 0G'],
    ['base', NATIVE, 'native ETH on Base'],
    ['base', TYPO_USDC, 'a look-alike of the USDC address'],
  ] as const)('refuses %s + %s (%s)', (chain, token, _why) => {
    expect(payoutCurrency(chain, token)).toBeNull();
  });

  it('refuses every Base token when no Base USDC is configured', () => {
    cfg.baseUsdcAddress = '';
    expect(payoutCurrency('base', BASE_USDC)).toBeNull();
    expect(payoutCurrency('base', NATIVE)).toBeNull();
  });

  it('refuses a chain it does not know instead of guessing', () => {
    expect(payoutCurrency('arc' as never, NATIVE)).toBeNull();
  });
});

describe('assertPostingUnitMatchesPricing', () => {
  it('passes the default posting chain, with or without a Base escrow', () => {
    expect(() => assertPostingUnitMatchesPricing()).not.toThrow();
    cfg.baseEscrowAddress = '';
    expect(() => assertPostingUnitMatchesPricing()).not.toThrow();
  });

  it('passes POSTING_CHAIN=base, and POSTING_CHAIN=0g without a Base escrow', () => {
    cfg.postingChain = 'base';
    expect(() => assertPostingUnitMatchesPricing()).not.toThrow();
    Object.assign(cfg, { postingChain: '0g', baseEscrowAddress: '' });
    expect(() => assertPostingUnitMatchesPricing()).not.toThrow();
  });

  it('refuses POSTING_CHAIN=0g while a Base escrow keeps prices in USDC', () => {
    cfg.postingChain = '0g';
    expect(() => assertPostingUnitMatchesPricing()).toThrow(
      /Invalid POSTING_CHAIN: 0g settles in 0G, but service prices and reward floors are in USDC/,
    );
  });
});

// Used by the withdraw route where a chain's gas coin is its settlement token
// (Arc's USDC), to keep the native gas reserve back while sweeping the ERC-20.
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
