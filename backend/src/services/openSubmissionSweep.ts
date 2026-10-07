/**
 * Timed alerts for open-submission tasks (docs/OPEN-SUBMISSION-TASKS.md).
 *
 * Once a task's submissions close, its poster is told how many agents
 * submitted and what happens next. A poster who picks the winner is reminded
 * an hour before their pick window ends. Both read the chain: the escrow's
 * phase and pause-adjusted deadline decide (a pause moves every window later,
 * also between the summary and the reminder), and the count is the escrow's
 * own, so a lagging indexer cannot under-report it.
 *
 * Tasks wait in the `due` set (openSubmissionStore), scored by when to look
 * next, so a tick touches only the tasks that are due. Stored times, not
 * timers: a restart loses nothing.
 */

import { config } from '../config.js';
import { backgroundWritesAllowed } from './deploymentIdentity.js';
import { escrowFor } from './escrow.js';
import { notifyOnce } from './notificationStore.js';
import * as store from './openSubmissionStore.js';
import type { OpenTaskRecord } from './openSubmissionStore.js';
import { agents } from './openSubmissionEvents.js';

/** The escrow's OpenPhase enum. */
export const PHASE = { Submissions: 0, CreatorPick: 1, VerifierPick: 2, BackupPick: 3, AdminResolve: 4, Closed: 5 } as const;

const SWEEP_INTERVAL_MS = 60_000;
/** Tasks looked at per tick; the rest wait for the next. */
const SWEEP_LIMIT = 50;
/** A task still taking submissions after its stored deadline (the escrow was paused): look again this much later. */
const RECHECK_SEC = 300;
/** Remind a picking poster this long before their window ends. */
export const PICK_REMINDER_SEC = 3600;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

/**
 * Time left, rounded DOWN: telling a poster they have longer than they do
 * could cost them their pick.
 */
export function timeLeftText(sec: number): string {
  const days = Math.floor(sec / 86_400);
  if (days >= 2) return `${days} days`;
  const hours = Math.floor(sec / 3600);
  if (hours >= 2) return `${hours} hours`;
  if (hours === 1) return 'an hour';
  const minutes = Math.max(1, Math.floor(sec / 60));
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}

/** Who picks next, for a phase after the poster's window. */
const NEXT_PICKER: Partial<Record<number, string>> = {
  [PHASE.VerifierPick]: "Your task's verifier is picking the winner now.",
  [PHASE.BackupPick]: "Your task's verifier did not pick, so the platform's backup judge is picking the winner now.",
  [PHASE.AdminResolve]: 'An admin will pick the winner.',
};

/**
 * The deadline summary. The copy follows the escrow's phase, not the task's
 * pick mode: a sweep that runs late may find the poster's window already gone.
 */
function closedNotice(rec: OpenTaskRecord, count: number, phase: number, pickLeftSec: number) {
  const taskId = rec.taskHash;
  if (count === 0) {
    return {
      type: 'expired' as const,
      title: 'No submissions came in',
      body: 'No agent submitted before the deadline. Its escrow is still yours: open the task to reclaim it.',
      taskId,
    };
  }
  if (phase === PHASE.CreatorPick) {
    return {
      type: 'submissions' as const,
      title: 'Submissions closed: pick a winner',
      body: `${agents(count)} submitted. Pick a winner within ${timeLeftText(pickLeftSec)}. After that, your task's verifier picks.`,
      taskId,
    };
  }
  return {
    type: 'submissions' as const,
    title: 'Submissions closed',
    body: `${agents(count)} submitted. ${NEXT_PICKER[phase] ?? NEXT_PICKER[PHASE.VerifierPick]}`,
    taskId,
  };
}

/** Seconds left in the poster's pick window, from the escrow's pause-adjusted deadline. */
async function pickTimeLeft(rec: OpenTaskRecord, nowSec: number): Promise<number> {
  return Number(await escrowFor(rec.chain).effectiveDeadline(rec.taskId)) + rec.creatorWindow - nowSec;
}

/** Look at one due task. True when an alert went out. Throws on a chain read failure: the task stays due. */
async function sweepOne(taskHash: string, nowSec: number): Promise<boolean> {
  const rec = await store.getRecord(taskHash);
  if (!rec || (await store.getOutcome(taskHash))) {
    await store.unscheduleSweep(taskHash);
    return false;
  }
  const escrow = escrowFor(rec.chain);
  const phase = Number(await escrow.openPhase(rec.taskId));
  if (phase === PHASE.Submissions) {
    await store.scheduleSweep(taskHash, nowSec + RECHECK_SEC);
    return false;
  }
  if (phase === PHASE.Closed) {
    // Cancelled before anyone submitted, or settled before the indexer saw it.
    await store.unscheduleSweep(taskHash);
    return false;
  }

  if (!(await store.isClosedNotified(taskHash))) {
    const count = Number(await escrow.submissionCount(rec.taskId));
    const pickLeft = phase === PHASE.CreatorPick ? await pickTimeLeft(rec, nowSec) : 0;
    await notifyOnce(`open:closed:${taskHash}`, rec.poster, closedNotice(rec, count, phase, pickLeft));
    await store.markClosedNotified(taskHash);
    // Remind before the window ends, unless the summary already said it ends within two hours.
    if (phase === PHASE.CreatorPick && count > 0 && pickLeft > 2 * PICK_REMINDER_SEC) {
      await store.scheduleSweep(taskHash, nowSec + pickLeft - PICK_REMINDER_SEC);
    } else {
      await store.unscheduleSweep(taskHash);
    }
    return true;
  }

  // The pick reminder. Only while the poster can still pick.
  if (phase !== PHASE.CreatorPick) {
    await store.unscheduleSweep(taskHash);
    return false;
  }
  const pickLeft = await pickTimeLeft(rec, nowSec);
  // A pause since the summary moved the window later: wait for its new last hour.
  if (pickLeft > PICK_REMINDER_SEC + RECHECK_SEC) {
    await store.scheduleSweep(taskHash, nowSec + pickLeft - PICK_REMINDER_SEC);
    return false;
  }
  await store.unscheduleSweep(taskHash);
  return notifyOnce(`open:pick-soon:${taskHash}`, rec.poster, {
    type: 'deadline_soon',
    title: 'Pick a winner soon',
    body: `Your pick window closes in ${timeLeftText(pickLeft)}. After that, your task's verifier picks the winner.`,
    taskId: taskHash,
  });
}

/** One pass over the due tasks. Returns how many alerts went out. */
export async function sweepOpenSubmissions(nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
  if (!config.openSubmissionEnabled) return 0;
  if (!backgroundWritesAllowed('open-submission sweep')) return 0;
  if (inFlight) return 0;
  inFlight = true;
  let sent = 0;
  try {
    for (const taskHash of await store.dueForSweep(nowSec, SWEEP_LIMIT)) {
      try {
        if (await sweepOne(taskHash, nowSec)) sent++;
      } catch (err) {
        console.warn(`[openSubmissionSweep] ${taskHash.slice(0, 10)}… not checked this tick:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.error('[openSubmissionSweep] sweep failed (non-fatal):', (err as Error).message);
  } finally {
    inFlight = false;
  }
  return sent;
}

export function startOpenSubmissionSweepLoop(): void {
  if (timer) return;
  timer = setInterval(() => void sweepOpenSubmissions(), SWEEP_INTERVAL_MS);
  console.log(`[openSubmissionSweep] checking open-submission tasks every ${SWEEP_INTERVAL_MS / 1000}s`);
}

export function stopOpenSubmissionSweepLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
