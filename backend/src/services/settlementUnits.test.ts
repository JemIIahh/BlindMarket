import { describe, it, expect, vi, beforeEach } from 'vitest';

const cfg = vi.hoisted(() => ({ baseEscrowAddress: '0xescrow' as string }));
vi.mock('../config.js', () => ({ config: cfg }));

const { normalizeSettlementAmount, settlementToken } = await import('./settlementUnits.js');

beforeEach(() => { cfg.baseEscrowAddress = '0xescrow'; });

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
