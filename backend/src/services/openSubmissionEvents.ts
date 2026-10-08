/**
 * Open-submission events from the escrow (docs/OPEN-SUBMISSION-TASKS.md),
 * turned into the off-chain record and the alerts for the poster and the
 * submitters. Called by the chain indexer (arcEscrowEvents), which delivers
 * each event at least once: every write and every alert here is idempotent.
 *
 * Alerts, in the app and on Telegram (notify() forwards them):
 *   - the poster: the first submission at once, then how many have submitted
 *     at most once every COUNT_NOTICE_GAP_SEC. One alert per submission would
 *     mean fifty on a popular task. The deadline summary comes from the sweep
 *     (openSubmissionSweep.ts), with the count read from the chain;
 *   - when a winner is paid: the poster, the winner, and every other
 *     submitter; when the task is voided by a judge: the poster and the
 *     submitters.
 * Every text is generic: counts and fixed copy, never a result or an agent
 * address, because Telegram is outside the platform's access control.
 */

import { ethers, type EventLog } from 'ethers';
import { closeOpenSubmissionTask, getMeta } from './a2aStore.js';
import { loadAgentBySmartAccount } from './deployedAgentStore.js';
import { escrowFor } from './escrow.js';
import { notify, notifyOnce, notifyOnceMany, type OnceNotice } from './notificationStore.js';
import { agents } from './openSubmissionCopy.js';
import * as store from './openSubmissionStore.js';
import { taskRef, type OpenJudge, type OpenTaskRecord, type TaskRef } from './openSubmissionStore.js';
import { isListedTask, type TaskChain } from './taskChain.js';
import { recordWorkerPayout } from './workerPayout.js';
import type { A2ATaskMeta } from '../types.js';

/** The least time between two "how many so far" alerts for one task. */
export const COUNT_NOTICE_GAP_SEC = 3600;

/** The escrow's Judge enum; 0 (None) never closes a task. */
const JUDGES: Record<number, OpenJudge> = { 1: 'creator', 2: 'task_verifier', 3: 'backup', 4: 'admin' };

/** The four events, for one log query that covers them all. */
export const OPEN_EVENTS = ['OpenTaskCreated', 'OpenSubmission', 'WinnerSelected', 'OpenTaskVoided'] as const;


/**
 * The task's record, read from the chain and saved the first time this
 * backend meets the task: its OpenTaskCreated may predate the event scan.
 * A task met for the first time is scheduled for the sweep at its deadline,
 * before its record is saved: until the record exists the task counts as
 * unmet, so a failure part-way is redone in full when the event is retried.
 * null for a task that does not take open submissions.
 */
async function ensureRecord(chain: TaskChain, taskId: bigint): Promise<{ ref: TaskRef; rec: OpenTaskRecord } | null> {
  const ref = taskRef(chain, taskId);
  const known = await store.getRecord(ref);
  if (known) return { ref, rec: known };
  const escrow = escrowFor(chain);
  const [task, open] = await Promise.all([escrow.getTask(taskId), escrow.getOpenTask(taskId)]);
  if (!open.open) return null;
  if (!(await store.getOutcome(ref)) && !(await store.isClosedNotified(ref))) {
    await store.scheduleSweep(ref, Number(task.deadline));
  }
  const rec = await store.saveRecord({
    chain,
    taskId: taskId.toString(),
    taskHash: String(task.taskHash),
    poster: String(task.agent),
    deadline: Number(task.deadline),
    mode: Number(open.mode) === 1 ? 'creator' : 'agent',
    creatorWindow: Number(open.creatorWindow),
  });
  return { ref, rec };
}

/**
 * The task's listing, when the task has one and it is this task; else null.
 * The escrow does not make hashes unique: a decoy task with the same hash
 * must never close the real listing or take its credit (security review of
 * #142), so the listing's own hash→task mapping, written when its verified
 * poster listed it, decides (isListedTask, as the dispute listener asks).
 */
async function listingOf(rec: OpenTaskRecord): Promise<A2ATaskMeta | null> {
  const meta = await getMeta(rec.taskHash);
  if (!meta || meta.submissionMode !== 'open') return null;
  return (await isListedTask(rec.chain, rec.taskId, rec.taskHash, rec.poster, meta.posterAddress)) ? meta : null;
}

/**
 * An on-chain address's executor: agents that submit through a smart account
 * (Base) are credited as its owner. A failed lookup fails the event (it is
 * retried), as in the dispute listener: crediting the raw account would find
 * no executor and lose the credit for good.
 */
async function executorFor(onChain: string): Promise<string> {
  const owner = await loadAgentBySmartAccount(onChain);
  return owner?.walletAddress || onChain;
}

export async function handleOpenTaskCreated(chain: TaskChain, taskId: bigint): Promise<void> {
  // Nothing more on creation: the record and the sweep are all it needs.
  await ensureRecord(chain, taskId);
}

export async function handleOpenSubmission(
  chain: TaskChain,
  taskId: bigint,
  submitter: string,
  evidenceHash: string,
  count: bigint,
  txHash?: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<void> {
  const found = await ensureRecord(chain, taskId);
  if (!found) return;
  const { ref, rec } = found;
  const hash = rec.taskHash;
  const isNew = await store.recordSubmission(ref, submitter, {
    evidenceHash,
    ordinal: Number(count),
    ...(txHash ? { txHash } : {}),
    recordedAt: new Date(nowSec * 1000).toISOString(),
  });
  // Keep the result the submitter sent, if its hash is the one on-chain.
  // Before the alert: an alert failing must not lose the result.
  await store.keepResult(ref, submitter, evidenceHash);
  // A redelivered event: its alert, if any, went out the first time. Sending
  // again would repeat a stale count, or take the count slot from a real one.
  if (!isNew) return;

  // The deadline summary reports the final count: no running count after it,
  // or once it is due (the indexer can run behind the chain).
  if (nowSec >= rec.deadline || (await store.isClosedNotified(ref))) return;
  const n = Number(count);
  if (n === 1) {
    await store.takeCountNoticeSlot(ref, COUNT_NOTICE_GAP_SEC);
    await notifyOnce(`open:first:${ref}`, rec.poster, {
      type: 'submissions',
      title: 'First submission on your task',
      body: 'An agent submitted a result. Submissions stay open until the deadline.',
      taskId: hash,
    });
  } else if (await store.takeCountNoticeSlot(ref, COUNT_NOTICE_GAP_SEC)) {
    await notify(rec.poster, {
      type: 'submissions',
      title: 'New submissions on your task',
      body: `${agents(n)} have submitted so far. Submissions stay open until the deadline.`,
      taskId: hash,
    });
  }
}

/** How many submitted: the chain's count, or this backend's if the chain cannot be read. */
async function submissionTotal(ref: TaskRef, rec: OpenTaskRecord): Promise<number> {
  try {
    return Number(await escrowFor(rec.chain).submissionCount(rec.taskId));
  } catch {
    return store.recordedSubmissionCount(ref);
  }
}

/** One alert to every recorded submitter but `except`, a page at a time. */
async function tellSubmitters(
  ref: TaskRef,
  key: string,
  except: string | null,
  input: OnceNotice['input'],
): Promise<void> {
  await store.forEachSubmitter(ref, async (addresses) => {
    const notices = addresses
      .filter((a) => a !== except)
      .map((to) => ({ dedupeKey: `${key}:${ref}:${to}`, to, input }));
    await notifyOnceMany(notices);
  });
}

/**
 * The judge's scorecard, kept when the escrow anchored its hash. Only the
 * poster and the task verifier pick through POST /select, which holds one; a
 * backup judge's or admin's scorecard can still be sent afterwards (POST
 * /tasks/:id/scorecard), checked against the hash recorded here.
 */
async function keepJudgeScorecard(ref: TaskRef, judge: OpenJudge, scorecardHash: string): Promise<void> {
  if (!scorecardHash || /^0x0*$/.test(scorecardHash)) return;
  if (judge !== 'creator' && judge !== 'task_verifier') return;
  await store.keepScorecard(ref, judge, scorecardHash);
}

const WINNER_PICKED_BY: Record<OpenJudge, string> = {
  creator: 'You picked a winner',
  task_verifier: "Your task's verifier picked a winner",
  backup: "Your task's verifier did not pick in time, so the platform's backup judge picked a winner",
  admin: 'An admin picked a winner',
};

export async function handleWinnerSelected(chain: TaskChain, taskId: bigint, winner: string, judgeIndex: number, scorecardHash: string = ethers.ZeroHash): Promise<void> {
  const found = await ensureRecord(chain, taskId);
  if (!found) return;
  const { ref, rec } = found;
  const hash = rec.taskHash;
  const judge = JUDGES[judgeIndex] ?? 'admin';
  const winnerAddr = winner.toLowerCase();
  await store.saveOutcome(ref, { kind: 'winner', winner: winnerAddr, judge, scorecardHash: scorecardHash.toLowerCase() });
  await keepJudgeScorecard(ref, judge, scorecardHash);
  await store.unscheduleSweep(ref);
  const listing = await listingOf(rec);
  if (listing) {
    // The listing's state: 'completed', with the winner as its executor.
    await closeOpenSubmissionTask(hash, { kind: 'winner', winner: winnerAddr });
    // The winner's earnings, credited exactly as a passed single-assignee
    // task credits its worker: once per task (recordWorkerPayout's own claim),
    // the escrow's amount less the fee it charged. rethrow: a failed credit
    // fails the event, so the scan retries it; everything else here is
    // idempotent.
    const t = await escrowFor(chain).getTask(taskId);
    // The record and the escrow must name the same task: a record left from
    // another network would credit an unrelated task under its hash.
    if (String(t.taskHash).toLowerCase() === hash) {
      await recordWorkerPayout(hash, await executorFor(winnerAddr), rec.taskId, BigInt(t.amount), { chain, token: String(t.token) }, {
        rethrow: true,
        meta: listing,
      });
    } else {
      console.error(`[open-submission] not crediting task ${ref}: its record's hash is not the escrow's`);
    }
  }
  const total = await submissionTotal(ref, rec);
  await notifyOnce(`open:picked:${ref}`, rec.poster, {
    type: 'completed',
    title: 'Winner picked — escrow released',
    body: `${WINNER_PICKED_BY[judge]} from ${total} submission${total === 1 ? '' : 's'}. The payout was sent to them.`,
    taskId: hash,
  });
  await notifyOnce(`open:won:${ref}`, winnerAddr, {
    type: 'completed',
    title: 'Your submission won',
    body: `Your result was picked from ${total} submission${total === 1 ? '' : 's'}. The payout was sent to your wallet.`,
    taskId: hash,
  });
  await tellSubmitters(ref, 'open:lost', winnerAddr, {
    type: 'failed',
    title: 'Another submission was picked',
    body: `Your result for this task was not picked. ${agents(total)} submitted.`,
    taskId: hash,
  });
}

export async function handleOpenTaskVoided(chain: TaskChain, taskId: bigint, judgeIndex: number, scorecardHash: string = ethers.ZeroHash): Promise<void> {
  const found = await ensureRecord(chain, taskId);
  if (!found) return;
  const { ref, rec } = found;
  const hash = rec.taskHash;
  const judge = JUDGES[judgeIndex] ?? 'admin';
  await store.saveOutcome(ref, { kind: 'void', judge, scorecardHash: scorecardHash.toLowerCase() });
  await keepJudgeScorecard(ref, judge, scorecardHash);
  await store.unscheduleSweep(ref);
  if (await listingOf(rec)) await closeOpenSubmissionTask(hash, { kind: 'void' });
  // The poster voids only a task nobody submitted to, and needs no alert for
  // their own refund.
  if (judge === 'creator') return;
  await notifyOnce(`open:voided:${ref}`, rec.poster, {
    type: 'completed',
    title: 'Task closed with no winner — escrow refunded',
    body: 'No submission was picked, so the full escrow went back to you.',
    taskId: hash,
  });
  await tellSubmitters(ref, 'open:void', null, {
    type: 'failed',
    title: 'No submission was picked',
    body: 'The task closed without a winner and its escrow went back to the poster.',
    taskId: hash,
  });
}

/** Route one decoded escrow log to its handler. Other events are ignored. */
export async function handleOpenEvent(chain: TaskChain, ev: EventLog): Promise<void> {
  const a = ev.args;
  if (!a) return;
  switch (ev.eventName) {
    case 'OpenTaskCreated':
      return handleOpenTaskCreated(chain, a.taskId as bigint);
    case 'OpenSubmission':
      return handleOpenSubmission(chain, a.taskId as bigint, String(a.submitter), String(a.evidenceHash), a.count as bigint, ev.transactionHash);
    case 'WinnerSelected':
      return handleWinnerSelected(chain, a.taskId as bigint, String(a.winner), Number(a.judge), String(a.scorecardHash));
    case 'OpenTaskVoided':
      return handleOpenTaskVoided(chain, a.taskId as bigint, Number(a.judge), String(a.scorecardHash));
  }
}
