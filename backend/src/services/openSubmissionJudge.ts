/**
 * The platform's turns judging open-submission tasks
 * (docs/OPEN-SUBMISSION-TASKS.md section 22).
 *
 * After an open task's deadline the escrow lets its judges pick in turn: the
 * poster (CreatorReview), the task verifier, the global verifier as backup
 * judge, then the admin. The platform's verifier signer takes two of those
 * turns:
 *   - the task verifier's, on a task that named the platform as its verifier
 *     (GET /a2a/open-submission `defaultJudge`). POST /tasks takes such a task
 *     only with the poster picking first: this rule is a fallback for a poster
 *     who did not pick, not a judge of quality;
 *   - the backup judge's, on every open task this server listed, so a task
 *     whose judges stayed silent is settled rather than left for the admin.
 *
 * The rule, the same in both turns:
 *   1. Only real work counts: a kept result past deliverableFloor (not empty,
 *      not a worker's error, not a refusal, past the content floor the task's
 *      format allows). The poster's checks cannot fail real work here: if
 *      they could, a poster could set an answer nobody matches, read every
 *      result and be refunded, which the escrow's void rule exists to stop.
 *   2. Of the real submissions, one that passes the task's own checks
 *      (autoVerify) beats one that does not; then the higher score; then the
 *      more substantive (distinct words, capped), so a one-line answer does
 *      not beat real work by being first; then the earliest.
 *   3. No real submission: as task verifier the platform lets its turn pass;
 *      as backup judge it refunds the poster (voidOpenTask), but only when
 *      every submission on-chain was recorded, has its result, and was judged.
 *      Otherwise the task is left for the admin.
 *
 * A judge agent's decline (POST /judge-decline) is not followed: a poster may
 * name their own agent as judge, and following its decline would let them
 * read every result and pay nothing.
 *
 * Each pick or void anchors a scorecard, held before the transaction so the
 * indexer keeps it once the escrow records its hash.
 */

import { ethers } from 'ethers';
import { config } from '../config.js';
import type { VerificationCriteria } from '../types.js';
import { autoVerify, deliverableFloor } from './autoVerify.js';
import { chainScope } from './chainScope.js';
import { backgroundWritesAllowed } from './deploymentIdentity.js';
import { escrowFor } from './escrow.js';
import { listingOf } from './openSubmissionEvents.js';
import { OPEN_PICK_WINDOWS } from './openPickWindows.js';
import * as store from './openSubmissionStore.js';
import type { OpenResult, OpenTaskRecord, ScorecardRole, TaskRef } from './openSubmissionStore.js';
import { PHASE } from './openSubmissionSweep.js';
import { SETTLEMENT_CHAIN_KEYS } from './settlementChains.js';
import { verifierSignerFor } from './verifierSigner.js';

const JUDGE_INTERVAL_MS = 60_000;
/** Tasks looked at per network per tick; the rest wait for the next. */
const JUDGE_LIMIT = 20;
/** Look again this much later: a failed send, an indexer behind the chain, a task not yet saved. */
export const RECHECK_SEC = 300;
/** Look again this much later while results are missing in the backup window: a submitter may re-send. */
export const MISSING_RECHECK_SEC = 3600;
/** Look this long after a window opens, so the chain's clock has passed it too. */
export const SLACK_SEC = 30;
/**
 * Fewer submissions recorded than the escrow counts means the indexer is
 * behind: wait for it, unless the window has less than this left.
 */
export const LAG_GRACE_SEC = 3600;
/** Submissions with a result judged per task, earliest first. */
export const MAX_JUDGED = 2000;
/** Submissions judged between two yields to the event loop. */
const JUDGE_BATCH = 25;
/** Distinct words counted toward substance; more add nothing. */
export const SUBSTANCE_CAP = 500;
/** Scorecard entries kept, best first: the scorecard is stored and served. */
const MAX_SCORECARD_ENTRIES = 100;

export const JUDGE_RULE =
  "Of the submissions that are real work, the platform pays one that passes the task's checks before one that does not, " +
  'then the higher score, then the more substantive, then the earliest. With no real work it refunds the poster.';

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export interface JudgedEntry {
  submitter: string;
  ordinal: number;
  /** Real work at all (deliverableFloor): what decides between paying and refunding. */
  real: boolean;
  /** Passed the task's own checks (autoVerify). */
  passed: boolean;
  score: number;
  /** Distinct words in the result, capped at SUBSTANCE_CAP. */
  substance: number;
  /** Why it is not real work, or why it failed the task's checks. */
  reason?: string;
}

function substanceOf(resultData: Record<string, unknown>): number {
  const output = typeof resultData.output === 'string' ? resultData.output : JSON.stringify(resultData);
  return Math.min(SUBSTANCE_CAP, new Set(output.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).size);
}

/** Judge each submission: is it real work, and does it pass the task's checks. */
export function judgeSubmissions(
  subs: ReadonlyArray<{ submitter: string; ordinal: number; result: OpenResult }>,
  criteria: VerificationCriteria,
): JudgedEntry[] {
  return subs.map(({ submitter, ordinal, result }) => {
    try {
      const floor = deliverableFloor(result.resultData, criteria);
      if (floor) return { submitter, ordinal, real: false, passed: false, score: 0, substance: 0, reason: floor };
      const v = autoVerify(result.resultData, criteria);
      return {
        submitter,
        ordinal,
        real: true,
        passed: v.passed,
        score: v.score,
        substance: substanceOf(result.resultData),
        ...(v.passed ? {} : { reason: v.reasons[0] ?? "Failed the task's checks" }),
      };
    } catch (err) {
      return { submitter, ordinal, real: false, passed: false, score: 0, substance: 0, reason: `Could not be checked: ${(err as Error).message}` };
    }
  });
}

/** Best first: passed the checks, then score, then substance, then the earliest. */
function better(a: JudgedEntry, b: JudgedEntry): number {
  return Number(b.passed) - Number(a.passed) || b.score - a.score || b.substance - a.substance || a.ordinal - b.ordinal;
}

/** The submission to pay, or null when none is real work. */
export function pickWinner(judged: readonly JudgedEntry[]): JudgedEntry | null {
  let best: JudgedEntry | null = null;
  for (const e of judged) if (e.real && (!best || better(e, best) < 0)) best = e;
  return best;
}

function scorecardOf(
  judged: readonly JudgedEntry[],
  winner: JudgedEntry | null,
  role: ScorecardRole,
  counts: { submissions: number; recorded: number; withResult: number },
): Record<string, unknown> {
  return {
    judge: 'platform',
    role,
    rule: JUDGE_RULE,
    decision: winner ? { winner: winner.submitter, score: winner.score } : { void: true, reason: 'No submission was real work' },
    ...counts,
    judged: judged.length,
    real: judged.filter((e) => e.real).length,
    passed: judged.filter((e) => e.passed).length,
    entries: [...judged].sort((a, b) => Number(b.real) - Number(a.real) || better(a, b)).slice(0, MAX_SCORECARD_ENTRIES),
  };
}

/** The task's recorded submissions, earliest first. */
async function submissionsOf(ref: TaskRef): Promise<Array<{ submitter: string; ordinal: number }>> {
  const all: Array<{ submitter: string; ordinal: number }> = [];
  let cursor = '0';
  do {
    const page = await store.pageSubmissions(ref, cursor, 500);
    cursor = page.cursor;
    for (const s of page.submissions) all.push({ submitter: s.submitter.toLowerCase(), ordinal: s.ordinal });
  } while (cursor !== '0');
  return all.sort((a, b) => a.ordinal - b.ordinal);
}

export type JudgeAction = 'picked' | 'voided' | null;

/**
 * Look at one due task: wait for the platform's turn, or take it. Throws on a
 * chain read or a failed send; the caller looks again later.
 */
async function judgeOne(ref: TaskRef, nowSec: number): Promise<JudgeAction> {
  const rec: OpenTaskRecord | null = await store.getRecord(ref);
  if (!rec) {
    // The indexer schedules a task just before saving its record.
    await store.scheduleJudge(ref, nowSec + RECHECK_SEC);
    return null;
  }
  if ((await store.getOutcome(ref)) || !store.onThisNetwork(rec)) {
    await store.unscheduleJudge(ref);
    return null;
  }
  const signer = await verifierSignerFor(rec.chain);
  if (!signer) {
    await store.scheduleJudge(ref, nowSec + RECHECK_SEC);
    return null;
  }
  const escrow = escrowFor(rec.chain);
  const phase = Number(await escrow.openPhase(rec.taskId));
  // Closed: settled or cancelled. AdminResolve: the platform's turns are over.
  if (phase === PHASE.Closed || phase === PHASE.AdminResolve) {
    await store.unscheduleJudge(ref);
    return null;
  }
  // The id must still name the task the record was saved for, as the indexer
  // checks before crediting: a record from before refs were network-scoped
  // would otherwise be judged against whatever task now has its id.
  if (String((await escrow.getTask(rec.taskId)).taskHash).toLowerCase() !== rec.taskHash) {
    console.error(`[openSubmissionJudge] task ${ref}: the escrow's task hash is not the record's; not judging it`);
    await store.unscheduleJudge(ref);
    return null;
  }

  // Every window follows the escrow's pause-adjusted deadline.
  const verifierStart = Number(await escrow.effectiveDeadline(rec.taskId)) + rec.creatorWindow;
  const backupStart = verifierStart + OPEN_PICK_WINDOWS.verifierSec;
  const backupEnd = backupStart + OPEN_PICK_WINDOWS.backupSec;
  const isTaskJudge = String(await escrow.taskVerifier(rec.taskId)).toLowerCase() === signer.address;

  const asBackup = phase === PHASE.BackupPick;
  if (!asBackup && !(phase === PHASE.VerifierPick && isTaskJudge)) {
    // Not the platform's turn yet: its first is the task verifier's window when it is the task's judge.
    await store.scheduleJudge(ref, Math.max(isTaskJudge ? verifierStart : backupStart, nowSec) + SLACK_SEC);
    return null;
  }
  if (asBackup && String(await escrow.verifier()).toLowerCase() !== signer.address) {
    console.error(`[openSubmissionJudge] task ${ref}: this server's signer is not the escrow's verifier, so it cannot judge as backup`);
    await store.scheduleJudge(ref, nowSec + MISSING_RECHECK_SEC);
    return null;
  }

  const count = Number(await escrow.submissionCount(rec.taskId));
  if (count === 0) {
    // Nothing to judge: only the poster can close a task nobody submitted to.
    await store.unscheduleJudge(ref);
    return null;
  }
  // A task this server never listed (created on the escrow directly) has no
  // result here to judge. Its poster's and the admin's turns remain.
  const listing = await listingOf(rec);
  if (!listing) {
    await store.unscheduleJudge(ref);
    return null;
  }
  const windowEnd = asBackup ? backupEnd : backupStart;
  const recorded = await store.recordedSubmissionCount(ref);
  if (recorded < count && windowEnd - nowSec > LAG_GRACE_SEC) {
    await store.scheduleJudge(ref, nowSec + RECHECK_SEC);
    return null;
  }

  const criteria: VerificationCriteria = listing.verificationCriteria ?? {};
  const subs = await submissionsOf(ref);
  const results = await store.getResults(ref, subs.map((s) => s.submitter));
  // Only submissions with a result can be judged; ones without do not crowd them out.
  const withResult = subs.flatMap((s, i) => (results[i] ? [{ ...s, result: results[i]! }] : []));
  const toJudge = withResult.slice(0, MAX_JUDGED);
  const judged: JudgedEntry[] = [];
  for (let i = 0; i < toJudge.length; i += JUDGE_BATCH) {
    // Judging runs on the API process: let requests through between batches.
    if (i > 0) await new Promise((resolve) => setImmediate(resolve));
    judged.push(...judgeSubmissions(toJudge.slice(i, i + JUDGE_BATCH), criteria));
  }
  const winner = pickWinner(judged);

  if (!winner) {
    if (!asBackup) {
      // Nothing to pay as the task verifier: the turn passes to the backup judge.
      await store.scheduleJudge(ref, backupStart + SLACK_SEC);
      return null;
    }
    // A refund needs every submission seen, with its result, and judged.
    const unseen = count - toJudge.length;
    if (unseen > 0) {
      if (windowEnd - nowSec > MISSING_RECHECK_SEC) {
        await store.scheduleJudge(ref, nowSec + MISSING_RECHECK_SEC);
      } else {
        console.error(`[openSubmissionJudge] task ${ref}: no real work in ${toJudge.length} judged, ${unseen} submission(s) not seen or not judged; left for the admin`);
        await store.unscheduleJudge(ref);
      }
      return null;
    }
  }

  const role: ScorecardRole = asBackup ? 'backup' : 'task_verifier';
  const scorecardHash = await store.savePendingScorecard(
    ref,
    role,
    scorecardOf(judged, winner, role, { submissions: count, recorded, withResult: withResult.length }),
  );
  const taskId = BigInt(rec.taskId);
  const tx = (await signer.enqueue(() =>
    winner
      ? asBackup
        ? signer.escrow.selectWinnerByBackup(taskId, winner.submitter, scorecardHash)
        : signer.escrow.selectWinnerByVerifier(taskId, winner.submitter, scorecardHash)
      : signer.escrow.voidOpenTask(taskId, scorecardHash),
  )) as ethers.ContractTransactionResponse;
  const receipt = await tx.wait(1, 60_000);
  if (receipt?.status !== 1) throw new Error(`judge tx ${tx.hash} reverted`);
  await store.unscheduleJudge(ref);
  console.log(
    `[openSubmissionJudge] ${winner ? `picked ${winner.submitter} (score ${winner.score})` : 'voided'} on task ${ref} as ${role}, ` +
      `${judged.filter((e) => e.real).length}/${judged.length} real, tx ${tx.hash}`,
  );
  return winner ? 'picked' : 'voided';
}

/** This backend's networks: the scope of each settlement chain. */
function ownScopes(): string[] {
  return [...new Set(SETTLEMENT_CHAIN_KEYS.map((chain) => chainScope(chain)))];
}

/** One pass over the due tasks. Returns how many tasks the platform settled. */
export async function judgeOpenSubmissions(nowSec = Math.floor(Date.now() / 1000), scopes: readonly string[] = ownScopes()): Promise<number> {
  if (!config.openSubmissionEnabled) return 0;
  if (!backgroundWritesAllowed('open-submission judge')) return 0;
  if (inFlight) return 0;
  inFlight = true;
  let settled = 0;
  try {
    for (const scope of scopes) {
      for (const ref of await store.dueForJudge(scope, nowSec, JUDGE_LIMIT)) {
        try {
          if (await judgeOne(ref, nowSec)) settled++;
        } catch (err) {
          console.warn(`[openSubmissionJudge] task ${ref} not judged this tick:`, (err as Error).message);
          await store.scheduleJudge(ref, nowSec + RECHECK_SEC).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('[openSubmissionJudge] pass failed (non-fatal):', (err as Error).message);
  } finally {
    inFlight = false;
  }
  return settled;
}

/**
 * Schedule each network's saved open tasks that have no outcome, once per
 * network: the indexer schedules only the tasks it meets first, so this
 * covers the ones created before the judge ran. Returns how many it scheduled.
 */
export async function scheduleExistingOpenTasks(scopes: readonly string[] = ownScopes()): Promise<number> {
  const pending = new Set<string>();
  for (const scope of scopes) if (await store.markJudgeBackfilled(scope)) pending.add(scope);
  if (pending.size === 0) return 0;
  let scheduled = 0;
  await store.forEachRecordRef(async (refs) => {
    for (const ref of refs) {
      if (!pending.has(store.scopeOfRef(ref))) continue;
      const rec = await store.getRecord(ref);
      if (!rec || !store.onThisNetwork(rec) || (await store.getOutcome(ref))) continue;
      await store.scheduleJudgeIfAbsent(ref, rec.deadline);
      scheduled++;
    }
  });
  return scheduled;
}

export function startOpenSubmissionJudgeLoop(): void {
  if (timer) return;
  void scheduleExistingOpenTasks()
    .then((n) => console.log(`[openSubmissionJudge] ${n} existing open task(s) scheduled`))
    .catch((err) => console.error('[openSubmissionJudge] scheduling existing tasks failed:', (err as Error).message));
  timer = setInterval(() => void judgeOpenSubmissions(), JUDGE_INTERVAL_MS);
  console.log(`[openSubmissionJudge] judging open-submission tasks every ${JUDGE_INTERVAL_MS / 1000}s`);
}

export function stopOpenSubmissionJudgeLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
