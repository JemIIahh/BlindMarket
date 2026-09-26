/**
 * One-shot backfill that re-derives the accounting ledger's payment rows from
 * on-chain truth, repairing the gross/fee/net inconsistency that zeroed out
 * "Net revenue" on the Earnings page.
 *
 * Background — two payout paths wrote `transactions` rows with different,
 * mutually inconsistent conventions before commit b5c416b:
 *
 *   - a2a.ts (autonomous flow) recorded amount = workerShare (already net of
 *     fee) with no explicit `net`, so recordTransaction defaulted
 *     net = amount − fee and subtracted the 15% fee a SECOND time.
 *   - submissions.ts (manual verify) recorded amount = gross but fee = 1% of
 *     amount — a hardcoded rate, when the real on-chain fee is 15%.
 *
 * You cannot tell a buggy row from a correct one by its stored values alone:
 * both satisfy net = amount − fee. So this script ignores the stored numbers
 * and recomputes from the contract for every `type = 'payment'` row:
 *
 *     gross = BlindEscrow.getTask(taskId).amount   (full escrow, in token units)
 *     fee   = gross × feeBps / 10_000              (on-chain platform fee)
 *     net   = gross − fee                          (worker take-home)
 *
 * Because it derives from chain state (which never changes for a settled task),
 * it is fully idempotent: re-running produces identical values and is safe on
 * rows already written by the corrected code.
 *
 * SAFE BY DEFAULT: dry-run. It prints every change it WOULD make and the net
 * effect on the Earnings totals, but writes nothing unless you pass --apply.
 *
 * Usage:
 *   cd backend
 *
 *   # Dry-run against the prod mainnet DB (default RPC + escrow are mainnet):
 *   npx tsx scripts/backfill-accounting-net.ts
 *
 *   # Apply the changes (wrapped in a single SQLite transaction):
 *   npx tsx scripts/backfill-accounting-net.ts --apply
 *
 *   # Point at a specific DB / chain when the defaults don't match your env:
 *   DB_PATH=/srv/blindmarket/data/blindmarket.db \
 *   OG_RPC_URL=https://0g-rpc.publicnode.com \
 *   BLIND_ESCROW_ADDRESS=0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff \
 *   npx tsx scripts/backfill-accounting-net.ts --apply
 *
 * Notes:
 *   - Defaults read the same env vars the backend uses (OG_RPC_URL,
 *     BLIND_ESCROW_ADDRESS), so on a host with a populated .env it targets that
 *     host's chain. RPC and escrow must be the SAME network or feeBps reverts.
 *   - Run it where the prod DB file actually lives (or set DB_PATH). SQLite WAL
 *     allows this to run while the backend is up, but prefer a quiet window.
 *   - Only `type = 'payment'` rows are touched. 'stake_return' (fee-free) and
 *     the separate 'fee'-type platform-revenue rows are left as-is.
 */

import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonRpcProvider, Contract, formatUnits } from 'ethers';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env') });

const APPLY = process.argv.includes('--apply');
const DB_PATH = process.env.DB_PATH ?? path.resolve(__dirname, '../data/blindmarket.db');
// Read the SAME env vars the backend uses (config.ogRpcUrl / config.blindEscrowAddress)
// so running this on a host with a populated .env targets that host's chain
// automatically. RPC and escrow MUST be the same network — a mismatch makes
// getTask/feeBps revert (e.g. the mainnet escrow address is BlindReputation on
// testnet, which has no feeBps()).
const OG_RPC_URL = process.env.OG_RPC_URL ?? 'https://0g-rpc.publicnode.com';
const ESCROW_ADDRESS =
  process.env.BLIND_ESCROW_ADDRESS ??
  process.env.ESCROW_ADDRESS ??
  '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff';

// Smallest unit we persist — round to nano-0G to keep doubles free of float
// noise (e.g. 0.050999999998) while preserving every realistic amount.
const PRECISION = 1e9;
const round = (n: number) => Math.round(n * PRECISION) / PRECISION;
// Below this, a recomputed value is considered unchanged from the stored one.
const EPSILON = 1 / PRECISION;

const ESCROW_ABI = [
  'function feeBps() view returns (uint256)',
  'function getTask(uint256 taskId) view returns (tuple(address agent, address worker, address token, uint256 amount, bytes32 taskHash, bytes32 evidenceHash, uint8 status, string category, string locationZone, uint256 createdAt, uint256 deadline, uint8 submissionAttempts))',
];
const ERC20_ABI = ['function decimals() view returns (uint8)'];

interface PaymentRow {
  id: number;
  task_id: string | null;
  address: string;
  amount: number;
  fee: number;
  net: number;
}

const NATIVE = '0x0000000000000000000000000000000000000000';
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 6 });

async function main(): Promise<void> {
  const provider = new JsonRpcProvider(OG_RPC_URL);
  const escrow = new Contract(ESCROW_ADDRESS, ESCROW_ABI, provider);

  const network = await provider.getNetwork();
  let feeBps: number;
  try {
    feeBps = Number(await escrow.feeBps());
  } catch {
    console.error(
      `feeBps() reverted at ${ESCROW_ADDRESS} on chain ${network.chainId}.\n` +
        'This almost always means OG_RPC_URL and the escrow address are on different\n' +
        'networks. Set BLIND_ESCROW_ADDRESS + OG_RPC_URL to the same chain (mainnet:\n' +
        '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff @ https://0g-rpc.publicnode.com).',
    );
    process.exit(1);
  }
  const feeRatio = feeBps / 10_000;

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const rows = db
    .prepare("SELECT id, task_id, address, amount, fee, net FROM transactions WHERE type = 'payment' ORDER BY id")
    .all() as PaymentRow[];

  console.log('Accounting net-revenue backfill');
  console.log(`  mode      ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes — pass --apply to commit)'}`);
  console.log(`  db        ${DB_PATH}`);
  console.log(`  rpc       ${OG_RPC_URL}`);
  console.log(`  chain     ${network.chainId}`);
  console.log(`  escrow    ${ESCROW_ADDRESS}`);
  console.log(`  feeBps    ${feeBps} (${(feeRatio * 100).toFixed(2)}%)`);
  console.log(`  payments  ${rows.length} rows`);
  console.log('');

  const decimalsCache = new Map<string, number>();
  async function decimalsFor(token: string): Promise<number> {
    const key = token.toLowerCase();
    if (key === NATIVE) return 18;
    if (decimalsCache.has(key)) return decimalsCache.get(key)!;
    const d = Number(await new Contract(token, ERC20_ABI, provider).decimals());
    decimalsCache.set(key, d);
    return d;
  }

  const updates: { id: number; amount: number; fee: number; net: number; row: PaymentRow }[] = [];
  let skipped = 0;
  let unchanged = 0;

  for (const row of rows) {
    const idNum = Number(row.task_id);
    if (!row.task_id || !Number.isInteger(idNum)) {
      console.log(`  skip   #${row.id} — non-numeric task_id ${JSON.stringify(row.task_id)}`);
      skipped++;
      continue;
    }
    let task;
    try {
      task = await escrow.getTask(idNum);
    } catch (e) {
      console.log(`  skip   #${row.id} task ${idNum} — getTask failed: ${(e as Error).message.slice(0, 80)}`);
      skipped++;
      continue;
    }
    const decimals = await decimalsFor(task.token);
    const gross = Number(formatUnits(task.amount, decimals));
    const amount = round(gross);
    const fee = round(gross * feeRatio);
    const net = round(gross - gross * feeRatio);

    const changed =
      Math.abs(amount - row.amount) > EPSILON ||
      Math.abs(fee - row.fee) > EPSILON ||
      Math.abs(net - row.net) > EPSILON;

    if (!changed) {
      unchanged++;
      continue;
    }
    updates.push({ id: row.id, amount, fee, net, row });
    console.log(
      `  fix    #${row.id} task ${idNum}  ` +
        `amount ${fmt(row.amount)}→${fmt(amount)}  fee ${fmt(row.fee)}→${fmt(fee)}  net ${fmt(row.net)}→${fmt(net)}`,
    );
  }

  const delta = (sel: (u: (typeof updates)[number]) => number, old: (r: PaymentRow) => number) =>
    updates.reduce((s, u) => s + (sel(u) - old(u.row)), 0);

  console.log('');
  console.log('Summary');
  console.log(`  to fix       ${updates.length}`);
  console.log(`  unchanged    ${unchanged}`);
  console.log(`  skipped      ${skipped}`);
  console.log(`  Δ totalEarned ${fmt(round(delta((u) => u.amount, (r) => r.amount)))} 0G`);
  console.log(`  Δ totalFees   ${fmt(round(delta((u) => u.fee, (r) => r.fee)))} 0G`);
  console.log(`  Δ netRevenue  ${fmt(round(delta((u) => u.net, (r) => r.net)))} 0G`);
  console.log('');

  if (!APPLY) {
    console.log('Dry-run only — nothing written. Re-run with --apply to commit these changes.');
    db.close();
    return;
  }

  const stmt = db.prepare('UPDATE transactions SET amount = ?, fee = ?, net = ? WHERE id = ?');
  const applyAll = db.transaction((items: typeof updates) => {
    for (const u of items) stmt.run(u.amount, u.fee, u.net, u.id);
  });
  applyAll(updates);

  console.log(`Applied ${updates.length} row update(s).`);
  db.close();
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
