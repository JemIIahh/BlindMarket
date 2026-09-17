/**
 * DisputeResolved scanning in the 0G and Base indexers.
 *
 * The Base indexer only read TaskCreated, so a Base dispute ruled for the
 * worker never reached their earnings. It now scans DisputeResolved from the
 * poll loop, behind its own checkpoint, so a failing ruling can't hold up
 * task indexing and request paths that force a tick don't wait on rulings.
 * The 0G indexer keeps one checkpoint for both events.
 *
 * Run: npx vitest run src/services/escrowEvents.disputes.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { chain, redisMock, listener } = vi.hoisted(() => {
  const escrowMock = () => ({
    filters: {
      TaskCreated: vi.fn(() => 'TaskCreated'),
      DisputeResolved: vi.fn(() => 'DisputeResolved'),
    },
    queryFilter: vi.fn(),
  });
  const store = new Map<string, string>();
  return {
    chain: {
      provider: { getBlockNumber: vi.fn() },
      escrow: escrowMock(),
      baseProvider: { getBlockNumber: vi.fn() },
      baseEscrow: escrowMock(),
    },
    redisMock: {
      store,
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string, mode?: string) => {
        if (mode === 'NX' && store.has(k)) return null;
        store.set(k, v);
        return 'OK';
      }),
      pipeline: vi.fn(() => ({ set: vi.fn(), exec: vi.fn(async () => []) })),
    },
    listener: {
      handleDisputeResolved: vi.fn(),
      retryParkedDisputes: vi.fn(async () => {}),
    },
  };
});

vi.mock('./chain.js', () => chain);
vi.mock('./redis.js', () => ({ redis: redisMock }));
vi.mock('./disputeListener.js', () => listener);

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
  chain.provider.getBlockNumber.mockResolvedValue(HEAD);
  chain.baseProvider.getBlockNumber.mockResolvedValue(HEAD);
  serve(chain.escrow);
  serve(chain.baseEscrow);
  listener.handleDisputeResolved.mockResolvedValue(undefined);
});

async function loadBase(deploymentBlock?: string) {
  vi.resetModules();
  if (deploymentBlock === undefined) delete process.env.BASE_ESCROW_DEPLOYMENT_BLOCK;
  else process.env.BASE_ESCROW_DEPLOYMENT_BLOCK = deploymentBlock;
  const mod = await import('./baseEscrowEvents.js');
  delete process.env.BASE_ESCROW_DEPLOYMENT_BLOCK;
  return mod;
}

describe('Base DisputeResolved scan', () => {
  it('starts where task indexing stood and hands each ruling to the listener', async () => {
    redisMock.store.set('base:events:checkpoint', '9800');
    serve(chain.baseEscrow, [ruling(3n, true), ruling(4n, false)]);
    const { pollBaseEscrowOnce } = await loadBase();

    await pollBaseEscrowOnce();

    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([{ from: 9801, to: HEAD }]);
    expect(listener.handleDisputeResolved.mock.calls).toEqual([['base', 3n, true], ['base', 4n, false]]);
    expect(listener.retryParkedDisputes).toHaveBeenCalledWith('base');
    expect(redisMock.store.get('base:events:checkpoint')).toBe(String(HEAD));
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe(String(HEAD));
  });

  it('starts at the deployment block on a new Redis', async () => {
    const { pollBaseEscrowOnce } = await loadBase('9000');

    await pollBaseEscrowOnce();

    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([{ from: 9000, to: 9499 }]);
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe('9499');
  });

  it('leaves rulings to the poll loop when a request forces a tick', async () => {
    redisMock.store.set('base:events:checkpoint', '9800');
    serve(chain.baseEscrow, [ruling(3n, true)]);
    const { forceBaseTick, pollBaseEscrowOnce } = await loadBase();

    await forceBaseTick();
    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([]);
    expect(listener.retryParkedDisputes).not.toHaveBeenCalled();
    expect(redisMock.store.get('base:events:checkpoint')).toBe(String(HEAD));

    // The forced pass moved task indexing on, but seeded the ruling scan
    // from where it started, so the next poll still covers those blocks.
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe('9800');
    await pollBaseEscrowOnce();
    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([{ from: 9801, to: HEAD }]);
    expect(listener.handleDisputeResolved).toHaveBeenCalledWith('base', 3n, true);
  });

  it('keeps its own checkpoint when a ruling fails, while task indexing moves on', async () => {
    redisMock.store.set('base:events:checkpoint', '9800');
    serve(chain.baseEscrow, [ruling(3n, true)]);
    listener.handleDisputeResolved.mockRejectedValueOnce(new Error('DisputeResolved base taskId=3: ledger down'));
    const { pollBaseEscrowOnce } = await loadBase();

    await pollBaseEscrowOnce();

    expect(redisMock.store.get('base:events:checkpoint')).toBe(String(HEAD));
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe('9800');

    // Next poll: tasks are caught up, the ruling is retried.
    await pollBaseEscrowOnce();
    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([
      { from: 9801, to: HEAD },
      { from: 9801, to: HEAD },
    ]);
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe(String(HEAD));
  });

  it('catches up in chunks once tasks are indexed', async () => {
    redisMock.store.set('base:events:checkpoint', '9800');
    redisMock.store.set('base:events:dispute-checkpoint', '8000');
    const { pollBaseEscrowOnce } = await loadBase();

    await pollBaseEscrowOnce();
    await pollBaseEscrowOnce();

    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([
      { from: 8001, to: 8500 },
      { from: 8501, to: 9000 },
    ]);
  });

  it('never scans past the TaskCreated checkpoint', async () => {
    redisMock.store.set('base:events:checkpoint', '5000');
    redisMock.store.set('base:events:dispute-checkpoint', '5200');
    const { pollBaseEscrowOnce } = await loadBase();

    await pollBaseEscrowOnce();

    expect(rangesFor(chain.baseEscrow, 'TaskCreated')).toEqual([{ from: 5001, to: 5500 }]);
    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([{ from: 5201, to: 5500 }]);
  });

  it('does not scan rulings when the TaskCreated pass failed', async () => {
    redisMock.store.set('base:events:checkpoint', '9800');
    redisMock.store.set('base:events:dispute-checkpoint', '9800');
    chain.baseEscrow.queryFilter.mockRejectedValueOnce(new Error('rpc down'));
    const { pollBaseEscrowOnce } = await loadBase();

    await pollBaseEscrowOnce();

    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([]);
    expect(listener.retryParkedDisputes).not.toHaveBeenCalled();
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

    expect(listener.handleDisputeResolved).toHaveBeenCalledWith('0g', 9n, true);
    expect(redisMock.store.get('a2a:events:checkpoint')).toBe(String(HEAD));
    // Parked rulings are retried from the poll loop only.
    expect(listener.retryParkedDisputes).not.toHaveBeenCalled();
  });

  it('keeps the checkpoint when a ruling fails', async () => {
    redisMock.store.set('a2a:events:checkpoint', '9800');
    serve(chain.escrow, [ruling(9n, true)]);
    listener.handleDisputeResolved.mockRejectedValueOnce(new Error('ledger down'));
    const { forceTick } = await load0G();

    await forceTick();

    expect(redisMock.store.get('a2a:events:checkpoint')).toBe('9800');
  });

  it('retries parked rulings from the poll loop', async () => {
    redisMock.store.set('a2a:events:checkpoint', '9800');
    const { pollEscrowOnce } = await load0G();
    await pollEscrowOnce();
    expect(listener.retryParkedDisputes).toHaveBeenCalledWith('0g');
  });
});
