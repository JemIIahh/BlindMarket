/**
 * The backend signs marketplaceAssign and completeVerification by escrow task
 * id, and gets the id from the hash index, which is a cache. An entry that
 * names a task carrying another hash (keys left by another escrow or network
 * under the same chain key; escrow ids restart at 1 on every escrow) would
 * assign an unrelated Funded task, or pay whoever submitted on one. So both
 * read the escrow task first and act only on the one carrying this task's
 * hash. Copies of one hash funded more than once cannot be told apart this
 * way. Verification also pays only this task's executor.
 *
 * Run: npx vitest run src/services/a2aSettlement.taskMatch.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const TASK = '0x' + 'ab'.repeat(32);
const OTHER = '0x' + 'cd'.repeat(32);
const EMPTY = '0x' + '00'.repeat(32);
const EXECUTOR = '0x3db43a971e4464346eba9233b485116713eb1b01';
const SMART_ACCOUNT = '0x5c0ffee00000000000000000000000000000a11c';
const STRANGER = '0x00000000000000000000000000000000000beef1';

const escrow = vi.hoisted(() => ({ getTaskOn: vi.fn() }));
const marketplaceAssign = vi.hoisted(() =>
  Object.assign(vi.fn(), { staticCall: vi.fn(async () => undefined) }),
);
const completeVerification = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const agents = vi.hoisted(() => ({ loadAgentByWallet: vi.fn(async () => null as null | { smartAccountAddress?: string }) }));
const minedTx = (hash: string) => ({ hash, wait: vi.fn(async () => ({ status: 1, blockNumber: 1 })) });

vi.mock('../config.js', () => ({ config: {} }));
vi.mock('./chain.js', () => ({
  escrowAsMarketplace: null,
  marketplaceSigner: null,
  baseEscrowAsMarketplace: null,
  baseMarketplaceSigner: null,
  baseProvider: {},
  baseEscrow: null,
  arcEscrowAsMarketplace: { marketplaceAssign, completeVerification, getTask: vi.fn() },
  arcMarketplaceSigner: {},
  arcProvider: {},
  arcEscrow: { getTask: vi.fn() },
}));
vi.mock('./escrow.js', () => escrow);
vi.mock('./taskChain.js', () => ({ resolveTaskByHash: vi.fn(async () => ({ taskId: '7', chain: 'arc' })) }));
vi.mock('./a2aStore.js', () => ({
  updateState: vi.fn(async (_t: string, patch: Record<string, unknown>) => {
    state.value = { ...state.value, ...patch };
    return state.value;
  }),
  getState: vi.fn(async () => state.value),
  markAssignBroadcast: vi.fn(async () => {}),
}));
vi.mock('./deployedAgentStore.js', () => agents);
vi.mock('./socket.js', () => ({ rooms: { tasks: vi.fn(), task: vi.fn() } }));

const { settleAssignment, settleVerification, escrowTaskMismatch } = await import('./a2aSettlement.js');

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  escrow.getTaskOn.mockReset();
  agents.loadAgentByWallet.mockReset().mockResolvedValue(null);
  marketplaceAssign.mockReset().mockResolvedValue(minedTx('0xassign'));
  completeVerification.mockReset().mockResolvedValue(minedTx('0xverify'));
  state.value = { taskId: TASK, status: 'accepted', executorAddress: EXECUTOR };
});

/** Runs `call` with fake timers, stepping past the retry waits between reads. */
async function pastRetries<T>(call: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  const pending = call();
  await vi.advanceTimersByTimeAsync(5_000);
  return pending;
}

describe('escrowTaskMismatch', () => {
  it('passes the escrow task that carries the hash, whatever its case', async () => {
    escrow.getTaskOn.mockResolvedValue({ taskHash: TASK.toUpperCase().replace('0X', '0x') });
    expect(await escrowTaskMismatch('arc', '7', TASK, 1)).toBeNull();
    expect(escrow.getTaskOn).toHaveBeenCalledWith('arc', 7);
  });

  it('refuses a task carrying another hash at once, without retrying', async () => {
    escrow.getTaskOn.mockResolvedValue({ taskHash: OTHER });
    expect(await escrowTaskMismatch('arc', '7', TASK, 1)).toMatch(/arc escrow task 7 carries hash 0xcdcdcdcd…, not this task's 0xabababab…/);
    expect(escrow.getTaskOn).toHaveBeenCalledTimes(1);
  });

  it('reads an empty task again, since an RPC node can lag the creation', async () => {
    escrow.getTaskOn.mockResolvedValueOnce({ taskHash: EMPTY }).mockResolvedValueOnce({ taskHash: TASK });
    expect(await escrowTaskMismatch('arc', '7', TASK, 1)).toBeNull();
    expect(escrow.getTaskOn).toHaveBeenCalledTimes(2);
  });

  it('refuses a task that still reads as empty after three reads', async () => {
    escrow.getTaskOn.mockResolvedValue({ taskHash: EMPTY });
    expect(await escrowTaskMismatch('arc', '7', TASK, 1)).toMatch(/arc escrow task 7 reads as empty/);
    expect(escrow.getTaskOn).toHaveBeenCalledTimes(3);
  });

  it('reads again after a read that throws', async () => {
    escrow.getTaskOn.mockRejectedValueOnce(new Error('rpc blip')).mockResolvedValueOnce({ taskHash: TASK });
    expect(await escrowTaskMismatch('arc', '7', TASK, 1)).toBeNull();
    expect(escrow.getTaskOn).toHaveBeenCalledTimes(2);
  });

  it('refuses when the task cannot be read after three reads', async () => {
    escrow.getTaskOn.mockRejectedValue(new Error('rpc down'));
    expect(await escrowTaskMismatch('arc', '7', TASK, 1)).toMatch(/could not read arc escrow task 7 .*rpc down/);
    expect(escrow.getTaskOn).toHaveBeenCalledTimes(3);
  });
});

describe('settleAssignment and settleVerification act only on the matching escrow task', () => {
  it('assigns the escrow task that carries the hash', async () => {
    escrow.getTaskOn.mockResolvedValue({ taskHash: TASK });
    const result = await settleAssignment(TASK, EXECUTOR);
    expect(result).toMatchObject({ success: true, txHash: '0xassign', chain: 'arc' });
    expect(marketplaceAssign).toHaveBeenCalledWith(7n, EXECUTOR);
  });

  it('does not assign a task the hash index names wrongly, and marks it lasting', async () => {
    escrow.getTaskOn.mockResolvedValue({ taskHash: OTHER });
    const result = await settleAssignment(TASK, EXECUTOR);
    expect(result).toMatchObject({ success: false, escrowMismatch: true });
    expect(marketplaceAssign.staticCall).not.toHaveBeenCalled();
    expect(marketplaceAssign).not.toHaveBeenCalled();
    // Persisted, so /submit refuses too.
    expect(state.value.assignError).toMatch(/names another task, so nothing was sent/);
  });

  it('does not assign when the escrow task cannot be read, and leaves no assignError', async () => {
    // An assignError would make /submit refuse the rightful worker of a task
    // already assigned (a re-accept re-reads it); /submit checks the chain itself.
    escrow.getTaskOn.mockRejectedValue(new Error('rpc down'));
    const result = await pastRetries(() => settleAssignment(TASK, EXECUTOR));
    expect(result.success).toBe(false);
    expect(result.escrowMismatch).toBeUndefined();
    expect(escrow.getTaskOn).toHaveBeenCalledTimes(3);
    expect(marketplaceAssign).not.toHaveBeenCalled();
    expect(state.value.assignError).toBeUndefined();
  });

  it('settles a verdict on the matching task assigned to this executor', async () => {
    escrow.getTaskOn.mockResolvedValue({ taskHash: TASK, worker: EXECUTOR });
    const result = await settleVerification(TASK, true);
    expect(result).toMatchObject({ success: true, txHash: '0xverify' });
    expect(completeVerification).toHaveBeenCalledWith(7n, true);
  });

  it("settles when the escrow records the executor's smart account", async () => {
    agents.loadAgentByWallet.mockResolvedValue({ smartAccountAddress: SMART_ACCOUNT });
    escrow.getTaskOn.mockResolvedValue({ taskHash: TASK, worker: SMART_ACCOUNT });
    expect((await settleVerification(TASK, true)).success).toBe(true);
    expect(completeVerification).toHaveBeenCalledTimes(1);
  });

  it('does not settle a verdict on a task the hash index names wrongly', async () => {
    escrow.getTaskOn.mockResolvedValue({ taskHash: OTHER, worker: EXECUTOR });
    const result = await settleVerification(TASK, true);
    expect(result.success).toBe(false);
    expect(completeVerification).not.toHaveBeenCalled();
    expect(state.value.verifyError).toMatch(/names another task, so nothing was sent/);
  });

  it("does not pay a worker other than this task's executor", async () => {
    // Copies of one hash pass the hash check; the worker still has to be ours.
    escrow.getTaskOn.mockResolvedValue({ taskHash: TASK, worker: STRANGER });
    const result = await settleVerification(TASK, true);
    expect(result.success).toBe(false);
    expect(completeVerification).not.toHaveBeenCalled();
    expect(state.value.verifyError).toMatch(new RegExp(`is assigned to ${STRANGER}, not this task's executor ${EXECUTOR}`));
  });

  it('does not settle when the escrow task cannot be read, after reading again', async () => {
    escrow.getTaskOn.mockRejectedValue(new Error('rpc down'));
    const result = await pastRetries(() => settleVerification(TASK, true));
    expect(result.success).toBe(false);
    expect(escrow.getTaskOn).toHaveBeenCalledTimes(3);
    expect(completeVerification).not.toHaveBeenCalled();
  });
});
