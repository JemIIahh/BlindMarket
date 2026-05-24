import type { EventLog } from 'ethers';
import { escrow, provider } from './chain.js';
import { redis } from './redis.js';

// ── Keys ─────────────────────────────────────────────────────────────────────
//
// Bidirectional mapping between the bytes32 taskHash (used as the A2A store
// key) and the on-chain uint256 taskId (needed for assignWorker /
// completeVerification). Hash side is lowercased to defang any mixed-case
// inputs from the createTask schema (which permits [0-9a-fA-F]).
//
//   a2a:hash2id:<lowercased_hash>  → string of uint256 taskId
//   a2a:id2hash:<taskId>           → 0x-prefixed lowercased hash
//   a2a:events:checkpoint          → last block number processed (string)
//
// All writes are idempotent (SET overwrite with identical value), so
// at-least-once delivery from the poll loop is safe.

const KEY = {
  hash2id: (hash: string) => `a2a:hash2id:${hash.toLowerCase()}`,
  id2hash: (taskId: bigint | string) => `a2a:id2hash:${String(taskId)}`,
  checkpoint: 'a2a:events:checkpoint',
};

const POLL_INTERVAL_MS = 5_000;

// Cap the per-tick block range. 0G's testnet RPC times out reliably on
// queryFilter ranges over a few thousand blocks (observed: consistent
// TIMEOUTs when the lag grows past one tick). Chunking keeps each request
// small enough to land, and lets us catch up over multiple ticks without
// the checkpoint-never-advances spiral that happens when one big query
// fails and the next attempt asks for an even bigger range.
const MAX_BLOCKS_PER_TICK = 1000;

// Floor for the on-demand backfill scan. If Redis is flushed or the indexer
// was offline when a task was created, the forward-only tick loop can't
// recover those events. `getTaskIdByHash` calls `backfillFromDeployment()`
// as a last resort, which scans from this block forward. Read from env so
// production can pin to the actual mainnet deployment block.
const DEPLOYMENT_BLOCK = Number(process.env.ESCROW_DEPLOYMENT_BLOCK ?? 33_459_885);

// One-shot guard — once the full backfill has run successfully in this
// process, subsequent cache misses are treated as genuine (task doesn't
// exist) instead of triggering another 850k-block sweep.
let backfillDone = false;
let backfillInFlight: Promise<void> | null = null;

let timer: NodeJS.Timeout | null = null;
let inFlightPromise: Promise<void> | null = null;

// Failure-mode tracking so we don't spam the same error every 30s. We log
// the first occurrence of each failure type, then go silent until either
// (a) the failure type changes, or (b) a tick succeeds — at which point we
// log a recovery line. Resets on successful tick.
let lastFailureSig: string | null = null;
let consecutiveFailures = 0;

/** Trigger an immediate indexer tick and wait for it to complete. */
export async function forceTick(): Promise<void> {
  await tick();
}

async function tick(): Promise<void> {
  // Skip re-entry: if a tick is already running, return its promise so
  // concurrent callers wait for the same result.
  if (inFlightPromise) return inFlightPromise;

  inFlightPromise = (async () => {
    try {
      const latest = await provider.getBlockNumber();
      const checkpointRaw = await redis.get(KEY.checkpoint);

      // First run: pin checkpoint at the current head and start polling forward.
      // Historical tasks pre-date A2A persistence, so backfill has no callers.
      let from: number;
      if (checkpointRaw) {
        from = Number(checkpointRaw) + 1;
      } else {
        from = latest;
        await redis.set(KEY.checkpoint, String(latest));
      }
      if (from > latest) return;

      // Cap the tail end so each request stays small. If we're behind by more
      // than the cap, this tick processes the next chunk and the next tick
      // picks up from there — at worst we trail by ~MAX_BLOCKS_PER_TICK blocks.
      const to = Math.min(latest, from + MAX_BLOCKS_PER_TICK - 1);
      const lagBlocks = latest - to;

      const filter = escrow.filters.TaskCreated();
      const events = await escrow.queryFilter(filter, from, to);

      if (events.length > 0) {
        const pipe = redis.pipeline();
        for (const ev of events) {
          // queryFilter on a contract filter returns EventLog with typed args.
          // Defensive cast covers the (EventLog | Log) union ethers narrows to.
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
          `[escrowEvents] processed ${events.length} TaskCreated event(s) (blocks ${from}..${to}` +
            (lagBlocks > 0 ? `, still ${lagBlocks} blocks behind` : '') +
            `)`,
        );
      } else if (lagBlocks > 0) {
        // No events in this chunk but we're still catching up — log so it's
        // visible we're making progress, otherwise silent ticks look like
        // nothing's happening when in fact each tick is advancing 1k blocks.
        console.log(`[escrowEvents] empty chunk ${from}..${to} (${lagBlocks} blocks behind)`);
      }

      // Advance checkpoint to the end of the chunk we successfully processed.
      // On error this line is skipped (we throw before getting here), so the
      // next tick retries from the same `from`.
      await redis.set(KEY.checkpoint, String(to));

      // Recovery log if the previous tick(s) were failing.
      if (lastFailureSig !== null) {
        console.log(
          `[escrowEvents] recovered after ${consecutiveFailures} failed tick(s) (${lastFailureSig})`,
        );
        lastFailureSig = null;
        consecutiveFailures = 0;
      }
    } catch (e) {
      // RPC blips and DNS hiccups are transient. The next tick retries from
      // the same checkpoint — no events lost. To avoid log spam during long
      // network-fault windows we collapse repeated identical errors into a
      // single line, with a count emitted on the first occurrence and on
      // each transition to a new failure mode.
      const err = e as Error & { errors?: Error[] };
      const msg = err.errors?.length
        ? `AggregateError: ${err.errors.map((ee: Error) => ee.message || String(ee)).join('; ')}`
        : (err.message || `${err.name || typeof e}: ${String(e)}`);
      // Bucket by first few words / error code so transient timeouts don't
      // each look unique to the dedup logic.
      const sig = msg.match(/^[A-Za-z _-]+ (?:error )?: ?[A-Z_]+/)?.[0]
        ?? msg.split(/[\s(]/).slice(0, 3).join(' ');
      if (sig !== lastFailureSig) {
        console.error(`[escrowEvents] tick error: ${msg}` + (consecutiveFailures > 0 ? ` (after ${consecutiveFailures} of previous mode)` : ''));
        lastFailureSig = sig;
        consecutiveFailures = 1;
      } else {
        consecutiveFailures += 1;
      }
    } finally {
      inFlightPromise = null;
    }
  })();

  return inFlightPromise;
}
export function startEscrowEventLoop(): void {
  if (timer) return; // idempotent — safe to call from multiple boot paths
  void tick(); // run immediately so we don't wait 5s for the first capture
  timer = setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[escrowEvents] polling TaskCreated every ${POLL_INTERVAL_MS / 1000}s`);
}

export function stopEscrowEventLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ── Lookup helpers (used by the settlement bridge) ──────────────────────────

/** Resolve a taskHash to its on-chain uint256 taskId, or null if not yet seen. */
export async function getTaskIdByHash(taskHash: string): Promise<string | null> {
  // Try immediate lookup first
  let id = await redis.get(KEY.hash2id(taskHash));
  if (id) return id;

  // If not found, it might be due to indexing lag. Try triggering a tick and retrying.
  // We'll retry up to 3 times with a short delay.
  for (let i = 0; i < 3; i++) {
    await tick();
    id = await redis.get(KEY.hash2id(taskHash));
    if (id) return id;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // Last resort: full backfill from contract deployment. Handles the case
  // where the forward-only tick loop missed this event (Redis flush, indexer
  // downtime during task creation, checkpoint pinned past the create block).
  // Guarded so a single process only does the 850k-block sweep once.
  if (!backfillDone) {
    await backfillFromDeployment();
    id = await redis.get(KEY.hash2id(taskHash));
    if (id) return id;
  }

  return null;
}

/**
 * One-shot scan of all TaskCreated events from contract deployment to head.
 * Writes every (taskHash → taskId, taskId → taskHash) mapping to Redis as a
 * side effect. Called from `getTaskIdByHash` when the forward-only indexer
 * has missed an event. Concurrent callers share the same promise so the
 * scan only runs once even under request bursts.
 */
async function backfillFromDeployment(): Promise<void> {
  if (backfillInFlight) return backfillInFlight;
  backfillInFlight = (async () => {
    try {
      const latest = await provider.getBlockNumber();
      console.log(
        `[escrowEvents] on-demand backfill: scanning blocks ${DEPLOYMENT_BLOCK}..${latest} (${latest - DEPLOYMENT_BLOCK} blocks)`,
      );
      const filter = escrow.filters.TaskCreated();
      let from = DEPLOYMENT_BLOCK;
      let chunks = 0;
      let totalEvents = 0;
      while (from <= latest) {
        const to = Math.min(latest, from + MAX_BLOCKS_PER_TICK - 1);
        try {
          const events = await escrow.queryFilter(filter, from, to);
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
            totalEvents += events.length;
          }
          from = to + 1;
          chunks += 1;
        } catch (e) {
          // Same RPC-blip handling as the regular tick — sleep briefly and
          // retry the same chunk. Backfill must be complete or it doesn't
          // serve its purpose, so we don't abandon on transient errors.
          console.error(
            `[escrowEvents] backfill chunk ${from}..${to} failed: ${(e as Error).message}; retrying in 2s`,
          );
          await new Promise((r) => setTimeout(r, 2_000));
        }
      }
      console.log(
        `[escrowEvents] backfill complete: ${totalEvents} events across ${chunks} chunks`,
      );
      backfillDone = true;
    } finally {
      backfillInFlight = null;
    }
  })();
  return backfillInFlight;
}

/** Resolve an on-chain taskId back to its taskHash, or null if not seen. */
export async function getTaskHashById(taskId: bigint | string | number): Promise<string | null> {
  return redis.get(KEY.id2hash(typeof taskId === 'number' ? BigInt(taskId) : taskId));
}
