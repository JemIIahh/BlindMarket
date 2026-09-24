import { describe, expect, it } from 'vitest';
import { id } from 'ethers';
import { encodeRefundCall, isReclaimable, refundAction } from './refund';

const DEADLINE = 1_790_246_651; // 2026-09-24 10:44:11 UTC
const BEFORE = DEADLINE - 60;
const AFTER = DEADLINE + 60;

describe('refundAction', () => {
  it('cancels a task nobody took, at any time', () => {
    expect(refundAction(0, DEADLINE, BEFORE)).toBe('cancel');
    expect(refundAction(0, DEADLINE, AFTER)).toBe('cancel');
  });

  it.each([1, 2, 3])('claims the timeout on status %i only once the deadline has passed', (status) => {
    expect(refundAction(status, DEADLINE, BEFORE)).toBeNull();
    expect(refundAction(status, DEADLINE, DEADLINE)).toBe('timeout');
    expect(refundAction(status, DEADLINE, AFTER)).toBe('timeout');
  });

  it.each([4, 5, 6])('offers nothing for status %i (completed, cancelled, disputed)', (status) => {
    expect(refundAction(status, DEADLINE, AFTER)).toBeNull();
  });

  it('never claims a timeout on an unknown deadline', () => {
    expect(refundAction(1, 0, AFTER)).toBeNull();
  });
});

describe('isReclaimable', () => {
  it('flags escrow left behind after the deadline: an unclaimed task, or one its agent missed', () => {
    expect(isReclaimable(0, DEADLINE, AFTER)).toBe(true);
    expect(isReclaimable(1, DEADLINE, AFTER)).toBe(true);
  });

  it('does not flag a live task, or one already settled', () => {
    expect(isReclaimable(0, DEADLINE, BEFORE)).toBe(false);
    expect(isReclaimable(1, DEADLINE, BEFORE)).toBe(false);
    expect(isReclaimable(4, DEADLINE, AFTER)).toBe(false);
    expect(isReclaimable(5, DEADLINE, AFTER)).toBe(false);
  });
});

describe('encodeRefundCall', () => {
  // The escrow's own signatures (BlindEscrow.sol: cancelTask(uint256), claimTimeout(uint256)).
  const selector = (sig: string) => id(sig).slice(0, 10);

  it('encodes cancelTask and claimTimeout for the on-chain id', () => {
    const cancel = encodeRefundCall('cancel', '7');
    expect(cancel.slice(0, 10)).toBe(selector('cancelTask(uint256)'));
    expect(BigInt('0x' + cancel.slice(10))).toBe(7n);
    const timeout = encodeRefundCall('timeout', '8');
    expect(timeout.slice(0, 10)).toBe(selector('claimTimeout(uint256)'));
    expect(BigInt('0x' + timeout.slice(10))).toBe(8n);
  });

  it.each(['', '0x07', '7.0', '-7', 'abc'])('refuses %j, which is not an on-chain id', (bad) => {
    expect(() => encodeRefundCall('cancel', bad)).toThrow(/Not an on-chain task id/);
  });
});
