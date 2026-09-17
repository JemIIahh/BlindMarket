/**
 * Base chain event listener.
 *
 * Polls the Base BlindEscrow for TaskCreated events and maintains a
 * bidirectional mapping in Redis:
 *
 *   base:hash2id:<lowercased_hash>  → string of uint256 taskId
 *   base:id2hash:<taskId>           → 0x-prefixed lowercased hash
 *   base:events:checkpoint          → last block number processed
 *   base:events:escrow              → <chainId>:<escrow> these keys belong to
 *                                     (see escrowFingerprint)
 *
 * All writes are idempotent (SET overwrite with identical value), so
 * at-least-once delivery from the poll loop is safe.
 *
 * It also mirrors DisputeResolved rulings into the off-chain accounting
 * (see disputeListener), behind its own checkpoint:
 *
 *   base:events:dispute-checkpoint  → last block scanned for DisputeResolved
 *
 * so a failing ruling delays only other rulings, never task indexing. The
 * dispute scan never passes the TaskCreated checkpoint, and runs from the
 * poll loop only: request paths that force a tick need TaskCreated alone.
 */

import type { EventLog } from 'ethers';
import { baseEscrow, baseProvider } from './chain.js';
import { redis } from './redis.js';
import { handleDisputeResolved, retryParkedDisputes } from './disputeListener.js';
import { checkEscrowFingerprint } from './escrowFingerprint.js';
import { config } from '../config.js';

// ── Redis keys ──────────────────────────────────────────────────────────────

const KEY = {
  hash2id: (hash: string) => `base:hash2id:${hash.toLowerCase()}`,
  id2hash: (taskId: bigint | string) => `base:id2hash:${String(taskId)}`,
  checkpoint: 'base:events:checkpoint',
  disputeCheckpoint: 'base:events:dispute-checkpoint',
};

// ── Polling config ──────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
const MAX_BLOCKS_PER_TICK = 500;

// Where indexing starts when Redis has no checkpoint (first boot, or a new
// Redis such as a staging stack). With BASE_ESCROW_DEPLOYMENT_BLOCK set it is
// that block, so tasks created before the indexer first ran are found;
// catching up costs MAX_BLOCKS_PER_TICK per POLL_INTERVAL_MS. Unset, it is
// the current head. An existing checkpoint always wins.
const DEPLOYMENT_BLOCK = Number(process.env.BASE_ESCROW_DEPLOYMENT_BLOCK ?? 0);
const LAG_LOG_INTERVAL_MS = 60_000;
// Rulings are scanned this far behind the head. The checkpoint never comes
// back to a block, so a node that briefly answers from behind the head (an
// empty log list, no error) must not move it past a ruling.
const DISPUTE_CONFIRMATIONS = 5;

// ── State ───────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let inFlightPromise: Promise<number | null> | null = null;
let disputesInFlight = false;
let disputeCheckpointSeeded = false;
/** The dispute checkpoint went missing after this process seeded it. */
let disputeCheckpointLost = false;

let lastFailureSig: string | null = null;
let consecutiveFailures = 0;
let lastLagLogAt = 0;
let lastDisputeFailure: string | null = null;

// ── Public API ──────────────────────────────────────────────────────────────

/** Index TaskCreated now (request paths). Rulings wait for the poll loop. */
export async function forceBaseTick(): Promise<void> {
  await indexOnce();
}

export async function getBaseTaskIdByHash(taskHash: string): Promise<string | null> {
  return redis.get(KEY.hash2id(taskHash));
}

/** Base counterpart of escrowEvents.seedTaskIdMapping — writes the `base:` keys. */
export async function seedBaseTaskIdMapping(taskHash: string, taskId: bigint | string): Promise<void> {
  const pipe = redis.pipeline();
  pipe.set(KEY.hash2id(taskHash), String(taskId));
  pipe.set(KEY.id2hash(taskId), taskHash.toLowerCase());
  await pipe.exec();
}

export async function getBaseTaskHashById(taskId: bigint | string | number): Promise<string | null> {
  return redis.get(KEY.id2hash(typeof taskId === 'number' ? BigInt(taskId) : taskId));
}

export function startBaseEscrowEventLoop(): void {
  if (timer) return;
  void pollBaseEscrowOnce();
  timer = setInterval(() => void pollBaseEscrowOnce(), POLL_INTERVAL_MS);
  console.log(`[baseEscrowEvents] polling Base BlindEscrow every ${POLL_INTERVAL_MS / 1000}s`);
}

export function stopBaseEscrowEventLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ── Core poll loop ──────────────────────────────────────────────────────────

/**
 * One iteration of the poll loop: TaskCreated, then DisputeResolved up to
 * where tasks are indexed, then parked rulings.
 */
export async function pollBaseEscrowOnce(): Promise<void> {
  const indexedTo = await indexOnce();
  if (indexedTo === null || disputesInFlight) return;
  disputesInFlight = true;
  try {
    await indexDisputes(indexedTo);
    await retryParkedDisputes('base');
  } finally {
    disputesInFlight = false;
  }
}

/** One TaskCreated pass, shared by concurrent callers. Resolves to the
 *  TaskCreated checkpoint after the pass, or null when it failed. */
function indexOnce(): Promise<number | null> {
  if (inFlightPromise) return inFlightPromise;
  inFlightPromise = (async () => {
    try {
      return baseEscrow ? await indexTaskCreated() : null;
    } finally {
      inFlightPromise = null;
    }
  })();
  return inFlightPromise;
}

/** Index TaskCreated events. Returns the checkpoint after the pass, or
 *  null when it failed. */
async function indexTaskCreated(): Promise<number | null> {
  if (!baseEscrow) return null;

  try {
    await checkEscrowFingerprint('base', config.baseChainId, config.baseEscrowAddress);
    const latest = await baseProvider.getBlockNumber();
    const checkpointRaw = await redis.get(KEY.checkpoint);

    let from: number;
    if (checkpointRaw) {
      from = Number(checkpointRaw) + 1;
    } else {
      from = Number.isSafeInteger(DEPLOYMENT_BLOCK) && DEPLOYMENT_BLOCK > 0
        ? Math.min(DEPLOYMENT_BLOCK, latest)
        : latest;
      // A new Redis (or a flushed one) has lost the markers that stop a
      // ruling from being credited twice, while the database may still hold
      // those credits. So rulings are scanned from the head only; earlier
      // ones are for the earnings backfill, which writes totals. Written
      // before the TaskCreated checkpoint, so a failure in between can't
      // leave this pass looking like an existing deployment.
      await redis.set(KEY.disputeCheckpoint, String(latest), 'NX');
      // The checkpoint means "last block processed", so record the block
      // before `from`: a failed first tick must not skip `from`.
      await redis.set(KEY.checkpoint, String(from - 1));
    }
    if (!disputeCheckpointSeeded) {
      // On an existing deployment, rulings are scanned from where task
      // indexing stood when this code first ran; earlier ones are for the
      // earnings backfill. Seeded by whichever pass runs first, forced or
      // not, so no forced pass can move task indexing past unscanned blocks.
      // A checkpoint deleted later starts again at the head: task indexing
      // may be catching up after a flush, with the credit markers gone.
      const seed = disputeCheckpointLost ? latest : from - 1;
      await redis.set(KEY.disputeCheckpoint, String(seed), 'NX');
      disputeCheckpointSeeded = true;
      disputeCheckpointLost = false;
    }
    if (from > latest) return from - 1;

    const to = Math.min(latest, from + MAX_BLOCKS_PER_TICK - 1);
    const lagBlocks = latest - to;

    const filter = baseEscrow.filters.TaskCreated();
    const events = await baseEscrow.queryFilter(filter, from, to);

    if (events.length > 0) {
      const pipe = redis.pipeline();
      for (const ev of events) {
        const args = (ev as EventLog).args;
        if (!args) continue;
        const taskId = args.taskId as bigint | undefined;
        const taskHash = args.taskHash as string | undefined;
        if (taskId === undefined || !taskHash) continue;
        pipe.set(KEY.hash2id(taskHash), String(taskId));
        pipe.set(KEY.id2hash(taskId), taskHash.toLowerCase());
      }
      await pipe.exec();
      console.log(
        `[baseEscrowEvents] processed ${events.length} TaskCreated event(s) (blocks ${from}..${to}` +
          (lagBlocks > 0 ? `, still ${lagBlocks} blocks behind` : '') +
          `)`,
      );
    } else if (lagBlocks > 0 && Date.now() - lastLagLogAt >= LAG_LOG_INTERVAL_MS) {
      // A catch-up from the deployment block is hours of empty chunks.
      lastLagLogAt = Date.now();
      console.log(`[baseEscrowEvents] empty chunk ${from}..${to} (${lagBlocks} blocks behind)`);
    }

    await redis.set(KEY.checkpoint, String(to));

    if (lastFailureSig !== null) {
      console.log(
        `[baseEscrowEvents] recovered after ${consecutiveFailures} failed tick(s) (${lastFailureSig})`,
      );
      lastFailureSig = null;
      consecutiveFailures = 0;
    }
    return to;
  } catch (e) {
    const err = e as Error & { errors?: Error[] };
    const msg = err.errors?.length
      ? `AggregateError: ${err.errors.map((ee: Error) => ee.message || String(ee)).join('; ')}`
      : (err.message || `${err.name || typeof e}: ${String(e)}`);
    const sig = msg.match(/^[A-Za-z _-]+ (?:error )?: ?[A-Z_]+/)?.[0]
      ?? msg.split(/[\s(]/).slice(0, 3).join(' ');
    if (sig !== lastFailureSig) {
      console.error(`[baseEscrowEvents] tick error: ${msg}` + (consecutiveFailures > 0 ? ` (after ${consecutiveFailures} of previous mode)` : ''));
      lastFailureSig = sig;
      consecutiveFailures = 1;
    } else {
      consecutiveFailures += 1;
    }
    return null;
  }
}

/**
 * Mirror DisputeResolved rulings up to DISPUTE_CONFIRMATIONS blocks below
 * `indexedTo`, the TaskCreated checkpoint. A failed event leaves the
 * checkpoint where it was, so the next poll retries it.
 */
async function indexDisputes(indexedTo: number): Promise<void> {
  if (!baseEscrow) return;

  try {
    const checkpointRaw = await redis.get(KEY.disputeCheckpoint);
    if (checkpointRaw === null) {
      // Seeded by the TaskCreated pass; missing if the key was deleted.
      // Seed it again on the next pass.
      disputeCheckpointSeeded = false;
      disputeCheckpointLost = true;
      return;
    }
    const from = Number(checkpointRaw) + 1;
    const upTo = indexedTo - DISPUTE_CONFIRMATIONS;
    if (from > upTo) return;
    const to = Math.min(upTo, from + MAX_BLOCKS_PER_TICK - 1);

    const events = await baseEscrow.queryFilter(baseEscrow.filters.DisputeResolved(), from, to);
    for (const ev of events) {
      const args = (ev as EventLog).args;
      if (!args) continue;
      await handleDisputeResolved('base', args.taskId as bigint, args.workerFavored as boolean);
    }
    await redis.set(KEY.disputeCheckpoint, String(to));

    if (lastDisputeFailure !== null) {
      console.log('[baseEscrowEvents] DisputeResolved scan recovered');
      lastDisputeFailure = null;
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (msg !== lastDisputeFailure) {
      console.error(`[baseEscrowEvents] DisputeResolved scan error: ${msg}`);
      lastDisputeFailure = msg;
    }
  }
}
