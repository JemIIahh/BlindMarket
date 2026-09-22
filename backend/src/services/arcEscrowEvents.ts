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
 * All writes are idempotent, so at-least-once delivery from the poll loop is
 * safe. hash2id is first-writer-wins (SET NX): a later TaskCreated reusing a
 * live task's hash must not repoint it (see indexTaskCreated).
 *
 * It also mirrors DisputeResolved rulings into the off-chain accounting
 * (see disputeListener), behind its own checkpoint:
 *
 *   arc:events:dispute-checkpoint  → last block scanned for DisputeResolved
 */

import type { EventLog } from 'ethers';
import { arcEscrow, arcProvider } from './chain.js';
import { redis } from './redis.js';
import { backgroundWritesAllowed } from './deploymentIdentity.js';
import { handleDisputeResolved, retryParkedDisputes } from './disputeListener.js';
import { checkEscrowFingerprint } from './escrowFingerprint.js';
import { config } from '../config.js';

// ── Redis keys ──────────────────────────────────────────────────────────────

const KEY = {
  hash2id: (hash: string) => `arc:hash2id:${hash.toLowerCase()}`,
  id2hash: (taskId: bigint | string) => `arc:id2hash:${String(taskId)}`,
  checkpoint: 'arc:events:checkpoint',
  disputeCheckpoint: 'arc:events:dispute-checkpoint',
};

// ── Polling config ──────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
const MAX_BLOCKS_PER_TICK = 500;

const DEPLOYMENT_BLOCK = Number(process.env.ARC_ESCROW_DEPLOYMENT_BLOCK ?? 0);
const LAG_LOG_INTERVAL_MS = 60_000;
const DISPUTE_CONFIRMATIONS = 5;

// ── State ───────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let inFlightPromise: Promise<number | null> | null = null;
let disputesInFlight = false;
let disputeCheckpointSeeded = false;
let disputeCheckpointLost = false;
let lastFailureSig: string | null = null;
let consecutiveFailures = 0;
let lastLagLogAt = 0;
let lastDisputeFailure: string | null = null;

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
  if (indexedTo === null || disputesInFlight) return;
  disputesInFlight = true;
  try {
    await indexDisputes(indexedTo);
    await retryParkedDisputes('arc');
  } finally {
    disputesInFlight = false;
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
      from = Number.isSafeInteger(DEPLOYMENT_BLOCK) && DEPLOYMENT_BLOCK > 0
        ? Math.min(DEPLOYMENT_BLOCK, latest)
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
    const events = await arcEscrow.queryFilter(filter, from, to);

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
    const events = await arcEscrow.queryFilter(filter, from, to);
    for (const ev of events) {
      const args = (ev as EventLog).args;
      if (!args) continue;
      await handleDisputeResolved('arc', args.taskId as bigint, args.workerFavored as boolean);
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
