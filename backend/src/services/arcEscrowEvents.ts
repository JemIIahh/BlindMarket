/**
 * Arc chain event listener.
 *
 * Polls the Arc BlindEscrow for TaskCreated events and maintains a
 * bidirectional mapping in Redis:
 *
 *   arc:hash2id:<lowercased_hash>  → string of uint256 taskId
 *   arc:id2hash:<taskId>           → 0x-prefixed lowercased hash
 *   arc:events:checkpoint          → last block number processed
 *   arc:events:escrow              → <chainId>:<escrow> these keys belong to
 *                                     (see escrowFingerprint)
 *
 * The `arc:` prefix is chainScope('arc'): it is `arc` on Arc testnet, where these
 * keys have always lived, and `arc@<chainId>` on any other network, so a
 * move to another network starts from an empty index.
 *
 * All writes are idempotent, so at-least-once delivery from the poll loop is
 * safe. hash2id is first-writer-wins (SET NX): a later TaskCreated reusing a
 * live task's hash must not repoint it (see indexTaskCreated).
 *
 * It also mirrors DisputeResolved rulings, and UnjudgedWorkReleased payouts
 * of escalated work, into the off-chain accounting (see disputeListener),
 * behind its own checkpoint:
 *
 *   arc:events:dispute-checkpoint  → last block scanned for DisputeResolved
 *
 * And it closes the listing of a task its poster cancelled on-chain
 * (TaskCancelled, see refundedTasks.handleTaskCancelled), behind another:
 *
 *   arc:events:cancel-checkpoint   → last block scanned for TaskCancelled
 *
 * And, with OPEN_SUBMISSION_ENABLED, the open-submission events
 * (openSubmissionEvents), behind one more:
 *
 *   arc:events:open-checkpoint     → last block scanned for them
 */

import type { EventLog } from 'ethers';
import { arcArchiveEscrow, arcEscrow, arcProvider } from './chain.js';
import { redis } from './redis.js';
import { backgroundWritesAllowed } from './deploymentIdentity.js';
import { handleDisputeResolved, retryParkedDisputes } from './disputeListener.js';
import { checkEscrowFingerprint } from './escrowFingerprint.js';
import { config } from '../config.js';
import { chainScope } from './chainScope.js';

// ── Redis keys ──────────────────────────────────────────────────────────────

// Under the network's scope (chainScope), so a move to another Arc network
// starts from an empty index instead of reading this one's.
const KEY = {
  hash2id: (hash: string) => `${chainScope('arc')}:hash2id:${hash.toLowerCase()}`,
  id2hash: (taskId: bigint | string) => `${chainScope('arc')}:id2hash:${String(taskId)}`,
  get checkpoint() { return `${chainScope('arc')}:events:checkpoint`; },
  get disputeCheckpoint() { return `${chainScope('arc')}:events:dispute-checkpoint`; },
  get cancelCheckpoint() { return `${chainScope('arc')}:events:cancel-checkpoint`; },
  get openCheckpoint() { return `${chainScope('arc')}:events:open-checkpoint`; },
};

function isPrunedHistoryError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  const code = (err as { code?: unknown }).code;
  return (
    msg.toLowerCase().includes('pruned history') ||
    msg.toLowerCase().includes('pruned') ||
    (typeof code === 'number' && code === 4444) ||
    msg.toLowerCase().includes('history unavailable')
  );
}

/**
 * Query Arc escrow logs, falling back to an archive RPC when the primary
 * RPC has pruned the requested block range. Without an archive RPC the error
 * is re-thrown with a note telling the operator to set ARC_ARCHIVE_RPC_URL.
 */
async function queryArcEscrowLogs(
  filter: any,
  from: number,
  to: number,
): Promise<any[]> {
  if (!arcEscrow) return [];
  try {
    return await arcEscrow.queryFilter(filter, from, to);
  } catch (err) {
    if (!isPrunedHistoryError(err)) throw err;
    if (arcArchiveEscrow) {
      console.warn(`[arcEscrowEvents] primary RPC pruned history for blocks ${from}..${to}, trying archive RPC`);
      return arcArchiveEscrow.queryFilter(filter, from, to);
    }
    throw new Error(
      `${(err as Error).message} — set ARC_ARCHIVE_RPC_URL to an Arc RPC that retains full history (or a window covering your escrow's deploy block).`,
    );
  }
}

// ── Polling config ──────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
const MAX_BLOCKS_PER_TICK = 500;

// First indexing starts here when Redis has no checkpoint: the deploy block
// from config (ARC_ESCROW_DEPLOYMENT_BLOCK, else the generated record for this
// Arc network), so a fresh backend backfills from the escrow's birth instead
// of the head. Read per tick: tests reload config with different env.
function deploymentBlock(): number {
  const block = config.arcEscrowDeploymentBlock;
  return Number.isSafeInteger(block) && block > 0 ? block : 0;
}
const LAG_LOG_INTERVAL_MS = 60_000;
const DISPUTE_CONFIRMATIONS = 5;

// ── State ───────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let inFlightPromise: Promise<number | null> | null = null;
// The dispute and cancel scans that follow a TaskCreated tick.
let followUpsInFlight = false;
let disputeCheckpointSeeded = false;
let disputeCheckpointLost = false;
let lastFailureSig: string | null = null;
let consecutiveFailures = 0;
let lastLagLogAt = 0;
let lastDisputeFailure: string | null = null;
let lastCancelFailure: string | null = null;
let lastOpenFailure: string | null = null;

// ── Public API ──────────────────────────────────────────────────────────────

/** Index TaskCreated now (request paths). Rulings wait for the poll loop. */
export async function forceArcTick(): Promise<void> {
  await indexOnce();
}

export async function getArcTaskIdByHash(taskHash: string): Promise<string | null> {
  return redis.get(KEY.hash2id(taskHash));
}

/** Arc counterpart of baseEscrowEvents.seedBaseTaskIdMapping — writes the `arc:` keys. */
export async function seedArcTaskIdMapping(taskHash: string, taskId: bigint | string): Promise<void> {
  const pipe = redis.pipeline();
  pipe.set(KEY.hash2id(taskHash), String(taskId));
  pipe.set(KEY.id2hash(taskId), taskHash.toLowerCase());
  await pipe.exec();
}

export async function getArcTaskHashById(taskId: bigint | string | number): Promise<string | null> {
  return redis.get(KEY.id2hash(typeof taskId === 'number' ? BigInt(taskId) : taskId));
}

export function startArcEscrowEventLoop(): void {
  if (timer) return;
  void pollArcEscrowOnce();
  timer = setInterval(() => void pollArcEscrowOnce(), POLL_INTERVAL_MS);
  console.log(`[arcEscrowEvents] polling Arc BlindEscrow every ${POLL_INTERVAL_MS / 1000}s`);
}

export function stopArcEscrowEventLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ── Core poll loop ──────────────────────────────────────────────────────────

export async function pollArcEscrowOnce(): Promise<void> {
  const indexedTo = await indexOnce();
  if (indexedTo === null || followUpsInFlight) return;
  followUpsInFlight = true;
  try {
    await indexDisputes(indexedTo);
    await retryParkedDisputes('arc');
    await indexCancels(indexedTo);
    await indexOpenSubmissions(indexedTo);
  } finally {
    followUpsInFlight = false;
  }
}

function indexOnce(): Promise<number | null> {
  if (!backgroundWritesAllowed('Arc indexer')) return Promise.resolve(null);
  if (inFlightPromise) return inFlightPromise;
  inFlightPromise = (async () => {
    try {
      return arcEscrow ? await indexTaskCreated() : null;
    } finally {
      inFlightPromise = null;
    }
  })();
  return inFlightPromise;
}

async function indexTaskCreated(): Promise<number | null> {
  if (!arcEscrow) return null;

  try {
    await checkEscrowFingerprint('arc', config.arcChainId, config.arcEscrowAddress);
    const latest = await arcProvider.getBlockNumber();
    const checkpointRaw = await redis.get(KEY.checkpoint);

    let from: number;
    if (checkpointRaw) {
      from = Number(checkpointRaw) + 1;
    } else {
      const startBlock = deploymentBlock();
      from = startBlock > 0
        ? Math.min(startBlock, latest)
        : latest;
      await redis.set(KEY.disputeCheckpoint, String(latest), 'NX');
      await redis.set(KEY.checkpoint, String(from - 1));
    }
    if (!disputeCheckpointSeeded) {
      const seed = disputeCheckpointLost ? latest : from - 1;
      await redis.set(KEY.disputeCheckpoint, String(seed), 'NX');
      disputeCheckpointSeeded = true;
      disputeCheckpointLost = false;
    }
    if (from > latest) return from - 1;

    const to = Math.min(latest, from + MAX_BLOCKS_PER_TICK - 1);
    const lagBlocks = latest - to;

    const filter = arcEscrow.filters.TaskCreated();
    const events = await queryArcEscrowLogs(filter, from, to);

    if (events.length > 0) {
      const pipe = redis.pipeline();
      for (const ev of events) {
        const args = (ev as EventLog).args;
        if (!args) continue;
        const taskId = args.taskId as bigint | undefined;
        const taskHash = args.taskHash as string | undefined;
        if (taskId === undefined || !taskHash) continue;
        // First writer wins, as on Base (baseEscrowEvents.ts). The escrow does
        // not enforce unique task hashes, so anyone can emit a later
        // TaskCreated reusing a live task's hash; a plain SET let that repoint
        // the hash at the attacker's escrow id — assignment, settlement and
        // result visibility would then follow the attacker's task. The index
        // route's seed (caller verified as the hash's claimed poster) still
        // overwrites.
        pipe.set(KEY.hash2id(taskHash), String(taskId), 'NX');
        pipe.set(KEY.id2hash(taskId), taskHash.toLowerCase());
      }
      await pipe.exec();
    }

    await redis.set(KEY.checkpoint, String(to));

    if (Date.now() - lastLagLogAt > LAG_LOG_INTERVAL_MS) {
      console.log(`[arcEscrowEvents] indexed up to block ${to}, lag ${lagBlocks} blocks`);
      lastLagLogAt = Date.now();
    }

    lastFailureSig = null;
    consecutiveFailures = 0;
    return to;
  } catch (err) {
    const sig = `${(err as Error).name}:${(err as Error).message}`;
    if (sig !== lastFailureSig) {
      console.error('[arcEscrowEvents] TaskCreated tick failed:', (err as Error).message);
      lastFailureSig = sig;
    }
    consecutiveFailures++;
    return null;
  }
}

async function indexDisputes(indexedTo: number): Promise<void> {
  if (!arcEscrow) return;
  try {
    const checkpointRaw = await redis.get(KEY.disputeCheckpoint);
    const from = checkpointRaw ? Number(checkpointRaw) + 1 : indexedTo;
    const to = Math.min(indexedTo - DISPUTE_CONFIRMATIONS, from + MAX_BLOCKS_PER_TICK - 1);
    if (from > to) return;

    const filter = arcEscrow.filters.DisputeResolved();
    const events = await queryArcEscrowLogs(filter, from, to);
    // The worker collecting escalated work nobody ruled on pays out exactly
    // like a ruling in its favour (security audit run 1, C18).
    const releases = await queryArcEscrowLogs(arcEscrow.filters.UnjudgedWorkReleased(), from, to);
    for (const ev of events) {
      const args = (ev as EventLog).args;
      if (!args) continue;
      await handleDisputeResolved('arc', args.taskId as bigint, args.workerFavored as boolean);
    }
    for (const ev of releases) {
      const args = (ev as EventLog).args;
      if (!args) continue;
      await handleDisputeResolved('arc', args.taskId as bigint, true);
    }
    await redis.set(KEY.disputeCheckpoint, String(to));
  } catch (err) {
    const msg = (err as Error).message;
    if (msg !== lastDisputeFailure) {
      console.error('[arcEscrowEvents] DisputeResolved tick failed:', msg);
      lastDisputeFailure = msg;
    }
  }
}

/**
 * Close the listing of every task its poster cancelled on-chain. The CLI and
 * web app report a cancel through POST /tasks/:id/confirm-tx, but a cancel
 * sent from the SDK or straight to the escrow reported nothing, and the task
 * stayed listed. A first scan starts at the indexed head. A failed event
 * fails the scan, which retries from the same block next tick; closing is a
 * compare-and-set, so the events it already closed change nothing.
 */
async function indexCancels(indexedTo: number): Promise<void> {
  if (!arcEscrow) return;
  try {
    const checkpointRaw = await redis.get(KEY.cancelCheckpoint);
    const from = checkpointRaw ? Number(checkpointRaw) + 1 : indexedTo;
    const to = Math.min(indexedTo, from + MAX_BLOCKS_PER_TICK - 1);
    if (from > to) return;

    const events = await queryArcEscrowLogs(arcEscrow.filters.TaskCancelled(), from, to);
    if (events.length > 0) {
      // Imported at call time, like disputeListener's taskChain import:
      // taskChain loads this indexer.
      const { handleTaskCancelled } = await import('./refundedTasks.js');
      for (const ev of events) {
        const args = (ev as EventLog).args;
        if (!args) continue;
        await handleTaskCancelled('arc', args.taskId as bigint);
      }
    }
    await redis.set(KEY.cancelCheckpoint, String(to));
    lastCancelFailure = null;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg !== lastCancelFailure) {
      console.error('[arcEscrowEvents] TaskCancelled tick failed:', msg);
      lastCancelFailure = msg;
    }
  }
}

/**
 * Open-submission events (OpenTaskCreated, OpenSubmission, WinnerSelected,
 * OpenTaskVoided), in one log query, only with OPEN_SUBMISSION_ENABLED: off,
 * this scan neither queries nor writes. A first scan starts at the indexed
 * head. A failed event fails the scan, which retries from the same block next
 * tick; every handler is idempotent.
 */
async function indexOpenSubmissions(indexedTo: number): Promise<void> {
  if (!arcEscrow || !config.openSubmissionEnabled) return;
  try {
    const checkpointRaw = await redis.get(KEY.openCheckpoint);
    const from = checkpointRaw ? Number(checkpointRaw) + 1 : indexedTo;
    const to = Math.min(indexedTo, from + MAX_BLOCKS_PER_TICK - 1);
    if (from > to) return;

    // Imported at call time, like refundedTasks above: escrow.js reaches this indexer.
    const { OPEN_EVENTS, handleOpenEvent } = await import('./openSubmissionEvents.js');
    const events = await queryArcEscrowLogs([[...OPEN_EVENTS]], from, to);
    for (const ev of events) {
      if ((ev as EventLog).eventName) await handleOpenEvent('arc', ev as EventLog);
    }
    await redis.set(KEY.openCheckpoint, String(to));
    lastOpenFailure = null;
  } catch (err) {
    const msg = (err as Error).message;
    if (msg !== lastOpenFailure) {
      console.error('[arcEscrowEvents] open-submission tick failed:', msg);
      lastOpenFailure = msg;
    }
  }
}
