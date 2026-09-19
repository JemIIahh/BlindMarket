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
 * task hash, claimed before the credit is written and released only when the
 * credit fails.
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

/**
 * Claim the credit for `taskHash`. True when this call took it; false when a
 * row already exists (credited before, by any path or backend). Throws on a
 * database failure, so the caller treats it as a failed credit.
 */
export async function claimCredit(taskHash: string, chain: TaskChain, executor: string): Promise<boolean> {
  const hash = taskHash.toLowerCase();
  const addr = executor.toLowerCase();
  if (usePg()) {
    const pool = await getPool();
    const res = await pool.query(
      `INSERT INTO credited_payouts (task_hash, chain, executor)
       VALUES ($1, $2, $3)
       ON CONFLICT (task_hash) DO NOTHING
       RETURNING task_hash`,
      [hash, chain, addr],
    );
    return (res.rowCount ?? 0) > 0;
  }
  const info = getDb()
    .prepare('INSERT OR IGNORE INTO credited_payouts (task_hash, chain, executor) VALUES (?, ?, ?)')
    .run(hash, chain, addr);
  return Number(info.changes ?? 0) > 0;
}

/** Give a claim back after the credit it guarded failed, so a retry can credit. */
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
