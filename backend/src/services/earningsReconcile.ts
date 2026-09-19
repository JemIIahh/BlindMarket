/**
 * Executor earnings as the escrows record them, compared with what
 * agent_executors stores. Pure; scripts/backfill-earnings-by-chain.ts does the
 * chain and database I/O around it.
 *
 * Every payout to a worker emits TaskCompleted(taskId, workerPayout, fee),
 * including admin-resolved disputes won by the worker, so summing workerPayout
 * per worker and per escrow gives what each executor was actually paid. The
 * stored totals can differ because payouts were once added into one column
 * regardless of currency, restarts reset them to 0, and the live credit
 * subtracts sandbox compute cost, which the chain doesn't.
 */

export type EarningsUnit = '0G' | 'USDC';

export interface ChainEarnings {
  native: bigint;
  usdc: bigint;
  tasks: number;
}

export interface StoredEarnings {
  address: string;
  tasksCompleted: number;
  totalEarnedRaw: string;
  totalEarnedUsdcRaw: string;
}

export interface EarningsValues {
  tasksCompleted: number;
  totalEarnedRaw: string;
  totalEarnedUsdcRaw: string;
}

export interface EarningsFix {
  /** Lowercased, as the chain totals are keyed. */
  address: string;
  /** The stored values exactly as read, including the address as stored,
   *  so a guarded update can match the row. */
  stored: EarningsValues & { address: string };
  to: EarningsValues;
}

/** A stored amount, or null when it isn't a plain non-negative integer. */
function asAmount(raw: string): bigint | null {
  return /^[0-9]+$/.test(raw) ? BigInt(raw) : null;
}

/** Add one on-chain payout to `totals`, keyed by the lowercased executor. */
export function addPayout(
  totals: Map<string, ChainEarnings>,
  executor: string,
  unit: EarningsUnit,
  amount: bigint,
): void {
  const key = executor.toLowerCase();
  const cur = totals.get(key) ?? { native: 0n, usdc: 0n, tasks: 0 };
  if (unit === 'USDC') cur.usdc += amount;
  else cur.native += amount;
  cur.tasks += 1;
  totals.set(key, cur);
}

/**
 * The executor a payout belongs to. Base agents with a smart account are
 * recorded on-chain as that account, but their earnings are booked to the
 * agent's wallet.
 */
export function executorFor(worker: string, walletBySmartAccount: Map<string, string>): string {
  const w = worker.toLowerCase();
  return (walletBySmartAccount.get(w) ?? w).toLowerCase();
}

/**
 * The stored rows that disagree with the chain, and what they should become.
 * Earnings are taken from the chain. The task count only ever goes up: a
 * stored count can include completions the scan doesn't cover.
 */
export function reconcileEarnings(
  stored: StoredEarnings[],
  chain: Map<string, ChainEarnings>,
): { fixes: EarningsFix[]; unchanged: number; unregistered: string[] } {
  const fixes: EarningsFix[] = [];
  let unchanged = 0;
  const known = new Set<string>();
  for (const row of stored) {
    const address = row.address.toLowerCase();
    known.add(address);
    const c = chain.get(address) ?? { native: 0n, usdc: 0n, tasks: 0 };
    const to: EarningsValues = {
      tasksCompleted: Math.max(row.tasksCompleted, c.tasks),
      totalEarnedRaw: c.native.toString(),
      totalEarnedUsdcRaw: c.usdc.toString(),
    };
    const same = row.tasksCompleted === to.tasksCompleted
      && asAmount(row.totalEarnedRaw) === c.native
      && asAmount(row.totalEarnedUsdcRaw) === c.usdc;
    if (same) unchanged++;
    else fixes.push({ address, stored: { ...row }, to });
  }
  const unregistered = [...chain.keys()].filter((a) => !known.has(a)).sort();
  return { fixes, unchanged, unregistered };
}
