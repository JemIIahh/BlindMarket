import { getDb } from './database.js';
import { getPool } from './neonDb.js';
import { config } from '../config.js';
import { pricingUnit } from './settlementUnits.js';

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
  /** The currency amount/fee/net are in ('USDC', '0G'); NULL for rows from before the column. */
  unit: string | null;
  status: string;
  tx_hash: string | null;
  created_at: string;
}

export interface UnitTotals {
  totalEarned: number;
  totalFees: number;
  netRevenue: number;
  taskCount: number;
}

/**
 * The headline totals are in ONE unit — this deployment's pricing unit — and
 * count rows in that unit plus rows written before the unit column existed
 * (`unitlessRows`; they are in whatever the deployment paid in then). Rows in
 * any other unit are only in `byUnit`, never added to the headline: a 5 USDC
 * and a 5 0G task are not 10 of anything.
 */
export interface TransactionSummary extends UnitTotals {
  unit: string;
  byUnit: Record<string, UnitTotals>;
  unitlessRows: number;
}

interface IncomeRow {
  type: string;
  unit: string | null;
  total_amount: number | string | null;
  total_fee: number | string | null;
  cnt: number | string | null;
}

const INCOME_TYPES = new Set(['payment', 'stake_return']);
const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

function foldIncome(rows: IncomeRow[], opts: { platformFeeRows?: boolean } = {}): TransactionSummary {
  const unit = pricingUnit().symbol;
  const empty = (): UnitTotals => ({ totalEarned: 0, totalFees: 0, netRevenue: 0, taskCount: 0 });
  const byUnit: Record<string, UnitTotals> = {};
  const headline = empty();
  let unitlessRows = 0;
  for (const row of rows) {
    const income = INCOME_TYPES.has(row.type);
    const feeRow = opts.platformFeeRows === true && row.type === 'fee';
    if (!income && !feeRow) continue;
    const amount = Number(row.total_amount ?? 0);
    const fee = Number(row.total_fee ?? 0);
    const cnt = Number(row.cnt ?? 0);
    const rowUnit = row.unit ?? unit;
    const bucket = (byUnit[rowUnit] ??= empty());
    const targets = row.unit === null || row.unit === unit ? [bucket, headline] : [bucket];
    if (row.unit === null) unitlessRows += cnt;
    for (const t of targets) {
      if (income) {
        t.totalEarned += amount;
        t.totalFees += fee;
        t.taskCount += cnt;
      } else {
        t.totalFees += fee;
      }
    }
  }
  const finish = (t: UnitTotals): UnitTotals => ({
    totalEarned: round(t.totalEarned),
    totalFees: round(t.totalFees),
    netRevenue: round(t.totalEarned - t.totalFees),
    taskCount: t.taskCount,
  });
  return {
    ...finish(headline),
    unit,
    byUnit: Object.fromEntries(Object.entries(byUnit).map(([k, v]) => [k, finish(v)])),
    unitlessRows,
  };
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
  /** The currency the amounts are in ('USDC', '0G'). Omit only when unknown. */
  unit?: string;
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
    unit: tx.unit ?? null,
    status: tx.status ?? 'confirmed',
    tx_hash: tx.txHash ?? null,
  };

  if (usePg()) {
    const pool = await getPool();
    const res = await pool.query(
      `INSERT INTO transactions (address, role, task_id, type, amount, fee, net, unit, status, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [row.address, row.role, row.task_id, row.type, row.amount, row.fee, row.net, row.unit, row.status, row.tx_hash],
    );
    return res.rows[0] as Transaction;
  }

  const db = getDb();
  db.prepare(
    'INSERT INTO transactions (address, role, task_id, type, amount, fee, net, unit, status, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(row.address, row.role, row.task_id, row.type, row.amount, row.fee, row.net, row.unit, row.status, row.tx_hash);

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
  if (addresses.length === 0) return foldIncome([]);
  const lowerAddrs = addresses.map(a => a.toLowerCase());

  if (usePg()) {
    const pool = await getPool();
    const conditions: string[] = ['address = ANY($1::text[])'];
    const params: any[] = [lowerAddrs];
    let idx = 2;
    if (from) { conditions.push(`created_at >= $${idx++}`); params.push(from); }
    if (to) { conditions.push(`created_at <= $${idx++}`); params.push(to); }
    const where = conditions.join(' AND ');
    const rows = await pool.query<IncomeRow>(
      `SELECT type, unit, SUM(amount) as total_amount, SUM(fee) as total_fee, COUNT(*)::int as cnt FROM transactions WHERE ${where} GROUP BY type, unit`,
      params,
    );
    return foldIncome(rows.rows);
  }

  const db = getDb();
  const placeholders = lowerAddrs.map(() => '?').join(',');
  let query = `SELECT type, unit, SUM(amount) as total_amount, SUM(fee) as total_fee, COUNT(*) as cnt FROM transactions WHERE address IN (${placeholders})`;
  const queryParams: (string | number)[] = [...lowerAddrs];
  if (from) { query += ' AND created_at >= ?'; queryParams.push(from); }
  if (to) { query += ' AND created_at <= ?'; queryParams.push(to); }
  query += ' GROUP BY type, unit';
  return foldIncome(db.prepare(query).all(...queryParams) as IncomeRow[]);
}

export interface GlobalStats extends UnitTotals {
  totalVolume: number;
  unit: string;
  byUnit: Record<string, UnitTotals & { totalVolume: number }>;
  unitlessRows: number;
}

/** Platform-wide totals, per unit like getSummary; 'fee' rows add to the fees. */
export async function getGlobalStats(): Promise<GlobalStats> {
  let rows: IncomeRow[];
  if (usePg()) {
    const pool = await getPool();
    rows = (await pool.query<IncomeRow>(
      `SELECT type, unit, SUM(amount) as total_amount, SUM(fee) as total_fee, COUNT(*)::int as cnt FROM transactions GROUP BY type, unit`,
    )).rows;
  } else {
    rows = getDb().prepare(
      `SELECT type, unit, SUM(amount) as total_amount, SUM(fee) as total_fee, COUNT(*) as cnt FROM transactions GROUP BY type, unit`,
    ).all() as IncomeRow[];
  }
  const s = foldIncome(rows, { platformFeeRows: true });
  // Volume processed: a payment row's amount is already GROSS (worker share +
  // platform fee — see workerPayout.ts), so its fee is not added again; a
  // standalone 'fee' row is platform income outside any payment and adds its
  // fee. It used to be totalEarned + totalFees, counting every payment's fee
  // twice. Headline vs byUnit follows foldIncome: other units never mix in.
  const volumeByUnit: Record<string, number> = {};
  let headlineVolume = 0;
  for (const row of rows) {
    const v = INCOME_TYPES.has(row.type) ? Number(row.total_amount ?? 0)
      : row.type === 'fee' ? Number(row.total_fee ?? 0)
      : 0;
    if (!v) continue;
    const rowUnit = row.unit ?? s.unit;
    volumeByUnit[rowUnit] = (volumeByUnit[rowUnit] ?? 0) + v;
    if (row.unit === null || row.unit === s.unit) headlineVolume += v;
  }
  const { byUnit, ...rest } = s;
  return {
    ...rest,
    totalVolume: round(headlineVolume),
    unit: s.unit,
    unitlessRows: s.unitlessRows,
    byUnit: Object.fromEntries(Object.entries(byUnit).map(([k, v]) => [k, { ...v, totalVolume: round(volumeByUnit[k] ?? 0) }])),
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

  const header = 'Date,Task ID,Type,Role,Amount,Fee,Net,Status,Tx Hash,Unit';
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
      tx.unit ?? '',
    ].join(','),
  );

  return [header, ...rows].join('\n');
}
