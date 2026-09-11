import { describe, it, expect, vi } from 'vitest';
vi.mock('./redis.js', () => ({ redis: {} }));
vi.mock('./neonDb.js', () => ({ getPool: vi.fn() }));
import { withExplorationHead } from './a2aStore.js';

const e = (address: string, score: number) => ({ address, score, displayName: address });

describe('withExplorationHead', () => {
  it('keeps the exploration pick at position 0 and the ranking behind it', () => {
    const out = withExplorationHead(e('0xNEW', 3.9), [e('0xbest', 5), e('0xnext', 3.9)]);
    expect(out.map((x) => x.address)).toEqual(['0xNEW', '0xbest', '0xnext']);
  });
  it('never offers the pick twice when it also appears in the ranking', () => {
    const out = withExplorationHead(e('0xnew', 3.9), [e('0xbest', 5), e('0xNEW', 3.9), e('0xnext', 1)]);
    expect(out.map((x) => x.address)).toEqual(['0xnew', '0xbest', '0xnext']);
  });
});
