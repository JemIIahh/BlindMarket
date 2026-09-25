/**
 * Durable record of which deploy-fee payments have paid for an agent.
 *
 * A payment is an AgentFactory AgentDeployed event (key arc:factory:<factory>:
 * <nonce>) or an Arc USDC transfer to the treasury (arc:transfer:<txHash>).
 * Both used to be tracked in Redis alone: a claimed factory credit was deleted
 * with no tombstone, so a re-delivered event (a retried or overlapping listener
 * tick, or a rescan after Redis loss) recreated it, and a transfer's "used"
 * mark vanished with Redis. Either way one payment deployed several agents
 * (security audit run 1, C29).
 *
 * One row per payment: claimed before the deploy, given the agent's id when it
 * exists, deleted only when the deploy fails, never expired. A claim whose
 * deploy never finished (the process died mid-deploy) can be taken over after
 * PENDING_CLAIM_TTL_S.
 *
 * Postgres migration 40 / SQLite migration 20 create the table.
 */
import { getDb } from './database.js';
import { getPool } from './neonDb.js';
import { config } from '../config.js';
import { chainScope } from './chainScope.js';

export const PENDING_CLAIM_TTL_S = 600;

export type PaymentClaim =
  | { claimed: true }
  | { claimed: false; pending: boolean; agentId?: string };

// Under the network's scope (chainScope): 'arc:' on Arc testnet, as before.
export const factoryPaymentKey = (factory: string, nonce: string): string =>
  `${chainScope('arc')}:factory:${factory.toLowerCase()}:${nonce}`;
export const transferPaymentKey = (txHash: string): string => `${chainScope('arc')}:transfer:${txHash.toLowerCase()}`;

function usePg(): boolean {
  return Boolean(config.databaseUrl);
}

const nowS = (): number => Math.floor(Date.now() / 1000);

/** Claim a payment for a deploy about to run. */
export async function claimPayment(key: string, owner: string): Promise<PaymentClaim> {
  const now = nowS();
  const staleBefore = now - PENDING_CLAIM_TTL_S;
  const who = owner.toLowerCase();
  if (usePg()) {
    const pool = await getPool();
    const inserted = await pool.query(
      `INSERT INTO spent_deploy_payments (payment_key, owner, agent_id, claimed_at)
       VALUES ($1, $2, NULL, $3)
       ON CONFLICT (payment_key) DO NOTHING
       RETURNING payment_key`,
      [key, who, now],
    );
    if ((inserted.rowCount ?? 0) > 0) return { claimed: true };
    const tookOver = await pool.query(
      `UPDATE spent_deploy_payments SET owner = $2, claimed_at = $3
       WHERE payment_key = $1 AND agent_id IS NULL AND claimed_at < $4
       RETURNING payment_key`,
      [key, who, now, staleBefore],
    );
    if ((tookOver.rowCount ?? 0) > 0) return { claimed: true };
    const { rows } = await pool.query<{ agent_id: string | null }>(
      'SELECT agent_id FROM spent_deploy_payments WHERE payment_key = $1',
      [key],
    );
    const agentId = rows[0]?.agent_id ?? undefined;
    return { claimed: false, pending: agentId === undefined, ...(agentId ? { agentId } : {}) };
  }
  const db = getDb();
  return db.transaction((): PaymentClaim => {
    const inserted = db
      .prepare('INSERT OR IGNORE INTO spent_deploy_payments (payment_key, owner, agent_id, claimed_at) VALUES (?, ?, NULL, ?)')
      .run(key, who, now);
    if (Number(inserted.changes ?? 0) > 0) return { claimed: true };
    const tookOver = db
      .prepare('UPDATE spent_deploy_payments SET owner = ?, claimed_at = ? WHERE payment_key = ? AND agent_id IS NULL AND claimed_at < ?')
      .run(who, now, key, staleBefore);
    if (Number(tookOver.changes ?? 0) > 0) return { claimed: true };
    const row = db.prepare('SELECT agent_id FROM spent_deploy_payments WHERE payment_key = ?').get(key) as
      { agent_id: string | null } | undefined;
    const agentId = row?.agent_id ?? undefined;
    return { claimed: false, pending: agentId === undefined, ...(agentId ? { agentId } : {}) };
  })();
}

/** Record the agent a claimed payment paid for. The row then never goes away. */
export async function markPaymentUsed(key: string, agentId: string): Promise<void> {
  if (usePg()) {
    const pool = await getPool();
    await pool.query('UPDATE spent_deploy_payments SET agent_id = $2 WHERE payment_key = $1', [key, agentId]);
    return;
  }
  getDb().prepare('UPDATE spent_deploy_payments SET agent_id = ? WHERE payment_key = ?').run(agentId, key);
}

/** Record a payment already spent on `agentId` (a legacy Redis mark being carried over). */
export async function recordUsedPayment(key: string, owner: string, agentId: string): Promise<void> {
  if (usePg()) {
    const pool = await getPool();
    await pool.query(
      `INSERT INTO spent_deploy_payments (payment_key, owner, agent_id, claimed_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (payment_key) DO NOTHING`,
      [key, owner.toLowerCase(), agentId, nowS()],
    );
    return;
  }
  getDb()
    .prepare('INSERT OR IGNORE INTO spent_deploy_payments (payment_key, owner, agent_id, claimed_at) VALUES (?, ?, ?, ?)')
    .run(key, owner.toLowerCase(), agentId, nowS());
}

/** Give a payment back after the deploy it was claimed for failed. A payment
 *  that already paid for an agent is never given back. */
export async function releasePayment(key: string): Promise<void> {
  if (usePg()) {
    const pool = await getPool();
    await pool.query('DELETE FROM spent_deploy_payments WHERE payment_key = $1 AND agent_id IS NULL', [key]);
    return;
  }
  getDb().prepare('DELETE FROM spent_deploy_payments WHERE payment_key = ? AND agent_id IS NULL').run(key);
}

/** Whether a payment is claimed or spent. The factory listener uses it so a
 *  re-delivered event can't recreate a credit that was already used. */
export async function isPaymentRecorded(key: string): Promise<boolean> {
  if (usePg()) {
    const pool = await getPool();
    const { rowCount } = await pool.query('SELECT 1 FROM spent_deploy_payments WHERE payment_key = $1', [key]);
    return (rowCount ?? 0) > 0;
  }
  return getDb().prepare('SELECT 1 FROM spent_deploy_payments WHERE payment_key = ?').get(key) !== undefined;
}
