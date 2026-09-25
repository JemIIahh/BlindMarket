/**
 * The backend signs marketplaceAssign and completeVerification by escrow task
 * id, and gets the id from the hash index, which is a cache. An entry that
 * names the wrong task (keys left by another escrow or network under the same
 * chain key, or a duplicate hash; escrow ids restart at 1 on every escrow)
 * would assign an unrelated Funded task, or pay whoever submitted on one. So
 * both read the escrow task first and act only on the one carrying this
 * task's hash.
 *
 * Run: npx vitest run src/services/a2aSettlement.taskMatch.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const TASK = '0x' + 'ab'.repeat(32);
const OTHER = '0x' + 'cd'.repeat(32);
const EMPTY = '0x' + '00'.repeat(32);
const EXECUTOR = '0x3db43a971e4464346eba9233b485116713eb1b01';

const escrow = vi.hoisted(() => ({ getTaskOn: vi.fn() }));
const marketplaceAssign = vi.hoisted(() =>
  Object.assign(vi.fn(), { staticCall: vi.fn(async () => undefined) }),
);
const completeVerification = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));

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
vi.mock('./deployedAgentStore.js', () => ({ loadAgentByWallet: vi.fn(async () => null) }));
vi.mock('./socket.js', () => ({ rooms: {} }));

const { settleAssignment, settleVerification, escrowTaskMismatch } = await import('./a2aSettlement.js');

beforeEach(() => {
  vi.clearAllMocks();
  escrow.getTaskOn.mockReset();
  state.value = { taskId: TASK, status: 'accepted', executorAddress: EXECUTOR };
});

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
    expect(await escrowTaskMismatch('arc', '7', TASK, 1)).toMatch(/carries hash 0x00000000…/);
    expect(escrow.getTaskOn).toHaveBeenCalledTimes(3);
  });

  it('refuses when the task cannot be read', async () => {
    escrow.getTaskOn.mockRejectedValue(new Error('rpc down'));
    expect(await escrowTaskMismatch('arc', '7', TASK, 1)).toMatch(/could not read arc escrow task 7 .*rpc down/);
  });
});

describe('settleAssignment and settleVerification act only on the matching escrow task', () => {
  it('does not assign a task the hash index names wrongly', async () => {
    escrow.getTaskOn.mockResolvedValue({ taskHash: OTHER });
    const result = await settleAssignment(TASK, EXECUTOR);
    expect(result.success).toBe(false);
    expect(marketplaceAssign.staticCall).not.toHaveBeenCalled();
    expect(marketplaceAssign).not.toHaveBeenCalled();
    expect(state.value.assignError).toMatch(/names another task, so nothing was sent/);
  });

  it('does not assign when the escrow task cannot be read', async () => {
    escrow.getTaskOn.mockRejectedValue(new Error('rpc down'));
    expect((await settleAssignment(TASK, EXECUTOR)).success).toBe(false);
    expect(marketplaceAssign).not.toHaveBeenCalled();
  });

  it('does not settle a verdict on a task the hash index names wrongly', async () => {
    escrow.getTaskOn.mockResolvedValue({ taskHash: OTHER });
    const result = await settleVerification(TASK, true);
    expect(result.success).toBe(false);
    expect(completeVerification).not.toHaveBeenCalled();
    expect(state.value.verifyError).toMatch(/names another task, so nothing was sent/);
  });
});
