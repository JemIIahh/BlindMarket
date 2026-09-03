import * as a2aStore from './a2aStore.js';
import * as escrowService from './escrow.js';
import { resolveCachedTaskByHash, resolveTaskByHash } from './taskChain.js';
import { SWEEP_INTERVAL_MS, EXPIRY_GRACE_SEC } from '../constants.js';

// Re-export for any callers that import from here (backward compat)
export { EXPIRY_GRACE_SEC } from '../constants.js';

// ── Expiry sweep ─────────────────────────────────────────────────────────────
//
// Proactively close open tasks whose on-chain deadline has passed. Without
// this, an expired-but-never-accepted task stays in a2a:open and both browse
// feeds indefinitely — the only close was lazy (an agent's /accept burning a
// CAS + an on-chain staticCall that reverts DeadlineReached). Every such
// listing cost an agent a wasted accept and a marketplace-signer staticCall.
//
// The sweep is OFF-CHAIN ONLY: it flips Redis state open→failed (via the
// tryExpire Lua CAS, so a racing /accept can't be clobbered) and drops the
// task from a2a:open. Escrow stays Funded on-chain — the poster reclaims via
// cancelTask, exactly as the lazy-close path already tells agents.
//
// Deadlines come from meta.deadline (persisted from the TaskCreated event at
// /tasks/index time). Tasks indexed before that field existed get a one-time
// chain read here, cached under a side key (a2a:deadline:<id> — NOT written
// into the meta blob, whose unguarded read-modify-write writers could lose a
// concurrent wrap slice), so steady-state sweeps are pure Redis.
//
// The grace margin covers server-clock vs block.timestamp drift: an accept
// inside the grace window simply fails on-chain as before, which is strictly
// no worse than pre-sweep behaviour. /accept's pre-CAS check shares this
// constant for the same reason — it must never terminally close a task the
// contract would still assign.

// Cap on the heavyweight hash→id resolution (it forces indexer ticks, sleeps,
// and possibly the one-shot deployment-scan backfill). Without a timeout, a
// persistent RPC outage inside the backfill's retry-forever loop would hold
// the inFlight guard and wedge the sweep permanently.
const HEAVY_RESOLVE_TIMEOUT_MS = 30_000;

// Hashes this process has already definitively resolved (or definitively
// failed to resolve) via the heavyweight path — never re-pay that cost for
// the same task in this process's lifetime. Timed-out attempts are removed so
// a later tick can retry once RPC recovers.
const heavyResolveAttempted = new Set<string>();

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export function startExpirySweepLoop(): void {
  if (timer) return; // idempotent — safe to call from multiple boot paths
  void sweepExpiredTasks(); // immediate first pass so a restart catches up
  timer = setInterval(() => {
    void sweepExpiredTasks();
    void sweepGasLiveness();
  }, SWEEP_INTERVAL_MS);
  console.log(
    `[a2aExpirySweep] sweeping expired open tasks + gas-liveness every ${SWEEP_INTERVAL_MS / 1000}s (grace ${EXPIRY_GRACE_SEC}s)`,
  );
}

export function stopExpirySweepLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function sweepExpiredTasks(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Repair the open index before sweeping so tasks stranded from a2a:open
    // are re-discovered (and can be expired if past deadline).
    await a2aStore.resyncOpenIndex().catch((err) =>
      console.warn(`[a2aExpirySweep] resyncOpenIndex error:`, (err as Error).message),
    );

    const open = await a2aStore.listOpenTasks();
    if (open.length === 0) return;

    const nowSec = Math.floor(Date.now() / 1000);
    let closed = 0;
    let backfilled = 0;
    // At most ONE heavyweight resolution per tick, so a backlog of phantom
    // tasks can't stack 30s timeouts inside a single 60s interval.
    let heavyUsedThisTick = false;

    for (const { meta } of open) {
      const tid = meta.taskId.toLowerCase();
      let deadline = meta.deadline ?? (await a2aStore.getCachedDeadline(tid).catch(() => null));

      if (!deadline) {
        let resolved = await resolveCachedTaskByHash(tid).catch(() => null);

        if (!resolved) {
          // Unmapped hash. Every task that passed the verified /tasks/index
          // gate had its hash2id mapping seeded eagerly, so a missing mapping
          // means either a phantom meta (reverted createTask, pre-gate write)
          // or a Redis flush the event indexer hasn't healed yet. Pay the
          // heavyweight resolution (forced ticks + full deployment scan) at
          // most once per task per process to find out which.
          if (heavyUsedThisTick || heavyResolveAttempted.has(tid)) continue;
          heavyUsedThisTick = true;
          heavyResolveAttempted.add(tid);
          try {
            resolved = await withTimeout(resolveTaskByHash(tid), HEAVY_RESOLVE_TIMEOUT_MS);
          } catch {
            // RPC trouble mid-scan — not a verdict on the task. Allow a retry
            // on a later tick.
            heavyResolveAttempted.delete(tid);
            continue;
          }
          if (!resolved) {
            // Definitive: the full event history contains no TaskCreated for
            // this hash, so no escrow was ever funded — a phantom that would
            // otherwise list forever and bounce every /accept via
            // SETTLEMENT_FAILED. Safe to close terminally.
            const r = await a2aStore.tryExpire(tid, 'unindexed');
            if (r.ok) {
              closed++;
              console.warn(
                `[a2aExpirySweep] closed phantom task ${tid.slice(0, 10)}… — no TaskCreated event on either chain (reverted/never-funded createTask)`,
              );
            }
            continue;
          }
        }

        try {
          const task = await escrowService.getTaskOn(resolved.chain, Number(resolved.taskId));
          // Identity check before trusting the read. On a Redis shared across
          // chains (the known stray-testnet-backend topology) numeric taskIds
          // collide across escrows, so a wrong-chain getTask would return a
          // DIFFERENT task's deadline — caching it could terminally close a
          // live task on the other chain. The on-chain struct stores the
          // taskHash, which IS our task key: require it to match.
          if ((task.taskHash ?? '').toLowerCase() !== tid) {
            console.warn(
              `[a2aExpirySweep] hash mismatch for ${tid.slice(0, 10)}… (${resolved.chain} id ${resolved.taskId} has taskHash ${String(task.taskHash).slice(0, 10)}…) — wrong chain or stale mapping; skipping`,
            );
            continue;
          }
          deadline = Number(task.deadline);
          // A nonexistent taskId reads back as a zeroed struct; deadline=0
          // must not be mistaken for "expired since 1970".
          if (!deadline) continue;
          await a2aStore.cacheDeadline(tid, deadline);
          backfilled++;
        } catch {
          continue; // RPC blip — retry on the next sweep
        }
      }

      if (nowSec < deadline + EXPIRY_GRACE_SEC) continue;

      const result = await a2aStore.tryExpire(tid, 'expired');
      if (result.ok) {
        closed++;
        // Best-effort cleanup; both keys self-expire via TTL anyway.
        await Promise.all([
          a2aStore.clearOffer(tid).catch(() => {}),
          a2aStore.clearCascade(tid).catch(() => {}),
        ]);
        console.log(
          `[a2aExpirySweep] closed expired task ${tid.slice(0, 10)}… ` +
            `(deadline ${new Date(deadline * 1000).toISOString()}) — escrow still Funded; poster reclaims via cancelTask`,
        );
      }
    }

    if (closed > 0 || backfilled > 0) {
      console.log(
        `[a2aExpirySweep] tick: ${open.length} open task(s), ${backfilled} deadline(s) backfilled, ${closed} task(s) closed`,
      );
    }
  } catch (err) {
    console.error('[a2aExpirySweep] sweep failed (non-fatal):', (err as Error).message);
  } finally {
    inFlight = false;
  }
}

// ── Gas-liveness sweep (Part 3) ──────────────────────────────────────────────
//
// After CAS wins, a settlement deadline key is set (TTL 120s). If the on-chain
// tx confirms within that window, the key is cleared. If it expires, this sweep
// detects the task and reverts it to 'open' so another agent can pick it up.

let gasLivenessInFlight = false;

export async function sweepGasLiveness(): Promise<void> {
  if (gasLivenessInFlight) return;
  gasLivenessInFlight = true;
  try {
    const accepted = await a2aStore.listAcceptedTasks();
    if (accepted.length === 0) return;

    let reverted = 0;
    for (const { taskId, executorAddress } of accepted) {
      // Check if the settlement deadline key still exists.
      // TTL returns -2 if key doesn't exist (expired/never set), -1 if no expiry.
      const ttl = await a2aStore.getSettlementDeadlineTTL(taskId);
      if (ttl === -2) {
        // Key expired or was never set — but only revert if the task was
        // recently accepted (within 2× the deadline window). Older accepted
        // tasks may have had their key cleared by a successful settle.
        // We check if the task has an acceptedAt timestamp that's recent.
        const stateRaw = await (await import('./redis.js')).redis.get(`a2a:state:${taskId.toLowerCase()}`);
        if (!stateRaw) continue;
        try {
          const state = JSON.parse(stateRaw);
          const acceptedAt = state.acceptedAt ? new Date(state.acceptedAt).getTime() : 0;
          const ageMs = Date.now() - acceptedAt;
          // Only revert if accepted within the last 5 minutes (settlement deadline is 120s,
          // so anything older likely settled or was handled differently)
          if (ageMs > 5 * 60_000) continue;

          console.warn(
            `[a2aExpirySweep] gas-liveness: reverting task ${taskId.slice(0, 10)}… ` +
              `(accepted ${Math.round(ageMs / 1000)}s ago by ${executorAddress?.slice(0, 10)}… — settlement deadline expired)`,
          );
          await a2aStore.releaseToOpen(taskId);
          reverted++;
        } catch {
          // Skip malformed state
        }
      }
    }

    if (reverted > 0) {
      console.log(`[a2aExpirySweep] gas-liveness: reverted ${reverted} task(s) with expired settlement deadlines`);
    }
  } catch (err) {
    console.error('[a2aExpirySweep] gas-liveness sweep failed (non-fatal):', (err as Error).message);
  } finally {
    gasLivenessInFlight = false;
  }
}
