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
 */

import type { EventLog } from 'ethers';
import { baseEscrow, baseProvider } from './chain.js';
import { redis } from './redis.js';
import { config } from '../config.js';

// ── Redis keys ──────────────────────────────────────────────────────────────

const KEY = {
  hash2id: (hash: string) => `base:hash2id:${hash.toLowerCase()}`,
  id2hash: (taskId: bigint | string) => `base:id2hash:${String(taskId)}`,
  checkpoint: 'base:events:checkpoint',
};

// ── Polling config ──────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5_000;
const MAX_BLOCKS_PER_TICK = 500;

// Fresh deployment — no backfill needed. Set to the Base deployment block
// via env so we start indexing from contract creation.
const DEPLOYMENT_BLOCK = Number(process.env.BASE_ESCROW_DEPLOYMENT_BLOCK ?? 0);

// ── State ───────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let inFlightPromise: Promise<void> | null = null;

let lastFailureSig: string | null = null;
let consecutiveFailures = 0;

// ── Public API ──────────────────────────────────────────────────────────────

export async function forceBaseTick(): Promise<void> {
  await tick();
}

export async function getBaseTaskIdByHash(taskHash: string): Promise<string | null> {
  return redis.get(KEY.hash2id(taskHash));
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
      const latest = await baseProvider.getBlockNumber();
      const checkpointRaw = await redis.get(KEY.checkpoint);

      let from: number;
      if (checkpointRaw) {
        from = Number(checkpointRaw) + 1;
      } else {
        from = Math.max(latest, DEPLOYMENT_BLOCK);
        await redis.set(KEY.checkpoint, String(from));
      }
      if (from > latest) return;

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
      } else if (lagBlocks > 0) {
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
    } finally {
      inFlightPromise = null;
    }
  })();

  return inFlightPromise;
}
