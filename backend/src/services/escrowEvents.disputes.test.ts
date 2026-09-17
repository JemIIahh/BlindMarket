/**
 * DisputeResolved scanning in the 0G and Base indexers.
 *
 * The Base indexer only read TaskCreated, so a Base dispute ruled for the
 * worker never reached their earnings. It now scans DisputeResolved behind
 * its own checkpoint, so a failing ruling can't hold up task indexing. The
 * 0G indexer keeps one checkpoint for both events.
 *
 * Run: npx vitest run src/services/escrowEvents.disputes.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { chain, redisMock, handleDisputeResolved } = vi.hoisted(() => {
  const escrowMock = () => ({
    filters: {
      TaskCreated: vi.fn(() => 'TaskCreated'),
      DisputeResolved: vi.fn(() => 'DisputeResolved'),
    },
    queryFilter: vi.fn(),
  });
  return {
    chain: {
      provider: { getBlockNumber: vi.fn() },
      escrow: escrowMock(),
      baseProvider: { getBlockNumber: vi.fn() },
      baseEscrow: escrowMock(),
    },
    redisMock: {
      store: new Map<string, string>(),
      get: vi.fn(),
      set: vi.fn(),
      pipeline: vi.fn(() => ({ set: vi.fn(), exec: vi.fn(async () => []) })),
    },
    handleDisputeResolved: vi.fn(),
  };
});

vi.mock('./chain.js', () => chain);
vi.mock('./redis.js', () => ({ redis: redisMock }));
vi.mock('./disputeListener.js', () => ({ handleDisputeResolved }));

const HEAD = 10_000;
const ruling = (taskId: bigint, workerFavored: boolean) => ({ args: { taskId, workerFavored } });

type EscrowMock = typeof chain.escrow;

/** Serve `disputes` for every DisputeResolved query and no TaskCreated events. */
function serve(escrow: EscrowMock, disputes: unknown[] = []) {
  escrow.queryFilter.mockImplementation(async (filter: string) => (filter === 'DisputeResolved' ? disputes : []));
}

function rangesFor(escrow: EscrowMock, filter: string) {
  return escrow.queryFilter.mock.calls
    .filter(([f]) => f === filter)
    .map(([, from, to]) => ({ from, to }));
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.store.clear();
  redisMock.get.mockImplementation(async (k: string) => redisMock.store.get(k) ?? null);
  redisMock.set.mockImplementation(async (k: string, v: string) => { redisMock.store.set(k, v); return 'OK'; });
  chain.provider.getBlockNumber.mockResolvedValue(HEAD);
  chain.baseProvider.getBlockNumber.mockResolvedValue(HEAD);
  serve(chain.escrow);
  serve(chain.baseEscrow);
  handleDisputeResolved.mockResolvedValue(undefined);
});

async function loadBase() {
  vi.resetModules();
  delete process.env.BASE_ESCROW_DEPLOYMENT_BLOCK;
  return import('./baseEscrowEvents.js');
}

describe('Base DisputeResolved scan', () => {
  it('starts where the TaskCreated pass started and hands each ruling to the listener', async () => {
    redisMock.store.set('base:events:checkpoint', '9800');
    serve(chain.baseEscrow, [ruling(3n, true), ruling(4n, false)]);
    const { forceBaseTick } = await loadBase();

    await forceBaseTick();

    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([{ from: 9801, to: HEAD }]);
    expect(handleDisputeResolved.mock.calls).toEqual([['base', 3n, true], ['base', 4n, false]]);
    expect(redisMock.store.get('base:events:checkpoint')).toBe(String(HEAD));
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe(String(HEAD));
  });

  it('starts at the deployment block on a new Redis', async () => {
    vi.resetModules();
    process.env.BASE_ESCROW_DEPLOYMENT_BLOCK = '9000';
    const { forceBaseTick } = await import('./baseEscrowEvents.js');
    delete process.env.BASE_ESCROW_DEPLOYMENT_BLOCK;

    await forceBaseTick();

    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([{ from: 9000, to: 9499 }]);
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe('9499');
  });

  it('keeps its own checkpoint when a ruling fails, while task indexing moves on', async () => {
    redisMock.store.set('base:events:checkpoint', '9800');
    serve(chain.baseEscrow, [ruling(3n, true)]);
    handleDisputeResolved.mockRejectedValueOnce(new Error('ledger down'));
    const { forceBaseTick } = await loadBase();

    await forceBaseTick();

    expect(redisMock.store.get('base:events:checkpoint')).toBe(String(HEAD));
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe('9800');

    // Next tick: tasks are caught up, the ruling is retried.
    await forceBaseTick();
    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([
      { from: 9801, to: HEAD },
      { from: 9801, to: HEAD },
    ]);
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe(String(HEAD));
  });

  it('catches up in chunks once tasks are indexed', async () => {
    redisMock.store.set('base:events:checkpoint', '9800');
    redisMock.store.set('base:events:dispute-checkpoint', '8000');
    const { forceBaseTick } = await loadBase();

    await forceBaseTick();
    await forceBaseTick();

    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([
      { from: 8001, to: 8500 },
      { from: 8501, to: 9000 },
    ]);
  });

  it('never scans past the TaskCreated checkpoint', async () => {
    redisMock.store.set('base:events:checkpoint', '5000');
    redisMock.store.set('base:events:dispute-checkpoint', '5200');
    const { forceBaseTick } = await loadBase();

    await forceBaseTick();

    expect(rangesFor(chain.baseEscrow, 'TaskCreated')).toEqual([{ from: 5001, to: 5500 }]);
    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([{ from: 5201, to: 5500 }]);
  });

  it('does not scan rulings when the TaskCreated pass failed', async () => {
    redisMock.store.set('base:events:checkpoint', '9800');
    chain.baseEscrow.queryFilter.mockRejectedValueOnce(new Error('rpc down'));
    const { forceBaseTick } = await loadBase();

    await forceBaseTick();

    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([]);
    expect(redisMock.store.has('base:events:dispute-checkpoint')).toBe(false);
  });
});

describe('0G DisputeResolved scan', () => {
  async function load0G() {
    vi.resetModules();
    return import('./escrowEvents.js');
  }

  it('hands each ruling to the listener as a 0G ruling', async () => {
    redisMock.store.set('a2a:events:checkpoint', '9800');
    serve(chain.escrow, [ruling(9n, true)]);
    const { forceTick } = await load0G();

    await forceTick();

    expect(handleDisputeResolved).toHaveBeenCalledWith('0g', 9n, true);
    expect(redisMock.store.get('a2a:events:checkpoint')).toBe(String(HEAD));
  });

  it('keeps the checkpoint when a ruling fails', async () => {
    redisMock.store.set('a2a:events:checkpoint', '9800');
    serve(chain.escrow, [ruling(9n, true)]);
    handleDisputeResolved.mockRejectedValueOnce(new Error('ledger down'));
    const { forceTick } = await load0G();

    await forceTick();

    expect(redisMock.store.get('a2a:events:checkpoint')).toBe('9800');
  });
});
