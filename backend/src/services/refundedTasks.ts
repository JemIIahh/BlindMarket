/**
 * Closing the off-chain A2A state of a task whose escrow the chain refunded.
 *
 * Two routes reach it: POST /tasks/:id/confirm-tx, which the CLI and web app
 * call after a cancel or timeout reclaim, and the Arc indexer's TaskCancelled
 * handler, for a cancel sent from the SDK or straight to the escrow, which
 * nothing reports. Both close through closeRefundedA2ATask, a compare-and-set,
 * so whichever runs second changes nothing.
 */
import { ethers } from 'ethers';
import * as a2aStore from './a2aStore.js';
import { getTaskOn } from './escrow.js';
import { resolveCachedTaskByHash, type TaskChain } from './taskChain.js';

/**
 * Close the A2A state of escrow task `escrowTaskId` on `chain`, refunded to
 * `poster` (the task's on-chain agent), whatever live status it is in. Left
 * open it keeps listing in a2a:open; left accepted/submitted/
 * awaiting_verification it keeps feeding worker resume loops and the verifier
 * queue. A compare-and-set, so a terminal state is never rewritten. Returns
 * true when this call closed it; throws when a store read or write fails.
 *
 * A2A state is keyed by taskHash alone and the escrow does not enforce unique
 * hashes, so owning SOME escrow task with this hash proves nothing about the
 * A2A task: anyone can createTask with a victim's hash, cancel it for an
 * instant refund and land here. Close only when the A2A task is this
 * poster's (meta.posterAddress, set from the authenticated poster at index
 * time — the check that matters) and the hash index does not name a
 * different escrow task. The indexers keep the first writer (SET NX), but an
 * entry can be missing, so the index is the secondary guard; no recorded
 * poster means no close.
 */
export async function closeRefundedA2ATask(
  chain: TaskChain,
  escrowTaskId: string,
  taskHash: string,
  poster: string,
  settled: 'cancelled' | 'expired',
  logPrefix: string,
): Promise<boolean> {
  if (!taskHash || !(await a2aStore.getState(taskHash))) return false;
  const [a2aMeta, mapped] = await Promise.all([
    a2aStore.getMeta(taskHash),
    resolveCachedTaskByHash(taskHash).catch(() => null),
  ]);
  const posterMatches = a2aMeta?.posterAddress?.toLowerCase() === poster.toLowerCase();
  const sameEscrowTask = !mapped || (mapped.chain === chain && mapped.taskId === escrowTaskId);
  if (!posterMatches || !sameEscrowTask) {
    console.warn(
      `${logPrefix}: NOT closing A2A state ${taskHash.slice(0, 10)}… for ${chain} task ${escrowTaskId} — ` +
        (posterMatches
          ? `the hash index names ${mapped!.chain} task ${mapped!.taskId}`
          : `${poster} is not the A2A task's poster`) +
        ' (duplicate taskHash on another escrow task)',
    );
    return false;
  }
  const closed = await a2aStore.tryCloseOnChainTerminal(taskHash, settled);
  if (!closed.ok) return false;
  await Promise.all([
    a2aStore.clearOffer(taskHash).catch(() => {}),
    a2aStore.clearCascade(taskHash).catch(() => {}),
  ]);
  console.log(`${logPrefix}: closed A2A state for ${chain} task ${escrowTaskId} (${closed.previousStatus} → failed/${settled})`);
  return true;
}

/**
 * A TaskCancelled event from `chain`'s escrow: close the task's listing. The
 * event carries only the id, so the hash and poster come from the task's
 * record. resolveDispute emits TaskCancelled too when it refunds the poster;
 * that task had a worker, and disputeListener closes it from the ruling, so
 * it is left alone here. Throws when the chain or the store can't be read,
 * so the indexer retries the event.
 */
export async function handleTaskCancelled(chain: TaskChain, escrowTaskId: bigint): Promise<boolean> {
  const task = await getTaskOn(chain, Number(escrowTaskId));
  if (task.worker && task.worker !== ethers.ZeroAddress) return false;
  return closeRefundedA2ATask(
    chain,
    escrowTaskId.toString(),
    String(task.taskHash).toLowerCase(),
    String(task.agent),
    'cancelled',
    `[${chain}EscrowEvents] TaskCancelled`,
  );
}
