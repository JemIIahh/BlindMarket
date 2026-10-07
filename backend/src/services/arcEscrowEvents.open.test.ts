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

const openLog = (eventName: string, taskId: bigint) => ({ eventName, args: { taskId }, transactionHash: '0xtx' });
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

  it('keeps the checkpoint when an event fails, so the scan retries those blocks', async () => {
    handleOpenEvent.mockImplementation(async (_c: string, ev: unknown) => {
      if ((ev as { eventName: string }).eventName === 'OpenSubmission') throw new Error('rpc down');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await pollArcEscrowOnce();
    expect(store.get('arc:events:open-checkpoint')).toBe(String(HEAD - 10));
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
