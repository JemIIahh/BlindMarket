import { describe, expect, it } from 'vitest';
import { FEE_HOLD_MS, addFee, claimFee, dropFee, freeFees, releaseFees, touchFees, type FeeStorage } from './pendingFees';

/**
 * Two tabs of one owner share localStorage. Each deploy run holds the fees it
 * paid or took from an earlier attempt; another run is offered only the fees
 * no live run holds, and a run clears only the fee it consumed.
 */

const OWNER = '0xAbC0000000000000000000000000000000000001';
const TX = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const T0 = 1_790_000_000_000;

function memory(): FeeStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v); },
    removeItem: (k) => { data.delete(k); },
  };
}
const hashes = (s: FeeStorage, now = T0) => freeFees(s, OWNER, now).map((f) => f.hash);

describe('pending deploy fees across tabs', () => {
  it('does not offer a run the fee another live run just paid', () => {
    const s = memory();
    // Tab A pays its first agent's fee; its deploy is still running.
    addFee(s, OWNER, TX(1), 'run-a', T0);
    // Tab B starts a run: nothing is free, so it pays its own.
    expect(claimFee(s, OWNER, 'run-b', T0 + 1_000)).toBeNull();
    expect(hashes(s, T0 + 1_000)).toEqual([]);
  });

  it("keeps another tab's fee when a run clears the one it consumed", () => {
    const s = memory();
    addFee(s, OWNER, TX(1), 'run-a', T0);
    addFee(s, OWNER, TX(2), 'run-b', T0);
    // A's agent deployed with TX(1): only that one goes.
    dropFee(s, OWNER, TX(1));
    // B's deploy fails: its fee is free for the next attempt, not lost.
    releaseFees(s, OWNER, 'run-b');
    expect(hashes(s)).toEqual([TX(2)]);
    expect(claimFee(s, OWNER, 'run-c', T0)).toBe(TX(2));
  });

  it('frees a fee once its run ends without using it, and hands it to one run only', () => {
    const s = memory();
    addFee(s, OWNER, TX(1), 'run-a', T0);
    releaseFees(s, OWNER, 'run-a');
    expect(claimFee(s, OWNER, 'run-b', T0)).toBe(TX(1));
    expect(claimFee(s, OWNER, 'run-c', T0)).toBeNull();
  });

  it('frees the fees of a run whose tab closed mid-run, once its hold lapses', () => {
    const s = memory();
    addFee(s, OWNER, TX(1), 'run-a', T0);
    expect(claimFee(s, OWNER, 'run-b', T0 + FEE_HOLD_MS - 1)).toBeNull();
    expect(claimFee(s, OWNER, 'run-b', T0 + FEE_HOLD_MS)).toBe(TX(1));
  });

  it('keeps a live run holding its fees while it says it is alive', () => {
    const s = memory();
    addFee(s, OWNER, TX(1), 'run-a', T0);
    touchFees(s, OWNER, 'run-a', T0 + FEE_HOLD_MS - 1);
    expect(claimFee(s, OWNER, 'run-b', T0 + FEE_HOLD_MS + 1)).toBeNull();
  });

  it('reads a fee the single-slot page saved, and clears it only when that fee is consumed', () => {
    const s = memory();
    s.setItem(`bb.deployFeeTx.${OWNER.toLowerCase()}`, TX(9));
    expect(hashes(s)).toEqual([TX(9)]);
    expect(claimFee(s, OWNER, 'run-a', T0)).toBe(TX(9));
    expect(claimFee(s, OWNER, 'run-b', T0)).toBeNull();
    dropFee(s, OWNER, TX(8));
    expect(s.getItem(`bb.deployFeeTx.${OWNER.toLowerCase()}`)).toBe(TX(9));
    dropFee(s, OWNER, TX(9));
    expect(s.getItem(`bb.deployFeeTx.${OWNER.toLowerCase()}`)).toBeNull();
    expect(hashes(s)).toEqual([]);
  });

  it('keeps each owner apart, and ignores what is not a transaction hash', () => {
    const s = memory();
    addFee(s, OWNER, TX(1), 'run-a', T0);
    releaseFees(s, OWNER, 'run-a');
    expect(freeFees(s, '0x' + '22'.repeat(20), T0)).toEqual([]);
    s.setItem(`bb.deployFeeTx.${'0x' + '33'.repeat(20)}`, 'not-a-hash');
    expect(freeFees(s, '0x' + '33'.repeat(20), T0)).toEqual([]);
  });
});
