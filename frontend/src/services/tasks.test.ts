import { afterEach, describe, expect, it } from 'vitest';
import { getSettlement, resetSettlement } from '../config/settlement';
import { assertRefundTarget } from './tasks';

/**
 * Numeric task ids collide across chains, so a cancel/claimTimeout tx is
 * signed only when the backend built it for the task's own chain and it calls
 * that chain's escrow: a Base escrow address signed on Arc hits no code, so
 * the send "succeeds" and refunds nothing.
 */
afterEach(() => resetSettlement());

const tx = (to: string) => ({ from: '0x1111111111111111111111111111111111111111', to, data: '0xcancel' });

describe('assertRefundTarget', () => {
  it("passes a tx built for the task's chain that calls its escrow", () => {
    const { chains } = getSettlement();
    for (const chain of ['arc', 'base'] as const) {
      const escrow = chains[chain].escrow;
      if (!escrow) continue;
      const built = { unsignedTx: tx(escrow.toLowerCase()), chain };
      expect(assertRefundTarget(built, chain)).toBe(built.unsignedTx);
    }
  });

  it('refuses a tx the backend built for another chain', () => {
    const escrow = getSettlement().chains.base.escrow || '0x3333333333333333333333333333333333333333';
    expect(() => assertRefundTarget({ unsignedTx: tx(escrow), chain: 'base' }, 'arc')).toThrow(/built for base/);
  });

  it("refuses a tx that does not call the task chain's escrow", () => {
    expect(() => assertRefundTarget({ unsignedTx: tx('0x3333333333333333333333333333333333333333'), chain: 'arc' }, 'arc'))
      .toThrow(/does not target the arc escrow/);
  });

  it('refuses a response without a chain, and a task chain this app cannot send on', () => {
    const escrow = getSettlement().chains.arc.escrow;
    expect(() => assertRefundTarget({ unsignedTx: tx(escrow) }, 'arc')).toThrow(/built for undefined/);
    expect(() => assertRefundTarget({ unsignedTx: tx(escrow), chain: '0g' }, '0g')).toThrow(/not one this app/);
    expect(() => assertRefundTarget({ unsignedTx: tx(escrow), chain: 'arc' }, undefined)).toThrow(/not one this app/);
  });
});
