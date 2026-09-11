/**
 * Manual recovery for a CCTP transfer stuck at 'attestation_ready' — Circle
 * has signed the attestation but the Forwarding Service never submitted the
 * destination mint (see cctpAttestationPoller.ts's stall warning log). This
 * self-relays it: receiveMessage() is permissionless (destinationCaller is
 * always the zero address — see cctp.ts), so ANY funded wallet on the
 * destination chain can submit it, not just Circle's own relayer.
 *
 * Same shape as recover-stuck-a2a-tasks.ts: one-shot, CLI-driven, explicit
 * per-row confirmation before acting.
 *
 * Usage:
 *   cd backend
 *   CCTP_RECOVERY_PRIVATE_KEY=0x... npx tsx scripts/recover-stuck-cctp-transfer.ts <transferId> [<transferId>...]
 *
 * The recovery wallet needs native gas on the DESTINATION chain (not Base —
 * whatever chain the stuck transfer is minting into). It does not need to be
 * the agent's or user's own wallet; anyone can complete a permissionless mint.
 */

import { config as loadEnv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, '../.env') });

import { ethers } from 'ethers';
import { getById, updateTransfer } from '../src/services/cctpTransferStore.js';
import { getCctpChain } from '../src/services/cctpChains.js';
import { executeReceiveMessage } from '../src/services/cctp.js';

async function recoverOne(transferId: number, wallet: ethers.Wallet): Promise<void> {
  console.log(`\n── transfer #${transferId} ──`);
  const row = await getById(transferId);
  if (!row) { console.log('  not found'); return; }
  console.log(`  stage=${row.stage} direction=${row.direction} dest=${row.dest_chain}`);

  if (row.stage === 'mint_confirmed') { console.log('  already minted — nothing to do'); return; }
  if (row.stage !== 'attestation_ready') {
    console.log(`  stage is '${row.stage}', not 'attestation_ready' — self-relay only applies once Circle has signed the attestation. Let the poller keep running, or investigate why it's stuck at this stage instead.`);
    return;
  }
  if (!row.cctp_message_hex || !row.cctp_attestation_hex) {
    console.log('  attestation_ready but missing message/attestation hex on the row — cannot self-relay; something is wrong upstream, do not force this.');
    return;
  }

  const dest = getCctpChain(row.dest_chain as never);
  if (!dest) { console.log(`  dest chain '${row.dest_chain}' is not configured on this backend — cannot relay from here`); return; }

  const destWallet = wallet.connect(dest.rpc);
  const balance = await dest.rpc.getBalance(destWallet.address);
  console.log(`  relaying via ${destWallet.address} (balance ${ethers.formatEther(balance)} native) on ${dest.label}…`);

  const { txHash } = await executeReceiveMessage(dest, destWallet, row.cctp_message_hex, row.cctp_attestation_hex);
  console.log(`  submitted receiveMessage: ${txHash}`);

  await updateTransfer(row.id, { stage: 'mint_confirmed', mint_tx_hash: txHash });
  console.log(`  RECOVERED → stage=mint_confirmed`);
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
  const pk = process.env.CCTP_RECOVERY_PRIVATE_KEY;
  if (ids.length === 0 || !pk) {
    console.error('Usage: CCTP_RECOVERY_PRIVATE_KEY=0x... npx tsx scripts/recover-stuck-cctp-transfer.ts <transferId> [<transferId>...]');
    process.exit(1);
  }
  const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : `0x${pk}`);
  console.log(`recovering ${ids.length} transfer(s) as ${wallet.address}…`);
  for (const id of ids) {
    try {
      await recoverOne(id, wallet);
    } catch (e) {
      console.error(`  ERROR for #${id}:`, (e as Error).message);
    }
  }
  console.log('\ndone.');
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
