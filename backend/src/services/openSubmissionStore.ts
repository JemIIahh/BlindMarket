/**
 * Open-submission tasks (docs/OPEN-SUBMISSION-TASKS.md), off-chain: what the
 * escrow's events say about each one. Kept apart from the single-assignee A2A
 * state (a2aStore), so nothing in the accept, cascade or expiry flows ever
 * sees an open task.
 *
 * Keys (task hash lowercased):
 *   a2a:open:<hash>              JSON OpenTaskRecord, written once
 *   a2a:open:id:<chain>:<id>     the task hash of an on-chain task id
 *   a2a:open:subs:<hash>         hash: submitter → JSON SubmissionRecord
 *   a2a:open:outcome:<hash>      JSON OpenTaskOutcome, once a winner is paid or the task voided
 *   a2a:open:closed:<hash>       set once the poster was told submissions closed
 *   a2a:open:count-gate:<hash>   set for COUNT_NOTICE_GAP_SEC after a count notice
 *   a2a:open:due                 zset: hash → unix seconds the sweep next looks at it
 *
 * Each key has one writer: the indexer writes the record, submissions and
 * outcome from events; the sweep writes `closed` and `due`. No key is
 * read-modified-written by both, so the two processes cannot lose a write.
 */

import { redis } from './redis.js';
import type { TaskChain } from './taskChain.js';

/** Who picks first, as the escrow's PickMode: 0 the task verifier, 1 the poster. */
export type PickMode = 'agent' | 'creator';

export interface OpenTaskRecord {
  chain: TaskChain;
  /** On-chain task id. */
  taskId: string;
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

const KEY = {
  record: (hash: string) => `a2a:open:${hash.toLowerCase()}`,
  byId: (chain: string, taskId: string) => `a2a:open:id:${chain}:${taskId}`,
  subs: (hash: string) => `a2a:open:subs:${hash.toLowerCase()}`,
  outcome: (hash: string) => `a2a:open:outcome:${hash.toLowerCase()}`,
  closed: (hash: string) => `a2a:open:closed:${hash.toLowerCase()}`,
  countGate: (hash: string) => `a2a:open:count-gate:${hash.toLowerCase()}`,
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

/** Save a task's record unless one exists. Returns the record now stored. */
export async function saveRecord(rec: OpenTaskRecord): Promise<OpenTaskRecord> {
  const hash = rec.taskHash.toLowerCase();
  const stored: OpenTaskRecord = { ...rec, taskHash: hash, poster: rec.poster.toLowerCase() };
  const first = await redis.set(KEY.record(hash), JSON.stringify(stored), 'NX');
  await redis.set(KEY.byId(rec.chain, rec.taskId), hash);
  if (first !== null) return stored;
  return (await getRecord(hash)) ?? stored;
}

export async function getRecord(taskHash: string): Promise<OpenTaskRecord | null> {
  return parse<OpenTaskRecord>(await redis.get(KEY.record(taskHash)));
}

export async function getRecordById(chain: TaskChain, taskId: string): Promise<OpenTaskRecord | null> {
  const hash = await redis.get(KEY.byId(chain, taskId));
  return hash ? getRecord(hash) : null;
}

/** Record a submission. True the first time this submitter is recorded for the task. */
export async function recordSubmission(taskHash: string, submitter: string, rec: SubmissionRecord): Promise<boolean> {
  return (await redis.hsetnx(KEY.subs(taskHash), submitter.toLowerCase(), JSON.stringify(rec))) === 1;
}

/** How many submissions this backend has recorded for the task. */
export async function recordedSubmissionCount(taskHash: string): Promise<number> {
  return redis.hlen(KEY.subs(taskHash));
}

/**
 * Every recorded submitter, a page at a time (HSCAN), so a task with many
 * submissions never loads them in one reply.
 */
export async function forEachSubmitter(taskHash: string, visit: (addresses: string[]) => Promise<void>): Promise<void> {
  let cursor = '0';
  do {
    const [next, flat] = await redis.hscan(KEY.subs(taskHash), cursor, 'COUNT', 500);
    cursor = next;
    const addresses: string[] = [];
    for (let i = 0; i < flat.length; i += 2) addresses.push(flat[i]);
    if (addresses.length > 0) await visit(addresses);
  } while (cursor !== '0');
}

export async function saveOutcome(taskHash: string, outcome: OpenTaskOutcome): Promise<boolean> {
  return (await redis.set(KEY.outcome(taskHash), JSON.stringify(outcome), 'NX')) !== null;
}

export async function getOutcome(taskHash: string): Promise<OpenTaskOutcome | null> {
  return parse<OpenTaskOutcome>(await redis.get(KEY.outcome(taskHash)));
}

/** Mark that the poster was told submissions closed. True the first time. */
export async function markClosedNotified(taskHash: string): Promise<boolean> {
  return (await redis.set(KEY.closed(taskHash), '1', 'NX')) !== null;
}

export async function isClosedNotified(taskHash: string): Promise<boolean> {
  return (await redis.exists(KEY.closed(taskHash))) === 1;
}

/**
 * Take the task's count-notice slot for `gapSec`. True when no count notice
 * went out in that time, so one may go now.
 */
export async function takeCountNoticeSlot(taskHash: string, gapSec: number): Promise<boolean> {
  return (await redis.set(KEY.countGate(taskHash), '1', 'EX', gapSec, 'NX')) !== null;
}

/** When the sweep should next look at the task (unix seconds). */
export async function scheduleSweep(taskHash: string, atSec: number): Promise<void> {
  await redis.zadd(KEY.due, atSec, taskHash.toLowerCase());
}

export async function unscheduleSweep(taskHash: string): Promise<void> {
  await redis.zrem(KEY.due, taskHash.toLowerCase());
}

/** Tasks the sweep should look at by `nowSec`, soonest first. */
export async function dueForSweep(nowSec: number, limit: number): Promise<string[]> {
  return redis.zrangebyscore(KEY.due, '-inf', nowSec, 'LIMIT', 0, limit);
}
