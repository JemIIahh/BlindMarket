import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * claimTaskHash is the line TASK_HASH_TAKEN's front-run defence rests on:
 * one SET NX per hash, holder lowercased, 24h TTL. The route tests mock the
 * store wholesale, so this runs it against a Map-backed Redis with the exact
 * `set(key, value, 'EX', ttl, 'NX')` semantics ioredis has.
 */

const fake = vi.hoisted(() => {
  const store = new Map<string, { value: string; ttl: number | null }>();
  return {
    store,
    redis: {
      set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
        const nx = args.includes('NX');
        const exAt = args.indexOf('EX');
        const ttl = exAt >= 0 ? Number(args[exAt + 1]) : null;
        if (nx && store.has(key)) return null;
        store.set(key, { value, ttl });
        return 'OK';
      }),
      get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
      exists: vi.fn(), pipeline: vi.fn(), sadd: vi.fn(), del: vi.fn(),
    },
  };
});
vi.mock('./redis.js', () => ({ redis: fake.redis }));
vi.mock('./neonDb.js', () => ({ getPool: vi.fn() }));
vi.mock('../config.js', () => ({ config: {} }));

const { claimTaskHash, getTaskHashClaim, HASH_CLAIM_TTL_SECONDS } = await import('./a2aStore.js');

const HASH = '0x' + 'AB'.repeat(32);
const ALICE = '0xAaAa000000000000000000000000000000000001';
const BOB = '0xbbbb000000000000000000000000000000000002';

beforeEach(() => fake.store.clear());

describe('claimTaskHash', () => {
  it('gives the first claimant the hash, and refuses every other address after', async () => {
    expect(await claimTaskHash(HASH, ALICE)).toEqual({ poster: ALICE.toLowerCase(), mine: true });
    expect(await claimTaskHash(HASH, BOB)).toEqual({ poster: ALICE.toLowerCase(), mine: false });
    expect(await getTaskHashClaim(HASH)).toBe(ALICE.toLowerCase());
  });

  it('is idempotent for the holder, whatever the letter case', async () => {
    await claimTaskHash(HASH, ALICE.toLowerCase());
    expect(await claimTaskHash(HASH, ALICE)).toEqual({ poster: ALICE.toLowerCase(), mine: true });
    expect(await claimTaskHash(HASH.toLowerCase(), ALICE.toUpperCase().replace('0X', '0x'))).toMatchObject({ mine: true });
  });

  it('claims atomically with NX and a 24h expiry, keyed by the lowercased hash', async () => {
    await claimTaskHash(HASH, ALICE);
    const [key, value, ...args] = fake.redis.set.mock.calls[0] as [string, string, ...unknown[]];
    expect(key).toBe(`a2a:hash-claim:${HASH.toLowerCase()}`);
    expect(value).toBe(ALICE.toLowerCase());
    expect(args).toEqual(['EX', HASH_CLAIM_TTL_SECONDS, 'NX']);
    expect(HASH_CLAIM_TTL_SECONDS).toBe(86_400);
  });

  it('reports no claim for an unclaimed hash', async () => {
    expect(await getTaskHashClaim(HASH)).toBeNull();
  });
});
