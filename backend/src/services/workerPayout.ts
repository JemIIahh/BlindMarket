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
import { payoutCurrency } from './settlementUnits.js';
import { isCredited } from './creditLedger.js';
import { chainScope } from './chainScope.js';
import type { TaskChain } from './taskChain.js';

// Earned-badge threshold: N settled completions per (agent, capability) with a
// failure ratio under the cap. 5 real paid escrow settlements can't be faked
// by one lucky task but stays reachable during bootstrap; the ratio guard
// blocks dispute-heavy grinders.
const EARNED_BADGE_MIN_COMPLETED = 5;
const EARNED_BADGE_MAX_FAILURE_RATIO = 0.2;

// Fee basis points per chain, read once per process from THAT chain's
// escrow: each escrow has its own feeBps (set-fee.ts sets them one at a
// time), and the split credited here must be the split the escrow paid.
// Reading the 0G escrow for a Base payout mis-credited every USDC task the
// moment the two fees differed. Falls back to 1000 (10%) if the RPC is
// unreachable, and says which chain.
const cachedFeeBps = new Map<TaskChain, number>();
export async function getFeeBps(chain: TaskChain): Promise<number> {
  const cached = cachedFeeBps.get(chain);
  if (cached !== undefined) return cached;
  let bps: number;
  try {
    bps = await escrowService.feeBpsOn(chain);
  } catch (err) {
    console.warn(`[a2a] feeBps RPC read on ${chain} failed, falling back to 1000:`, (err as Error).message);
    bps = 1000;
  }
  cachedFeeBps.set(chain, bps);
  return bps;
}

/**
 * Record a successful task completion on the executor's record: bump
 * tasksCompleted, reputation, and the earnings total for the task's currency
 * TOGETHER by the worker's share of the escrow (gross amount minus platform
 * fee). Native 0G and USDC have separate totals; `settlement` (the task's
 * chain and escrow token) picks one, via payoutCurrency.
 *
 * The on-chain id, gross amount and token are resolved by the CALLER (which
 * has already confirmed the task is indexed + settled on-chain) and passed in
 * — this function never does its own getTaskIdByHash lookup. That closes the
 * "3 tasks · 0 0G" drift: previously tasksCompleted was bumped unconditionally
 * while totalEarnedRaw was only written if a SECOND, internal getTaskIdByHash
 * happened to resolve.
 *
 * IDEMPOTENT per task: the task's credited_payouts row, claimed in the same
 * transaction as the credit (agentStore.creditPayoutOnce), guarantees a task
 * credits its worker at most once, no matter how many paths observe the
 * settlement (a /finalize retry after a lost response, the /verdict route, the
 * DisputeResolved listener, /submissions/confirm). A Redis NX marker
 * (a2a:credited:<taskHash>) in front of it skips the database for the common
 * repeat.
 *
 * A task escrowed in a token BlindMarket doesn't settle in (or in a unit no
 * earnings total holds) is not credited at all: it is logged, parked under
 * a2a:uncredited:<taskHash> (listed in the set a2a:uncredited:all) for a
 * backfill, and left unmarked so a build that knows the token can still
 * credit it. That returns normally even with `rethrow`, because retrying
 * cannot help, and callers have already recorded the settlement.
 *
 * Persists to the agent store so the /agents endpoint can surface these
 * stats to the UI without re-deriving from on-chain history. If anything in
 * here fails we log + continue: the worker still gets paid on chain — only the
 * UI counter is at risk.
 */
export async function recordWorkerPayout(
  taskHash: string,
  executorAddr: string,
  onChainId: string,
  grossAmount: bigint,
  settlement: { chain: TaskChain; token: string },
  opts: {
    rethrow?: boolean;
    serviceId?: number;
    computeCostMicroUnits?: number;
    meta?: import('../types.js').A2ATaskMeta;
  } = {},
): Promise<void> {
  const creditedKey = `a2a:credited:${taskHash.toLowerCase()}`;
  const unit = payoutCurrency(settlement.chain, settlement.token);
  if (!unit || !agentStore.hasEarningsTotal(unit)) {
    const parked = {
      chain: settlement.chain, token: settlement.token, taskHash, onChainId,
      executor: executorAddr.toLowerCase(), grossAmount: grossAmount.toString(),
    };
    console.error(`[payout] UNCREDITED_TOKEN ${JSON.stringify(parked)}`);
    try {
      await redis.set(`a2a:uncredited:${taskHash.toLowerCase()}`, JSON.stringify(parked));
      await redis.sadd('a2a:uncredited:all', taskHash.toLowerCase());
    } catch (e) {
      console.error(`[payout] could not park ${taskHash.slice(0, 10)}…:`, (e as Error).message);
    }
    return;
  }
  // Whether THIS call wrote the marker: true when its SET NX took it, null
  // when the SET failed and the marker's state is unknown. The catch undoes
  // only what this call did (security audit run 1, C34).
  let markerSet: boolean | null = false;
  try {
    // Fast path. NX returns null when the key already exists — some other
    // path already credited this task; nothing to do. The marker is only a
    // cache in front of the credited_payouts row, which is the authority, so
    // a SET that errors (a dropped connection, OOM) falls through to the
    // database claim instead of failing the credit.
    let first: string | null;
    try {
      first = await redis.set(creditedKey, executorAddr.toLowerCase(), 'NX');
      markerSet = first !== null;
    } catch (markerErr) {
      console.warn(`[a2a] credited marker unavailable for ${taskHash.slice(0, 10)}…, using the database claim:`, (markerErr as Error).message);
      first = 'unknown';
      markerSet = null;
    }
    if (first === null) {
      console.log(`[a2a] payout for ${taskHash.slice(0, 10)}… already credited — skipping duplicate`);
      return;
    }

    const feeBps = await getFeeBps(settlement.chain);
    const decimalsDivisor = 10 ** unit.decimals;

    // Convert micro-units (1e-6 USDC) to chain units.
    // USDC (6 decimals): 1 micro-unit = 1e-6, so no conversion needed.
    // Native 0G (18 decimals): 1 micro-unit = 1e-12 chain units.
    const computeCostChain = unit.decimals === 6
      ? BigInt(Math.floor(opts.computeCostMicroUnits ?? 0))
      : BigInt(Math.floor((opts.computeCostMicroUnits ?? 0) * 1e12));
    const afterComputeCost = grossAmount > computeCostChain ? grossAmount - computeCostChain : 0n;

    const workerShare = (afterComputeCost * (10_000n - BigInt(feeBps))) / 10_000n;
    const platformFee = afterComputeCost - workerShare;

    // tasksCompleted, reputation, and the earnings total move as one unit —
    // the task counter is never advanced without crediting the matching
    // earnings — and in the same transaction as the task's credited_payouts
    // row, the durable gate: a Redis snapshot restore deletes the markers
    // written since the snapshot while the credits stay; this row does not.
    const outcome = await agentStore.creditPayoutOnce(
      { taskHash, chain: settlement.chain }, executorAddr, unit, workerShare,
    );
    if (outcome === 'duplicate') {
      console.log(`[a2a] payout for ${taskHash.slice(0, 10)}… already credited (database) — skipping duplicate`);
      return;
    }
    if (outcome === 'unregistered') {
      // Executor not registered (yet). Rolled back, so no row stands behind
      // the marker: drop it so a later observation can credit once the
      // registration exists.
      console.warn(`[a2a] payout for ${taskHash.slice(0, 10)}… not credited: executor ${executorAddr} is not registered`);
      if (markerSet !== false) await redis.del(creditedKey).catch(() => {});
      return;
    }

    // rent-your-agent: bump the rented service's sold_count in the SAME
    // at-most-once block so a finalize retry can't double-count. Own try/catch —
    // a bump failure must not reach the catch below as a failed credit.
    if (opts.serviceId !== undefined) {
      try {
        await serviceStore.incrementSoldCount(opts.serviceId);
      } catch (scErr) {
        console.warn(`[a2a] incrementSoldCount ${opts.serviceId} failed:`, (scErr as Error).message);
      }
    }

    // Mirror the payout into the accounting ledger so the Earnings page can
    // surface it, in whole units of the task's currency.
    try {
      // Ledger convention (must match submissions.ts /verify):
      //   amount = GROSS escrow (worker share + platform fee)
      //   fee    = platform fee
      //   net    = worker take-home = amount − fee = workerShare
      // Passing `net` explicitly avoids recordTransaction's default of
      // `amount − fee`, which — when amount was the already-net workerShare —
      // subtracted the fee a second time and zeroed out Net revenue.
      // Awaited so a failed write lands in the catch below instead of becoming
      // an unhandled rejection, which ends the process on Node 22.
      await accountingService.recordTransaction({
        address: executorAddr.toLowerCase(),
        role: 'worker',
        taskId: onChainId,
        type: 'payment',
        amount: Number(grossAmount) / decimalsDivisor,
        fee: Number(platformFee) / decimalsDivisor,
        net: Number(workerShare) / decimalsDivisor,
        unit: unit.symbol,
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
    // The claim and the credit are one transaction, so a failure left no row
    // of this call's to give back, and a row an earlier credit wrote is never
    // deleted. Releasing both gates unconditionally here is what let a
    // re-observation of an already-credited task that hit a Redis or database
    // fault delete the earlier credit's gates, so the next observation
    // credited it again (security audit run 1, C34). Only the marker can need
    // undoing, so a blip doesn't leave it blocking every retry: drop it when
    // this call set it; when the SET failed and its state is unknown, drop it
    // only if no credit row stands behind it (keep it if that check fails).
    if (markerSet === true || (markerSet === null && !(await isCredited(taskHash).catch(() => true)))) {
      await redis.del(creditedKey).catch(() => {});
    }
    // Callers with no re-observation path (the DisputeResolved listener) pass
    // rethrow:true so the failure aborts the tick BEFORE its checkpoint advances
    // and the event is re-processed — otherwise a transient blip means the worker
    // is paid on-chain but the earnings ledger is never written ("N tasks · 0 0G").
    // The /finalize + /verdict routes omit it: they're re-driven by client retries.
    if (opts.rethrow) throw err;
  }
}

/**
 * The failed round a dispute is for: the on-chain task and its
 * submissionAttempts at settlement (completeVerification(false) leaves the
 * count unchanged and a retry's submitEvidence bumps it, so it names exactly
 * one round), or 'ruling' for an admin DisputeResolved ruling.
 */
export interface FailedRound {
  chain: TaskChain;
  taskId: string;
  attempt: number | 'ruling';
}

/**
 * Record a dispute against an executor. Decrements the Redis reputation counter
 * and records the dispute in the Neon PostgreSQL reputation system. On-chain
 * dispute is also recorded by BlindEscrow when completeVerification →
 * BlindReputation.recordDispute() fires.
 *
 * At most once per failed round, however many observers see it: returns true
 * when this call recorded the dispute, false when the round was already
 * recorded (or recording failed without rethrow).
 * Non-blocking — logged on failure, caller continues.
 */
export async function recordWorkerDispute(
  taskHash: string,
  executorAddr: string,
  round: FailedRound,
  opts: { rethrow?: boolean } = {},
): Promise<boolean> {
  // The failed-path twin of the credit gate. /finalize, /verify, /verdict and
  // /submissions/confirm each recorded the round they observed, so replaying a
  // round's settlement tx to /submissions/confirm docked the executor a second
  // time for one on-chain failure (security audit run 1, C21). Keyed on the
  // round, not the task hash: rounds 2 and 3 are disputes of their own. And
  // on the chain's network (chainScope), since escrow ids restart at 1 on a
  // new escrow: another network's round for the same id is not this one.
  const roundKey = `a2a:dispute-round:${chainScope(round.chain)}:${round.taskId}:${round.attempt}`;
  let claimed = false;
  try {
    if ((await redis.set(roundKey, executorAddr.toLowerCase(), 'NX')) === null) {
      console.log(`[a2a] dispute for ${taskHash.slice(0, 10)}… round ${round.attempt} already recorded — skipping duplicate`);
      return false;
    }
    claimed = true;
    await agentStore.adjustReputation(executorAddr, -10);
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
    return true;
  } catch (err) {
    // Give the round back so a later observer can record it, but only if
    // this call took it.
    if (claimed) await redis.del(roundKey).catch(() => {});
    console.warn(
      `[a2a] recordWorkerDispute failed for ${taskHash.slice(0, 10)}… executor=${executorAddr}:`,
      (err as Error).message,
    );
    // Listener path (DisputeResolved) rethrows so its NX marker is released and
    // the tick retries; the routes swallow-and-continue as before.
    if (opts.rethrow) throw err;
    return false;
  }
}
