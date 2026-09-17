import { describe, it, expect, vi, beforeEach } from 'vitest';

const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const cfg = vi.hoisted(() => ({ baseEscrowAddress: '0xescrow' as string, baseUsdcAddress: '' as string }));
vi.mock('../config.js', () => ({ config: cfg }));

const { normalizeSettlementAmount, settlementToken, payoutCurrency } = await import('./settlementUnits.js');

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
