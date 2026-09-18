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
// Open unless a test closes it: a process on another deployment's Redis.
const gate = vi.hoisted(() => ({ allowed: true }));
vi.mock('./deploymentIdentity.js', () => ({ backgroundWritesAllowed: () => gate.allowed }));

const HEAD = 10_000;
/** Rulings are scanned this far behind the head (DISPUTE_CONFIRMATIONS). */
const RULINGS_TO = HEAD - 5;
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
  gate.allowed = true;
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

    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([{ from: 9801, to: RULINGS_TO }]);
    expect(listener.handleDisputeResolved.mock.calls).toEqual([['base', 3n, true], ['base', 4n, false]]);
    expect(listener.retryParkedDisputes).toHaveBeenCalledWith('base');
    expect(redisMock.store.get('base:events:checkpoint')).toBe(String(HEAD));
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe(String(RULINGS_TO));
  });

  it('on a new or flushed Redis, scans rulings from the head only, so past ones are not credited again', async () => {
    const { pollBaseEscrowOnce } = await loadBase('9000');

    await pollBaseEscrowOnce();

    // Tasks are indexed from the deployment block; rulings are not.
    expect(rangesFor(chain.baseEscrow, 'TaskCreated')).toEqual([{ from: 9000, to: 9499 }]);
    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([]);
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe(String(HEAD));

    // Once tasks catch up, rulings after the head at first boot are scanned.
    chain.baseProvider.getBlockNumber.mockResolvedValue(HEAD + 100);
    redisMock.store.set('base:events:checkpoint', String(HEAD));
    await pollBaseEscrowOnce();
    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([{ from: HEAD + 1, to: HEAD + 95 }]);
  });

  it('seeds the ruling scan before task indexing, so a failed first pass cannot replay history', async () => {
    const { pollBaseEscrowOnce } = await loadBase('9000');
    const set = redisMock.set.getMockImplementation()!;
    let failed = false;
    redisMock.set.mockImplementation(async (k: string, v: string, mode?: string) => {
      if (k === 'base:events:checkpoint' && !failed) {
        failed = true;
        throw new Error('redis blip');
      }
      return set(k, v, mode);
    });

    await pollBaseEscrowOnce();
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe(String(HEAD));
    expect(redisMock.store.has('base:events:checkpoint')).toBe(false);

    await pollBaseEscrowOnce();
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe(String(HEAD));
    expect(redisMock.store.get('base:events:checkpoint')).toBe('9499');
    redisMock.set.mockImplementation(set);
  });

  it('seeds the ruling scan again when its checkpoint is deleted', async () => {
    redisMock.store.set('base:events:checkpoint', '9800');
    const { pollBaseEscrowOnce } = await loadBase();
    await pollBaseEscrowOnce();
    redisMock.store.delete('base:events:dispute-checkpoint');

    // The poll that finds it missing stops scanning; the next one reseeds it
    // where task indexing stands.
    await pollBaseEscrowOnce();
    expect(redisMock.store.has('base:events:dispute-checkpoint')).toBe(false);
    await pollBaseEscrowOnce();
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe(String(HEAD));

    chain.baseProvider.getBlockNumber.mockResolvedValue(HEAD + 50);
    await pollBaseEscrowOnce();
    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([
      { from: 9801, to: RULINGS_TO },
      { from: HEAD + 1, to: HEAD + 45 },
    ]);
  });

  it('starts a checkpoint deleted during a catch-up at the head, not where tasks stand', async () => {
    redisMock.store.set('base:events:checkpoint', '5000');
    redisMock.store.set('base:events:dispute-checkpoint', '5000');
    const { pollBaseEscrowOnce } = await loadBase();
    await pollBaseEscrowOnce();
    redisMock.store.delete('base:events:dispute-checkpoint');

    await pollBaseEscrowOnce();
    await pollBaseEscrowOnce();
    expect(redisMock.store.get('base:events:checkpoint')).toBe('6500');
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe(String(HEAD));
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
    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([{ from: 9801, to: RULINGS_TO }]);
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
      { from: 9801, to: RULINGS_TO },
      { from: 9801, to: RULINGS_TO },
    ]);
    expect(redisMock.store.get('base:events:dispute-checkpoint')).toBe(String(RULINGS_TO));
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

  it('stays a few blocks behind the TaskCreated checkpoint', async () => {
    redisMock.store.set('base:events:checkpoint', '5000');
    redisMock.store.set('base:events:dispute-checkpoint', '5200');
    const { pollBaseEscrowOnce } = await loadBase();

    await pollBaseEscrowOnce();

    expect(rangesFor(chain.baseEscrow, 'TaskCreated')).toEqual([{ from: 5001, to: 5500 }]);
    expect(rangesFor(chain.baseEscrow, 'DisputeResolved')).toEqual([{ from: 5201, to: 5495 }]);
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

// A process on another deployment's Redis must not write that deployment's
// index — not from its loops, and not from the passes request paths force
// (taskChain's slow path, /tasks/index), which is how such a process would
// otherwise plant escrow fingerprints and move checkpoints.
describe('on another deployment\'s Redis (deploymentIdentity)', () => {
  it('the 0G indexer reads and writes nothing, forced or polled', async () => {
    redisMock.store.set('a2a:events:checkpoint', '9800');
    gate.allowed = false;
    vi.resetModules();
    const { forceTick, pollEscrowOnce } = await import('./escrowEvents.js');
    await forceTick();
    await pollEscrowOnce();
    expect(chain.provider.getBlockNumber).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(listener.retryParkedDisputes).not.toHaveBeenCalled();
  });

  it("the 0G request path's retries and full backfill write nothing either", async () => {
    gate.allowed = false;
    vi.resetModules();
    const { getTaskIdByHash } = await import('./escrowEvents.js');
    vi.useFakeTimers();
    try {
      const found = getTaskIdByHash('0x' + 'ab'.repeat(32));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await found).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect(chain.provider.getBlockNumber).not.toHaveBeenCalled();
    expect(chain.escrow.queryFilter).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(redisMock.pipeline).not.toHaveBeenCalled();
  });

  it('neither does the Base indexer', async () => {
    redisMock.store.set('base:events:checkpoint', '9800');
    gate.allowed = false;
    vi.resetModules();
    const { forceBaseTick, pollBaseEscrowOnce } = await import('./baseEscrowEvents.js');
    await forceBaseTick();
    await pollBaseEscrowOnce();
    expect(chain.baseProvider.getBlockNumber).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(listener.retryParkedDisputes).not.toHaveBeenCalled();
  });
});
