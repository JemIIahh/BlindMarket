/**
 * reclaim-funded-tasks — cancel your own still-Funded (never-accepted) tasks on
 * BlindEscrow, refunding the escrow and removing them from the marketplace.
 *
 * Why: test posts made against the LIVE mainnet contracts that no agent ever
 * accepted sit in `Funded` status forever. They count toward the sidebar's
 * "open tasks", show in the task feed, and keep their escrow locked. The clean
 * fix is to cancel them at the source — `BlindEscrow.cancelTask`:
 *   - onlyAgent (only the original poster can call it — you can ONLY ever
 *     cancel tasks you posted, so this script is safe by construction),
 *   - requires status == Funded (no deadline wait needed),
 *   - refunds the full amount to you and fires TaskRegistry.closeTask, which
 *     decrements openTaskCount → the sidebar count drops accordingly.
 *
 * SAFE BY DEFAULT: dry-run. Lists exactly which tasks would be cancelled and
 * the total refund; sends nothing without --execute. Idempotent — re-running
 * only picks up whatever is still Funded.
 *
 * Usage:
 *   cd backend
 *
 *   # Keyless preview — which Funded tasks does a given poster have? (read-only)
 *   npx tsx scripts/reclaim-funded-tasks.ts --poster 0x2f8b1177c83623a560B26B38dE984e154b123D75
 *
 *   # Dry-run for the wallet behind PRIVATE_KEY (derives poster from the key):
 *   PRIVATE_KEY=0x... npx tsx scripts/reclaim-funded-tasks.ts
 *
 *   # Actually cancel them (sends one cancelTask tx per task):
 *   PRIVATE_KEY=0x... npx tsx scripts/reclaim-funded-tasks.ts --execute
 *
 * Defaults target MAINNET (OG_RPC_URL / BLIND_ESCROW_ADDRESS override either).
 * PRIVATE_KEY must be the poster of the tasks (the deployer wallet for the
 * test posts) — cancelTask reverts for anyone else.
 */

import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { JsonRpcProvider, Contract, Wallet, formatUnits } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env') });

const EXECUTE = process.argv.includes('--execute');
const posterArgIdx = process.argv.indexOf('--poster');
const POSTER_ARG = posterArgIdx >= 0 ? process.argv[posterArgIdx + 1] : undefined;

const OG_RPC_URL = process.env.OG_RPC_URL ?? 'https://evmrpc.0g.ai';
const ESCROW_ADDRESS =
  process.env.BLIND_ESCROW_ADDRESS ??
  process.env.ESCROW_ADDRESS ??
  '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff';
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const ESCROW_ABI = [
  'function nextTaskId() view returns (uint256)',
  'function getTask(uint256) view returns (tuple(address agent, address worker, address token, uint256 amount, bytes32 taskHash, bytes32 evidenceHash, uint8 status, string category, string locationZone, uint256 createdAt, uint256 deadline, uint8 submissionAttempts))',
  'function cancelTask(uint256 taskId)',
];

const FUNDED = 0; // TaskStatus.Funded

async function main(): Promise<void> {
  const provider = new JsonRpcProvider(OG_RPC_URL);
  const network = await provider.getNetwork();

  // Determine whose tasks we're acting on. --execute needs a signing key;
  // dry-run can preview any --poster address with no key at all.
  let signer: Wallet | null = null;
  let poster: string;
  if (PRIVATE_KEY) {
    signer = new Wallet(PRIVATE_KEY, provider);
    poster = signer.address;
  } else if (POSTER_ARG) {
    poster = POSTER_ARG;
  } else {
    console.error('Provide PRIVATE_KEY (to cancel) or --poster <addr> (to preview). Aborting.');
    process.exit(1);
  }
  if (EXECUTE && !signer) {
    console.error('--execute requires PRIVATE_KEY (the poster wallet). Aborting.');
    process.exit(1);
  }

  const escrow = new Contract(ESCROW_ADDRESS, ESCROW_ABI, signer ?? provider);
  const next = Number(await escrow.nextTaskId());
  const posterLc = poster.toLowerCase();

  console.log('Reclaim funded (open) tasks');
  console.log(`  mode      ${EXECUTE ? 'EXECUTE (sends cancelTask txs)' : 'DRY-RUN (no txs — pass --execute to cancel)'}`);
  console.log(`  rpc       ${OG_RPC_URL}`);
  console.log(`  chain     ${network.chainId}`);
  console.log(`  escrow    ${ESCROW_ADDRESS}`);
  console.log(`  poster    ${poster}${signer ? ' (from PRIVATE_KEY)' : ' (--poster, read-only)'}`);
  console.log(`  scanning  ${next} task ids`);
  console.log('');

  const targets: { id: number; amount: bigint }[] = [];
  for (let id = 0; id < next; id++) {
    let t;
    try {
      t = await escrow.getTask(id);
    } catch {
      continue;
    }
    if (Number(t.status) !== FUNDED) continue;
    if (t.agent.toLowerCase() !== posterLc) continue;
    targets.push({ id, amount: t.amount });
    console.log(`  funded #${id}  amount ${formatUnits(t.amount, 18)} 0G`);
  }

  const total = targets.reduce((s, x) => s + x.amount, 0n);
  console.log('');
  console.log(`  ${targets.length} funded task(s) owned by poster · ${formatUnits(total, 18)} 0G refundable`);
  console.log('');

  if (!targets.length) {
    console.log('Nothing to cancel.');
    return;
  }
  if (!EXECUTE) {
    console.log('Dry-run only — nothing sent. Re-run with PRIVATE_KEY + --execute to cancel.');
    return;
  }

  let ok = 0;
  for (const { id } of targets) {
    try {
      const tx = await escrow.cancelTask(id);
      console.log(`  cancel #${id} → ${tx.hash} … waiting`);
      await tx.wait();
      ok++;
      console.log(`  cancel #${id} confirmed`);
    } catch (e) {
      console.error(`  cancel #${id} FAILED: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  console.log('');
  console.log(`Cancelled ${ok}/${targets.length} task(s). openTaskCount drops by ${ok}.`);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
