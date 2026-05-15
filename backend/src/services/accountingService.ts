import { getDb } from './database.js';

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

export function recordTransaction(tx: {
  address: string;
  role: string;
  taskId?: string;
  type: TransactionType;
  amount: number;
  fee?: number;
  net?: number;
  status?: string;
  txHash?: string;
}): Transaction {
  const db = getDb();
  const fee = tx.fee ?? 0;
  const net = tx.net ?? tx.amount - fee;

  db.prepare(
    'INSERT INTO transactions (address, role, task_id, type, amount, fee, net, status, tx_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(tx.address.toLowerCase(), tx.role, tx.taskId ?? null, tx.type, tx.amount, fee, net, tx.status ?? 'confirmed', tx.txHash ?? null);

  return db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 1').get() as Transaction;
}

export function getTransactions(
  address: string,
  from?: string,
  to?: string,
  type?: string,
): { transactions: Transaction[]; total: number } {
  const db = getDb();
  let query = 'SELECT * FROM transactions WHERE address = ?';
  const params: (string | number)[] = [address.toLowerCase()];

  if (from) {
    query += ' AND created_at >= ?';
    params.push(from);
  }
  if (to) {
    query += ' AND created_at <= ?';
    params.push(to);
  }
  if (type) {
    query += ' AND type = ?';
    params.push(type);
  }

  const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as cnt');
  const total = (db.prepare(countQuery).get(...params) as { cnt: number }).cnt;

  query += ' ORDER BY created_at DESC';
  const transactions = db.prepare(query).all(...params) as Transaction[];

  return { transactions, total };
}

export function getSummary(address: string, from?: string, to?: string): TransactionSummary {
  const db = getDb();
  let query = 'SELECT type, SUM(amount) as total_amount, SUM(fee) as total_fee, SUM(net) as total_net, COUNT(*) as cnt FROM transactions WHERE address = ?';
  const params: string[] = [address.toLowerCase()];

  if (from) {
    query += ' AND created_at >= ?';
    params.push(from);
  }
  if (to) {
    query += ' AND created_at <= ?';
    params.push(to);
  }

  query += ' GROUP BY type';
  const rows = db.prepare(query).all(...params) as { type: string; total_amount: number; total_fee: number; total_net: number; cnt: number }[];

  let totalEarned = 0;
  let totalFees = 0;
  let netRevenue = 0;
  let taskCount = 0;

  // Only payment-shaped rows ('payment' = worker payout, 'stake_return' =
  // refund of an earlier stake) count toward earnings/revenue/task count.
  // escrow_lock + refund + stake are CASH MOVEMENTS the user originated, not
  // INCOME — including them previously made escrow locks display as
  // "+$1,009.98 NET REVENUE" on the earnings page, which is the opposite of
  // what the user wants to see (they actually spent that, not earned it).
  const INCOME_TYPES = new Set(['payment', 'stake_return']);

  for (const row of rows) {
    if (!INCOME_TYPES.has(row.type)) continue;
    totalEarned += row.total_amount;
    totalFees += row.total_fee;
    netRevenue += row.total_net;
    taskCount += row.cnt;
  }

  return {
    totalEarned: Math.round(totalEarned * 1_000_000) / 1_000_000,
    totalFees: Math.round(totalFees * 1_000_000) / 1_000_000,
    netRevenue: Math.round(netRevenue * 1_000_000) / 1_000_000,
    taskCount,
  };
}

export function exportCsv(address: string, from?: string, to?: string): string {
  const { transactions } = getTransactions(address, from, to);

  const header = 'Date,Task ID,Type,Role,Amount,Fee,Net,Status,Tx Hash';
  const rows = transactions.map((tx) =>
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
