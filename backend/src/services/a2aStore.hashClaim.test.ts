import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * claimTaskHash is the line TASK_HASH_TAKEN's front-run defence rests on: one
 * claim per hash, holder lowercased, 24h TTL. Each claim also carries the
 * token of the request that last built on it, and only that request can
 * release it (security review: a failed batch released a claim a concurrent
 * retry had built its tx on). The route tests mock the store wholesale, so
 * this runs it against a Map-backed Redis that runs the two scripts the way
 * Redis would.
 */

const fake = vi.hoisted(() => {
  const store = new Map<string, { value: string; ttl: number | null }>();
  return {
    store,
    redis: {
      get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
      eval: vi.fn(async (script: string, _n: number, key: string, ...args: Array<string | number>) => {
        if (script.includes("'taken'")) {
          // claimTaskHash: claim, re-tag the poster's own claim, or refuse.
          const [poster, token, ttl] = args as [string, string, number];
          const current = store.get(key)?.value;
          const holder = current === undefined ? null : current.split('|')[0];
          if (holder !== null && holder !== poster) return ['taken', holder];
          store.set(key, { value: `${poster}|${token}`, ttl: Number(ttl) });
          return holder !== null ? ['mine', holder] : ['fresh', poster];
        }
        // releaseTaskHashClaim: compare-and-delete.
        if (store.get(key)?.value !== args[0]) return 0;
        store.delete(key);
        return 1;
      }),
      set: vi.fn(), exists: vi.fn(), pipeline: vi.fn(), sadd: vi.fn(), del: vi.fn(),
    },
  };
});
vi.mock('./redis.js', () => ({ redis: fake.redis }));
vi.mock('./neonDb.js', () => ({ getPool: vi.fn() }));
vi.mock('../config.js', () => ({ config: {} }));

const { claimTaskHash, getTaskHashClaim, releaseTaskHashClaim, HASH_CLAIM_TTL_SECONDS } = await import('./a2aStore.js');

const HASH = '0x' + 'AB'.repeat(32);
const KEY = `a2a:hash-claim:${HASH.toLowerCase()}`;
const ALICE = '0xAaAa000000000000000000000000000000000001';
const BOB = '0xbbbb000000000000000000000000000000000002';

beforeEach(() => {
  fake.store.clear();
  vi.clearAllMocks();
});

describe('claimTaskHash', () => {
  it('gives the first claimant the hash, and refuses every other address after', async () => {
    expect(await claimTaskHash(HASH, ALICE, 't1')).toEqual({ poster: ALICE.toLowerCase(), mine: true, fresh: true });
    expect(await claimTaskHash(HASH, BOB, 't2')).toEqual({ poster: ALICE.toLowerCase(), mine: false, fresh: false });
    expect(await getTaskHashClaim(HASH)).toBe(ALICE.toLowerCase());
  });

  it('is idempotent for the holder, whatever the letter case', async () => {
    await claimTaskHash(HASH, ALICE.toLowerCase(), 't1');
    // Already Alice's: hers, but not taken by this call.
    expect(await claimTaskHash(HASH, ALICE, 't2')).toEqual({ poster: ALICE.toLowerCase(), mine: true, fresh: false });
    expect(await claimTaskHash(HASH.toLowerCase(), ALICE.toUpperCase().replace('0X', '0x'), 't3')).toMatchObject({ mine: true });
  });

  it("records the poster and the request's token, with a 24h expiry, keyed by the lowercased hash", async () => {
    await claimTaskHash(HASH, ALICE, 'req-1');
    const [, n, key, poster, token, ttl] = fake.redis.eval.mock.calls[0] as [string, number, string, string, string, number];
    expect([n, key, poster, token, ttl]).toEqual([1, KEY, ALICE.toLowerCase(), 'req-1', HASH_CLAIM_TTL_SECONDS]);
    expect(fake.store.get(KEY)).toEqual({ value: `${ALICE.toLowerCase()}|req-1`, ttl: 86_400 });
    expect(HASH_CLAIM_TTL_SECONDS).toBe(86_400);
  });

  it("re-tags the poster's own claim with the new request's token", async () => {
    await claimTaskHash(HASH, ALICE, 'req-1');
    await claimTaskHash(HASH, ALICE, 'req-2');
    expect(fake.store.get(KEY)?.value).toBe(`${ALICE.toLowerCase()}|req-2`);
  });

  it('reads a claim from before tokens as all poster', async () => {
    fake.store.set(KEY, { value: ALICE.toLowerCase(), ttl: 86_400 });
    expect(await getTaskHashClaim(HASH)).toBe(ALICE.toLowerCase());
    expect(await claimTaskHash(HASH, ALICE, 'req-1')).toEqual({ poster: ALICE.toLowerCase(), mine: true, fresh: false });
    expect(await claimTaskHash(HASH, BOB, 'req-2')).toMatchObject({ mine: false });
  });

  it('reports no claim for an unclaimed hash', async () => {
    expect(await getTaskHashClaim(HASH)).toBeNull();
  });
});

// POST /tasks/batch releases the claims it took when the batch fails, so a
// public brief's hash is not held for 24 hours by a batch that built nothing.
describe('releaseTaskHashClaim', () => {
  it("drops the request's own claim, whatever the letter case, so anyone can claim the hash again", async () => {
    await claimTaskHash(HASH, ALICE, 'req-1');
    expect(await releaseTaskHashClaim(HASH, ALICE.toUpperCase().replace('0X', '0x'), 'req-1')).toBe(true);
    expect(await getTaskHashClaim(HASH)).toBeNull();
    expect(await claimTaskHash(HASH, BOB, 'req-2')).toMatchObject({ mine: true, fresh: true });
  });

  it('leaves a claim a later request of the same poster built on', async () => {
    await claimTaskHash(HASH, ALICE, 'failed-batch');
    await claimTaskHash(HASH, ALICE, 'retry');
    expect(await releaseTaskHashClaim(HASH, ALICE, 'failed-batch')).toBe(false);
    expect(await getTaskHashClaim(HASH)).toBe(ALICE.toLowerCase());
  });

  it("leaves another poster's claim in place", async () => {
    await claimTaskHash(HASH, ALICE, 'req-1');
    expect(await releaseTaskHashClaim(HASH, BOB, 'req-1')).toBe(false);
    expect(await getTaskHashClaim(HASH)).toBe(ALICE.toLowerCase());
  });

  it('is a no-op for an unclaimed hash', async () => {
    expect(await releaseTaskHashClaim(HASH, ALICE, 'req-1')).toBe(false);
  });

  it('compares and deletes in one script, on the exact poster and token', async () => {
    await claimTaskHash(HASH, ALICE, 'req-1');
    await releaseTaskHashClaim(HASH, ALICE, 'req-1');
    const [script, n, key, value] = fake.redis.eval.mock.calls[1] as [string, number, string, string];
    expect(script).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
    expect(script).toContain("redis.call('DEL', KEYS[1])");
    expect([n, key, value]).toEqual([1, KEY, `${ALICE.toLowerCase()}|req-1`]);
  });
});
