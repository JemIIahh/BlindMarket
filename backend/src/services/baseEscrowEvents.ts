/**
 * Base chain event listener.
 *
 * Polls the Base BlindEscrow for TaskCreated events and maintains a
 * bidirectional mapping in Redis:
 *
 *   base:hash2id:<lowercased_hash>  → string of uint256 taskId
 *   base:id2hash:<taskId>           → 0x-prefixed lowercased hash
 *   base:events:checkpoint          → last block number processed
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
 * dispute scan never passes the TaskCreated checkpoint.
 */

import type { EventLog } from 'ethers';
import { baseEscrow, baseProvider } from './chain.js';
import { redis } from './redis.js';
import { handleDisputeResolved } from './disputeListener.js';

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

// ── State ───────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let inFlightPromise: Promise<void> | null = null;

let lastFailureSig: string | null = null;
let consecutiveFailures = 0;
let lastLagLogAt = 0;
let lastDisputeFailure: string | null = null;

// ── Public API ──────────────────────────────────────────────────────────────

export async function forceBaseTick(): Promise<void> {
  await tick();
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
  void tick();
  timer = setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[baseEscrowEvents] polling Base BlindEscrow every ${POLL_INTERVAL_MS / 1000}s`);
}

export function stopBaseEscrowEventLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ── Core poll loop ──────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (inFlightPromise) return inFlightPromise;

  inFlightPromise = (async () => {
    if (!baseEscrow) return;
    try {
      const indexed = await indexTaskCreated();
      if (indexed) await indexDisputes(indexed);
    } finally {
      inFlightPromise = null;
    }
  })();

  return inFlightPromise;
}

/** The TaskCreated checkpoint before and after a successful pass. */
interface IndexedRange {
  before: number;
  after: number;
}

/** Index TaskCreated events. Returns null when the pass failed. */
async function indexTaskCreated(): Promise<IndexedRange | null> {
  if (!baseEscrow) return null;

  try {
    const latest = await baseProvider.getBlockNumber();
    const checkpointRaw = await redis.get(KEY.checkpoint);

    let from: number;
    if (checkpointRaw) {
      from = Number(checkpointRaw) + 1;
    } else {
      // The checkpoint means "last block processed", so record the block
      // before `from`: a failed first tick must not skip `from`.
      from = Number.isSafeInteger(DEPLOYMENT_BLOCK) && DEPLOYMENT_BLOCK > 0
        ? Math.min(DEPLOYMENT_BLOCK, latest)
        : latest;
      await redis.set(KEY.checkpoint, String(from - 1));
    }
    if (from > latest) return { before: from - 1, after: from - 1 };

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
    return { before: from - 1, after: to };
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
 * Mirror DisputeResolved rulings up to the TaskCreated checkpoint. With no
 * dispute checkpoint yet, scanning starts where this tick's TaskCreated pass
 * started: on an existing deployment that is where the listener was switched
 * on (earlier rulings are for the earnings backfill), on a new Redis it is
 * the deployment block. A failed event leaves the checkpoint where it was, so
 * the next tick retries it.
 */
async function indexDisputes(indexed: IndexedRange): Promise<void> {
  if (!baseEscrow) return;

  try {
    const checkpointRaw = await redis.get(KEY.disputeCheckpoint);
    let last: number;
    if (checkpointRaw) {
      last = Number(checkpointRaw);
    } else {
      last = indexed.before;
      await redis.set(KEY.disputeCheckpoint, String(last));
    }
    const from = last + 1;
    if (from > indexed.after) return;
    const to = Math.min(indexed.after, from + MAX_BLOCKS_PER_TICK - 1);

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
