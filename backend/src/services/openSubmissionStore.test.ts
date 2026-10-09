import { describe, it, expect, vi } from 'vitest';

/**
 * Open-submission records are keyed by on-chain task, network-scoped like
 * every other per-chain key (chainScope.ts): escrow ids restart at 1 on a new
 * network, so a key by chain alone would name an unrelated task after a move.
 */

vi.mock('./redis.js', () => ({ redis: {} }));
vi.mock('./chainScope.js', () => ({ chainScope: (chain: string) => (chain === 'arc' ? 'arc@5042' : chain) }));

const { taskRef } = await import('./openSubmissionStore.js');

describe('taskRef', () => {
  it("is the chain's network scope and the on-chain task id", () => {
    expect(taskRef('arc', 7)).toBe('arc@5042:7');
    expect(taskRef('arc', 7n)).toBe('arc@5042:7');
    expect(taskRef('base', '12')).toBe('base:12');
  });
});
