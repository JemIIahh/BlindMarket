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

const POLL_INTERVAL_MS = 30_000;

// Cap the per-tick block range. 0G's testnet RPC times out reliably on
// queryFilter ranges over a few thousand blocks (observed: consistent
// TIMEOUTs when the lag grows past one tick). Chunking keeps each request
// small enough to land, and lets us catch up over multiple ticks without
// the checkpoint-never-advances spiral that happens when one big query
// fails and the next attempt asks for an even bigger range.
const MAX_BLOCKS_PER_TICK = 1000;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

// Failure-mode tracking so we don't spam the same error every 30s. We log
// the first occurrence of each failure type, then go silent until either
// (a) the failure type changes, or (b) a tick succeeds — at which point we
// log a recovery line. Resets on successful tick.
let lastFailureSig: string | null = null;
let consecutiveFailures = 0;

async function tick(): Promise<void> {
  // Skip re-entry: a slow RPC could otherwise stack overlapping ticks.
  if (inFlight) return;
  inFlight = true;
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
    const msg = (e as Error).message ?? String(e);
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
    inFlight = false;
  }
}

export function startEscrowEventLoop(): void {
  if (timer) return; // idempotent — safe to call from multiple boot paths
  void tick(); // run immediately so we don't wait 30s for the first capture
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
  return redis.get(KEY.hash2id(taskHash));
}

/** Resolve an on-chain taskId back to its taskHash, or null if not seen. */
export async function getTaskHashById(taskId: bigint | string | number): Promise<string | null> {
  return redis.get(KEY.id2hash(typeof taskId === 'number' ? BigInt(taskId) : taskId));
}
