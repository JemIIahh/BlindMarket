/**
 * Recompute every executor's earnings from the escrows, per currency, and
 * repair agent_executors (Postgres).
 *
 * Why: until Sep 2026 payouts were added into total_earned_raw whatever their
 * currency (18-decimal 0G and 6-decimal USDC together), and every worker
 * restart reset that column to 0 while the task count stayed. USDC now has its
 * own column (migration 33), but rows written before that are wrong. This
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
 * The backend credits payouts as increments and this script writes totals,
 * so a payout the backend credits after this script counted it would count
 * twice. --apply therefore works through the backend's Redis (REDIS_URL).
 * Steps 1-3 write nothing, and refuse the run when they fail:
 *   1. The Redis must belong to these escrows (the indexers' fingerprints).
 *   2. Each chain's ruling scan must pass the blocks read here, with no ruling
 *      retrying or parked, within BACKFILL_LISTENER_WAIT_MS (default 10
 *      minutes), so every counted ruling has closed its task.
 *      --skip-listener-check skips this step only.
 *   3. No counted payout may still be waiting for its settlement route
 *      (a2a state 'submitted' or 'awaiting_verification', not yet credited).
 *      Step 4 would stop that route from crediting it, and the route's other
 *      writes (Earnings ledger row, reputation, sold count, skill stats) would
 *      never happen; this script restores only the totals and task count.
 *      The run lists those tasks; finalize them first, or pass
 *      --claim-pending to accept that.
 *   4. It claims the credit marker (a2a:credited:<taskHash>) of every counted
 *      payout, so no backend path (the settlement routes, the dispute
 *      listener) can credit those tasks afterwards, then waits
 *      BACKFILL_CLAIM_SETTLE_MS (default 30s) so credits already under way
 *      reach the database, where the guarded UPDATE skips their rows.
 * A run that stops after step 4 leaves the payouts it claimed uncounted, and
 * the side effects above unwritten for any still pending, until the next
 * successful run writes the full totals again. Deploy the dispute listener
 * before running this.
 *
 * Usage (from backend/, with the target's env):
 *   DATABASE_URL=postgres://… \
 *   OG_RPC_URL=https://0g-rpc.publicnode.com BLIND_ESCROW_ADDRESS=0x3d03… ESCROW_DEPLOYMENT_BLOCK=33459885 \
 *   BASE_RPC_URL=https://base-sepolia-rpc.publicnode.com BASE_ESCROW_ADDRESS=0xCca5… \
 *   BASE_ESCROW_DEPLOYMENT_BLOCK=46211199 BASE_USDC_ADDRESS=0x036C… \
 *   REDIS_URL=redis://… \
 *   npx tsx scripts/backfill-earnings-by-chain.ts [--apply] [--skip-listener-check] [--claim-pending]
 *
 * With --apply every variable above except the Base ones is required. A dry
 * run falls back to the 0G mainnet values and never reads REDIS_URL. Leave
 * BASE_ESCROW_ADDRESS empty to skip Base. BACKFILL_BLOCK_CHUNK sets the
 * getLogs range (default 10000; halved automatically when an RPC refuses).
 * Run migration 33 first (the backend applies it at boot).
 */

import { config as loadEnv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { Redis } from 'ioredis';
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
const SKIP_LISTENER_CHECK = process.argv.includes('--skip-listener-check');
const CLAIM_PENDING = process.argv.includes('--claim-pending');
/** a2a states in which a settlement route may still credit the task. */
const PENDING_STATES = new Set(['submitted', 'awaiting_verification']);
const LISTENER_WAIT_MS = Number(process.env.BACKFILL_LISTENER_WAIT_MS ?? 10 * 60_000);
const CLAIM_SETTLE_MS = Number(process.env.BACKFILL_CLAIM_SETTLE_MS ?? 30_000);
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const LISTENER_POLL_MS = 15_000;
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
  /** The backend's Redis keys for this chain (services/escrowFingerprint,
   *  disputeKeys, and the indexer that scans DisputeResolved). */
  redisKeys: { fingerprint: string; rulingsScannedTo: string; attempts: string; parked: string };
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
    rpcUrl: APPLY ? required('OG_RPC_URL') : process.env.OG_RPC_URL || 'https://0g-rpc.publicnode.com',
    escrow: APPLY ? required('BLIND_ESCROW_ADDRESS') : process.env.BLIND_ESCROW_ADDRESS || '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff',
    fromBlock: positiveBlock('ESCROW_DEPLOYMENT_BLOCK', APPLY ? undefined : 33_459_885),
    token: NATIVE,
    // 0G scans rulings in its TaskCreated pass, under one checkpoint.
    redisKeys: {
      fingerprint: 'a2a:events:escrow',
      rulingsScannedTo: 'a2a:events:checkpoint',
      attempts: 'a2a:dispute-attempts:*',
      parked: 'a2a:dispute-parked',
    },
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
      redisKeys: {
        fingerprint: 'base:events:escrow',
        rulingsScannedTo: 'base:events:dispute-checkpoint',
        attempts: 'base:dispute-attempts:*',
        parked: 'base:dispute-parked',
      },
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

interface ScannedChain {
  src: EscrowSource;
  chainId: bigint;
  latest: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Why REDIS_URL is not the Redis of the backend indexing this escrow, or null. */
async function fingerprintProblem(redis: Redis, { src, chainId }: ScannedChain): Promise<string | null> {
  const k = src.redisKeys;
  const expected = `${chainId}:${src.escrow.toLowerCase()}`;
  const fingerprint = await redis.get(k.fingerprint);
  if (fingerprint === null) return `${k.fingerprint} is unset: the backend on this Redis predates the dispute listener`;
  if (fingerprint !== expected) return `${k.fingerprint} is ${fingerprint}, not ${expected}: this Redis belongs to another deployment`;
  return null;
}

/** Claim the credit marker of each task. Returns how many were not yet set. */
/** The durable twin of claimCredits: one credited_payouts row per counted task (migration 34). */
async function claimCreditRows(pool: pg.Pool, credits: Map<string, { chain: string; executor: string }>): Promise<number> {
  let inserted = 0;
  const entries = [...credits.entries()];
  for (let i = 0; i < entries.length; i += 500) {
    const chunk = entries.slice(i, i + 500);
    const { rowCount } = await pool.query(
      `INSERT INTO credited_payouts (task_hash, chain, executor)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[])
       ON CONFLICT (task_hash) DO NOTHING`,
      [chunk.map(([h]) => h), chunk.map(([, c]) => c.chain), chunk.map(([, c]) => c.executor.toLowerCase())],
    );
    inserted += rowCount ?? 0;
  }
  return inserted;
}

async function claimCredits(redis: Redis, taskHashes: Set<string>): Promise<number> {
  let claimed = 0;
  const hashes = [...taskHashes];
  for (let i = 0; i < hashes.length; i += 500) {
    const pipe = redis.pipeline();
    for (const h of hashes.slice(i, i + 500)) pipe.set(`a2a:credited:${h}`, 'backfill', 'NX');
    for (const [err, reply] of (await pipe.exec()) ?? []) {
      if (err) throw err;
      if (reply === 'OK') claimed++;
    }
  }
  return claimed;
}

/** Counted tasks a settlement route may still credit (see step 3). */
async function pendingCredits(redis: Redis, taskHashes: Set<string>): Promise<string[]> {
  // State keys are lowercased, except for legacy tasks stored under the hash
  // as posted (see a2aStore). The chain only gives the hash, not its casing,
  // so find those keys once.
  const legacyStateKey = new Map<string, string>();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'a2a:state:0x*', 'COUNT', 1000);
    for (const key of keys) {
      const hash = key.slice('a2a:state:'.length);
      if (hash !== hash.toLowerCase()) legacyStateKey.set(hash.toLowerCase(), key);
    }
    cursor = next;
  } while (cursor !== '0');

  const pending: string[] = [];
  const hashes = [...taskHashes];
  for (let i = 0; i < hashes.length; i += 500) {
    const batch = hashes.slice(i, i + 500);
    const pipe = redis.pipeline();
    for (const h of batch) {
      pipe.get(`a2a:state:${h}`);
      pipe.get(legacyStateKey.get(h) ?? `a2a:state:${h}`);
      pipe.exists(`a2a:credited:${h}`);
    }
    const replies = (await pipe.exec()) ?? [];
    batch.forEach((h, j) => {
      const [stateErr, rawState] = replies[3 * j];
      const [legacyErr, rawLegacyState] = replies[3 * j + 1];
      const [creditedErr, credited] = replies[3 * j + 2];
      if (stateErr) throw stateErr;
      if (legacyErr) throw legacyErr;
      if (creditedErr) throw creditedErr;
      const raw = typeof rawState === 'string' ? rawState : rawLegacyState;
      if (credited === 1 || typeof raw !== 'string') return;
      let status: unknown;
      try {
        status = (JSON.parse(raw) as { status?: unknown }).status;
      } catch {
        return;
      }
      if (typeof status === 'string' && PENDING_STATES.has(status)) pending.push(`${h} (${status})`);
    });
  }
  return pending;
}

/** Why a ruling this run counted may not have closed its task yet, or null. */
async function listenerLag(redis: Redis, { src, latest }: ScannedChain): Promise<string | null> {
  const k = src.redisKeys;
  const scannedTo = Number(await redis.get(k.rulingsScannedTo));
  if (!(scannedTo >= latest)) return `${k.rulingsScannedTo} is ${scannedTo || 'unset'}, below block ${latest}`;

  const parked = await redis.hlen(k.parked);
  if (parked > 0) return `${parked} ruling(s) parked in ${k.parked}`;
  // SCAN can return nothing on a round and still match later, so walk it all.
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', k.attempts, 'COUNT', 1000);
    if (keys.length > 0) return `ruling(s) still retrying: ${keys.join(', ')}`;
    cursor = next;
  } while (cursor !== '0');
  return null;
}

/** Problems per chain, labelled; empty when there are none. */
async function problems(
  scanned: ScannedChain[],
  check: (c: ScannedChain) => Promise<string | null>,
): Promise<string[]> {
  return (await Promise.all(scanned.map(check)))
    .map((problem, i) => problem && `${scanned[i].src.label}: ${problem}`)
    .filter((problem): problem is string => !!problem);
}

async function waitForListeners(redis: Redis, scanned: ScannedChain[]): Promise<void> {
  const deadline = Date.now() + LISTENER_WAIT_MS;
  for (;;) {
    const lags = await problems(scanned, (c) => listenerLag(redis, c));
    if (lags.length === 0) {
      console.log('  listeners have scanned every block read here, none retrying or parked');
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `rulings counted here may not have closed their tasks yet, so nothing was written ` +
          `(the credit markers stay claimed; re-run once this clears):\n  ${lags.join('\n  ')}`,
      );
    }
    console.log(`  waiting for listeners: ${lags.join('; ')}`);
    await sleep(LISTENER_POLL_MS);
  }
}

/** Steps 1–4 of --apply (see the header). Throws when nothing may be written. */
async function prepareApply(
  scanned: ScannedChain[],
  taskHashes: Set<string>,
  credits: Map<string, { chain: string; executor: string }>,
  pool: pg.Pool,
): Promise<void> {
  const redis = new Redis(required('REDIS_URL'), { lazyConnect: true, maxRetriesPerRequest: 3 });
  try {
    const wrongRedis = await problems(scanned, (c) => fingerprintProblem(redis, c));
    if (wrongRedis.length > 0) {
      throw new Error(`REDIS_URL does not belong to these escrows, so nothing was written:\n  ${wrongRedis.join('\n  ')}`);
    }

    if (SKIP_LISTENER_CHECK) {
      console.log('  listeners NOT checked (--skip-listener-check)');
    } else {
      await waitForListeners(redis, scanned);
    }

    const pending = await pendingCredits(redis, taskHashes);
    if (pending.length > 0) {
      const list = pending.join('\n  ');
      if (!CLAIM_PENDING) {
        throw new Error(
          `${pending.length} counted task(s) still await their settlement route, so nothing was written. ` +
            `Finalize them first, or pass --claim-pending to skip their ledger, reputation and skill-stat writes:\n  ${list}`,
        );
      }
      console.log(`  --claim-pending: these tasks will not get their route's other writes:\n  ${list}`);
    }

    const claimed = await claimCredits(redis, taskHashes);
    const rows = await claimCreditRows(pool, credits);
    console.log(
      `  claimed ${claimed} credit marker(s) and ${rows} database credit row(s); ` +
        `${taskHashes.size - claimed} task(s) were already credited. ` +
        `Waiting ${CLAIM_SETTLE_MS / 1000}s for credits under way.`,
    );
    await sleep(CLAIM_SETTLE_MS);
  } finally {
    redis.disconnect();
  }
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
  if (cols.length === 0) throw new Error('agent_executors.total_earned_usdc_raw is missing: boot the backend once so migration 33 runs');

  const { rows: accounts } = await pool.query<{ wallet_address: string; smart_account_address: string }>(
    'SELECT wallet_address, smart_account_address FROM deployed_agents WHERE smart_account_address IS NOT NULL',
  );
  const walletBySmartAccount = new Map(accounts.map((a) => [a.smart_account_address.toLowerCase(), a.wallet_address.toLowerCase()]));

  // Read before scanning: the guarded UPDATE below then also skips a row that
  // a payout changed while the chains were being read.
  const { rows } = await pool.query<{ address: string; tasks_completed: number; total_earned_raw: string; total_earned_usdc_raw: string }>(
    'SELECT address, tasks_completed, total_earned_raw, total_earned_usdc_raw FROM agent_executors ORDER BY address',
  );

  const totals = new Map<string, ChainEarnings>();
  const scanned: ScannedChain[] = [];
  const countedTaskHashes = new Set<string>();
  // Durable credit rows (services/creditLedger.ts) for the same tasks, so a
  // Redis snapshot restore cannot re-credit what this run counted.
  const countedCredits = new Map<string, { chain: string; executor: string }>();
  for (const src of sources()) {
    const provider = new JsonRpcProvider(src.rpcUrl);
    const escrow = new Contract(src.escrow, ESCROW_ABI, provider);
    const [network, latest] = await Promise.all([provider.getNetwork(), provider.getBlockNumber()]);
    console.log(`  ${src.label.padEnd(9)} chain ${network.chainId}, escrow ${src.escrow}, blocks ${src.fromBlock}..${latest}`);
    scanned.push({ src, chainId: network.chainId, latest });

    const payouts = await scanPayouts(src, escrow, latest);
    let counted = 0;
    for (const [taskId, payout] of payouts) {
      const t = await escrow.getTask(taskId);
      if (getAddress(t.token) !== getAddress(src.token)) {
        console.log(`  ${src.label}: task ${taskId} paid in ${t.token}, not ${src.token}; not counted`);
        continue;
      }
      const executor = executorFor(t.worker, walletBySmartAccount);
      addPayout(totals, executor, src.unit, payout);
      const taskHash = String(t.taskHash).toLowerCase();
      if (taskHash !== ZERO_HASH) {
        countedTaskHashes.add(taskHash);
        countedCredits.set(taskHash, { chain: src.label === 'Base' ? 'base' : '0g', executor });
      }
      counted++;
    }
    console.log(`  ${src.label.padEnd(9)} ${payouts.size} TaskCompleted, ${counted} counted`);
  }

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

  await prepareApply(scanned, countedTaskHashes, countedCredits, pool);

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
