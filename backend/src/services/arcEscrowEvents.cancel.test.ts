import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The Arc indexer closes the listing of a task cancelled on-chain
 * (TaskCancelled). Before, only POST /tasks/:id/confirm-tx did, so a cancel
 * from the SDK or straight to the escrow left the task listed. Scanned behind
 * its own checkpoint, up to the TaskCreated head.
 */

const HEAD = 10_000;

const { chain, store, handleTaskCancelled } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  handleTaskCancelled: vi.fn(async (_chain: string, _taskId: bigint) => true),
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
vi.mock('./refundedTasks.js', () => ({ handleTaskCancelled }));

const { pollArcEscrowOnce } = await import('./arcEscrowEvents.js');

const cancelled = (taskId: bigint) => ({ args: { taskId, refundAmount: 1_000_000n } });

beforeEach(() => {
  vi.clearAllMocks();
  handleTaskCancelled.mockReset().mockResolvedValue(true);
  store.clear();
  // An existing deployment: tasks indexed to HEAD-10.
  store.set('arc:events:checkpoint', String(HEAD - 10));
  store.set('arc:events:dispute-checkpoint', String(HEAD - 20));
  store.set('arc:events:cancel-checkpoint', String(HEAD - 10));
  chain.arcProvider.getBlockNumber.mockResolvedValue(HEAD);
  chain.arcEscrow.queryFilter.mockImplementation(async (filter: string) =>
    filter === 'task-cancelled' ? [cancelled(4n), cancelled(6n)] : []);
});

describe('Arc indexer — TaskCancelled', () => {
  it('closes each cancelled task up to the indexed head and advances its checkpoint', async () => {
    await pollArcEscrowOnce();
    expect(chain.arcEscrow.queryFilter).toHaveBeenCalledWith('task-cancelled', HEAD - 9, HEAD);
    expect(handleTaskCancelled).toHaveBeenCalledWith('arc', 4n);
    expect(handleTaskCancelled).toHaveBeenCalledWith('arc', 6n);
    expect(store.get('arc:events:cancel-checkpoint')).toBe(String(HEAD));
  });

  it('keeps the checkpoint when a close fails, so the scan retries those blocks', async () => {
    handleTaskCancelled.mockImplementation(async (_c: string, taskId: bigint) => {
      if (taskId === 6n) throw new Error('rpc down');
      return true;
    });
    await pollArcEscrowOnce();
    expect(store.get('arc:events:cancel-checkpoint')).toBe(String(HEAD - 10));
    await pollArcEscrowOnce();
    expect(handleTaskCancelled).toHaveBeenCalledTimes(4);
  });

  it('starts at the indexed head on its first scan, not the escrow deploy block', async () => {
    store.delete('arc:events:cancel-checkpoint');
    await pollArcEscrowOnce();
    expect(chain.arcEscrow.queryFilter).toHaveBeenCalledWith('task-cancelled', HEAD, HEAD);
    expect(store.get('arc:events:cancel-checkpoint')).toBe(String(HEAD));
  });
});
