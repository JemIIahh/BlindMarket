import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Where the Base TaskCreated indexer starts when Redis has no checkpoint.
 * It used to be Math.max(head, BASE_ESCROW_DEPLOYMENT_BLOCK), which is the
 * head for any past deployment block, so tasks created before the indexer
 * first ran on a Redis were never indexed. It also saved `from` as already
 * processed before scanning it.
 */

const { chain, redisMock } = vi.hoisted(() => ({
  chain: {
    baseProvider: { getBlockNumber: vi.fn() },
    baseEscrow: {
      filters: { TaskCreated: vi.fn(() => 'task-created-filter') },
      queryFilter: vi.fn(),
    },
  },
  redisMock: {
    store: new Map<string, string>(),
    get: vi.fn(),
    set: vi.fn(),
    pipeline: vi.fn(() => ({ set: vi.fn(), exec: vi.fn(async () => []) })),
  },
}));

vi.mock('./chain.js', () => chain);
vi.mock('./redis.js', () => ({ redis: redisMock }));

const HEAD = 10_000;

async function loadWith(deploymentBlock: string | undefined) {
  vi.resetModules();
  if (deploymentBlock === undefined) delete process.env.BASE_ESCROW_DEPLOYMENT_BLOCK;
  else process.env.BASE_ESCROW_DEPLOYMENT_BLOCK = deploymentBlock;
  return import('./baseEscrowEvents.js');
}

/** Blocks the first tick asked the escrow for. */
function scanned() {
  const [, from, to] = chain.baseEscrow.queryFilter.mock.calls[0] as [unknown, number, number];
  return { from, to };
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.store.clear();
  redisMock.get.mockImplementation(async (k: string) => redisMock.store.get(k) ?? null);
  redisMock.set.mockImplementation(async (k: string, v: string) => { redisMock.store.set(k, v); return 'OK'; });
  chain.baseProvider.getBlockNumber.mockResolvedValue(HEAD);
  chain.baseEscrow.queryFilter.mockResolvedValue([]);
});

afterEach(() => { delete process.env.BASE_ESCROW_DEPLOYMENT_BLOCK; });

describe('Base indexer start block', () => {
  it('starts at the deployment block when one is set in the past', async () => {
    const { forceBaseTick } = await loadWith('9000');
    await forceBaseTick();
    expect(scanned()).toEqual({ from: 9000, to: 9499 });
    expect(redisMock.store.get('base:events:checkpoint')).toBe('9499');
  });

  it.each([undefined, '', 'abc', '9000.5', '-5'])('starts at the head when the deployment block is %j', async (value) => {
    const { forceBaseTick } = await loadWith(value);
    await forceBaseTick();
    expect(scanned()).toEqual({ from: HEAD, to: HEAD });
    expect(redisMock.store.get('base:events:checkpoint')).toBe(String(HEAD));
  });

  it('clamps a deployment block above the head to the head', async () => {
    const { forceBaseTick } = await loadWith(String(HEAD + 50));
    await forceBaseTick();
    expect(scanned()).toEqual({ from: HEAD, to: HEAD });
  });

  it('prefers an existing checkpoint over the deployment block', async () => {
    redisMock.store.set('base:events:checkpoint', '9800');
    const { forceBaseTick } = await loadWith('9000');
    await forceBaseTick();
    expect(scanned()).toEqual({ from: 9801, to: HEAD });
  });

  it('rescans the first block after a failed first tick', async () => {
    const { forceBaseTick } = await loadWith('9000');
    chain.baseEscrow.queryFilter.mockRejectedValueOnce(new Error('rpc down'));
    await forceBaseTick();
    expect(redisMock.store.get('base:events:checkpoint')).toBe('8999');

    await forceBaseTick();
    const [, from] = chain.baseEscrow.queryFilter.mock.calls[1] as [unknown, number];
    expect(from).toBe(9000);
  });
});
