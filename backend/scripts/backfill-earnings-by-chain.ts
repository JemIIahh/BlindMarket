/**
 * Recompute every executor's earnings from the escrows, per currency, and
 * repair agent_executors (Postgres).
 *
 * Why: until Sep 2026 payouts were added into total_earned_raw whatever their
 * currency (18-decimal 0G and 6-decimal USDC together), and every worker
 * restart reset that column to 0 while the task count stayed. USDC now has its
 * own column (migration 32), but rows written before that are wrong. This
 * script sums TaskCompleted.workerPayout per worker on each escrow and writes:
 *
 *   total_earned_raw       = Σ payouts on the 0G escrow (native 0G, 18 dp)
 *   total_earned_usdc_raw  = Σ payouts on the Base escrow (USDC, 6 dp)
 *   tasks_completed        = max(stored, number of those payouts)
 *
 * It replaces scripts/backfill-executor-earnings.ts, which still targets the
 * Redis agent store (gone since 9349b6e) and 0G only.
 *
 * The chain total is what each worker was paid. It can be slightly above the
 * live credit, which subtracts sandbox compute cost.
 *
 * SAFE BY DEFAULT: prints what it would change. Pass --apply to write. A row
 * that changes while the script runs (a payout lands) is skipped and
 * reported; re-run to pick it up.
 *
 * Usage (from backend/, with the target's env):
 *   DATABASE_URL=postgres://… \
 *   OG_RPC_URL=https://evmrpc.0g.ai BLIND_ESCROW_ADDRESS=0x3d03… ESCROW_DEPLOYMENT_BLOCK=33459885 \
 *   BASE_RPC_URL=https://sepolia.base.org BASE_ESCROW_ADDRESS=0xCca5… \
 *   BASE_ESCROW_DEPLOYMENT_BLOCK=46211199 BASE_USDC_ADDRESS=0x036C… \
 *   npx tsx scripts/backfill-earnings-by-chain.ts [--apply]
 *
 * With --apply every variable above except the Base ones is required (a dry
 * run falls back to the 0G mainnet values). Leave BASE_ESCROW_ADDRESS empty
 * to skip Base. BACKFILL_BLOCK_CHUNK sets the
 * getLogs range (default 10000; halved automatically when an RPC refuses).
 * Run migration 32 first (the backend applies it at boot).
 */

import { config as loadEnv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { Contract, JsonRpcProvider, getAddress, type EventLog } from 'ethers';
import {
  addPayout,
  executorFor,
  reconcileEarnings,
  type ChainEarnings,
  type EarningsUnit,
  type StoredEarnings,
} from '../src/services/earningsReconcile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '../.env') });

const APPLY = process.argv.includes('--apply');
const CHUNK = Number(process.env.BACKFILL_BLOCK_CHUNK ?? 10_000);
const MIN_CHUNK = 500;
const NATIVE = '0x0000000000000000000000000000000000000000';

const ESCROW_ABI = [
  'event TaskCompleted(uint256 indexed taskId, uint256 workerPayout, uint256 platformFee)',
  'function getTask(uint256 taskId) view returns (tuple(address agent, address worker, address token, uint256 amount, bytes32 taskHash, bytes32 evidenceHash, uint8 status, string category, string locationZone, uint256 createdAt, uint256 deadline, uint8 submissionAttempts))',
];

interface EscrowSource {
  label: string;
  unit: EarningsUnit;
  rpcUrl: string;
  escrow: string;
  fromBlock: number;
  /** The only token this escrow's payouts may be in. */
  token: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function positiveBlock(name: string, fallback?: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (n === undefined || !Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${name} must be a block number${fallback === undefined ? ' (required)' : ''}`);
  }
  return n;
}

function sources(): EscrowSource[] {
  // A dry run may use the 0G mainnet defaults; --apply writes, so it must be
  // told which chain the database belongs to.
  const list: EscrowSource[] = [{
    label: '0G',
    unit: '0G',
    rpcUrl: APPLY ? required('OG_RPC_URL') : process.env.OG_RPC_URL || 'https://evmrpc.0g.ai',
    escrow: APPLY ? required('BLIND_ESCROW_ADDRESS') : process.env.BLIND_ESCROW_ADDRESS || '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff',
    fromBlock: positiveBlock('ESCROW_DEPLOYMENT_BLOCK', APPLY ? undefined : 33_459_885),
    token: NATIVE,
  }];
  const baseEscrow = process.env.BASE_ESCROW_ADDRESS;
  if (baseEscrow) {
    list.push({
      label: 'Base',
      unit: 'USDC',
      rpcUrl: required('BASE_RPC_URL'),
      escrow: baseEscrow,
      fromBlock: positiveBlock('BASE_ESCROW_DEPLOYMENT_BLOCK'),
      token: required('BASE_USDC_ADDRESS'),
    });
  }
  return list;
}

/** TaskCompleted payouts on one escrow, keyed by task id. */
async function scanPayouts(src: EscrowSource, escrow: Contract, latest: number): Promise<Map<bigint, bigint>> {
  const payouts = new Map<bigint, bigint>();
  const filter = escrow.filters.TaskCompleted();
  let chunk = CHUNK;
  for (let from = src.fromBlock; from <= latest;) {
    const to = Math.min(latest, from + chunk - 1);
    let events;
    try {
      events = await escrow.queryFilter(filter, from, to);
    } catch (e) {
      if (chunk <= MIN_CHUNK) throw e;
      chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2));
      console.log(`  ${src.label}: getLogs ${from}..${to} failed (${(e as Error).message.slice(0, 80)}); retrying with ${chunk} blocks`);
      continue;
    }
    for (const ev of events) {
      const args = (ev as EventLog).args;
      if (args) payouts.set(args.taskId as bigint, args.workerPayout as bigint);
    }
    from = to + 1;
  }
  return payouts;
}

async function main(): Promise<void> {
  const pool = new pg.Pool({
    connectionString: required('DATABASE_URL'),
    ssl: /[?&]sslmode=disable\b/.test(process.env.DATABASE_URL ?? '') ? false : { rejectUnauthorized: false },
  });

  console.log('Executor earnings backfill (per currency)');
  console.log(`  mode      ${APPLY ? 'APPLY (writes agent_executors)' : 'DRY-RUN (no writes; pass --apply to commit)'}`);
  console.log(`  database  ${(process.env.DATABASE_URL ?? '').replace(/\/\/[^@]*@/, '//***@').replace(/\?.*$/, '')}`);

  const { rows: cols } = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_executors' AND column_name = 'total_earned_usdc_raw'",
  );
  if (cols.length === 0) throw new Error('agent_executors.total_earned_usdc_raw is missing: boot the backend once so migration 32 runs');

  const { rows: accounts } = await pool.query<{ wallet_address: string; smart_account_address: string }>(
    'SELECT wallet_address, smart_account_address FROM deployed_agents WHERE smart_account_address IS NOT NULL',
  );
  const walletBySmartAccount = new Map(accounts.map((a) => [a.smart_account_address.toLowerCase(), a.wallet_address.toLowerCase()]));

  const totals = new Map<string, ChainEarnings>();
  for (const src of sources()) {
    const provider = new JsonRpcProvider(src.rpcUrl);
    const escrow = new Contract(src.escrow, ESCROW_ABI, provider);
    const [network, latest] = await Promise.all([provider.getNetwork(), provider.getBlockNumber()]);
    console.log(`  ${src.label.padEnd(9)} chain ${network.chainId}, escrow ${src.escrow}, blocks ${src.fromBlock}..${latest}`);

    const payouts = await scanPayouts(src, escrow, latest);
    let counted = 0;
    for (const [taskId, payout] of payouts) {
      const t = await escrow.getTask(taskId);
      if (getAddress(t.token) !== getAddress(src.token)) {
        console.log(`  ${src.label}: task ${taskId} paid in ${t.token}, not ${src.token}; not counted`);
        continue;
      }
      addPayout(totals, executorFor(t.worker, walletBySmartAccount), src.unit, payout);
      counted++;
    }
    console.log(`  ${src.label.padEnd(9)} ${payouts.size} TaskCompleted, ${counted} counted`);
  }

  const { rows } = await pool.query<{ address: string; tasks_completed: number; total_earned_raw: string; total_earned_usdc_raw: string }>(
    'SELECT address, tasks_completed, total_earned_raw, total_earned_usdc_raw FROM agent_executors ORDER BY address',
  );
  const stored: StoredEarnings[] = rows.map((r) => ({
    address: r.address,
    tasksCompleted: r.tasks_completed,
    totalEarnedRaw: r.total_earned_raw,
    totalEarnedUsdcRaw: r.total_earned_usdc_raw,
  }));
  const { fixes, unchanged, unregistered } = reconcileEarnings(stored, totals);

  console.log('');
  for (const f of fixes) {
    console.log(`  fix ${f.address}`);
    console.log(`      tasks  ${f.stored.tasksCompleted} -> ${f.to.tasksCompleted}`);
    console.log(`      0G     ${f.stored.totalEarnedRaw || "''"} -> ${f.to.totalEarnedRaw}`);
    console.log(`      USDC   ${f.stored.totalEarnedUsdcRaw || "''"} -> ${f.to.totalEarnedUsdcRaw}`);
  }
  for (const a of unregistered) console.log(`  paid on-chain but not an executor: ${a} (${JSON.stringify(totals.get(a), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))})`);
  console.log('');
  console.log(`Summary: ${fixes.length} to fix, ${unchanged} unchanged, ${unregistered.length} unregistered`);

  if (!APPLY) {
    console.log('Dry-run only; nothing written. Re-run with --apply to commit.');
    await pool.end();
    return;
  }

  let applied = 0;
  const moved: string[] = [];
  for (const f of fixes) {
    // Only if the row still holds what was read: a payout that landed during
    // the scan must not be overwritten.
    const { rowCount } = await pool.query(
      `UPDATE agent_executors
          SET tasks_completed = $2, total_earned_raw = $3, total_earned_usdc_raw = $4, updated_at = NOW()
        WHERE address = $1 AND tasks_completed = $5 AND total_earned_raw = $6 AND total_earned_usdc_raw = $7`,
      [f.stored.address, f.to.tasksCompleted, f.to.totalEarnedRaw, f.to.totalEarnedUsdcRaw,
        f.stored.tasksCompleted, f.stored.totalEarnedRaw, f.stored.totalEarnedUsdcRaw],
    );
    if (rowCount) applied++;
    else moved.push(f.address);
  }
  console.log(`Applied ${applied} fix(es).`);
  if (moved.length > 0) console.log(`Changed during the run, not written (re-run): ${moved.join(', ')}`);
  await pool.end();
}

main().catch((e) => {
  console.error('fatal:', (e as Error).message);
  process.exit(1);
});
