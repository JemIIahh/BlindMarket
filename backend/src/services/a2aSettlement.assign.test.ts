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
const updateState = vi.fn(async () => ({}));

vi.mock('../config.js', () => ({ config: {} }));
vi.mock('./chain.js', () => ({
  escrowAsMarketplace: { marketplaceAssign, getTask },
  marketplaceSigner: {},
  baseEscrowAsMarketplace: null,
  baseMarketplaceSigner: null,
}));
vi.mock('./taskChain.js', () => ({ resolveTaskByHash: vi.fn(async () => ({ taskId: '7', chain: '0g' })) }));
vi.mock('./a2aStore.js', () => ({ updateState: (...a: unknown[]) => updateState(...(a as [])) }));
vi.mock('./deployedAgentStore.js', () => ({ loadAgentByWallet: vi.fn(async () => null) }));
vi.mock('./socket.js', () => ({ rooms: {} }));

const { settleAssignment } = await import('./a2aSettlement.js');

const timeoutErr = () => Object.assign(new Error('wait for transaction timeout'), { code: 'TIMEOUT' });

beforeEach(() => {
  wait.mockReset();
  getTask.mockReset();
  updateState.mockClear();
});

describe('settleAssignment when tx.wait() rejects', () => {
  it('reports a timed-out tx as pending with its hash instead of throwing', async () => {
    wait.mockRejectedValue(timeoutErr());
    getTask.mockResolvedValue({ worker: ZERO });

    const result = await settleAssignment(TASK, EXECUTOR);

    expect(result).toMatchObject({ success: false, pending: true, txHash: TX_HASH });
    expect(updateState).toHaveBeenLastCalledWith(TASK, { assignError: expect.stringContaining(TX_HASH) });
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
    wait.mockRejectedValue(Object.assign(new Error('transaction execution reverted'), { code: 'CALL_EXCEPTION' }));

    const result = await settleAssignment(TASK, EXECUTOR);

    expect(result.success).toBe(false);
    expect(result.pending).toBeUndefined();
    expect(result.txHash).toBe(TX_HASH);
    expect(getTask).not.toHaveBeenCalled();
  });
});
