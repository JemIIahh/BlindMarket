import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The escrow does not enforce unique task hashes, so anyone can fund a second
 * task under a live task's hash. The Arc indexer used to SET hash2id on every
 * TaskCreated, so the duplicate repointed the hash at the attacker's escrow
 * id — and assignment, settlement and result visibility all follow that
 * mapping. Base already kept the first writer; Arc must too.
 */

const HASH = '0x' + 'ab'.repeat(32);
const HEAD = 5_000;

const { chain, store } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    chain: {
      arcProvider: { getBlockNumber: vi.fn() },
      arcEscrow: {
        filters: { TaskCreated: vi.fn(() => 'task-created-filter') },
        queryFilter: vi.fn(),
      },
    },
  };
});

// A pipeline that honours NX the way Redis does.
function setWith(k: string, v: string, mode?: string): 'OK' | null {
  if (mode === 'NX' && store.has(k)) return null;
  store.set(k, v);
  return 'OK';
}

vi.mock('./chain.js', () => chain);
vi.mock('./redis.js', () => ({
  redis: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, mode?: string) => setWith(k, v, mode)),
    pipeline: vi.fn(() => {
      const ops: Array<() => void> = [];
      const pipe = {
        set: (k: string, v: string, mode?: string) => { ops.push(() => setWith(k, v, mode)); return pipe; },
        exec: async () => ops.map((op) => [null, op()]),
      };
      return pipe;
    }),
  },
}));
vi.mock('./deploymentIdentity.js', () => ({ backgroundWritesAllowed: () => true }));
vi.mock('./escrowFingerprint.js', () => ({ checkEscrowFingerprint: vi.fn(async () => {}) }));
vi.mock('./disputeListener.js', () => ({ handleDisputeResolved: vi.fn(), retryParkedDisputes: vi.fn() }));

const { forceArcTick, getArcTaskIdByHash, getArcTaskHashById, seedArcTaskIdMapping } = await import('./arcEscrowEvents.js');

function created(taskId: bigint) {
  return { args: { taskId, taskHash: HASH } };
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('Arc TaskCreated indexer', () => {
  it('keeps the first task a hash was indexed to when a later task reuses the hash', async () => {
    chain.arcProvider.getBlockNumber.mockResolvedValueOnce(HEAD).mockResolvedValueOnce(HEAD + 1);
    chain.arcEscrow.queryFilter
      .mockResolvedValueOnce([created(1n)])
      .mockResolvedValueOnce([created(2n)]);

    await forceArcTick();
    await forceArcTick();

    expect(chain.arcEscrow.queryFilter).toHaveBeenCalledTimes(2);
    expect(await getArcTaskIdByHash(HASH)).toBe('1');
    // The duplicate's own id still maps to the hash it really carries.
    expect(await getArcTaskHashById(2n)).toBe(HASH);
  });

  it("lets the index route's seed (the hash's claimed poster) set the mapping", async () => {
    await seedArcTaskIdMapping(HASH, 7n);
    expect(await getArcTaskIdByHash(HASH)).toBe('7');
  });
});
