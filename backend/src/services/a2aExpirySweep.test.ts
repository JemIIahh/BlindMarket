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
// The sweep releases through the compare-and-set only; a bare releaseToOpen
// would overwrite whatever happened while the chain was being read.
const releaseToOpen = vi.fn(async (_taskId: string) => {});
const tryReleaseAccepted = vi.fn(
  async (_taskId: string, _expected: { executorAddress?: string; assignTxHash?: string }) =>
    ({ ok: true }) as { ok: true } | { ok: false; currentStatus: string },
);
const getAssignBroadcastAt = vi.fn(async (_taskId: string, _txHash: string) => null as number | null);
const getTransaction = vi.fn(async (_hash: string) => null as { nonce: number } | null);
const getMeta = vi.fn(async (_taskId: string) => ({
  taskId: '', targetExecutorType: 'agent', requiredCapabilities: ['research'], chain: 'base',
}) as Record<string, unknown> | undefined);
const emitTaskAvailable = vi.fn((_taskId: string, _meta: Record<string, unknown>, _pinnedTo?: string) => {});
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
// Open unless a test closes it: a process on another deployment's Redis.
const gate = { allowed: true };
vi.mock('./deploymentIdentity.js', () => ({ backgroundWritesAllowed: () => gate.allowed }));
const listOpenTasks = vi.fn(async () => [] as unknown[]);
const resyncOpenIndex = vi.fn(async () => {});
vi.mock('./a2aStore.js', () => ({
  listAcceptedTasks: (...a: unknown[]) => listAcceptedTasks(...(a as [])),
  getSettlementDeadlineTTL: (...a: unknown[]) => getSettlementDeadlineTTL(...(a as [string])),
  releaseToOpen: (...a: unknown[]) => releaseToOpen(...(a as [string])),
  tryReleaseAccepted: (...a: unknown[]) => tryReleaseAccepted(...(a as [string, Record<string, string>])),
  getAssignBroadcastAt: (...a: unknown[]) => getAssignBroadcastAt(...(a as [string, string])),
  updateState: (...a: unknown[]) => updateState(...(a as [string, Record<string, unknown>])),
  markAssignReconciled: (...a: unknown[]) => markAssignReconciled(...(a as [string, string])),
  isAssignReconciled: (...a: unknown[]) => isAssignReconciled(...(a as [string, string])),
  listOpenTasks: (...a: unknown[]) => listOpenTasks(...(a as [])),
  resyncOpenIndex: (...a: unknown[]) => resyncOpenIndex(...(a as [])),
  getMeta: (...a: unknown[]) => getMeta(...(a as [string])),
}));
vi.mock('./socket.js', () => ({
  emitTaskAvailable: (...a: unknown[]) => emitTaskAvailable(...(a as [string, Record<string, unknown>, string | undefined])),
}));
vi.mock('./taskChain.js', () => ({
  resolveTaskByHash: (...a: unknown[]) => resolveTaskByHash(...(a as [string])),
  resolveCachedTaskByHash: async () => null,
}));
vi.mock('./escrow.js', () => ({
  getTaskOn: (...a: unknown[]) => getTaskOn(...(a as [string, number])),
}));
vi.mock('./chain.js', () => {
  const rpc = {
    getTransactionReceipt: (...a: unknown[]) => getTransactionReceipt(...(a as [string])),
    getTransaction: (...a: unknown[]) => getTransaction(...(a as [string])),
  };
  return { provider: rpc, baseProvider: rpc };
});
vi.mock('./deployedAgentStore.js', () => ({
  loadAgentByWallet: (...a: unknown[]) => loadAgentByWallet(...(a as [string])),
}));
vi.mock('../constants.js', () => ({ SWEEP_INTERVAL_MS: 60_000, EXPIRY_GRACE_SEC: 60 }));

const { sweepGasLiveness, sweepExpiredTasks } = await import('./a2aExpirySweep.js');

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
  tryReleaseAccepted.mockClear();
  tryReleaseAccepted.mockResolvedValue({ ok: true });
  getAssignBroadcastAt.mockResolvedValue(null);
  getTransaction.mockReset();
  getTransaction.mockResolvedValue(null);
  emitTaskAvailable.mockClear();
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
    expect(tryReleaseAccepted).not.toHaveBeenCalled();
    expect(getTaskOn).not.toHaveBeenCalled(); // no chain read needed
  });

  it('leaves a task alone when the chain already names this executor as worker', async () => {
    accepted();
    getTaskOn.mockResolvedValue({ worker: EXECUTOR.toUpperCase(), status: 1 });
    await sweepGasLiveness();
    expect(tryReleaseAccepted).not.toHaveBeenCalled();
  });

  it('leaves a task alone when the chain has moved past Funded for someone else', async () => {
    accepted();
    getTaskOn.mockResolvedValue({ worker: '0x' + '99'.repeat(20), status: 1 });
    await sweepGasLiveness();
    expect(tryReleaseAccepted).not.toHaveBeenCalled();
  });

  it('does nothing when the chain cannot be read this tick', async () => {
    accepted();
    getTaskOn.mockRejectedValue(new Error('rpc down'));
    await sweepGasLiveness();
    expect(tryReleaseAccepted).not.toHaveBeenCalled();
  });

  it('still reverts a young task that is genuinely unsettled (Funded on-chain, no tx hash)', async () => {
    accepted();
    await sweepGasLiveness();
    // CAS on "same executor, still no assign tx" — an accept that broadcast
    // while the chain was being read must not be overwritten.
    expect(tryReleaseAccepted).toHaveBeenCalledWith(TASK, { executorAddress: EXECUTOR });
    expect(releaseToOpen).not.toHaveBeenCalled();
  });

  it('announces a re-opened task to connected agents', async () => {
    accepted();
    await sweepGasLiveness();
    expect(emitTaskAvailable).toHaveBeenCalledWith(TASK, { requiredCapabilities: ['research'], chain: 'base' }, undefined);
  });

  it('announces a re-opened pinned task to its target alone', async () => {
    getMeta.mockResolvedValueOnce({
      taskId: TASK, targetExecutorType: 'agent', requiredCapabilities: [], chain: 'arc', targetExecutor: EXECUTOR,
    });
    accepted();
    await sweepGasLiveness();
    expect(emitTaskAvailable).toHaveBeenCalledWith(TASK, { chain: 'arc' }, EXECUTOR);
  });

  it('does not announce when the compare-and-set lost', async () => {
    accepted();
    tryReleaseAccepted.mockResolvedValue({ ok: false, currentStatus: 'submitted' });
    await sweepGasLiveness();
    expect(emitTaskAvailable).not.toHaveBeenCalled();
  });

  it('never touches a task accepted more than 5 minutes ago', async () => {
    accepted({ acceptedAt: new Date(Date.now() - 6 * 60_000).toISOString() });
    await sweepGasLiveness();
    expect(tryReleaseAccepted).not.toHaveBeenCalled();
  });
});

describe('sweepGasLiveness reconciling a broadcast assign tx', () => {
  const TX = '0x' + '11'.repeat(32);
  const SMART_ACCOUNT = '0x' + 'cd'.repeat(20);
  const old = (extra: Record<string, unknown> = {}) =>
    accepted({ assignTxHash: TX, acceptedAt: new Date(Date.now() - 11 * 60_000).toISOString(), ...extra });

  const minutesAgo = (m: number) => Date.now() - m * 60_000;

  it('re-opens a task still Funded whose old assign tx has no receipt and is unknown to the node', async () => {
    old();
    getAssignBroadcastAt.mockResolvedValue(minutesAgo(31));
    await sweepGasLiveness();
    expect(getTransactionReceipt).toHaveBeenCalledWith(TX);
    expect(getTransaction).toHaveBeenCalledWith(TX);
    expect(tryReleaseAccepted).toHaveBeenCalledWith(TASK, { executorAddress: EXECUTOR, assignTxHash: TX });
    expect(emitTaskAvailable).toHaveBeenCalledWith(TASK, expect.any(Object), undefined);
  });

  it('gives no verdict on a missing receipt until the tx is comfortably old', async () => {
    old();
    getAssignBroadcastAt.mockResolvedValue(minutesAgo(11));
    await sweepGasLiveness();
    expect(getTransactionReceipt).toHaveBeenCalledWith(TX);
    expect(tryReleaseAccepted).not.toHaveBeenCalled();
    expect(markAssignReconciled).not.toHaveBeenCalled(); // checked again next tick
  });

  it('never re-opens while the node still knows the tx (stuck nonce, may yet mine)', async () => {
    old();
    getAssignBroadcastAt.mockResolvedValue(minutesAgo(45));
    getTransaction.mockResolvedValue({ nonce: 12 });
    await sweepGasLiveness();
    expect(tryReleaseAccepted).not.toHaveBeenCalled();
  });

  it('does nothing when the mempool lookup fails', async () => {
    old();
    getAssignBroadcastAt.mockResolvedValue(minutesAgo(45));
    getTransaction.mockRejectedValue(new Error('rpc down'));
    await sweepGasLiveness();
    expect(tryReleaseAccepted).not.toHaveBeenCalled();
  });

  it('ages the tx from ITS broadcast, not from the accept: a fresh re-broadcast is left alone', async () => {
    old(); // accepted 11 minutes ago…
    getAssignBroadcastAt.mockResolvedValue(Date.now() - 5_000); // …but this hash went out 5s ago
    getTransactionReceipt.mockResolvedValue({ status: 0 });
    await sweepGasLiveness();
    expect(getAssignBroadcastAt).toHaveBeenCalledWith(TASK, TX);
    expect(getTaskOn).not.toHaveBeenCalled();
    expect(tryReleaseAccepted).not.toHaveBeenCalled();
  });

  it('falls back to acceptedAt for a tx broadcast before timestamps were recorded', async () => {
    accepted({ assignTxHash: TX, acceptedAt: new Date(minutesAgo(31)).toISOString() });
    await sweepGasLiveness();
    expect(tryReleaseAccepted).toHaveBeenCalledWith(TASK, { executorAddress: EXECUTOR, assignTxHash: TX });
  });

  it('re-opens when the assign tx reverted, without waiting for the dropped-tx age', async () => {
    old();
    getTransactionReceipt.mockResolvedValue({ status: 0 });
    await sweepGasLiveness();
    expect(tryReleaseAccepted).toHaveBeenCalledWith(TASK, { executorAddress: EXECUTOR, assignTxHash: TX });
    expect(getTransaction).not.toHaveBeenCalled();
  });

  it('releases against the hash it CHECKED — a re-broadcast during the RPC reads wins the CAS', async () => {
    old();
    getTransactionReceipt.mockResolvedValue({ status: 0 });
    // The store (Lua) sees a different assignTxHash by the time the release lands.
    tryReleaseAccepted.mockResolvedValue({ ok: false, currentStatus: 'accepted' });
    await sweepGasLiveness();
    expect(tryReleaseAccepted).toHaveBeenCalledWith(TASK, { executorAddress: EXECUTOR, assignTxHash: TX });
    expect(releaseToOpen).not.toHaveBeenCalled();
    expect(emitTaskAvailable).not.toHaveBeenCalled();
  });

  it('waits when the tx has a successful receipt but the status read is stale', async () => {
    old();
    getTransactionReceipt.mockResolvedValue({ status: 1 });
    await sweepGasLiveness();
    expect(tryReleaseAccepted).not.toHaveBeenCalled();
    expect(markAssignReconciled).not.toHaveBeenCalled();
  });

  it('does nothing when the receipt lookup fails', async () => {
    old();
    getTransactionReceipt.mockRejectedValue(new Error('rpc down'));
    await sweepGasLiveness();
    expect(tryReleaseAccepted).not.toHaveBeenCalled();
  });

  it('never reads a receipt on another chain’s RPC for a chain it has no provider for', async () => {
    old();
    getAssignBroadcastAt.mockResolvedValue(minutesAgo(31));
    resolveTaskByHash.mockResolvedValue({ taskId: '1', chain: 'arc' as never });
    await sweepGasLiveness();
    expect(getTransactionReceipt).not.toHaveBeenCalled();
    expect(tryReleaseAccepted).not.toHaveBeenCalled();
  });

  it('clears a stale assignError once the chain names this executor, and checks only once', async () => {
    old({ assignError: 'marketplaceAssign tx not confirmed after 60s' });
    getTaskOn.mockResolvedValue({ worker: EXECUTOR.toUpperCase(), status: 1 });
    await sweepGasLiveness();
    expect(updateState).toHaveBeenCalledWith(TASK, { assignError: undefined });
    expect(markAssignReconciled).toHaveBeenCalledWith(TASK, TX);
    expect(tryReleaseAccepted).not.toHaveBeenCalled();

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
    expect(tryReleaseAccepted).not.toHaveBeenCalled();
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

describe("on another deployment's Redis (deploymentIdentity)", () => {
  it('neither sweep reads or releases anything', async () => {
    gate.allowed = false;
    try {
      listAcceptedTasks.mockClear();
      listOpenTasks.mockClear();
      resyncOpenIndex.mockClear();
      await sweepGasLiveness();
      await sweepExpiredTasks();
      expect(listAcceptedTasks).not.toHaveBeenCalled();
      // The expiry sweep rewrites the open index before anything else.
      expect(resyncOpenIndex).not.toHaveBeenCalled();
      expect(listOpenTasks).not.toHaveBeenCalled();
      expect(tryReleaseAccepted).not.toHaveBeenCalled();
      expect(releaseToOpen).not.toHaveBeenCalled();
    } finally {
      gate.allowed = true;
    }
  });
});

describe('sweepExpiredTasks (the gate test above leans on this)', () => {
  it('repairs the open index and lists open tasks when writes are allowed', async () => {
    resyncOpenIndex.mockClear();
    listOpenTasks.mockClear();
    await sweepExpiredTasks();
    expect(resyncOpenIndex).toHaveBeenCalled();
    expect(listOpenTasks).toHaveBeenCalled();
  });
});
