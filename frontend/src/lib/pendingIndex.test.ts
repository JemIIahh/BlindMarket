import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearPendingIndex, listPendingIndex, savePendingIndex } from './pendingIndex';

/**
 * A funded escrow whose listing failed must stay retryable from this browser
 * (PostTask shows "Retry listing"), for its own poster only, and disappear
 * once listed or expired.
 */

const POSTER = '0xAbC0000000000000000000000000000000000001';
const OTHER = '0x0000000000000000000000000000000000000002';
const hash = (n: number) => '0x' + String(n).padStart(64, '0');

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('pendingIndex', () => {
  it("keeps a listing request for its poster until it is cleared", () => {
    savePendingIndex({ taskHash: hash(1), txHash: '0xtx1', poster: POSTER, body: { taskHash: hash(1), rootHash: '0xroot' } });
    savePendingIndex({ taskHash: hash(2), txHash: '0xtx2', poster: OTHER, body: { taskHash: hash(2) } });

    const mine = listPendingIndex(POSTER.toLowerCase());
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ taskHash: hash(1), txHash: '0xtx1', body: { rootHash: '0xroot' } });

    clearPendingIndex(hash(1).toUpperCase().replace('0X', '0x'));
    expect(listPendingIndex(POSTER)).toEqual([]);
    expect(listPendingIndex(OTHER)).toHaveLength(1);
  });

  it('evicts entries past their TTL and corrupt ones', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    savePendingIndex({ taskHash: hash(3), txHash: '0xtx3', poster: POSTER, body: {} });
    localStorage.setItem('blindmarket:pendingIndex:0xbad', '{not json');

    vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
    expect(listPendingIndex(POSTER)).toEqual([]);
    expect(localStorage.length).toBe(0);
  });

  it('never throws when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      get length(): number { throw new Error('blocked'); },
      key: () => { throw new Error('blocked'); },
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
      clear: () => { throw new Error('blocked'); },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => savePendingIndex({ taskHash: hash(4), txHash: '0xtx4', poster: POSTER, body: {} })).not.toThrow();
    expect(() => clearPendingIndex(hash(4))).not.toThrow();
    expect(listPendingIndex(POSTER)).toEqual([]);
    warn.mockRestore();
  });
});
