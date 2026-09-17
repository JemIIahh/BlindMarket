/**
 * Mirrors an on-chain dispute ruling (BlindEscrow DisputeResolved) into the
 * off-chain accounting, for whichever chain emitted it. Shared by the 0G and
 * Base event indexers.
 *
 * An admin resolveDispute pays the worker (or refunds the poster) entirely
 * outside the /finalize|/verify|/verdict routes, so this listener is the only
 * observer of the ruling. A failed event is retried on the next tick, and
 * parked after MAX_DISPUTE_ATTEMPTS so one bad event can't hold the
 * indexer's checkpoint forever.
 */

import { redis } from './redis.js';
import { getTaskOn } from './escrow.js';
import * as a2aStore from './a2aStore.js';
import { loadAgentBySmartAccount } from './deployedAgentStore.js';
import { notifyLifecycle } from './notificationStore.js';
import { recordWorkerPayout, recordWorkerDispute } from './workerPayout.js';
import type { TaskChain } from './taskChain.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'0'.repeat(64)}`;

/** Ticks one event may fail before it is parked. At the 5s poll interval,
 *  about 100s of consecutive failures. An RPC outage usually fails the
 *  event query first, which doesn't count. */
export const MAX_DISPUTE_ATTEMPTS = 20;

const KEY = {
  // Task ids are per-escrow counters, so the chain is part of every key.
  attempts: (chain: TaskChain, taskId: bigint) => `a2a:dispute-attempts:${chain}:${taskId}`,
  /** Hash of `<chain>:<taskId>` → JSON of the parked event. */
  parked: 'a2a:dispute-parked',
};
const ATTEMPTS_TTL_SECONDS = 24 * 60 * 60;

/**
 * Process one DisputeResolved event. Throws when it should be retried, so the
 * caller keeps its checkpoint; returns once it is processed or parked.
 */
export async function handleDisputeResolved(chain: TaskChain, taskId: bigint, workerFavored: boolean): Promise<void> {
  const attemptsKey = KEY.attempts(chain, taskId);
  try {
    await processDisputeResolved(chain, taskId, workerFavored);
  } catch (err) {
    const attempts = await redis.incr(attemptsKey);
    await redis.expire(attemptsKey, ATTEMPTS_TTL_SECONDS).catch(() => {});
    if (attempts < MAX_DISPUTE_ATTEMPTS) throw err;

    const parked = {
      chain,
      taskId: taskId.toString(),
      workerFavored,
      attempts,
      error: (err as Error).message,
      parkedAt: new Date().toISOString(),
    };
    await redis.hset(KEY.parked, `${chain}:${taskId}`, JSON.stringify(parked));
    await redis.del(attemptsKey).catch(() => {});
    // Earnings can be repaired with scripts/backfill-earnings-by-chain.ts; the
    // task state and dispute reputation need a manual look.
    console.error(`[disputes] PARKED ${JSON.stringify(parked)}`);
    return;
  }
  await redis.del(attemptsKey).catch(() => {});
}

/**
 * workerFavored=true → the contract already paid the worker (90/10 split) and
 * emitted TaskCompleted; credit tasksCompleted/the earnings total/the Earnings
 * ledger. workerFavored=false → the poster was refunded; record the dispute.
 * Also moves the a2a state out of any active status so worker resume loops
 * and verifier queues stop touching a task the admin has already closed.
 */
async function processDisputeResolved(chain: TaskChain, taskId: bigint, workerFavored: boolean): Promise<void> {
  // The task's own record is authoritative for the hash, the worker and the
  // amount. The indexer's id→hash cache is not: before #62 the 0G keys also
  // held Base task ids, so a 0G id could map to a Base task's hash.
  const t = await getTaskOn(chain, Number(taskId));
  const taskHash = String(t.taskHash).toLowerCase();
  if (taskHash === ZERO_HASH) {
    console.warn(`[disputes] DisputeResolved ${chain} taskId=${taskId} has no task on-chain — skipping`);
    return;
  }

  // The same hash can be escrowed on both chains; the off-chain task belongs
  // to the chain it was indexed on, and a ruling on the other escrow is not
  // about it.
  const meta = await a2aStore.getMeta(taskHash);
  if (meta?.chain && meta.chain !== chain) {
    console.warn(
      `[disputes] DisputeResolved ${chain} taskId=${taskId}: task ${taskHash.slice(0, 10)}… is indexed on ${meta.chain} — skipping`,
    );
    return;
  }

  const onChainWorker = String(t.worker ?? '');
  const hasWorker = !!onChainWorker && onChainWorker.toLowerCase() !== ZERO_ADDRESS;
  // Executors are known by their EOA. Agents that submit through a
  // BlindAccount (Base) are recorded on-chain under the smart account, so
  // credit the account's owner.
  const executor = hasWorker ? await executorFor(onChainWorker) : '';
  console.log(
    `[disputes] DisputeResolved ${chain} taskId=${taskId} workerFavored=${workerFavored} worker=${onChainWorker}` +
      (executor && executor.toLowerCase() !== onChainWorker.toLowerCase() ? ` (owner ${executor})` : ''),
  );

  if (workerFavored && hasWorker) {
    // rethrow: a failed credit must fail the event so it is retried, not be
    // swallowed.
    await recordWorkerPayout(taskHash, executor, taskId.toString(), t.amount, { chain, token: String(t.token) }, {
      rethrow: true,
      meta,
    });
  } else if (!workerFavored && hasWorker) {
    // At-most-once for this listener only (chunk retries re-observe events;
    // recordWorkerDispute itself has no guard because the routes legitimately
    // record one dispute per failed round). Released on failure so a
    // transient blip stays retryable, like the a2a:credited marker.
    const disputedKey = `a2a:dispute-recorded:${taskHash}`;
    const first = await redis.set(disputedKey, executor.toLowerCase(), 'NX');
    if (first !== null) {
      try {
        await recordWorkerDispute(taskHash, executor, { rethrow: true });
      } catch (err) {
        await redis.del(disputedKey).catch(() => {});
        throw err;
      }
    }
  }

  // Diary: an admin ruling ends the task — completed if the worker was
  // paid, disputed if the poster was refunded. Never throws.
  await notifyLifecycle(taskHash, workerFavored ? 'completed' : 'disputed').catch(() => {});

  // Close the off-chain state so resume/verifier loops drop the task.
  try {
    await a2aStore.updateState(taskHash, { status: workerFavored ? 'verified' : 'failed' });
  } catch (err) {
    // Missing state (task created pre-A2A) is expected — accounting above
    // still ran. Anything else (Redis blip) fails the event so it is retried.
    if (!(err as Error).message?.includes('No A2A state')) throw err;
  }
}

async function executorFor(onChainWorker: string): Promise<string> {
  const owner = await loadAgentBySmartAccount(onChainWorker);
  return owner?.walletAddress || onChainWorker;
}
