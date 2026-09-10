import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Regression: the gas-liveness sweep must not revert an assignment that
 * settled on-chain. The accept route clears the settlement-deadline key the
 * moment marketplaceAssign confirms, so a missing key looks identical to an
 * expired one; the sweep used to revert every young accepted task whose key
 * was gone — including the successfully settled ones (seen live 2026-09-10:
 * reverted 49s after accept, worker's /submit then 403'd).
 *
 * Run:  npx vitest run src/services/a2aExpirySweep.test.ts
 */

const redisStore = new Map<string, string>();
const releaseToOpen = vi.fn(async (_taskId: string) => {});
const listAcceptedTasks = vi.fn(async () => [] as Array<{ taskId: string; executorAddress: string }>);
const getSettlementDeadlineTTL = vi.fn(async (_taskId: string) => -2);
const resolveTaskByHash = vi.fn(async (_hash: string) => ({ taskId: '1', chain: 'base' as const }));
const getTaskOn = vi.fn(async (_chain: string, _id: number) => ({ worker: '0x0000000000000000000000000000000000000000', status: 0 }));

vi.mock('./redis.js', () => ({
  redis: { get: async (k: string) => redisStore.get(k) ?? null },
}));
vi.mock('./a2aStore.js', () => ({
  listAcceptedTasks: (...a: unknown[]) => listAcceptedTasks(...(a as [])),
  getSettlementDeadlineTTL: (...a: unknown[]) => getSettlementDeadlineTTL(...(a as [string])),
  releaseToOpen: (...a: unknown[]) => releaseToOpen(...(a as [string])),
  listOpenTasks: async () => [],
  getMeta: async () => null,
}));
vi.mock('./taskChain.js', () => ({
  resolveTaskByHash: (...a: unknown[]) => resolveTaskByHash(...(a as [string])),
  resolveCachedTaskByHash: async () => null,
}));
vi.mock('./escrow.js', () => ({
  getTaskOn: (...a: unknown[]) => getTaskOn(...(a as [string, number])),
}));
vi.mock('../constants.js', () => ({ SWEEP_INTERVAL_MS: 60_000, EXPIRY_GRACE_SEC: 60 }));

const { sweepGasLiveness } = await import('./a2aExpirySweep.js');

const TASK = '0x' + 'ab'.repeat(32);
const EXECUTOR = '0x3db43a971e4464346eba9233b485116713eb1b01';

function accepted(extra: Record<string, unknown> = {}) {
  redisStore.set(`a2a:state:${TASK}`, JSON.stringify({
    taskId: TASK,
    status: 'accepted',
    executorAddress: EXECUTOR,
    acceptedAt: new Date(Date.now() - 49_000).toISOString(), // young: inside the 5-minute window
    ...extra,
  }));
  listAcceptedTasks.mockResolvedValue([{ taskId: TASK, executorAddress: EXECUTOR }]);
}

beforeEach(() => {
  redisStore.clear();
  releaseToOpen.mockClear();
  getSettlementDeadlineTTL.mockResolvedValue(-2); // key gone in every case below
  resolveTaskByHash.mockResolvedValue({ taskId: '1', chain: 'base' });
  getTaskOn.mockResolvedValue({ worker: '0x0000000000000000000000000000000000000000', status: 0 });
});

describe('sweepGasLiveness with the deadline key gone', () => {
  it('leaves a task alone when the backend recorded the assign tx', async () => {
    accepted({ assignTxHash: '0x' + '11'.repeat(32) });
    await sweepGasLiveness();
    expect(releaseToOpen).not.toHaveBeenCalled();
    expect(getTaskOn).not.toHaveBeenCalled(); // no chain read needed
  });

  it('leaves a task alone when the chain already names this executor as worker', async () => {
    accepted();
    getTaskOn.mockResolvedValue({ worker: EXECUTOR.toUpperCase(), status: 1 });
    await sweepGasLiveness();
    expect(releaseToOpen).not.toHaveBeenCalled();
  });

  it('leaves a task alone when the chain has moved past Funded for someone else', async () => {
    accepted();
    getTaskOn.mockResolvedValue({ worker: '0x' + '99'.repeat(20), status: 1 });
    await sweepGasLiveness();
    expect(releaseToOpen).not.toHaveBeenCalled();
  });

  it('does nothing when the chain cannot be read this tick', async () => {
    accepted();
    getTaskOn.mockRejectedValue(new Error('rpc down'));
    await sweepGasLiveness();
    expect(releaseToOpen).not.toHaveBeenCalled();
  });

  it('still reverts a young task that is genuinely unsettled (Funded on-chain, no tx hash)', async () => {
    accepted();
    await sweepGasLiveness();
    expect(releaseToOpen).toHaveBeenCalledWith(TASK);
  });

  it('never touches a task accepted more than 5 minutes ago', async () => {
    accepted({ acceptedAt: new Date(Date.now() - 6 * 60_000).toISOString() });
    await sweepGasLiveness();
    expect(releaseToOpen).not.toHaveBeenCalled();
  });
});
