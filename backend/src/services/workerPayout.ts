/**
 * Worker payout / dispute accounting, shared by the A2A routes
 * (/finalize, /verify, /verdict) and the escrow event listener
 * (DisputeResolved). Moved out of routes/a2a.ts so the listener can import it
 * without a routes↔services import cycle (routes/a2a.ts already imports
 * escrowEvents.ts).
 */

import * as agentStore from './agentStore.js';
import * as accountingService from './accountingService.js';
import * as reputationDecay from './reputationDecay.js';
import * as escrowService from './escrow.js';
import * as serviceStore from './serviceStore.js';
import { redis } from './redis.js';

// Cache the on-chain feeBps for the duration of the process. Fee changes are
// admin-gated and rare; one stale read per restart is fine. Falls back to 1000
// (10%) — the documented default in CLAUDE.md — if the RPC is unreachable.
let cachedFeeBps: number | null = null;
export async function getFeeBps(): Promise<number> {
  if (cachedFeeBps !== null) return cachedFeeBps;
  try {
    cachedFeeBps = await escrowService.feeBps();
  } catch (err) {
    console.warn('[a2a] feeBps RPC read failed, falling back to 1000:', (err as Error).message);
    cachedFeeBps = 1000;
  }
  return cachedFeeBps;
}

/**
 * Record a successful task completion on the executor's record: bump
 * tasksCompleted, reputation, and totalEarnedRaw TOGETHER by the worker's share
 * of the escrow (gross amount minus platform fee).
 *
 * The on-chain id and gross amount are resolved by the CALLER (which has already
 * confirmed the task is indexed + settled on-chain) and passed in — this
 * function never does its own getTaskIdByHash lookup. That closes the
 * "3 tasks · 0 0G" drift: previously tasksCompleted was bumped unconditionally
 * while totalEarnedRaw was only written if a SECOND, internal getTaskIdByHash
 * happened to resolve.
 *
 * IDEMPOTENT per task: a Redis NX marker (a2a:credited:<taskHash>) guarantees a
 * task credits its worker at most once, no matter how many paths observe the
 * settlement (a /finalize retry after a lost response, the /verdict route, the
 * DisputeResolved listener). Without it, settle-then-credit retries and the
 * event listener could each credit the same payout.
 *
 * Persists to Redis (agentStore) so the /agents endpoint can surface these
 * stats to the UI without re-deriving from on-chain history. If anything in
 * here fails we log + continue: the worker still gets paid on chain — only the
 * UI counter is at risk.
 */
export async function recordWorkerPayout(
  taskHash: string,
  executorAddr: string,
  onChainId: string,
  grossAmount: bigint,
  opts: { rethrow?: boolean; serviceId?: number } = {},
): Promise<void> {
  const creditedKey = `a2a:credited:${taskHash.toLowerCase()}`;
  try {
    // At-most-once gate. NX returns null when the key already exists — some
    // other path already credited this task; nothing to do. On any FAILURE
    // below the marker is released again (see catch / early return), so a
    // transient blip can't permanently burn the credit — the next observer
    // (finalize retry, /verdict, DisputeResolved listener) retries it.
    const first = await redis.set(creditedKey, executorAddr.toLowerCase(), 'NX');
    if (first === null) {
      console.log(`[a2a] payout for ${taskHash.slice(0, 10)}… already credited — skipping duplicate`);
      return;
    }

    const agent = await agentStore.getAgent(executorAddr);
    if (!agent) {
      // Executor not registered (yet) — release the marker so a later
      // observation can credit once the registration exists.
      await redis.del(creditedKey).catch(() => {});
      return;
    }

    const feeBps = await getFeeBps();
    const workerShare = (grossAmount * (10_000n - BigInt(feeBps))) / 10_000n;
    const platformFee = grossAmount - workerShare;

    // tasksCompleted, reputation, and totalEarnedRaw move as one unit — the task
    // counter is never advanced without crediting the matching earnings.
    agent.tasksCompleted += 1;
    agent.reputation = Math.min(100, agent.reputation + 1);
    const prev = BigInt(agent.totalEarnedRaw ?? '0');
    agent.totalEarnedRaw = (prev + workerShare).toString();
    await agentStore.registerAgent(agent);

    // rent-your-agent: bump the rented service's sold_count in the SAME
    // at-most-once block so a finalize retry can't double-count. Own try/catch —
    // a bump failure must never release the credit marker (which would re-credit).
    if (opts.serviceId !== undefined) {
      try {
        await serviceStore.incrementSoldCount(opts.serviceId);
      } catch (scErr) {
        console.warn(`[a2a] incrementSoldCount ${opts.serviceId} failed:`, (scErr as Error).message);
      }
    }

    // Mirror the payout into the accounting ledger so the Earnings page can
    // surface it. Native 0G has 18 decimals.
    try {
      // Ledger convention (must match submissions.ts /verify):
      //   amount = GROSS escrow (worker share + platform fee)
      //   fee    = platform fee
      //   net    = worker take-home = amount − fee = workerShare
      // Passing `net` explicitly avoids recordTransaction's default of
      // `amount − fee`, which — when amount was the already-net workerShare —
      // subtracted the fee a second time and zeroed out Net revenue.
      accountingService.recordTransaction({
        address: executorAddr.toLowerCase(),
        role: 'worker',
        taskId: onChainId,
        type: 'payment',
        amount: Number(grossAmount) / 1e18,
        fee: Number(platformFee) / 1e18,
        net: Number(workerShare) / 1e18,
        status: 'confirmed',
      });
    } catch (acctErr) {
      console.warn(`[a2a] accounting recordTransaction failed for ${taskHash.slice(0, 10)}…:`, (acctErr as Error).message);
    }

    // Off-chain decay-based reputation (Neon PostgreSQL)
    try {
      await reputationDecay.recordTaskCompletion(executorAddr, taskHash, 10);
    } catch (decayErr) {
      console.warn(`[a2a] recordWorkerPayout: reputationDecay.recordTaskCompletion failed for ${taskHash.slice(0, 10)}…:`, (decayErr as Error).message);
    }

    // On-chain reputation is updated by BlindEscrow internally when
    // completeVerification → BlindReputation.rate() fires.
  } catch (err) {
    console.error(`[a2a] recordWorkerPayout failed for ${taskHash.slice(0, 10)}… executor=${executorAddr}:`, (err as Error).message);
    // Release the at-most-once marker so the credit stays retryable — without
    // this a single agentStore blip would make the payout permanently
    // uncreditable from EVERY path while the marker blocks all retries.
    await redis.del(creditedKey).catch(() => {});
    // Callers with no re-observation path (the DisputeResolved listener) pass
    // rethrow:true so the failure aborts the tick BEFORE its checkpoint advances
    // and the event is re-processed — otherwise a transient blip means the worker
    // is paid on-chain but the earnings ledger is never written ("N tasks · 0 0G").
    // The /finalize + /verdict routes omit it: they're re-driven by client retries.
    if (opts.rethrow) throw err;
  }
}

/**
 * Record a dispute against an executor. Decrements the Redis reputation counter
 * and records the dispute in the Neon PostgreSQL reputation system. On-chain
 * dispute is also recorded by BlindEscrow when completeVerification →
 * BlindReputation.recordDispute() fires.
 * Non-blocking — logged on failure, caller continues.
 */
export async function recordWorkerDispute(taskHash: string, executorAddr: string, opts: { rethrow?: boolean } = {}): Promise<void> {
  try {
    const agent = await agentStore.getAgent(executorAddr);
    if (agent) {
      agent.reputation = Math.max(0, agent.reputation - 10);
      await agentStore.registerAgent(agent);
    }
    await reputationDecay.recordDispute(executorAddr, taskHash);
  } catch (err) {
    console.warn(
      `[a2a] recordWorkerDispute failed for ${taskHash.slice(0, 10)}… executor=${executorAddr}:`,
      (err as Error).message,
    );
    // Listener path (DisputeResolved) rethrows so its NX marker is released and
    // the tick retries; the routes swallow-and-continue as before.
    if (opts.rethrow) throw err;
  }
}
