import { describe, expect, it } from 'vitest';
import { isReclaimable, refundAction } from './refund';

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
