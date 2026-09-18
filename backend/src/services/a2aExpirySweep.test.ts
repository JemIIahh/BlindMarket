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
const updateState = vi.fn(async (_taskId: string, _patch: Record<string, unknown>) => ({}));
const markAssignReconciled = vi.fn(async (_taskId: string, _txHash: string) => {});
const isAssignReconciled = vi.fn(async (_taskId: string, _txHash: string) => false);
const getTransactionReceipt = vi.fn(async (_hash: string) => null as { status: number } | null);
const loadAgentByWallet = vi.fn(async (_addr: string) => null as { smartAccountAddress?: string } | null);

vi.mock('./redis.js', () => ({
  redis: { get: async (k: string) => redisStore.get(k) ?? null },
}));
vi.mock('./a2aStore.js', () => ({
  listAcceptedTasks: (...a: unknown[]) => listAcceptedTasks(...(a as [])),
  getSettlementDeadlineTTL: (...a: unknown[]) => getSettlementDeadlineTTL(...(a as [string])),
  releaseToOpen: (...a: unknown[]) => releaseToOpen(...(a as [string])),
  updateState: (...a: unknown[]) => updateState(...(a as [string, Record<string, unknown>])),
  markAssignReconciled: (...a: unknown[]) => markAssignReconciled(...(a as [string, string])),
  isAssignReconciled: (...a: unknown[]) => isAssignReconciled(...(a as [string, string])),
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
vi.mock('./chain.js', () => ({
  provider: { getTransactionReceipt: (...a: unknown[]) => getTransactionReceipt(...(a as [string])) },
  baseProvider: { getTransactionReceipt: (...a: unknown[]) => getTransactionReceipt(...(a as [string])) },
}));
vi.mock('./deployedAgentStore.js', () => ({
  loadAgentByWallet: (...a: unknown[]) => loadAgentByWallet(...(a as [string])),
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
  updateState.mockClear();
  markAssignReconciled.mockClear();
  isAssignReconciled.mockResolvedValue(false);
  getTransactionReceipt.mockReset();
  getTransactionReceipt.mockResolvedValue(null);
  loadAgentByWallet.mockResolvedValue(null);
  getTaskOn.mockClear();
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

describe('sweepGasLiveness reconciling a broadcast assign tx', () => {
  const TX = '0x' + '11'.repeat(32);
  const SMART_ACCOUNT = '0x' + 'cd'.repeat(20);
  const old = (extra: Record<string, unknown> = {}) =>
    accepted({ assignTxHash: TX, acceptedAt: new Date(Date.now() - 11 * 60_000).toISOString(), ...extra });

  it('re-opens a task still Funded whose assign tx never mined', async () => {
    old({ assignError: 'marketplaceAssign tx not confirmed after 60s' });
    await sweepGasLiveness();
    expect(getTransactionReceipt).toHaveBeenCalledWith(TX);
    expect(releaseToOpen).toHaveBeenCalledWith(TASK);
  });

  it('re-opens when the assign tx reverted', async () => {
    old();
    getTransactionReceipt.mockResolvedValue({ status: 0 });
    await sweepGasLiveness();
    expect(releaseToOpen).toHaveBeenCalledWith(TASK);
  });

  it('waits when the tx has a successful receipt but the status read is stale', async () => {
    old();
    getTransactionReceipt.mockResolvedValue({ status: 1 });
    await sweepGasLiveness();
    expect(releaseToOpen).not.toHaveBeenCalled();
    expect(markAssignReconciled).not.toHaveBeenCalled();
  });

  it('does nothing when the receipt lookup fails', async () => {
    old();
    getTransactionReceipt.mockRejectedValue(new Error('rpc down'));
    await sweepGasLiveness();
    expect(releaseToOpen).not.toHaveBeenCalled();
  });

  it('clears a stale assignError once the chain names this executor, and checks only once', async () => {
    old({ assignError: 'marketplaceAssign tx not confirmed after 60s' });
    getTaskOn.mockResolvedValue({ worker: EXECUTOR.toUpperCase(), status: 1 });
    await sweepGasLiveness();
    expect(updateState).toHaveBeenCalledWith(TASK, { assignError: undefined });
    expect(markAssignReconciled).toHaveBeenCalledWith(TASK, TX);
    expect(releaseToOpen).not.toHaveBeenCalled();

    isAssignReconciled.mockResolvedValue(true);
    getTaskOn.mockClear();
    await sweepGasLiveness();
    expect(getTaskOn).not.toHaveBeenCalled();
  });

  it("treats the executor's smart account as the same worker", async () => {
    old({ assignError: 'x' });
    getTaskOn.mockResolvedValue({ worker: SMART_ACCOUNT, status: 1 });
    loadAgentByWallet.mockResolvedValue({ smartAccountAddress: SMART_ACCOUNT });
    await sweepGasLiveness();
    expect(updateState).toHaveBeenCalledWith(TASK, { assignError: undefined });
  });

  it("leaves another worker's assignment untouched", async () => {
    old({ assignError: 'x' });
    getTaskOn.mockResolvedValue({ worker: SMART_ACCOUNT, status: 1 });
    await sweepGasLiveness();
    expect(updateState).not.toHaveBeenCalled();
    expect(releaseToOpen).not.toHaveBeenCalled();
  });

  it('caps chain reconciles per tick', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => '0x' + i.toString(16).padStart(64, '0'));
    for (const id of ids) {
      redisStore.set(`a2a:state:${id}`, JSON.stringify({
        taskId: id, status: 'accepted', executorAddress: EXECUTOR, assignTxHash: TX,
        acceptedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      }));
    }
    listAcceptedTasks.mockResolvedValue(ids.map((taskId) => ({ taskId, executorAddress: EXECUTOR })));
    await sweepGasLiveness();
    expect(getTaskOn).toHaveBeenCalledTimes(5);
  });
});
