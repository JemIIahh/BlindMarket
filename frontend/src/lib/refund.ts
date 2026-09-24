/**
 * How a poster gets a task's escrow back, from the task's on-chain status
 * (BlindEscrow.TaskStatus) and deadline. Nothing refunds on its own: both
 * calls are poster-only, so the site has to offer them.
 *
 *   cancelTask   — Funded (no worker yet): any time.
 *   claimTimeout — Assigned, Submitted or Verified (failed verification):
 *                  only once the deadline has passed.
 *
 * Completed, Cancelled and Disputed tasks have nothing to reclaim here (a
 * dispute is resolved by the platform, or reclaimable after its window).
 */
import { Interface } from 'ethers';

export type RefundKind = 'cancel' | 'timeout';

const REFUND_ABI = new Interface(['function cancelTask(uint256 taskId)', 'function claimTimeout(uint256 taskId)']);

/**
 * The refund call's calldata, encoded in the browser. For a task funded from a
 * wallet that isn't linked to the account: the backend builds refunds only for
 * the account's wallets, while both calls are onlyAgent on chain, so the
 * escrow pays back only the wallet that funded the task whoever builds it.
 */
export function encodeRefundCall(kind: RefundKind, taskId: string): string {
  if (!/^\d+$/.test(taskId)) throw new Error(`Not an on-chain task id: ${taskId}`);
  return REFUND_ABI.encodeFunctionData(kind === 'cancel' ? 'cancelTask' : 'claimTimeout', [BigInt(taskId)]);
}

const FUNDED = 0;
const HELD_BY_EXECUTOR = [1, 2, 3];

export function refundAction(status: number, deadlineSec: number, nowSec = Math.floor(Date.now() / 1000)): RefundKind | null {
  if (status === FUNDED) return 'cancel';
  if (HELD_BY_EXECUTOR.includes(status) && deadlineSec > 0 && nowSec >= deadlineSec) return 'timeout';
  return null;
}

/**
 * Whether the escrow is waiting to be reclaimed: the deadline has passed and
 * the poster can still take it back. A live open task is not flagged; its
 * cancel stays on the task page.
 */
export function isReclaimable(status: number, deadlineSec: number, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return deadlineSec > 0 && nowSec >= deadlineSec && refundAction(status, deadlineSec, nowSec) !== null;
}
