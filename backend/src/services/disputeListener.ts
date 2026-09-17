/**
 * Mirrors an on-chain dispute ruling (BlindEscrow DisputeResolved) into the
 * off-chain accounting, for whichever chain emitted it. Shared by the 0G and
 * Base event indexers.
 *
 * An admin resolveDispute pays the worker (or refunds the poster) entirely
 * outside the /finalize|/verify|/verdict routes, so this listener is the only
 * observer of the ruling. A failed event is retried on the next scan. One
 * that is still failing after PARK_MIN_ATTEMPTS tries and PARK_MIN_FAILING_MS
 * is parked so it stops holding the indexer's checkpoint, and the poll loop
 * retries parked events every PARKED_RETRY_MS until they succeed.
 */

import { redis } from './redis.js';
import { getTaskOn } from './escrow.js';
import * as a2aStore from './a2aStore.js';
import { loadAgentBySmartAccount } from './deployedAgentStore.js';
import { notifyLifecycle } from './notificationStore.js';
import { recordWorkerPayout, recordWorkerDispute } from './workerPayout.js';
import { disputeKeys } from './disputeKeys.js';
import type { TaskChain } from './taskChain.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'0'.repeat(64)}`;
// BlindEscrow.TaskStatus after resolveDispute: Completed when the worker won,
// Cancelled when the poster was refunded.
const STATUS_COMPLETED = 4;
const STATUS_CANCELLED = 5;
const STATUS_DISPUTED = 6;

/** Both must be reached before an event is parked. Scans also run from
 *  request paths, so the attempt count alone says little about how long an
 *  event has been failing. */
export const PARK_MIN_ATTEMPTS = 10;
export const PARK_MIN_FAILING_MS = 5 * 60_000;
export const PARKED_RETRY_MS = 10 * 60_000;

const ATTEMPTS_TTL_SECONDS = 24 * 60 * 60;
const DONE_TTL_SECONDS = 30 * 24 * 60 * 60;

interface ParkedDispute {
  workerFavored: boolean;
  attempts: number;
  firstFailedAt: string;
  parkedAt: string;
  error: string;
  retries: number;
  lastTriedAt?: string;
}

/**
 * Process one DisputeResolved event. Throws when it should be retried, so the
 * caller keeps its checkpoint; returns once it is processed, already
 * processed, or parked.
 */
export async function handleDisputeResolved(
  chain: TaskChain,
  taskId: bigint,
  workerFavored: boolean,
  now = Date.now(),
): Promise<void> {
  const keys = disputeKeys(chain);
  const id = taskId.toString();
  // Seen again: a chunk retried for a later event, or a re-scan.
  if (await redis.exists(keys.done(id))) return;
  if (await redis.hexists(keys.parked, id)) return;

  try {
    await processDisputeResolved(chain, taskId, workerFavored);
  } catch (err) {
    const message = (err as Error).message;
    const attemptsKey = keys.attempts(id);
    // A Redis failure here propagates: the event is retried, never parked.
    const attempts = await redis.hincrby(attemptsKey, 'count', 1);
    await redis.hsetnx(attemptsKey, 'firstAt', String(now));
    await redis.expire(attemptsKey, ATTEMPTS_TTL_SECONDS).catch(() => {});
    const storedFirstAt = Number(await redis.hget(attemptsKey, 'firstAt'));
    const firstAt = storedFirstAt > 0 ? storedFirstAt : now;
    if (attempts < PARK_MIN_ATTEMPTS || now - firstAt < PARK_MIN_FAILING_MS) {
      throw new Error(`DisputeResolved ${chain} taskId=${id}: ${message}`);
    }

    const parked: ParkedDispute = {
      workerFavored,
      attempts,
      firstFailedAt: new Date(firstAt).toISOString(),
      parkedAt: new Date(now).toISOString(),
      error: message,
      retries: 0,
    };
    await redis.hset(keys.parked, id, JSON.stringify(parked));
    await redis.del(attemptsKey).catch(() => {});
    console.error(
      `[disputes] PARKED ${chain} taskId=${id} ${JSON.stringify(parked)}; retried every ${PARKED_RETRY_MS / 60_000} min`,
    );
    return;
  }
  await markDone(chain, id);
}

const lastParkedRetry = new Map<TaskChain, number>();

/**
 * Retry a chain's parked events, at most once per PARKED_RETRY_MS. Called by
 * the poll loop only, never from a request path. Never throws.
 */
export async function retryParkedDisputes(chain: TaskChain, now = Date.now()): Promise<void> {
  const last = lastParkedRetry.get(chain);
  if (last !== undefined && now - last < PARKED_RETRY_MS) return;
  lastParkedRetry.set(chain, now);

  const keys = disputeKeys(chain);
  let entries: Record<string, string>;
  try {
    entries = await redis.hgetall(keys.parked);
  } catch (err) {
    console.warn(`[disputes] could not read parked ${chain} rulings: ${(err as Error).message}`);
    return;
  }

  for (const [id, raw] of Object.entries(entries)) {
    let parked: ParkedDispute;
    try {
      parked = JSON.parse(raw) as ParkedDispute;
    } catch {
      console.error(`[disputes] parked ${chain} taskId=${id} is unreadable: ${raw}`);
      continue;
    }
    try {
      if (!(await redis.exists(keys.done(id)))) {
        await processDisputeResolved(chain, BigInt(id), parked.workerFavored);
        await markDone(chain, id);
      }
      await redis.hdel(keys.parked, id);
      console.log(`[disputes] parked ${chain} taskId=${id} processed on retry ${parked.retries + 1}`);
    } catch (err) {
      const next: ParkedDispute = {
        ...parked,
        retries: parked.retries + 1,
        error: (err as Error).message,
        lastTriedAt: new Date(now).toISOString(),
      };
      await redis.hset(keys.parked, id, JSON.stringify(next)).catch(() => {});
      console.error(`[disputes] parked ${chain} taskId=${id} failed retry ${next.retries}: ${next.error}`);
    }
  }
}

async function markDone(chain: TaskChain, id: string): Promise<void> {
  const keys = disputeKeys(chain);
  // The work is done; a failed marker write only means a re-observed event
  // runs again, which the credit and dispute markers make harmless.
  await redis.set(keys.done(id), '1', 'EX', DONE_TTL_SECONDS).catch(() => {});
  await redis.del(keys.attempts(id)).catch(() => {});
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
  // Still Disputed: the node that answered hasn't seen the ruling's block
  // yet. Retry; a ruling that stays this way is parked and shows in
  // /health/bridge. Any other status means the id now names a different task
  // than the ruling did (a parked ruling retried after the escrow was
  // redeployed under the same Redis keys), so the ruling is not about it.
  const expectedStatus = workerFavored ? STATUS_COMPLETED : STATUS_CANCELLED;
  const status = Number(t.status);
  if (status === STATUS_DISPUTED) {
    throw new Error('the task still reads as Disputed; the RPC node may be behind the ruling');
  }
  if (status !== expectedStatus) {
    console.warn(
      `[disputes] DisputeResolved ${chain} taskId=${taskId} workerFavored=${workerFavored} but the task's status is ${t.status}, not ${expectedStatus} — skipping`,
    );
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
    // At-most-once for this listener only (recordWorkerDispute itself has no
    // guard because the routes legitimately record one dispute per failed
    // round). Released on failure so a transient blip stays retryable, like
    // the a2a:credited marker.
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
