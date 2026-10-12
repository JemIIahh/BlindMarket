/**
 * The platform's turns judging open-submission tasks
 * (docs/OPEN-SUBMISSION-TASKS.md).
 *
 * After an open task's deadline the escrow lets its judges pick in turn: the
 * poster (CreatorReview only), the task verifier, the global verifier as
 * backup judge, then the admin. The platform's verifier signer takes two of
 * those turns:
 *   - the task verifier's, on a task that named the platform as its judge
 *     (GET /a2a/open-submission `defaultJudge`), so a public task needs no
 *     judge agent of its own;
 *   - the backup judge's, on every open task, so a task whose judges stayed
 *     silent is settled rather than left for the admin.
 *
 * The rule is the task's own checks: its verificationCriteria, through
 * autoVerify, which also fails empty output, worker errors and refusals.
 * Every submission that passes is valid; the highest score wins, and the
 * earliest submission on a tie. With none valid, the task verifier lets its
 * turn pass and the backup judge refunds the poster (voidOpenTask).
 *
 * A judge agent's decline (POST /judge-decline) is not followed. A poster may
 * name their own agent as judge; following its decline would let a poster
 * read every result and pay nothing, which the escrow's void rule exists to
 * prevent.
 *
 * Each pick or void anchors a scorecard (the submissions judged, their
 * scores, the rule), held before the transaction so the indexer keeps it
 * once the escrow records its hash.
 */

import { ethers } from 'ethers';
import { config } from '../config.js';
import type { VerificationCriteria } from '../types.js';
import { verifierSignerFor } from './verifierSigner.js';
import { autoVerify } from './autoVerify.js';
import { backgroundWritesAllowed } from './deploymentIdentity.js';
import { escrowFor } from './escrow.js';
import { listingOf } from './openSubmissionEvents.js';
import { OPEN_PICK_WINDOWS } from './openPickWindows.js';
import * as store from './openSubmissionStore.js';
import type { OpenResult, OpenTaskRecord, ScorecardRole, TaskRef } from './openSubmissionStore.js';
import { PHASE } from './openSubmissionSweep.js';

const JUDGE_INTERVAL_MS = 60_000;
/** Tasks looked at per tick; the rest wait for the next. */
const JUDGE_LIMIT = 20;
/** Look again this much later: a failed send, an indexer behind the chain, a task not yet saved. */
export const RECHECK_SEC = 300;
/** Look this long after a window opens, so the chain's clock has passed it too. */
export const SLACK_SEC = 30;
/**
 * Fewer submissions recorded than the escrow counts means the indexer is
 * behind: wait for it, unless the window has less than this left.
 */
export const LAG_GRACE_SEC = 3600;
/** Submissions judged per task, earliest first; later ones are not considered. */
export const MAX_JUDGED = 500;
/** Submissions judged between two yields to the event loop. */
const JUDGE_BATCH = 25;
/** Scorecard entries kept, best first: the scorecard is stored and served. */
const MAX_SCORECARD_ENTRIES = 100;

export const JUDGE_RULE = "Highest auto-check score among the submissions that pass the task's checks; the earliest submission wins a tie";

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export interface JudgedEntry {
  submitter: string;
  ordinal: number;
  passed: boolean;
  score: number;
  /** Why a submission failed: autoVerify's first reason, or no kept result. */
  reason?: string;
}

/** Judge each submission against the task's checks. A submission whose result was never kept cannot pass. */
export function judgeSubmissions(
  subs: ReadonlyArray<{ submitter: string; ordinal: number; result: OpenResult | null }>,
  criteria: VerificationCriteria,
): JudgedEntry[] {
  return subs.map(({ submitter, ordinal, result }) => {
    if (!result) return { submitter, ordinal, passed: false, score: 0, reason: 'No result was kept for this submission' };
    try {
      const v = autoVerify(result.resultData, criteria);
      return { submitter, ordinal, passed: v.passed, score: v.score, ...(v.passed ? {} : { reason: v.reasons[0] ?? 'Failed the checks' }) };
    } catch (err) {
      return { submitter, ordinal, passed: false, score: 0, reason: `Could not be checked: ${(err as Error).message}` };
    }
  });
}

/** The valid submission with the highest score, the earliest on a tie; null when none passed. */
export function pickWinner(judged: readonly JudgedEntry[]): JudgedEntry | null {
  let best: JudgedEntry | null = null;
  for (const e of judged) {
    if (!e.passed) continue;
    if (!best || e.score > best.score || (e.score === best.score && e.ordinal < best.ordinal)) best = e;
  }
  return best;
}

function scorecardOf(judged: readonly JudgedEntry[], winner: JudgedEntry | null, role: ScorecardRole, totalOnChain: number): Record<string, unknown> {
  const ranked = [...judged].sort((a, b) => Number(b.passed) - Number(a.passed) || b.score - a.score || a.ordinal - b.ordinal);
  return {
    judge: 'platform',
    role,
    rule: JUDGE_RULE,
    decision: winner ? { winner: winner.submitter, score: winner.score } : { void: true, reason: 'No submission passed the checks' },
    submissions: totalOnChain,
    judged: judged.length,
    valid: judged.filter((e) => e.passed).length,
    entries: ranked.slice(0, MAX_SCORECARD_ENTRIES),
  };
}

/** The task's recorded submissions, earliest first, at most MAX_JUDGED. */
async function submissionsOf(ref: TaskRef): Promise<Array<{ submitter: string; ordinal: number }>> {
  const all: Array<{ submitter: string; ordinal: number }> = [];
  let cursor = '0';
  do {
    const page = await store.pageSubmissions(ref, cursor, 500);
    cursor = page.cursor;
    for (const s of page.submissions) all.push({ submitter: s.submitter.toLowerCase(), ordinal: s.ordinal });
  } while (cursor !== '0');
  return all.sort((a, b) => a.ordinal - b.ordinal).slice(0, MAX_JUDGED);
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

  // Every window follows the escrow's pause-adjusted deadline.
  const verifierStart = Number(await escrow.effectiveDeadline(rec.taskId)) + rec.creatorWindow;
  const backupStart = verifierStart + OPEN_PICK_WINDOWS.verifierSec;
  const backupEnd = backupStart + OPEN_PICK_WINDOWS.backupSec;
  const isTaskJudge = String(await escrow.taskVerifier(rec.taskId)).toLowerCase() === signer.address;

  const asBackup = phase === PHASE.BackupPick;
  if (!asBackup && !(phase === PHASE.VerifierPick && isTaskJudge)) {
    // Not the platform's turn yet: its first is the task verifier's window when it is the task's judge.
    const turnStart = isTaskJudge ? verifierStart : backupStart;
    await store.scheduleJudge(ref, Math.max(turnStart, nowSec) + SLACK_SEC);
    return null;
  }

  const count = Number(await escrow.submissionCount(rec.taskId));
  if (count === 0) {
    // Nothing to judge: only the poster can close a task nobody submitted to.
    await store.unscheduleJudge(ref);
    return null;
  }
  const windowEnd = asBackup ? backupEnd : backupStart;
  if ((await store.recordedSubmissionCount(ref)) < count && windowEnd - nowSec > LAG_GRACE_SEC) {
    await store.scheduleJudge(ref, nowSec + RECHECK_SEC);
    return null;
  }

  // A task this server never listed (created on the escrow directly) has no
  // result here to judge: refunding it would ignore work sent elsewhere. Its
  // poster's and the admin's turns remain.
  const listing = await listingOf(rec);
  if (!listing) {
    await store.unscheduleJudge(ref);
    return null;
  }
  const criteria: VerificationCriteria = listing.verificationCriteria ?? {};
  const subs = await submissionsOf(ref);
  const results = await store.getResults(ref, subs.map((s) => s.submitter));
  const judged: JudgedEntry[] = [];
  for (let i = 0; i < subs.length; i += JUDGE_BATCH) {
    // Judging runs on the API process: let requests through between batches.
    if (i > 0) await new Promise((resolve) => setImmediate(resolve));
    const batch = subs.slice(i, i + JUDGE_BATCH).map((s, j) => ({ ...s, result: results[i + j] ?? null }));
    judged.push(...judgeSubmissions(batch, criteria));
  }
  const winner = pickWinner(judged);

  if (!winner && !asBackup) {
    // Nothing to pay as the task verifier: the turn passes, and as backup judge the platform refunds.
    await store.scheduleJudge(ref, backupStart + SLACK_SEC);
    return null;
  }

  const role: ScorecardRole = asBackup ? 'backup' : 'task_verifier';
  const scorecardHash = await store.savePendingScorecard(ref, role, scorecardOf(judged, winner, role, count));
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
      `${judged.filter((e) => e.passed).length}/${judged.length} valid, tx ${tx.hash}`,
  );
  return winner ? 'picked' : 'voided';
}

/** One pass over the due tasks. Returns how many tasks the platform settled. */
export async function judgeOpenSubmissions(nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
  if (!config.openSubmissionEnabled) return 0;
  if (!backgroundWritesAllowed('open-submission judge')) return 0;
  if (inFlight) return 0;
  inFlight = true;
  let settled = 0;
  try {
    for (const ref of await store.dueForJudge(nowSec, JUDGE_LIMIT)) {
      try {
        if (await judgeOne(ref, nowSec)) settled++;
      } catch (err) {
        console.warn(`[openSubmissionJudge] task ${ref} not judged this tick:`, (err as Error).message);
        await store.scheduleJudge(ref, nowSec + RECHECK_SEC).catch(() => {});
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
 * Schedule every saved open task that has no outcome, for tasks created
 * before the judge ran: the indexer schedules only the tasks it meets first.
 * Idempotent; an existing schedule is left as it is.
 */
export async function scheduleExistingOpenTasks(): Promise<number> {
  let scheduled = 0;
  await store.forEachRecordRef(async (refs) => {
    for (const ref of refs) {
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
