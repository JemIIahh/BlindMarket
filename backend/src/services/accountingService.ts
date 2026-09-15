import { getDb } from './database.js';
import { getPool } from './neonDb.js';
import { config } from '../config.js';

export type TransactionType = 'escrow_lock' | 'payment' | 'fee' | 'refund' | 'stake' | 'slash' | 'stake_return';

export interface Transaction {
  id: number;
  address: string;
  role: string;
  task_id: string | null;
  type: TransactionType;
  amount: number;
  fee: number;
  net: number;
  status: string;
  tx_hash: string | null;
  created_at: string;
}

export interface TransactionSummary {
  totalEarned: number;
  totalFees: number;
  netRevenue: number;
  taskCount: number;
}

function usePg(): boolean {
  return Boolean(config.databaseUrl);
}

export async function recordTransaction(tx: {
  address: string;
  role: string;
  taskId?: string;
  type: TransactionType;
  amount: number;
  fee?: number;
  net?: number;
  status?: string;
  txHash?: string;
}): Promise<Transaction> {
  const fee = tx.fee ?? 0;
  const net = tx.net ?? tx.amount - fee;
  const row: Omit<Transaction, 'id' | 'created_at'> = {
    address: tx.address.toLowerCase(),
    role: tx.role,
    task_id: tx.taskId ?? null,
    type: tx.type,
    amount: tx.amount,
    fee,
    net,
    status: tx.status ?? 'confirmed',
    tx_hash: tx.txHash ?? null,
  };

  if (usePg()) {
    const pool = await getPool();
    const res = await pool.query(
      `INSERT INTO transactions (address, role, task_id, type, amount, fee, net, status, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [row.address, row.role, row.task_id, row.type, row.amount, row.fee, row.net, row.status, row.tx_hash],
    );
    return res.rows[0] as Transaction;
  }

  const db = getDb();
  db.prepare(
    'INSERT INTO transactions (address, role, task_id, type, amount, fee, net, status, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(row.address, row.role, row.task_id, row.type, row.amount, row.fee, row.net, row.status, row.tx_hash);

  return db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 1').get() as Transaction;
}

export async function getTransactions(
  addresses: string[],
  from?: string,
  to?: string,
  type?: string,
  page: number = 1,
  pageSize: number = 20,
): Promise<{ transactions: Transaction[]; total: number }> {
  if (addresses.length === 0) return { transactions: [], total: 0 };
  const lowerAddrs = addresses.map(a => a.toLowerCase());

  if (usePg()) {
    const pool = await getPool();
    const conditions: string[] = ['address = ANY($1::text[])'];
    const params: any[] = [lowerAddrs];
    let idx = 2;
    if (from) { conditions.push(`created_at >= $${idx++}`); params.push(from); }
    if (to) { conditions.push(`created_at <= $${idx++}`); params.push(to); }
    if (type) { conditions.push(`type = $${idx++}`); params.push(type); }
    const where = conditions.join(' AND ');

    const countRow = await pool.query(`SELECT COUNT(*)::int AS cnt FROM transactions WHERE ${where}`, params);
    const total = countRow.rows[0].cnt;

    params.push(pageSize, (page - 1) * pageSize);
    const rows = await pool.query(
      `SELECT * FROM transactions WHERE ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      params,
    );
    return { transactions: rows.rows as Transaction[], total };
  }

  const db = getDb();
  const placeholders = lowerAddrs.map(() => '?').join(',');
  let query = `SELECT * FROM transactions WHERE address IN (${placeholders})`;
  const queryParams: (string | number)[] = [...lowerAddrs];
  if (from) { query += ' AND created_at >= ?'; queryParams.push(from); }
  if (to) { query += ' AND created_at <= ?'; queryParams.push(to); }
  if (type) { query += ' AND type = ?'; queryParams.push(type); }
  const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as cnt');
  const total = (db.prepare(countQuery).get(...queryParams) as { cnt: number }).cnt;
  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  const offset = (page - 1) * pageSize;
  queryParams.push(pageSize, offset);
  const transactions = db.prepare(query).all(...queryParams) as Transaction[];
  return { transactions, total };
}

export async function getSummary(addresses: string[], from?: string, to?: string): Promise<TransactionSummary> {
  if (addresses.length === 0) return { totalEarned: 0, totalFees: 0, netRevenue: 0, taskCount: 0 };
  const lowerAddrs = addresses.map(a => a.toLowerCase());

  if (usePg()) {
    const pool = await getPool();
    const conditions: string[] = ['address = ANY($1::text[])'];
    const params: any[] = [lowerAddrs];
    let idx = 2;
    if (from) { conditions.push(`created_at >= $${idx++}`); params.push(from); }
    if (to) { conditions.push(`created_at <= $${idx++}`); params.push(to); }
    const where = conditions.join(' AND ');
    const rows = await pool.query(
      `SELECT type, SUM(amount) as total_amount, SUM(fee) as total_fee, SUM(net) as total_net, COUNT(*)::int as cnt FROM transactions WHERE ${where} GROUP BY type`,
      params,
    );

    let totalEarned = 0;
    let totalFees = 0;
    let taskCount = 0;
    const INCOME_TYPES = new Set(['payment', 'stake_return']);
    for (const row of rows.rows) {
      if (!INCOME_TYPES.has(row.type)) continue;
      totalEarned += Number(row.total_amount ?? 0);
      totalFees += Number(row.total_fee ?? 0);
      taskCount += row.cnt ?? 0;
    }
    const netRevenue = totalEarned - totalFees;
    return {
      totalEarned: Math.round(totalEarned * 1_000_000) / 1_000_000,
      totalFees: Math.round(totalFees * 1_000_000) / 1_000_000,
      netRevenue: Math.round(netRevenue * 1_000_000) / 1_000_000,
      taskCount,
    };
  }

  const db = getDb();
  const placeholders = lowerAddrs.map(() => '?').join(',');
  let query = `SELECT type, SUM(amount) as total_amount, SUM(fee) as total_fee, SUM(net) as total_net, COUNT(*) as cnt FROM transactions WHERE address IN (${placeholders})`;
  const queryParams: (string | number)[] = [...lowerAddrs];
  if (from) { query += ' AND created_at >= ?'; queryParams.push(from); }
  if (to) { query += ' AND created_at <= ?'; queryParams.push(to); }
  query += ' GROUP BY type';
  const rows = db.prepare(query).all(...queryParams) as { type: string; total_amount: number; total_fee: number; total_net: number; cnt: number }[];
  let totalEarned = 0;
  let totalFees = 0;
  let taskCount = 0;
  const INCOME_TYPES = new Set(['payment', 'stake_return']);
  for (const row of rows) {
    if (!INCOME_TYPES.has(row.type)) continue;
    totalEarned += row.total_amount ?? 0;
    totalFees += row.total_fee ?? 0;
    taskCount += row.cnt;
  }
  const netRevenue = totalEarned - totalFees;
  return {
    totalEarned: Math.round(totalEarned * 1_000_000) / 1_000_000,
    totalFees: Math.round(totalFees * 1_000_000) / 1_000_000,
    netRevenue: Math.round(netRevenue * 1_000_000) / 1_000_000,
    taskCount,
  };
}

export async function getGlobalStats(): Promise<{ totalEarned: number; totalFees: number; totalVolume: number; taskCount: number }> {
  if (usePg()) {
    const pool = await getPool();
    const rows = await pool.query(
      `SELECT type, SUM(amount) as total_amount, SUM(fee) as total_fee, COUNT(*)::int as cnt FROM transactions GROUP BY type`,
    );
    let totalEarned = 0;
    let totalFees = 0;
    let taskCount = 0;
    const INCOME_TYPES = new Set(['payment', 'stake_return']);
    for (const row of rows.rows) {
      if (INCOME_TYPES.has(row.type)) {
        totalEarned += Number(row.total_amount ?? 0);
        totalFees += Number(row.total_fee ?? 0);
        taskCount += row.cnt ?? 0;
      }
      if (row.type === 'fee') {
        totalFees += Number(row.total_fee ?? 0);
      }
    }
    return {
      totalEarned: Math.round(totalEarned * 1_000_000) / 1_000_000,
      totalFees: Math.round(totalFees * 1_000_000) / 1_000_000,
      totalVolume: Math.round((totalEarned + totalFees) * 1_000_000) / 1_000_000,
      taskCount,
    };
  }

  const db = getDb();
  const rows = db.prepare(
    `SELECT type, SUM(amount) as total_amount, SUM(fee) as total_fee, COUNT(*) as cnt FROM transactions GROUP BY type`,
  ).all() as { type: string; total_amount: number; total_fee: number; cnt: number }[];
  let totalEarned = 0;
  let totalFees = 0;
  let taskCount = 0;
  const INCOME_TYPES = new Set(['payment', 'stake_return']);
  for (const row of rows) {
    if (INCOME_TYPES.has(row.type)) {
      totalEarned += row.total_amount ?? 0;
      totalFees += row.total_fee ?? 0;
      taskCount += row.cnt;
    }
    if (row.type === 'fee') {
      totalFees += row.total_fee ?? 0;
    }
  }
  return {
    totalEarned: Math.round(totalEarned * 1_000_000) / 1_000_000,
    totalFees: Math.round(totalFees * 1_000_000) / 1_000_000,
    totalVolume: Math.round((totalEarned + totalFees) * 1_000_000) / 1_000_000,
    taskCount,
  };
}

/**
 * M5 (audit): flip build-time ('pending') rows to 'confirmed' once the
 * broadcast is receipt-verified (A2A /index for escrow_lock, POST
 * /tasks/:id/confirm-tx for refunds). Idempotent: a second call matches
 * zero pending rows and reports confirmed: 0. Returns the flipped count.
 */
export async function confirmPendingTransactions(taskId: string, types: string[]): Promise<{ confirmed: number }> {
  if (types.length === 0) return { confirmed: 0 };
  if (usePg()) {
    const pool = await getPool();
    const res = await pool.query(
      `UPDATE transactions SET status = 'confirmed'
        WHERE LOWER(task_id) = LOWER($1) AND status = 'pending' AND type = ANY($2::text[])`,
      [taskId, types],
    );
    return { confirmed: res.rowCount ?? 0 };
  }
  const db = getDb();
  const placeholders = types.map(() => '?').join(',');
  const info = db.prepare(
    `UPDATE transactions SET status = 'confirmed'
      WHERE LOWER(task_id) = LOWER(?) AND status = 'pending' AND type IN (${placeholders})`,
  ).run(taskId, ...types);
  return { confirmed: Number(info.changes ?? 0) };
}

export async function exportCsv(addresses: string[], from?: string, to?: string): Promise<string> {
  const { transactions } = await getTransactions(addresses, from, to);

  const header = 'Date,Task ID,Type,Role,Amount,Fee,Net,Status,Tx Hash';
  const rows = transactions.map((tx: Transaction) =>
    [
      tx.created_at,
      tx.task_id ?? '',
      tx.type,
      tx.role,
      tx.amount,
      tx.fee,
      tx.net,
      tx.status,
      tx.tx_hash ?? '',
    ].join(','),
  );

  return [header, ...rows].join('\n');
}
