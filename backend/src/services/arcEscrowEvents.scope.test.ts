import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The Arc indexer keeps its hash<->id maps and checkpoints under the network's
 * scope (chainScope): 'arc:' on Arc testnet, as before, and 'arc@5042:' on
 * Arc mainnet. A backend moved to mainnet then starts from an empty index
 * instead of resuming from the testnet checkpoint (block 63M+, far past
 * mainnet's head) and resolving testnet hashes to mainnet ids.
 */

const HASH = '0x' + 'ab'.repeat(32);
const HEAD = 5_000;

const { chain, store, net } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  net: { arc: 5042 },
  chain: {
    arcProvider: { getBlockNumber: vi.fn() },
    arcEscrow: { filters: { TaskCreated: vi.fn(() => 'task-created-filter') }, queryFilter: vi.fn() },
  },
}));

vi.mock('./settlementChains.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./settlementChains.js')>();
  return {
    ...mod,
    settlementChainConfig: (key: 'arc' | 'base') =>
      key === 'arc' ? { ...mod.settlementChainConfig(key), chainId: net.arc } : mod.settlementChainConfig(key),
  };
});
vi.mock('./chain.js', () => chain);
vi.mock('./redis.js', () => ({
  redis: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, mode?: string) => {
      if (mode === 'NX' && store.has(k)) return null;
      store.set(k, v);
      return 'OK';
    }),
    pipeline: vi.fn(() => {
      const ops: Array<() => void> = [];
      const pipe = {
        set: (k: string, v: string) => { ops.push(() => store.set(k, v)); return pipe; },
        exec: async () => ops.map((op) => [null, op()]),
      };
      return pipe;
    }),
  },
}));
vi.mock('./deploymentIdentity.js', () => ({ backgroundWritesAllowed: () => true }));
vi.mock('./escrowFingerprint.js', () => ({ checkEscrowFingerprint: vi.fn(async () => {}) }));
vi.mock('./disputeListener.js', () => ({ handleDisputeResolved: vi.fn(), retryParkedDisputes: vi.fn() }));

const { seedArcTaskIdMapping, getArcTaskIdByHash, getArcTaskHashById, forceArcTick } = await import('./arcEscrowEvents.js');

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  net.arc = 5042;
});

describe('Arc indexer keys on Arc mainnet', () => {
  it('writes and reads the hash<->id maps under arc@5042, never the testnet keys', async () => {
    store.set(`arc:hash2id:${HASH}`, '7'); // left by the testnet backend
    expect(await getArcTaskIdByHash(HASH)).toBeNull();

    await seedArcTaskIdMapping(HASH, 1n);
    expect(store.get(`arc@5042:hash2id:${HASH}`)).toBe('1');
    expect(store.get('arc@5042:id2hash:1')).toBe(HASH);
    expect(await getArcTaskIdByHash(HASH)).toBe('1');
    expect(await getArcTaskHashById(1n)).toBe(HASH);
    expect(store.get(`arc:hash2id:${HASH}`)).toBe('7');
  });

  it("starts its own checkpoint instead of resuming from the testnet one", async () => {
    store.set('arc:events:checkpoint', '63235379'); // testnet, far past mainnet's head
    chain.arcProvider.getBlockNumber.mockResolvedValue(HEAD);
    chain.arcEscrow.queryFilter.mockResolvedValue([]);
    await forceArcTick();
    expect(chain.arcEscrow.queryFilter).toHaveBeenCalled();
    expect(Number(store.get('arc@5042:events:checkpoint'))).toBeLessThanOrEqual(HEAD);
    expect(store.get('arc:events:checkpoint')).toBe('63235379');
  });

  it('keeps the bare arc: keys on Arc testnet', async () => {
    net.arc = 5042002;
    await seedArcTaskIdMapping(HASH, 7n);
    expect(store.get(`arc:hash2id:${HASH}`)).toBe('7');
  });
});
