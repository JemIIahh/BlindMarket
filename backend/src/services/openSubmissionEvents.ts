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

import type { EventLog } from 'ethers';
import { escrowFor } from './escrow.js';
import { notify, notifyOnce, notifyOnceMany, type OnceNotice } from './notificationStore.js';
import * as store from './openSubmissionStore.js';
import type { OpenJudge, OpenTaskRecord } from './openSubmissionStore.js';
import type { TaskChain } from './taskChain.js';

/** The least time between two "how many so far" alerts for one task. */
export const COUNT_NOTICE_GAP_SEC = 3600;

/** The escrow's Judge enum; 0 (None) never closes a task. */
const JUDGES: Record<number, OpenJudge> = { 1: 'creator', 2: 'task_verifier', 3: 'backup', 4: 'admin' };

/** The four events, for one log query that covers them all. */
export const OPEN_EVENTS = ['OpenTaskCreated', 'OpenSubmission', 'WinnerSelected', 'OpenTaskVoided'] as const;

export const agents = (n: number) => (n === 1 ? '1 agent' : `${n} agents`);

/**
 * The task's record, read from the chain and saved the first time this
 * backend meets the task: its OpenTaskCreated may predate the event scan.
 * A task met for the first time is scheduled for the sweep at its deadline.
 * The id index is written last: until it exists the task counts as unmet, so
 * a failure part-way is redone in full when the event is retried.
 * null for a task that does not take open submissions.
 */
async function ensureRecord(chain: TaskChain, taskId: bigint): Promise<OpenTaskRecord | null> {
  const id = taskId.toString();
  const known = await store.getRecordById(chain, id);
  if (known) return known;
  const escrow = escrowFor(chain);
  const [task, open] = await Promise.all([escrow.getTask(taskId), escrow.getOpenTask(taskId)]);
  if (!open.open) return null;
  const rec = await store.saveRecord({
    chain,
    taskId: id,
    taskHash: String(task.taskHash),
    poster: String(task.agent),
    deadline: Number(task.deadline),
    mode: Number(open.mode) === 1 ? 'creator' : 'agent',
    creatorWindow: Number(open.creatorWindow),
  });
  if (!(await store.getOutcome(rec.taskHash)) && !(await store.isClosedNotified(rec.taskHash))) {
    await store.scheduleSweep(rec.taskHash, rec.deadline);
  }
  await store.indexRecordId(chain, id, rec.taskHash);
  return rec;
}

export async function handleOpenTaskCreated(chain: TaskChain, taskId: bigint): Promise<void> {
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
  const rec = await ensureRecord(chain, taskId);
  if (!rec) return;
  const hash = rec.taskHash;
  const isNew = await store.recordSubmission(hash, submitter, {
    evidenceHash,
    ordinal: Number(count),
    ...(txHash ? { txHash } : {}),
    recordedAt: new Date(nowSec * 1000).toISOString(),
  });
  // A redelivered event: its alert, if any, went out the first time. Sending
  // again would repeat a stale count, or take the count slot from a real one.
  if (!isNew) return;

  // The deadline summary reports the final count: no running count after it,
  // or once it is due (the indexer can run behind the chain).
  if (nowSec >= rec.deadline || (await store.isClosedNotified(hash))) return;
  const n = Number(count);
  if (n === 1) {
    await store.takeCountNoticeSlot(hash, COUNT_NOTICE_GAP_SEC);
    await notifyOnce(`open:first:${hash}`, rec.poster, {
      type: 'submissions',
      title: 'First submission on your task',
      body: 'An agent submitted a result. Submissions stay open until the deadline.',
      taskId: hash,
    });
  } else if (await store.takeCountNoticeSlot(hash, COUNT_NOTICE_GAP_SEC)) {
    await notify(rec.poster, {
      type: 'submissions',
      title: 'New submissions on your task',
      body: `${agents(n)} have submitted so far. Submissions stay open until the deadline.`,
      taskId: hash,
    });
  }
}

/** How many submitted: the chain's count, or this backend's if the chain cannot be read. */
async function submissionTotal(rec: OpenTaskRecord): Promise<number> {
  try {
    return Number(await escrowFor(rec.chain).submissionCount(rec.taskId));
  } catch {
    return store.recordedSubmissionCount(rec.taskHash);
  }
}

/** One alert to every recorded submitter but `except`, a page at a time. */
async function tellSubmitters(
  rec: OpenTaskRecord,
  key: string,
  except: string | null,
  input: OnceNotice['input'],
): Promise<void> {
  await store.forEachSubmitter(rec.taskHash, async (addresses) => {
    const notices = addresses
      .filter((a) => a !== except)
      .map((to) => ({ dedupeKey: `${key}:${rec.taskHash}:${to}`, to, input }));
    await notifyOnceMany(notices);
  });
}

const WINNER_PICKED_BY: Record<OpenJudge, string> = {
  creator: 'You picked a winner',
  task_verifier: "Your task's verifier picked a winner",
  backup: "Your task's verifier did not pick in time, so the platform's backup judge picked a winner",
  admin: 'An admin picked a winner',
};

export async function handleWinnerSelected(chain: TaskChain, taskId: bigint, winner: string, judgeIndex: number): Promise<void> {
  const rec = await ensureRecord(chain, taskId);
  if (!rec) return;
  const hash = rec.taskHash;
  const judge = JUDGES[judgeIndex] ?? 'admin';
  const winnerAddr = winner.toLowerCase();
  await store.saveOutcome(hash, { kind: 'winner', winner: winnerAddr, judge });
  await store.unscheduleSweep(hash);
  const total = await submissionTotal(rec);
  await notifyOnce(`open:picked:${hash}`, rec.poster, {
    type: 'completed',
    title: 'Winner picked — escrow released',
    body: `${WINNER_PICKED_BY[judge]} from ${total} submission${total === 1 ? '' : 's'}. The payout was sent to them.`,
    taskId: hash,
  });
  await notifyOnce(`open:won:${hash}`, winnerAddr, {
    type: 'completed',
    title: 'Your submission won',
    body: `Your result was picked from ${total} submission${total === 1 ? '' : 's'}. The payout was sent to your wallet.`,
    taskId: hash,
  });
  await tellSubmitters(rec, 'open:lost', winnerAddr, {
    type: 'failed',
    title: 'Another submission was picked',
    body: `Your result for this task was not picked. ${agents(total)} submitted.`,
    taskId: hash,
  });
}

export async function handleOpenTaskVoided(chain: TaskChain, taskId: bigint, judgeIndex: number): Promise<void> {
  const rec = await ensureRecord(chain, taskId);
  if (!rec) return;
  const hash = rec.taskHash;
  const judge = JUDGES[judgeIndex] ?? 'admin';
  await store.saveOutcome(hash, { kind: 'void', judge });
  await store.unscheduleSweep(hash);
  // The poster voids only a task nobody submitted to, and needs no alert for
  // their own refund.
  if (judge === 'creator') return;
  await notifyOnce(`open:voided:${hash}`, rec.poster, {
    type: 'completed',
    title: 'Task closed with no winner — escrow refunded',
    body: 'No submission was picked, so the full escrow went back to you.',
    taskId: hash,
  });
  await tellSubmitters(rec, 'open:void', null, {
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
      return handleWinnerSelected(chain, a.taskId as bigint, String(a.winner), Number(a.judge));
    case 'OpenTaskVoided':
      return handleOpenTaskVoided(chain, a.taskId as bigint, Number(a.judge));
  }
}
