/**
 * Durable state of sponsored agent gas (docs/AGENT-GAS-FUNDING.md): budget
 * reservations, every sponsored transaction (write-ahead), strikes, the
 * key-export log and the pause/kill controls. Postgres migration 43.
 *
 * Postgres only, never Redis or SQLite: these are money counters and signed
 * transactions, and a redeploy must not reset or lose them. Every function
 * throws without DATABASE_URL.
 *
 * Reservations are made under a Postgres advisory transaction lock, so the
 * caps hold however many /accept calls race, on however many processes:
 *   - one held reservation per agent;
 *   - sponsored tasks per agent, per Privy user and per poster wallet in the
 *     last 24 hours;
 *   - global spend in the last hour and the last 24 hours, where a held
 *     reservation counts its budget and a settled one what it really cost.
 * Spend is gasUsed × effectiveGasPrice from receipts, reverts included.
 */
import type pg from 'pg';
import { config } from '../config.js';
import { getPool } from './neonDb.js';

export type ReservationKind = 'submit' | 'release';
export type ReservationStatus = 'reserved' | 'used' | 'released' | 'expired';
export type SponsoredTxStatus = 'signed' | 'sent' | 'confirmed' | 'reverted' | 'noop' | 'dropped';

export interface Reservation {
  id: number;
  chainId: number;
  taskId: bigint;
  kind: ReservationKind;
  taskHash: string;
  agentWallet: string;
  ownerDid: string;
  poster: string;
  status: ReservationStatus;
  budgetWei: bigint;
  createdAt: Date;
  expiresAt: Date;
  txHash: string | null;
  gasUsed: bigint | null;
  costWei: bigint | null;
}

export interface SponsoredTx {
  id: number;
  chainId: number;
  reservationId: number;
  sponsor: string;
  nonce: number;
  rawTx: string;
  txHash: string;
  withAuthorization: boolean;
  status: SponsoredTxStatus;
}

export interface SponsorCaps {
  perAgentDaily: number;
  perUserDaily: number;
  perPosterDaily: number;
  hourlyBudgetWei: bigint;
  dailyBudgetWei: bigint;
  maxStrikes: number;
}

export type ReserveRefusal =
  | 'paused'
  | 'taken'
  | 'agent_held'
  | 'strikes'
  | 'agent_daily'
  | 'user_daily'
  | 'poster_daily'
  | 'hourly_budget'
  | 'daily_budget';

export type ReserveOutcome = { ok: true; reservation: Reservation; existing: boolean } | { ok: false; refusal: ReserveRefusal };

export class GasSponsorStoreUnavailable extends Error {
  constructor() {
    super('sponsored gas needs DATABASE_URL (Postgres): its caps and signed transactions must survive a redeploy');
  }
}

async function pool(): Promise<pg.Pool> {
  if (!config.databaseUrl) throw new GasSponsorStoreUnavailable();
  return getPool();
}

const big = (v: unknown): bigint | null => (v == null ? null : BigInt(String(v)));

function toReservation(r: Record<string, unknown>): Reservation {
  return {
    id: Number(r.id),
    chainId: Number(r.chain_id),
    taskId: BigInt(String(r.task_id)),
    kind: String(r.kind) as ReservationKind,
    taskHash: String(r.task_hash),
    agentWallet: String(r.agent_wallet),
    ownerDid: String(r.owner_did),
    poster: String(r.poster),
    status: String(r.status) as ReservationStatus,
    budgetWei: BigInt(String(r.budget_wei)),
    createdAt: new Date(r.created_at as string),
    expiresAt: new Date(r.expires_at as string),
    txHash: r.tx_hash == null ? null : String(r.tx_hash),
    gasUsed: big(r.gas_used),
    costWei: big(r.cost_wei),
  };
}

function toTx(r: Record<string, unknown>): SponsoredTx {
  return {
    id: Number(r.id),
    chainId: Number(r.chain_id),
    reservationId: Number(r.reservation_id),
    sponsor: String(r.sponsor),
    nonce: Number(r.nonce),
    rawTx: String(r.raw_tx),
    txHash: String(r.tx_hash),
    withAuthorization: r.with_authorization === true,
    status: String(r.status) as SponsoredTxStatus,
  };
}

// What a reservation counts against the global budget: its budget while held,
// what it really cost once settled.
const SPEND = `COALESCE(SUM(CASE WHEN status = 'reserved' THEN GREATEST(budget_wei, COALESCE(cost_wei, 0)) ELSE COALESCE(cost_wei, 0) END), 0)::text`;

/**
 * Reserve sponsor budget for one call on one escrow task. A reservation this
 * agent already holds for the task is returned as it is (a re-accept). One
 * released before anything was sent can be taken again.
 */
export async function reserve(
  input: {
    chainId: number;
    taskId: bigint;
    kind: ReservationKind;
    taskHash: string;
    agentWallet: string;
    ownerDid: string;
    poster: string;
    budgetWei: bigint;
    ttlSeconds: number;
  },
  caps: SponsorCaps,
): Promise<ReserveOutcome> {
  const wallet = input.agentWallet.toLowerCase();
  const poster = input.poster.toLowerCase();
  const client = await (await pool()).connect();
  const done = async (outcome: ReserveOutcome) => {
    await client.query('COMMIT');
    return outcome;
  };
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('gas_sponsor_reservations'))`);

    const controls = await client.query<{ paused: boolean; killed: boolean }>(
      'SELECT paused, killed FROM gas_sponsor_controls WHERE chain_id = $1',
      [input.chainId],
    );
    if (controls.rows[0]?.paused || controls.rows[0]?.killed) return await done({ ok: false, refusal: 'paused' });

    const existing = await client.query(
      'SELECT * FROM gas_sponsor_reservations WHERE chain_id = $1 AND task_id = $2 AND kind = $3',
      [input.chainId, input.taskId.toString(), input.kind],
    );
    const prior = existing.rows[0] ? toReservation(existing.rows[0]) : null;
    if (prior) {
      if (prior.status === 'reserved' && prior.agentWallet === wallet) return await done({ ok: true, reservation: prior, existing: true });
      if (!(prior.status === 'released' && prior.txHash === null && prior.costWei === null)) {
        return await done({ ok: false, refusal: 'taken' });
      }
    }

    if (input.kind === 'submit') {
      const held = await client.query(
        `SELECT 1 FROM gas_sponsor_reservations WHERE chain_id = $1 AND agent_wallet = $2 AND kind = 'submit' AND status = 'reserved'`,
        [input.chainId, wallet],
      );
      if ((held.rowCount ?? 0) > 0) return await done({ ok: false, refusal: 'agent_held' });
    }

    const strikes = await client.query<{ agent: string; owner: string }>(
      `SELECT COUNT(*) FILTER (WHERE agent_wallet = $2)::text AS agent, COUNT(*) FILTER (WHERE owner_did = $3)::text AS owner
       FROM gas_sponsor_strikes WHERE chain_id = $1 AND created_at > NOW() - interval '7 days'`,
      [input.chainId, wallet, input.ownerDid],
    );
    if (Number(strikes.rows[0]?.agent ?? 0) >= caps.maxStrikes || Number(strikes.rows[0]?.owner ?? 0) >= caps.maxStrikes) {
      return await done({ ok: false, refusal: 'strikes' });
    }

    const counts = await client.query<{ agent: string; owner: string; poster: string }>(
      `SELECT COUNT(*) FILTER (WHERE agent_wallet = $2)::text AS agent,
              COUNT(*) FILTER (WHERE owner_did = $3)::text AS owner,
              COUNT(*) FILTER (WHERE poster = $4)::text AS poster
       FROM gas_sponsor_reservations
       WHERE chain_id = $1 AND kind = 'submit' AND status IN ('reserved', 'used', 'expired')
         AND created_at > NOW() - interval '24 hours'`,
      [input.chainId, wallet, input.ownerDid, poster],
    );
    if (input.kind === 'submit') {
      const c = counts.rows[0];
      if (Number(c?.agent ?? 0) >= caps.perAgentDaily) return await done({ ok: false, refusal: 'agent_daily' });
      if (Number(c?.owner ?? 0) >= caps.perUserDaily) return await done({ ok: false, refusal: 'user_daily' });
      if (Number(c?.poster ?? 0) >= caps.perPosterDaily) return await done({ ok: false, refusal: 'poster_daily' });
    }

    const spend = await client.query<{ hour: string; day: string }>(
      `SELECT
         (SELECT ${SPEND} FROM gas_sponsor_reservations WHERE chain_id = $1 AND created_at > NOW() - interval '1 hour') AS hour,
         (SELECT ${SPEND} FROM gas_sponsor_reservations WHERE chain_id = $1 AND created_at > NOW() - interval '24 hours') AS day`,
      [input.chainId],
    );
    if (BigInt(spend.rows[0]?.hour ?? '0') + input.budgetWei > caps.hourlyBudgetWei) return await done({ ok: false, refusal: 'hourly_budget' });
    if (BigInt(spend.rows[0]?.day ?? '0') + input.budgetWei > caps.dailyBudgetWei) return await done({ ok: false, refusal: 'daily_budget' });

    const values = [
      input.chainId, input.taskId.toString(), input.kind, input.taskHash.toLowerCase(), wallet, input.ownerDid, poster,
      input.budgetWei.toString(), input.ttlSeconds,
    ];
    const { rows } = prior
      ? await client.query(
          `UPDATE gas_sponsor_reservations SET task_hash = $4, agent_wallet = $5, owner_did = $6, poster = $7,
             status = 'reserved', budget_wei = $8, created_at = NOW(), expires_at = NOW() + make_interval(secs => $9),
             settled_at = NULL
           WHERE chain_id = $1 AND task_id = $2 AND kind = $3 RETURNING *`,
          values,
        )
      : await client.query(
          `INSERT INTO gas_sponsor_reservations
             (chain_id, task_id, kind, task_hash, agent_wallet, owner_did, poster, status, budget_wei, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, NOW() + make_interval(secs => $9))
           RETURNING *`,
          values,
        );
    return await done({ ok: true, reservation: toReservation(rows[0]), existing: false });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getReservation(chainId: number, taskId: bigint, kind: ReservationKind): Promise<Reservation | null> {
  const { rows } = await (await pool()).query(
    'SELECT * FROM gas_sponsor_reservations WHERE chain_id = $1 AND task_id = $2 AND kind = $3',
    [chainId, taskId.toString(), kind],
  );
  return rows[0] ? toReservation(rows[0]) : null;
}

export async function getReservationById(id: number): Promise<Reservation | null> {
  const { rows } = await (await pool()).query('SELECT * FROM gas_sponsor_reservations WHERE id = $1', [id]);
  return rows[0] ? toReservation(rows[0]) : null;
}

/** Held reservations of a chain, oldest first (the expiry sweep's list). */
export async function heldReservations(chainId: number): Promise<Reservation[]> {
  const { rows } = await (await pool()).query(
    `SELECT * FROM gas_sponsor_reservations WHERE chain_id = $1 AND status = 'reserved' ORDER BY created_at ASC`,
    [chainId],
  );
  return rows.map(toReservation);
}

/** The reservation an agent holds, if any (it holds at most one submit). */
export async function heldByAgent(chainId: number, wallet: string): Promise<Reservation | null> {
  const { rows } = await (await pool()).query(
    `SELECT * FROM gas_sponsor_reservations WHERE chain_id = $1 AND agent_wallet = $2 AND status = 'reserved' ORDER BY created_at DESC LIMIT 1`,
    [chainId, wallet.toLowerCase()],
  );
  return rows[0] ? toReservation(rows[0]) : null;
}

/** Restart the hour from the on-chain assignment, once it is known. */
export async function startReservationClock(id: number, ttlSeconds: number): Promise<void> {
  await (await pool()).query(
    `UPDATE gas_sponsor_reservations SET expires_at = NOW() + make_interval(secs => $2) WHERE id = $1 AND status = 'reserved'`,
    [id, ttlSeconds],
  );
}

/**
 * Close a held reservation. 'expired' also records a strike against its agent
 * and Privy user. False when it was no longer held.
 */
export async function closeReservation(id: number, status: 'used' | 'released' | 'expired', reason?: string): Promise<boolean> {
  const client = await (await pool()).connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE gas_sponsor_reservations SET status = $2, settled_at = NOW() WHERE id = $1 AND status = 'reserved' RETURNING *`,
      [id, status],
    );
    if (rows[0] && status === 'expired') {
      const r = toReservation(rows[0]);
      await client.query(
        `INSERT INTO gas_sponsor_strikes (chain_id, agent_wallet, owner_did, reservation_id, reason)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (reservation_id) DO NOTHING`,
        [r.chainId, r.agentWallet, r.ownerDid, r.id, reason ?? 'held an hour without a submit'],
      );
    }
    await client.query('COMMIT');
    return rows.length > 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Write-ahead sponsored transactions ───────────────────────────────────────

/** The lowest nonce the sponsor may sign next: past every nonce it has stored. */
export async function nextStoredNonce(chainId: number, sponsor: string): Promise<number | null> {
  const { rows } = await (await pool()).query<{ n: string | null }>(
    'SELECT MAX(nonce)::text AS n FROM gas_sponsor_txs WHERE chain_id = $1 AND sponsor = $2',
    [chainId, sponsor.toLowerCase()],
  );
  return rows[0]?.n == null ? null : Number(rows[0].n) + 1;
}

/** Store a signed transaction before it is broadcast. */
export async function recordSignedTx(tx: {
  chainId: number;
  reservationId: number;
  sponsor: string;
  nonce: number;
  rawTx: string;
  txHash: string;
  withAuthorization: boolean;
}): Promise<SponsoredTx> {
  const { rows } = await (await pool()).query(
    `INSERT INTO gas_sponsor_txs (chain_id, reservation_id, sponsor, nonce, raw_tx, tx_hash, with_authorization, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'signed') RETURNING *`,
    [tx.chainId, tx.reservationId, tx.sponsor.toLowerCase(), tx.nonce, tx.rawTx, tx.txHash, tx.withAuthorization],
  );
  return toTx(rows[0]);
}

export async function setTxStatus(txHash: string, status: SponsoredTxStatus): Promise<void> {
  await (await pool()).query('UPDATE gas_sponsor_txs SET status = $2, updated_at = NOW() WHERE tx_hash = $1', [txHash, status]);
}

/**
 * Settle a mined transaction: its status, and its cost (gasUsed ×
 * effectiveGasPrice) added to its reservation, reverts and no-ops included.
 */
export async function settleTx(txHash: string, status: 'confirmed' | 'reverted' | 'noop', gasUsed: bigint, costWei: bigint): Promise<void> {
  const client = await (await pool()).connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE gas_sponsor_txs SET status = $2, gas_used = $3, cost_wei = $4, updated_at = NOW()
       WHERE tx_hash = $1 AND cost_wei IS NULL RETURNING reservation_id`,
      [txHash, status, gasUsed.toString(), costWei.toString()],
    );
    if (rows[0]) {
      await client.query(
        `UPDATE gas_sponsor_reservations SET gas_used = COALESCE(gas_used, 0) + $2, cost_wei = COALESCE(cost_wei, 0) + $3
         WHERE id = $1`,
        [rows[0].reservation_id, gasUsed.toString(), costWei.toString()],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Record the transaction that did the reservation's job (null: someone else landed the signed call), and close it as used. */
export async function markReservationUsed(id: number, txHash: string | null): Promise<void> {
  await (await pool()).query(
    `UPDATE gas_sponsor_reservations SET status = 'used', tx_hash = $2, settled_at = NOW() WHERE id = $1`,
    [id, txHash],
  );
}

/** Signed transactions of the sponsor not known to be mined, lowest nonce first. */
export async function unsettledTxs(chainId: number, sponsor: string): Promise<SponsoredTx[]> {
  const { rows } = await (await pool()).query(
    `SELECT * FROM gas_sponsor_txs WHERE chain_id = $1 AND sponsor = $2 AND status IN ('signed', 'sent') ORDER BY nonce ASC`,
    [chainId, sponsor.toLowerCase()],
  );
  return rows.map(toTx);
}

export async function txsForReservation(reservationId: number): Promise<SponsoredTx[]> {
  const { rows } = await (await pool()).query('SELECT * FROM gas_sponsor_txs WHERE reservation_id = $1 ORDER BY nonce ASC', [reservationId]);
  return rows.map(toTx);
}

/** Setup transactions (ones carrying a 7702 authorization) sent for a wallet, in any outcome but dropped. */
export async function setupAttempts(chainId: number, wallet: string): Promise<number> {
  const { rows } = await (await pool()).query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM gas_sponsor_txs t JOIN gas_sponsor_reservations r ON r.id = t.reservation_id
     WHERE t.chain_id = $1 AND r.agent_wallet = $2 AND t.with_authorization AND t.status <> 'dropped'`,
    [chainId, wallet.toLowerCase()],
  );
  return Number(rows[0]?.n ?? 0);
}

// ── Key exports ──────────────────────────────────────────────────────────────

/** Log an export of an agent's key. Its wallet is never sponsored again. */
export async function recordKeyExport(agentId: string, wallet: string, requestedBy: string): Promise<void> {
  await (await pool()).query(
    'INSERT INTO agent_key_exports (agent_id, wallet, requested_by) VALUES ($1, $2, $3)',
    [agentId, wallet.toLowerCase(), requestedBy.toLowerCase()],
  );
}

export async function walletKeyExported(wallet: string): Promise<boolean> {
  const { rowCount } = await (await pool()).query('SELECT 1 FROM agent_key_exports WHERE wallet = $1 LIMIT 1', [wallet.toLowerCase()]);
  return (rowCount ?? 0) > 0;
}

// ── Controls ─────────────────────────────────────────────────────────────────

export interface SponsorControls {
  paused: boolean;
  killed: boolean;
  reason: string | null;
  updatedBy: string | null;
  updatedAt: Date | null;
}

export async function getControls(chainId: number): Promise<SponsorControls> {
  const { rows } = await (await pool()).query('SELECT * FROM gas_sponsor_controls WHERE chain_id = $1', [chainId]);
  const r = rows[0];
  return r
    ? { paused: r.paused === true, killed: r.killed === true, reason: r.reason ?? null, updatedBy: r.updated_by ?? null, updatedAt: new Date(r.updated_at) }
    : { paused: false, killed: false, reason: null, updatedBy: null, updatedAt: null };
}

export async function setControls(
  chainId: number,
  change: { paused?: boolean; killed?: boolean },
  reason: string,
  updatedBy: string,
): Promise<SponsorControls> {
  await (await pool()).query(
    `INSERT INTO gas_sponsor_controls (chain_id, paused, killed, reason, updated_by, updated_at)
     VALUES ($1, COALESCE($2, false), COALESCE($3, false), $4, $5, NOW())
     ON CONFLICT (chain_id) DO UPDATE SET
       paused = COALESCE($2, gas_sponsor_controls.paused),
       killed = COALESCE($3, gas_sponsor_controls.killed),
       reason = $4, updated_by = $5, updated_at = NOW()`,
    [chainId, change.paused ?? null, change.killed ?? null, reason, updatedBy],
  );
  return getControls(chainId);
}

// ── Monitoring ───────────────────────────────────────────────────────────────

export interface SponsorUsage {
  spentLastHourWei: bigint;
  spentLastDayWei: bigint;
  callsLastDay: number;
  failuresLastHour: number;
  sendsLastHour: number;
}

export async function usage(chainId: number): Promise<SponsorUsage> {
  const { rows } = await (await pool()).query<{ hour: string; day: string; calls: string; failures: string; sends: string }>(
    `SELECT
       (SELECT ${SPEND} FROM gas_sponsor_reservations WHERE chain_id = $1 AND created_at > NOW() - interval '1 hour') AS hour,
       (SELECT ${SPEND} FROM gas_sponsor_reservations WHERE chain_id = $1 AND created_at > NOW() - interval '24 hours') AS day,
       (SELECT COUNT(*)::text FROM gas_sponsor_txs WHERE chain_id = $1 AND created_at > NOW() - interval '24 hours') AS calls,
       (SELECT COUNT(*)::text FROM gas_sponsor_txs WHERE chain_id = $1 AND created_at > NOW() - interval '1 hour'
          AND status IN ('reverted', 'noop', 'dropped')) AS failures,
       (SELECT COUNT(*)::text FROM gas_sponsor_txs WHERE chain_id = $1 AND created_at > NOW() - interval '1 hour') AS sends`,
    [chainId],
  );
  const r = rows[0];
  return {
    spentLastHourWei: BigInt(r?.hour ?? '0'),
    spentLastDayWei: BigInt(r?.day ?? '0'),
    callsLastDay: Number(r?.calls ?? 0),
    failuresLastHour: Number(r?.failures ?? 0),
    sendsLastHour: Number(r?.sends ?? 0),
  };
}

/** Strikes in the last 7 days against an agent, and against its Privy user. */
export async function strikeCounts(chainId: number, wallet: string, ownerDid: string | null): Promise<{ agent: number; owner: number }> {
  const { rows } = await (await pool()).query<{ agent: string; owner: string }>(
    `SELECT COUNT(*) FILTER (WHERE agent_wallet = $2)::text AS agent, COUNT(*) FILTER (WHERE owner_did = $3)::text AS owner
     FROM gas_sponsor_strikes WHERE chain_id = $1 AND created_at > NOW() - interval '7 days'`,
    [chainId, wallet.toLowerCase(), ownerDid ?? ''],
  );
  return { agent: Number(rows[0]?.agent ?? 0), owner: Number(rows[0]?.owner ?? 0) };
}
