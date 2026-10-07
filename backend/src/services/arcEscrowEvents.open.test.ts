import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The Arc indexer scans the open-submission events (OpenTaskCreated,
 * OpenSubmission, WinnerSelected, OpenTaskVoided) in one log query, behind
 * its own checkpoint, and only with OPEN_SUBMISSION_ENABLED: off, it neither
 * queries nor writes, so turning the feature off costs production nothing.
 */

const HEAD = 10_000;
const OPEN_EVENTS = ['OpenTaskCreated', 'OpenSubmission', 'WinnerSelected', 'OpenTaskVoided'];

const { chain, store, handleOpenEvent, flag } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  handleOpenEvent: vi.fn(async (_chain: string, _ev: unknown) => {}),
  flag: { on: true },
  chain: {
    arcProvider: { getBlockNumber: vi.fn() },
    arcEscrow: {
      filters: {
        TaskCreated: vi.fn(() => 'task-created'),
        DisputeResolved: vi.fn(() => 'dispute-resolved'),
        UnjudgedWorkReleased: vi.fn(() => 'unjudged-released'),
        TaskCancelled: vi.fn(() => 'task-cancelled'),
      },
      queryFilter: vi.fn(),
    },
  },
}));

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>();
  return {
    ...real,
    config: new Proxy(real.config, {
      get: (target, prop) => (prop === 'openSubmissionEnabled' ? flag.on : Reflect.get(target, prop)),
    }),
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
    pipeline: vi.fn(() => ({ set: vi.fn(), exec: vi.fn(async () => []) })),
  },
}));
vi.mock('./deploymentIdentity.js', () => ({ backgroundWritesAllowed: () => true }));
vi.mock('./escrowFingerprint.js', () => ({ checkEscrowFingerprint: vi.fn(async () => {}) }));
vi.mock('./disputeListener.js', () => ({ handleDisputeResolved: vi.fn(async () => {}), retryParkedDisputes: vi.fn(async () => {}) }));
vi.mock('./refundedTasks.js', () => ({ handleTaskCancelled: vi.fn(async () => true) }));
vi.mock('./openSubmissionEvents.js', () => ({ OPEN_EVENTS, handleOpenEvent }));

const { pollArcEscrowOnce } = await import('./arcEscrowEvents.js');

const openLog = (eventName: string, taskId: bigint, blockNumber = HEAD - 5) => ({ eventName, args: { taskId }, transactionHash: '0xtx', blockNumber });
const isOpenQuery = (filter: unknown) => Array.isArray(filter);
const openQueries = () => chain.arcEscrow.queryFilter.mock.calls.filter(([f]) => isOpenQuery(f));

beforeEach(() => {
  vi.clearAllMocks();
  flag.on = true;
  handleOpenEvent.mockReset().mockResolvedValue(undefined);
  store.clear();
  store.set('arc:events:checkpoint', String(HEAD - 10));
  store.set('arc:events:dispute-checkpoint', String(HEAD - 20));
  store.set('arc:events:cancel-checkpoint', String(HEAD));
  store.set('arc:events:open-checkpoint', String(HEAD - 10));
  chain.arcProvider.getBlockNumber.mockResolvedValue(HEAD);
  chain.arcEscrow.queryFilter.mockImplementation(async (filter: unknown) =>
    isOpenQuery(filter) ? [openLog('OpenTaskCreated', 4n), openLog('OpenSubmission', 4n)] : []);
});

describe('Arc indexer — open-submission events', () => {
  it('queries all four events at once up to the indexed head, hands each over in order, and advances', async () => {
    await pollArcEscrowOnce();
    expect(openQueries()).toEqual([[[OPEN_EVENTS], HEAD - 9, HEAD]]);
    expect(handleOpenEvent.mock.calls.map(([c, ev]) => [c, (ev as { eventName: string }).eventName])).toEqual([
      ['arc', 'OpenTaskCreated'],
      ['arc', 'OpenSubmission'],
    ]);
    expect(store.get('arc:events:open-checkpoint')).toBe(String(HEAD));
  });

  it('keeps the checkpoint before the block of a failed event, so the scan retries that block', async () => {
    handleOpenEvent.mockImplementation(async (_c: string, ev: unknown) => {
      if ((ev as { eventName: string }).eventName === 'OpenSubmission') throw new Error('rpc down');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await pollArcEscrowOnce();
    // Both events are in block HEAD-5: the whole block is redone next tick.
    expect(store.get('arc:events:open-checkpoint')).toBe(String(HEAD - 6));
    handleOpenEvent.mockReset().mockResolvedValue(undefined);
    await pollArcEscrowOnce();
    expect(handleOpenEvent).toHaveBeenCalledTimes(2);
    expect(store.get('arc:events:open-checkpoint')).toBe(String(HEAD));
  });

  it('keeps the checkpoint where it was when the first block fails', async () => {
    chain.arcEscrow.queryFilter.mockImplementation(async (filter: unknown) =>
      isOpenQuery(filter) ? [openLog('OpenSubmission', 4n, HEAD - 9)] : []);
    handleOpenEvent.mockRejectedValue(new Error('rpc down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await pollArcEscrowOnce();
    expect(store.get('arc:events:open-checkpoint')).toBe(String(HEAD - 10));
  });

  it('after a failure, redoes only the failing block', async () => {
    chain.arcEscrow.queryFilter.mockImplementation(async (filter: unknown) =>
      isOpenQuery(filter) ? [openLog('OpenTaskCreated', 4n, HEAD - 8), openLog('OpenSubmission', 4n, HEAD - 3)] : []);
    handleOpenEvent.mockImplementation(async (_c: string, ev: unknown) => {
      if ((ev as { eventName: string }).eventName === 'OpenSubmission') throw new Error('rpc down');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await pollArcEscrowOnce();
    expect(store.get('arc:events:open-checkpoint')).toBe(String(HEAD - 4));
  });

  it('stops between blocks once over its time budget, so a burst cannot hold up the other scans', async () => {
    chain.arcEscrow.queryFilter.mockImplementation(async (filter: unknown) =>
      isOpenQuery(filter) ? [openLog('OpenSubmission', 4n, HEAD - 8), openLog('OpenSubmission', 4n, HEAD - 8), openLog('OpenSubmission', 4n, HEAD - 2)] : []);
    let clock = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // Each event takes 10 s: the second (same block) still runs, the third (next block) waits.
    handleOpenEvent.mockImplementation(async () => { clock += 10_000; });
    await pollArcEscrowOnce();
    now.mockRestore();
    expect(handleOpenEvent).toHaveBeenCalledTimes(2);
    expect(store.get('arc:events:open-checkpoint')).toBe(String(HEAD - 3));
  });

  it('starts at the indexed head on its first scan', async () => {
    store.delete('arc:events:open-checkpoint');
    await pollArcEscrowOnce();
    expect(openQueries()).toEqual([[[OPEN_EVENTS], HEAD, HEAD]]);
  });

  it('skips logs the escrow interface could not decode', async () => {
    chain.arcEscrow.queryFilter.mockImplementation(async (filter: unknown) => (isOpenQuery(filter) ? [{ topics: [], data: '0x' }] : []));
    await pollArcEscrowOnce();
    expect(handleOpenEvent).not.toHaveBeenCalled();
    expect(store.get('arc:events:open-checkpoint')).toBe(String(HEAD));
  });

  it('with OPEN_SUBMISSION_ENABLED off, neither queries nor writes', async () => {
    flag.on = false;
    store.delete('arc:events:open-checkpoint');
    await pollArcEscrowOnce();
    expect(openQueries()).toHaveLength(0);
    expect(store.has('arc:events:open-checkpoint')).toBe(false);
  });
});
