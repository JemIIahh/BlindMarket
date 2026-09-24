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
export type RefundKind = 'cancel' | 'timeout';

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
