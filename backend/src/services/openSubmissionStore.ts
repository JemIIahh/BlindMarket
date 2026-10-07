/**
 * Open-submission tasks (docs/OPEN-SUBMISSION-TASKS.md), off-chain: what the
 * escrow's events say about each one. Kept apart from the single-assignee A2A
 * state (a2aStore), so nothing in the accept, cascade or expiry flows ever
 * sees an open task.
 *
 * Keyed by the ON-CHAIN task (`<chain>:<taskId>`, a TaskRef), never by the
 * task hash: the escrow does not make hashes unique, so anyone can post a
 * decoy task with a live task's hash. Keyed by hash, the decoy's events would
 * land on the real task's record (security review of #142). The hash rides
 * along in the record, for links.
 *
 * Keys:
 *   a2a:open:task:<ref>          JSON OpenTaskRecord, written once
 *   a2a:open:subs:<ref>          hash: submitter → JSON SubmissionRecord
 *   a2a:open:outcome:<ref>       JSON OpenTaskOutcome, once a winner is paid or the task voided
 *   a2a:open:closed:<ref>        set once the poster was told submissions closed
 *   a2a:open:count-gate:<ref>    set for COUNT_NOTICE_GAP_SEC after a count notice
 *   a2a:open:pending:<ref>:<a>   JSON OpenResult a submitter sent to submit-open, for
 *                                PENDING_RESULT_TTL_SEC: kept only if it lands on-chain
 *   a2a:open:results:<ref>       hash: submitter → JSON OpenResult whose evidence hash
 *                                the escrow recorded; kept RESULTS_TTL_SEC
 *   a2a:open:due                 zset: ref → unix seconds the sweep next looks at it
 *
 * Writers:
 * - The indexer writes the record, submissions, outcome and kept results, from
 *   events. A result is kept only when its submitter's on-chain submission
 *   carries its evidence hash, so nothing is kept for an agent that never
 *   paid gas to submit, and a kept result can't be replaced.
 * - The sweep writes `closed`.
 * - POST submit-open writes a submitter's own pending result.
 * - Both the indexer and the sweep write `due`.
 *
 * Every write is a whole-value SET, HSETNX or ZADD/ZREM, never a
 * read-modify-write, so no process loses another's write. The one race is
 * benign: the sweep can reschedule a task the indexer just settled, and the
 * next look drops it on its recorded outcome.
 */

import { redis } from './redis.js';
import type { TaskChain } from './taskChain.js';

/** An on-chain task: `<chain>:<taskId>`. */
export type TaskRef = string;

export function taskRef(chain: TaskChain, taskId: string | number | bigint): TaskRef {
  return `${chain}:${String(taskId)}`;
}

/** Who picks first, as the escrow's PickMode: 0 the task verifier, 1 the poster. */
export type PickMode = 'agent' | 'creator';

export interface OpenTaskRecord {
  chain: TaskChain;
  /** On-chain task id. */
  taskId: string;
  /** The hash the task was created with. Not unique: links only, never a key. */
  taskHash: string;
  poster: string;
  /** The deadline createTaskOpen set (unix seconds). A pause moves the real one later. */
  deadline: number;
  mode: PickMode;
  /** Seconds the poster has to pick after the deadline; 0 for agent mode. */
  creatorWindow: number;
}

export interface SubmissionRecord {
  evidenceHash: string;
  /** Its place in the order of submissions, from the event. */
  ordinal: number;
  txHash?: string;
  /** When this backend recorded it (ISO). */
  recordedAt: string;
}

/** Who closed the task, as the escrow's Judge enum. */
export type OpenJudge = 'creator' | 'task_verifier' | 'backup' | 'admin';

export interface OpenTaskOutcome {
  kind: 'winner' | 'void';
  winner?: string;
  judge: OpenJudge;
}

/**
 * A submitter's result as they sent it to submit-open. The escrow holds its
 * evidence hash (keccak256 of the JSON resultData).
 */
export interface OpenResult {
  resultData: Record<string, unknown>;
  evidenceHash: string;
  /** The full result in storage, as single-assignee tasks send it. */
  rootHash?: string | null;
  teeAttestation?: unknown;
  savedAt: string;
}

/** How long a sent result waits for its on-chain submission. */
export const PENDING_RESULT_TTL_SEC = 3600;
/** How long kept results last: well past every pick window. */
export const RESULTS_TTL_SEC = 90 * 86_400;

const KEY = {
  record: (ref: TaskRef) => `a2a:open:task:${ref}`,
  subs: (ref: TaskRef) => `a2a:open:subs:${ref}`,
  outcome: (ref: TaskRef) => `a2a:open:outcome:${ref}`,
  closed: (ref: TaskRef) => `a2a:open:closed:${ref}`,
  countGate: (ref: TaskRef) => `a2a:open:count-gate:${ref}`,
  pending: (ref: TaskRef, submitter: string) => `a2a:open:pending:${ref}:${submitter.toLowerCase()}`,
  results: (ref: TaskRef) => `a2a:open:results:${ref}`,
  due: 'a2a:open:due',
};

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── The task ────────────────────────────────────────────────────────────────

/** Save a task's record unless one exists. Returns the record now stored. */
export async function saveRecord(rec: OpenTaskRecord): Promise<OpenTaskRecord> {
  const stored: OpenTaskRecord = { ...rec, taskHash: rec.taskHash.toLowerCase(), poster: rec.poster.toLowerCase() };
  const ref = taskRef(rec.chain, rec.taskId);
  if ((await redis.set(KEY.record(ref), JSON.stringify(stored), 'NX')) !== null) return stored;
  return (await getRecord(ref)) ?? stored;
}

export async function getRecord(ref: TaskRef): Promise<OpenTaskRecord | null> {
  return parse<OpenTaskRecord>(await redis.get(KEY.record(ref)));
}

export async function saveOutcome(ref: TaskRef, outcome: OpenTaskOutcome): Promise<boolean> {
  return (await redis.set(KEY.outcome(ref), JSON.stringify(outcome), 'NX')) !== null;
}

export async function getOutcome(ref: TaskRef): Promise<OpenTaskOutcome | null> {
  return parse<OpenTaskOutcome>(await redis.get(KEY.outcome(ref)));
}

/** Mark that the poster was told submissions closed. True the first time. */
export async function markClosedNotified(ref: TaskRef): Promise<boolean> {
  return (await redis.set(KEY.closed(ref), '1', 'NX')) !== null;
}

export async function isClosedNotified(ref: TaskRef): Promise<boolean> {
  return (await redis.exists(KEY.closed(ref))) === 1;
}

/**
 * Take the task's count-notice slot for `gapSec`. True when no count notice
 * went out in that time, so one may go now.
 */
export async function takeCountNoticeSlot(ref: TaskRef, gapSec: number): Promise<boolean> {
  return (await redis.set(KEY.countGate(ref), '1', 'EX', gapSec, 'NX')) !== null;
}

/** When the sweep should next look at the task (unix seconds). */
export async function scheduleSweep(ref: TaskRef, atSec: number): Promise<void> {
  await redis.zadd(KEY.due, atSec, ref);
}

export async function unscheduleSweep(ref: TaskRef): Promise<void> {
  await redis.zrem(KEY.due, ref);
}

/** Tasks the sweep should look at by `nowSec`, soonest first. */
export async function dueForSweep(nowSec: number, limit: number): Promise<TaskRef[]> {
  return redis.zrangebyscore(KEY.due, '-inf', nowSec, 'LIMIT', 0, limit);
}

// ── Submissions ─────────────────────────────────────────────────────────────

/** Record an on-chain submission. True the first time this submitter is recorded for the task. */
export async function recordSubmission(ref: TaskRef, submitter: string, rec: SubmissionRecord): Promise<boolean> {
  return (await redis.hsetnx(KEY.subs(ref), submitter.toLowerCase(), JSON.stringify(rec))) === 1;
}

/** How many submissions this backend has recorded for the task. */
export async function recordedSubmissionCount(ref: TaskRef): Promise<number> {
  return redis.hlen(KEY.subs(ref));
}

/** A submitter's on-chain submission as recorded from events, or null. */
export async function getSubmission(ref: TaskRef, submitter: string): Promise<SubmissionRecord | null> {
  return parse<SubmissionRecord>(await redis.hget(KEY.subs(ref), submitter.toLowerCase()));
}

/**
 * Every recorded submitter, a page at a time (HSCAN), so a task with many
 * submissions never loads them in one reply.
 */
export async function forEachSubmitter(ref: TaskRef, visit: (addresses: string[]) => Promise<void>): Promise<void> {
  let cursor = '0';
  do {
    const [next, flat] = await redis.hscan(KEY.subs(ref), cursor, 'COUNT', 500);
    cursor = next;
    const addresses: string[] = [];
    for (let i = 0; i < flat.length; i += 2) addresses.push(flat[i]);
    if (addresses.length > 0) await visit(addresses);
  } while (cursor !== '0');
}

/**
 * One page of the task's recorded submissions (HSCAN). Pass the returned
 * cursor back for the next page; '0' when there are no more.
 */
export async function pageSubmissions(
  ref: TaskRef,
  cursor: string,
  count: number,
): Promise<{ cursor: string; submissions: Array<{ submitter: string } & SubmissionRecord> }> {
  const [next, flat] = await redis.hscan(KEY.subs(ref), cursor, 'COUNT', count);
  const submissions: Array<{ submitter: string } & SubmissionRecord> = [];
  for (let i = 0; i < flat.length; i += 2) {
    const rec = parse<SubmissionRecord>(flat[i + 1]);
    if (rec) submissions.push({ submitter: flat[i], ...rec });
  }
  return { cursor: next, submissions };
}

// ── Results ─────────────────────────────────────────────────────────────────

/**
 * Hold a result a submitter sent to submit-open until their on-chain
 * submission shows up, for PENDING_RESULT_TTL_SEC. Replaces their earlier
 * one: until it is on-chain, a submitter may change their mind.
 */
export async function savePendingResult(ref: TaskRef, submitter: string, result: OpenResult): Promise<void> {
  await redis.set(KEY.pending(ref, submitter), JSON.stringify(result), 'EX', PENDING_RESULT_TTL_SEC);
}

/**
 * Keep a submitter's pending result now that their on-chain submission is
 * recorded, if its evidence hash is the one on-chain. Called by the indexer.
 * True when a result was kept.
 */
export async function keepResult(ref: TaskRef, submitter: string, evidenceHash: string): Promise<boolean> {
  const pendingKey = KEY.pending(ref, submitter);
  const pending = parse<OpenResult>(await redis.get(pendingKey));
  if (!pending || pending.evidenceHash.toLowerCase() !== evidenceHash.toLowerCase()) return false;
  const kept = (await redis.hsetnx(KEY.results(ref), submitter.toLowerCase(), JSON.stringify(pending))) === 1;
  await redis.expire(KEY.results(ref), RESULTS_TTL_SEC);
  await redis.del(pendingKey);
  return kept;
}

/** Kept results for these submitters, in order; null where none was kept. */
export async function getResults(ref: TaskRef, submitters: string[]): Promise<Array<OpenResult | null>> {
  if (submitters.length === 0) return [];
  const raws = await redis.hmget(KEY.results(ref), ...submitters.map((a) => a.toLowerCase()));
  return raws.map((raw) => parse<OpenResult>(raw));
}
