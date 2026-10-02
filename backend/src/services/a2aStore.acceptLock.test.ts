import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The per-task accept lock belongs to the /accept request that took it: its
 * value is `<agent>|<token>`, and only that request can release or extend it.
 * releaseAcceptLock used to DEL the key unconditionally, so a request whose
 * settlement outlasted the 30 s TTL deleted the lock a later accept had taken
 * since. The route tests mock the store wholesale, so this runs it against a
 * Map-backed Redis that runs the scripts the way Redis would, owner guard
 * included (same approach as a2aStore.hashClaim.test.ts).
 */

const fake = vi.hoisted(() => {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    store,
    redis: {
      set: vi.fn(async (key: string, value: string, _ex: string, ttl: number, nx: string) => {
        if (nx === 'NX' && store.has(key)) return null;
        store.set(key, { value, ttl });
        return 'OK';
      }),
      eval: vi.fn(async (script: string, _n: number, key: string, ...args: Array<string | number>) => {
        // The owner check is the script's own guard: without it, it acts on any holder's lock.
        const guarded = script.includes("redis.call('GET', KEYS[1]) == ARGV[1]");
        if (guarded && store.get(key)?.value !== args[0]) return 0;
        if (!store.has(key)) return 0;
        if (script.includes("'DEL'")) {
          store.delete(key);
          return 1;
        }
        if (script.includes("'EXPIRE'")) {
          store.get(key)!.ttl = Number(args[1]);
          return 1;
        }
        throw new Error('unexpected script');
      }),
      get: vi.fn(), exists: vi.fn(), pipeline: vi.fn(), del: vi.fn(),
    },
  };
});
vi.mock('./redis.js', () => ({ redis: fake.redis }));
vi.mock('./neonDb.js', () => ({ getPool: vi.fn() }));
vi.mock('../config.js', () => ({ config: {} }));

const { acquireAcceptLock, releaseAcceptLock, extendAcceptLock } = await import('./a2aStore.js');
const { keepAcceptLock } = await import('./acceptLock.js');

const TASK = '0x' + 'AB'.repeat(32);
const KEY = `a2a:accept_lock:${TASK.toLowerCase()}`;
const ALICE = '0xAaAa000000000000000000000000000000000001';
const BOB = '0xbbbb000000000000000000000000000000000002';

beforeEach(() => {
  fake.store.clear();
  vi.clearAllMocks();
});

describe('accept lock ownership', () => {
  it('records the holder and the request, for the lock TTL, and refuses a second taker', async () => {
    expect(await acquireAcceptLock(TASK, ALICE, 'req-1')).toBe(true);
    expect(fake.store.get(KEY)).toEqual({ value: `${ALICE.toLowerCase()}|req-1`, ttl: 30 });
    expect(await acquireAcceptLock(TASK, BOB, 'req-2')).toBe(false);
  });

  it('a late finisher cannot delete the lock a newer request holds', async () => {
    await acquireAcceptLock(TASK, ALICE, 'req-1');
    fake.store.delete(KEY); // req-1's settlement outlasted the TTL
    expect(await acquireAcceptLock(TASK, BOB, 'req-2')).toBe(true);

    expect(await releaseAcceptLock(TASK, ALICE, 'req-1')).toBe(false);
    expect(fake.store.get(KEY)?.value).toBe(`${BOB.toLowerCase()}|req-2`);
    expect(await releaseAcceptLock(TASK, BOB, 'req-2')).toBe(true);
    expect(fake.store.has(KEY)).toBe(false);
  });

  it('a request of the same agent is told apart by its token', async () => {
    await acquireAcceptLock(TASK, ALICE, 'retry');
    expect(await releaseAcceptLock(TASK, ALICE, 'first-attempt')).toBe(false);
    expect(fake.store.has(KEY)).toBe(true);
  });

  it('only the holder extends the lock', async () => {
    await acquireAcceptLock(TASK, ALICE, 'req-1');
    fake.store.get(KEY)!.ttl = 3;
    expect(await extendAcceptLock(TASK, BOB, 'req-2')).toBe(false);
    expect(fake.store.get(KEY)!.ttl).toBe(3);
    expect(await extendAcceptLock(TASK, ALICE, 'req-1')).toBe(true);
    expect(fake.store.get(KEY)!.ttl).toBe(30);
  });
});

describe('keepAcceptLock', () => {
  // Fake timers (and clock): the interval fires exactly as many times as the
  // time advanced says, however loaded the machine is.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('keeps extending its own lock until stopped', async () => {
    await acquireAcceptLock(TASK, ALICE, 'req-1');
    const stop = keepAcceptLock(TASK, ALICE, 'req-1', { everyMs: 10_000, maxHoldMs: 300_000 });
    vi.advanceTimersByTime(35_000);
    expect(fake.redis.eval).toHaveBeenCalledTimes(3);
    expect(fake.redis.eval).toHaveBeenCalledWith(expect.stringContaining("'EXPIRE'"), 1, KEY, `${ALICE.toLowerCase()}|req-1`, 30);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(fake.redis.eval).toHaveBeenCalledTimes(3);
  });

  it('stops extending after maxHoldMs, so a hung request lets the lock lapse', async () => {
    await acquireAcceptLock(TASK, ALICE, 'req-1');
    keepAcceptLock(TASK, ALICE, 'req-1', { everyMs: 10_000, maxHoldMs: 35_000 });
    vi.advanceTimersByTime(120_000);
    expect(fake.redis.eval).toHaveBeenCalledTimes(3);
  });

  it('defaults to a third of the lock TTL, for at most ACCEPT_LOCK_MAX_HOLD_S', async () => {
    await acquireAcceptLock(TASK, ALICE, 'req-1');
    keepAcceptLock(TASK, ALICE, 'req-1');
    vi.advanceTimersByTime(10_000);
    expect(fake.redis.eval).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600_000);
    expect(fake.redis.eval).toHaveBeenCalledTimes(29); // 300 s / 10 s, the last tick at the cap stops it
  });
});
