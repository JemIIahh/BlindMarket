import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A cancel sent from the SDK or straight to the escrow left the task listed:
 * only POST /tasks/:id/confirm-tx closed the A2A state, and only the CLI and
 * web app call it. The Arc indexer now closes it from TaskCancelled through
 * the same close (closeRefundedA2ATask), with the same guards.
 */

const POSTER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WORKER = '0xcccccccccccccccccccccccccccccccccccccccc';
const ZERO = '0x0000000000000000000000000000000000000000';
const HASH = '0x' + 'ab'.repeat(32);

const getTaskOn = vi.fn();
vi.mock('./escrow.js', () => ({ getTaskOn: (...a: unknown[]) => getTaskOn(...a) }));

const resolveCachedTaskByHash = vi.fn();
vi.mock('./taskChain.js', () => ({ resolveCachedTaskByHash: (...a: unknown[]) => resolveCachedTaskByHash(...a) }));

vi.mock('./a2aStore.js', () => ({
  getState: vi.fn(),
  getMeta: vi.fn(),
  tryCloseOnChainTerminal: vi.fn(),
  clearOffer: vi.fn(async () => {}),
  clearCascade: vi.fn(async () => {}),
}));

import { handleTaskCancelled } from './refundedTasks.js';
import * as a2aStore from './a2aStore.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Escrow task 7 on Arc: cancelled while Funded, so no worker.
  getTaskOn.mockResolvedValue({ taskHash: HASH, agent: POSTER, worker: ZERO, status: 5 });
  resolveCachedTaskByHash.mockResolvedValue({ chain: 'arc', taskId: '7' });
  vi.mocked(a2aStore.getState).mockResolvedValue({ taskId: HASH, status: 'open' } as any);
  vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: HASH, posterAddress: POSTER } as any);
  vi.mocked(a2aStore.tryCloseOnChainTerminal).mockResolvedValue({ ok: true, previousStatus: 'open' });
});

describe('handleTaskCancelled', () => {
  it("closes the poster's listing and clears its offer and cascade", async () => {
    expect(await handleTaskCancelled('arc', 7n)).toBe(true);
    expect(getTaskOn).toHaveBeenCalledWith('arc', 7);
    expect(a2aStore.tryCloseOnChainTerminal).toHaveBeenCalledWith(HASH, 'cancelled');
    expect(a2aStore.clearOffer).toHaveBeenCalledWith(HASH);
    expect(a2aStore.clearCascade).toHaveBeenCalledWith(HASH);
  });

  it('changes nothing when confirm-tx already closed it', async () => {
    vi.mocked(a2aStore.tryCloseOnChainTerminal).mockResolvedValue({ ok: false, currentStatus: 'failed' });
    expect(await handleTaskCancelled('arc', 7n)).toBe(false);
    expect(a2aStore.clearOffer).not.toHaveBeenCalled();
  });

  it('leaves a refund by dispute ruling to disputeListener (the task had a worker)', async () => {
    getTaskOn.mockResolvedValue({ taskHash: HASH, agent: POSTER, worker: WORKER, status: 5 });
    expect(await handleTaskCancelled('arc', 7n)).toBe(false);
    expect(a2aStore.getState).not.toHaveBeenCalled();
    expect(a2aStore.tryCloseOnChainTerminal).not.toHaveBeenCalled();
  });

  it("does not close a listing another poster's duplicate-hash escrow was cancelled under", async () => {
    getTaskOn.mockResolvedValue({ taskHash: HASH, agent: OTHER, worker: ZERO, status: 5 });
    resolveCachedTaskByHash.mockResolvedValue(null);
    expect(await handleTaskCancelled('arc', 9n)).toBe(false);
    expect(a2aStore.tryCloseOnChainTerminal).not.toHaveBeenCalled();
  });

  it('does not close a listing the hash index names another escrow task for', async () => {
    resolveCachedTaskByHash.mockResolvedValue({ chain: 'arc', taskId: '3' });
    expect(await handleTaskCancelled('arc', 7n)).toBe(false);
    expect(a2aStore.tryCloseOnChainTerminal).not.toHaveBeenCalled();
  });

  it('does nothing for a task that was never listed', async () => {
    vi.mocked(a2aStore.getState).mockResolvedValue(undefined);
    expect(await handleTaskCancelled('arc', 7n)).toBe(false);
    expect(a2aStore.tryCloseOnChainTerminal).not.toHaveBeenCalled();
  });

  it('throws when the task cannot be read, so the indexer retries', async () => {
    getTaskOn.mockRejectedValue(new Error('rpc down'));
    await expect(handleTaskCancelled('arc', 7n)).rejects.toThrow('rpc down');
  });
});
