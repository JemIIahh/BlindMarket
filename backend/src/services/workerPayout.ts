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
import * as skillStatsStore from './skillStatsStore.js';
import * as badgeStore from './badgeStore.js';
import * as a2aStore from './a2aStore.js';
import * as semanticMatch from './semanticMatch.js';
import * as semanticProof from './semanticProof.js';
import { redis } from './redis.js';

// Earned-badge threshold: N settled completions per (agent, capability) with a
// failure ratio under the cap. 5 real paid escrow settlements can't be faked
// by one lucky task but stays reachable during bootstrap; the ratio guard
// blocks dispute-heavy grinders.
const EARNED_BADGE_MIN_COMPLETED = 5;
const EARNED_BADGE_MAX_FAILURE_RATIO = 0.2;

// Cached fee basis points. Read from 0G escrow at startup; Base escrow
// should mirror the same value (admin sets both via set-fee.ts). Falls back
// to 1000 (10%) if the RPC is unreachable.
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
  opts: {
    rethrow?: boolean;
    serviceId?: number;
    computeCostMicroUnits?: number;
    /** Token decimals: 6 for USDC (Base), 18 for native 0G. */
    decimals?: number;
    meta?: import('../types.js').A2ATaskMeta;
  } = {},
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
    const decimals = opts.decimals ?? 18;
    const decimalsDivisor = 10 ** decimals;

    // Convert micro-units (1e-6 USDC) to chain units.
    // USDC (6 decimals): 1 micro-unit = 1e-6, so no conversion needed.
    // Native 0G (18 decimals): 1 micro-unit = 1e-12 chain units.
    const computeCostChain = decimals === 6
      ? BigInt(Math.floor(opts.computeCostMicroUnits ?? 0))
      : BigInt(Math.floor((opts.computeCostMicroUnits ?? 0) * 1e12));
    const afterComputeCost = grossAmount > computeCostChain ? grossAmount - computeCostChain : 0n;

    const workerShare = (afterComputeCost * (10_000n - BigInt(feeBps))) / 10_000n;
    const platformFee = afterComputeCost - workerShare;

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
        amount: Number(grossAmount) / decimalsDivisor,
        fee: Number(platformFee) / decimalsDivisor,
        net: Number(workerShare) / decimalsDivisor,
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

    // Per-skill proof: credit the task's declared capability tags AND (proof
    // re-key, semantic era) the worker's closest installed skill slug — a
    // semantically routed task often carries no tags at all, and without the
    // slug credit its settlement would build no track record. Fire-and-forget
    // like recordShadowOutcome below: slug resolution fans out to the
    // embedding provider (bounded by its 10s fetch timeout) and must never
    // hold up the settlement HTTP response — the money already moved. The NX
    // marker is unaffected: stats failures were always swallowed without
    // releasing it, detached or not, so a finalize retry still can't
    // double-credit.
    void (async () => {
      try {
        const meta = opts.meta ?? (await a2aStore.getMeta(taskHash).catch(() => undefined));
        const caps: string[] = meta?.requiredCapabilities ?? [];
        const slug = meta ? await semanticProof.resolveProofSkillSlug(executorAddr, meta) : null;
        const keys = semanticProof.mergeProofKeys(caps, slug);
        if (keys.length > 0) {
          const stats = await skillStatsStore.recordCompletion(executorAddr, keys);
          for (const s of stats) {
            const attempts = s.tasks_completed + s.tasks_failed;
            const failureRatio = attempts > 0 ? s.tasks_failed / attempts : 0;
            if (s.tasks_completed >= EARNED_BADGE_MIN_COMPLETED && failureRatio < EARNED_BADGE_MAX_FAILURE_RATIO) {
              const granted = await badgeStore.grantEarnedBadge(executorAddr, s.capability);
              if (granted) {
                console.log(`[a2a] earned badge granted: ${executorAddr.slice(0, 10)}… × ${s.capability} (${s.tasks_completed} settled completions)`);
              }
            }
          }
        }
      } catch (statsErr) {
        console.warn(`[a2a] skill-stats credit failed for ${taskHash.slice(0, 10)}…:`, (statsErr as Error).message);
      }
    })();

    // Shadow measurement (semantic matching Phase 1): task settled. Best-effort.
    void semanticMatch.recordShadowOutcome(taskHash, { settled: true });

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
    // Per-skill proof: a dispute counts against the task's capability tags
    // AND the same resolved skill slug the success path would have credited
    // (mergeProofKeys is the shared definition) — otherwise a skill's failure
    // ratio only ever sees its wins and the earned-badge guard goes blind.
    // Fire-and-forget for the same reason as the success path: the embedding
    // fan-out must not delay the dispute response or the DisputeResolved
    // listener's tick.
    void (async () => {
      try {
        const meta = await a2aStore.getMeta(taskHash);
        const caps: string[] = meta?.requiredCapabilities ?? [];
        const slug = meta ? await semanticProof.resolveProofSkillSlug(executorAddr, meta) : null;
        await skillStatsStore.recordFailure(executorAddr, semanticProof.mergeProofKeys(caps, slug));
      } catch (statsErr) {
        console.warn(`[a2a] skill-stats failure record failed for ${taskHash.slice(0, 10)}…:`, (statsErr as Error).message);
      }
    })();
    // Shadow measurement: task failed/disputed. Best-effort.
    void semanticMatch.recordShadowOutcome(taskHash, { settled: false });
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
