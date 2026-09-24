/**
 * Durable record of which task payouts have been credited to an executor's
 * earnings and task count.
 *
 * The at-most-once gate for a credit used to be a Redis NX marker only
 * (a2a:credited:<taskHash>, workerPayout.ts). A Redis flush is handled (the
 * ruling scan restarts at the head), but a RESTORE from an older snapshot
 * rewinds the indexer checkpoints and deletes every marker written since,
 * while Postgres keeps the credits: the next scan re-credited each ruling.
 * The credits live in the database, so the gate lives there too: one row per
 * task hash. recordWorkerPayout claims it in the same transaction as the
 * credit (agentStore.creditPayoutOnce), so the row exists exactly when the
 * credit does and no failure path deletes it: the earlier claim-then-credit
 * sequence released the row on any error, including one on a re-observation
 * that never claimed it, and the task was credited again (security audit
 * run 1, C34).
 *
 * Postgres migration 34 / SQLite migration 16 create the table.
 */
import { getDb } from './database.js';
import { getPool } from './neonDb.js';
import { config } from '../config.js';
import type { TaskChain } from './taskChain.js';

function usePg(): boolean {
  return Boolean(config.databaseUrl);
}

/** The claim statement ($1/? = lowercase task hash, chain, lowercase executor).
 *  Shared with agentStore.creditPayoutOnce, which runs it inside the credit's
 *  transaction. Takes nothing when a row exists. */
export const CLAIM_CREDIT_SQL = {
  pg: `INSERT INTO credited_payouts (task_hash, chain, executor)
       VALUES ($1, $2, $3)
       ON CONFLICT (task_hash) DO NOTHING
       RETURNING task_hash`,
  sqlite: 'INSERT OR IGNORE INTO credited_payouts (task_hash, chain, executor) VALUES (?, ?, ?)',
} as const;

/**
 * Claim the credit for `taskHash` on its own, outside any credit. True when
 * this call took it; false when a row already exists (credited before, by any
 * path or backend). Throws on a database failure. recordWorkerPayout does not
 * use this: it claims inside agentStore.creditPayoutOnce's transaction.
 */
export async function claimCredit(taskHash: string, chain: TaskChain, executor: string): Promise<boolean> {
  const hash = taskHash.toLowerCase();
  const addr = executor.toLowerCase();
  if (usePg()) {
    const pool = await getPool();
    const res = await pool.query(CLAIM_CREDIT_SQL.pg, [hash, chain, addr]);
    return (res.rowCount ?? 0) > 0;
  }
  const info = getDb().prepare(CLAIM_CREDIT_SQL.sqlite).run(hash, chain, addr);
  return Number(info.changes ?? 0) > 0;
}

/**
 * Delete a task's claim row, whoever wrote it. Nothing on the credit path
 * calls this any more: a row stands for a credit that was applied, and
 * deleting one lets the task be credited again. For operator repair only.
 */
export async function releaseCredit(taskHash: string): Promise<void> {
  const hash = taskHash.toLowerCase();
  if (usePg()) {
    const pool = await getPool();
    await pool.query('DELETE FROM credited_payouts WHERE task_hash = $1', [hash]);
    return;
  }
  getDb().prepare('DELETE FROM credited_payouts WHERE task_hash = ?').run(hash);
}

/** Whether a credit row exists (read-only; for scripts and health checks). */
export async function isCredited(taskHash: string): Promise<boolean> {
  const hash = taskHash.toLowerCase();
  if (usePg()) {
    const pool = await getPool();
    const res = await pool.query('SELECT 1 FROM credited_payouts WHERE task_hash = $1', [hash]);
    return (res.rowCount ?? 0) > 0;
  }
  return getDb().prepare('SELECT 1 FROM credited_payouts WHERE task_hash = ?').get(hash) !== undefined;
}
