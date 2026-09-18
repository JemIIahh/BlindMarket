/**
 * settleAssignment after the broadcast: tx.wait() rejecting (timeout on a slow
 * chain, or a revert) used to escape as a thrown error — the accept route
 * 500'd with state already `accepted` + assignTxHash, which the gas-liveness
 * sweep then skipped forever.
 *
 * Run: npx vitest run src/services/a2aSettlement.assign.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const TASK = '0x' + 'ab'.repeat(32);
const EXECUTOR = '0x3db43a971e4464346eba9233b485116713eb1b01';
const TX_HASH = '0x' + '11'.repeat(32);
const ZERO = '0x0000000000000000000000000000000000000000';

const wait = vi.fn();
const getTask = vi.fn();
const marketplaceAssign = Object.assign(
  vi.fn(async () => ({ hash: TX_HASH, wait })),
  { staticCall: vi.fn(async () => undefined) },
);
// A tiny state blob so assignError writes/clears are observable end to end.
let state: Record<string, unknown> = {};
const updateState = vi.fn(async (_taskId: string, patch: Record<string, unknown>) => {
  state = { ...state, ...patch };
  return state;
});
const getState = vi.fn(async (_taskId: string) => state);
const markAssignBroadcast = vi.fn(async (_taskId: string, _txHash: string) => {});

vi.mock('../config.js', () => ({ config: {} }));
vi.mock('./chain.js', () => ({
  escrowAsMarketplace: { marketplaceAssign, getTask },
  marketplaceSigner: {},
  baseEscrowAsMarketplace: null,
  baseMarketplaceSigner: null,
}));
vi.mock('./taskChain.js', () => ({ resolveTaskByHash: vi.fn(async () => ({ taskId: '7', chain: '0g' })) }));
vi.mock('./a2aStore.js', () => ({
  updateState: (...a: unknown[]) => updateState(...(a as [string, Record<string, unknown>])),
  getState: (...a: unknown[]) => getState(...(a as [string])),
  markAssignBroadcast: (...a: unknown[]) => markAssignBroadcast(...(a as [string, string])),
}));
vi.mock('./deployedAgentStore.js', () => ({ loadAgentByWallet: vi.fn(async () => null) }));
vi.mock('./socket.js', () => ({ rooms: {} }));

const { settleAssignment } = await import('./a2aSettlement.js');

const revertErr = () => Object.assign(new Error('transaction execution reverted'), { code: 'CALL_EXCEPTION' });
const timeoutErr = () => Object.assign(new Error('wait for transaction timeout'), { code: 'TIMEOUT' });

beforeEach(() => {
  wait.mockReset();
  getTask.mockReset();
  updateState.mockClear();
  markAssignBroadcast.mockClear();
  marketplaceAssign.mockClear();
  marketplaceAssign.staticCall.mockReset();
  marketplaceAssign.staticCall.mockResolvedValue(undefined);
  state = { taskId: TASK, status: 'accepted', executorAddress: EXECUTOR };
});

describe('settleAssignment when tx.wait() rejects', () => {
  it('reports a timed-out tx as pending with its hash instead of throwing', async () => {
    wait.mockRejectedValue(timeoutErr());
    getTask.mockResolvedValue({ worker: ZERO });

    const result = await settleAssignment(TASK, EXECUTOR);

    expect(result).toMatchObject({ success: false, pending: true, txHash: TX_HASH });
    // Pending is not a failure: /submit 503s BRIDGE_FAILED on any assignError.
    expect(state.assignError).toBeUndefined();
    expect(state.assignTxHash).toBe(TX_HASH);
    expect(markAssignBroadcast).toHaveBeenCalledWith(TASK, TX_HASH);
  });

  it('succeeds when the chain already names the executor despite the timeout', async () => {
    wait.mockRejectedValue(timeoutErr());
    getTask.mockResolvedValue({ worker: EXECUTOR.toUpperCase().replace('0X', '0x') });

    const result = await settleAssignment(TASK, EXECUTOR);

    expect(result).toEqual({ success: true, txHash: TX_HASH, chain: '0g' });
  });

  it('stays pending when the follow-up chain read fails too', async () => {
    wait.mockRejectedValue(timeoutErr());
    getTask.mockRejectedValue(new Error('rpc down'));

    const result = await settleAssignment(TASK, EXECUTOR);

    expect(result).toMatchObject({ success: false, pending: true, txHash: TX_HASH });
  });

  it('reports a reverted tx as a plain failure, not pending', async () => {
    wait.mockRejectedValue(revertErr());
    getTask.mockResolvedValue({ worker: ZERO });

    const result = await settleAssignment(TASK, EXECUTOR);

    expect(result.success).toBe(false);
    expect(result.pending).toBeUndefined();
    expect(result.txHash).toBe(TX_HASH);
    expect(state.assignError).toEqual(expect.stringContaining('reverted'));
  });

  it('still reports a revert as a failure when the chain cannot be read', async () => {
    wait.mockRejectedValue(revertErr());
    getTask.mockRejectedValue(new Error('rpc down'));

    const result = await settleAssignment(TASK, EXECUTOR);

    expect(result).toMatchObject({ success: false, txHash: TX_HASH });
    expect(result.pending).toBeUndefined();
  });
});

describe('assignError never outlives a confirmed assignment', () => {
  it('pending, then the tx mines: the retry confirms and leaves no assignError', async () => {
    wait.mockRejectedValue(timeoutErr());
    getTask.mockResolvedValue({ worker: ZERO });
    expect((await settleAssignment(TASK, EXECUTOR)).pending).toBe(true);
    expect(state.assignError).toBeUndefined();

    // Mined. The idempotent re-accept's staticCall now reverts InvalidStatus.
    marketplaceAssign.staticCall.mockRejectedValue(new Error('execution reverted: InvalidStatus()'));
    getTask.mockResolvedValue({ worker: EXECUTOR });

    const retry = await settleAssignment(TASK, EXECUTOR);

    expect(retry).toMatchObject({ success: true, alreadySettled: true });
    expect(state.assignError).toBeUndefined();
  });

  it('clears an assignError left by an earlier attempt once the chain names this executor', async () => {
    state.assignError = 'marketplaceAssign tx 0x… not confirmed after 60s';
    marketplaceAssign.staticCall.mockRejectedValue(new Error('execution reverted: InvalidStatus()'));
    getTask.mockResolvedValue({ worker: EXECUTOR });

    const result = await settleAssignment(TASK, EXECUTOR);

    expect(result).toMatchObject({ success: true, alreadySettled: true });
    expect('assignError' in state && state.assignError).toBeFalsy();
    expect(updateState).toHaveBeenCalledWith(TASK, { assignError: undefined });
  });

  it('does not write state when there is no assignError to clear', async () => {
    marketplaceAssign.staticCall.mockRejectedValue(new Error('execution reverted: InvalidStatus()'));
    getTask.mockResolvedValue({ worker: EXECUTOR });

    await settleAssignment(TASK, EXECUTOR);

    expect(updateState).not.toHaveBeenCalled();
  });

  it('a second assign tx reverting because the first landed for this worker is success', async () => {
    state.assignError = 'left by the first attempt';
    wait.mockRejectedValue(revertErr());
    getTask.mockResolvedValue({ worker: EXECUTOR });

    const result = await settleAssignment(TASK, EXECUTOR);

    expect(result).toMatchObject({ success: true, alreadySettled: true, chain: '0g' });
    expect(state.assignError).toBeUndefined();
  });

  it('a timeout that turns out assigned also clears a stale assignError', async () => {
    state.assignError = 'left by the first attempt';
    wait.mockRejectedValue(timeoutErr());
    getTask.mockResolvedValue({ worker: EXECUTOR });

    expect(await settleAssignment(TASK, EXECUTOR)).toEqual({ success: true, txHash: TX_HASH, chain: '0g' });
    expect(state.assignError).toBeUndefined();
  });

  it('a revert with the task assigned to someone else stays a failure', async () => {
    wait.mockRejectedValue(revertErr());
    getTask.mockResolvedValue({ worker: '0x' + '99'.repeat(20) });

    const result = await settleAssignment(TASK, EXECUTOR);

    expect(result.success).toBe(false);
    expect(state.assignError).toEqual(expect.stringContaining('reverted'));
  });
});
