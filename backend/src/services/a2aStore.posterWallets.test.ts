import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * My Tasks lists the tasks a user posted. The poster index is per wallet, and
 * it was read for the session's address only, so a task posted from another
 * of the user's linked wallets never showed (and nor did its refund).
 */

const mem = vi.hoisted(() => ({ sets: new Map<string, string[]>(), keys: new Map<string, string>() }));
vi.mock('./redis.js', () => ({
  redis: {
    smembers: async (k: string) => mem.sets.get(k) ?? [],
    pipeline: () => {
      const gets: string[] = [];
      const p = {
        get: (k: string) => { gets.push(k); return p; },
        exec: async () => gets.map((k) => [null, mem.keys.get(k) ?? null]),
      };
      return p;
    },
  },
}));
vi.mock('./neonDb.js', () => ({ getPool: vi.fn() }));
vi.mock('../config.js', () => ({ config: {} }));

const { getPosterTasksForWallets } = await import('./a2aStore.js');

const SESSION = '0x1111111111111111111111111111111111111111';
const LINKED = '0xBb8021Dc9a063F4F2525f532fAA3FE1907599026';

function posted(poster: string, taskId: string) {
  const key = `a2a:poster:${poster.toLowerCase()}`;
  mem.sets.set(key, [...(mem.sets.get(key) ?? []), taskId]);
  mem.keys.set(`a2a:meta:${taskId}`, JSON.stringify({ taskId, posterAddress: poster }));
  mem.keys.set(`a2a:state:${taskId}`, JSON.stringify({ taskId, status: 'open' }));
}

beforeEach(() => {
  mem.sets.clear();
  mem.keys.clear();
});

describe('getPosterTasksForWallets', () => {
  it("lists tasks posted from any of the user's wallets", async () => {
    posted(SESSION, '0xaa');
    posted(LINKED, '0xbb');
    const ids = (await getPosterTasksForWallets([SESSION, LINKED])).map((t) => t.meta.taskId).sort();
    expect(ids).toEqual(['0xaa', '0xbb']);
  });

  it('lists a task once even when two of the wallets index it, and ignores letter case', async () => {
    posted(SESSION, '0xaa');
    posted(LINKED, '0xaa');
    expect(await getPosterTasksForWallets([SESSION, LINKED.toLowerCase(), LINKED])).toHaveLength(1);
  });

  it('lists nothing for no wallets', async () => {
    posted(SESSION, '0xaa');
    expect(await getPosterTasksForWallets([])).toEqual([]);
  });
});
