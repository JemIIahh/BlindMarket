/**
 * CCTP attestation poller — advances every in-flight cctp_transfers row one
 * step per tick (burn confirmation -> Iris attestation -> mint). Drives BOTH
 * Phase A (outbound, agent-initiated) and Phase B (inbound, user-initiated)
 * rows identically from 'burn_confirmed' onward; the two phases only differ
 * in how a row reaches 'burn_confirmed' in the first place (routes/agentsCctp.ts
 * submits the burn itself; routes/cctp.ts's /confirm endpoint verifies a
 * user-submitted burn tx independently).
 *
 * Modeled on services/agentFactoryListener.ts's poller shape: gate on config,
 * `void tick()` once then setInterval, single in-flight tick guard.
 *
 * A row stuck at 'created' (row inserted but the burn was never broadcast —
 * a crash in that narrow window) is NOT resumed here: nothing happened
 * on-chain, so there's nothing to advance. It's left for manual inspection;
 * the owner can retry with a fresh idempotencyKey.
 */
import { config } from '../config.js';
import { isCctpConfigured, getCctpChain } from './cctpChains.js';
import { pollIrisAttestation } from './cctp.js';
import {
  listNonTerminal,
  updateTransfer,
  type CctpTransfer,
} from './cctpTransferStore.js';

const POLL_INTERVAL_MS = 5_000;
// How long a row may sit at 'attestation_ready' (attested, waiting on
// Circle's Forwarding Service to submit the destination mint) before we log
// a loud warning. No automatic self-relay fallback is wired in for the
// initial ship (see the CCTP plan, Phase B §4.3) — this is visibility only.
const FORWARDING_STALL_WARNING_MS = 10 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let inFlightPromise: Promise<void> | null = null;

export function startCctpAttestationPoller(): void {
  if (timer) return;
  if (!isCctpConfigured()) {
    console.log('[cctp] CCTP_ENABLED is false (or contracts unset) — attestation poller disabled');
    return;
  }
  void tick();
  timer = setInterval(tick, POLL_INTERVAL_MS);
  console.log(`[cctp] attestation poller running every ${POLL_INTERVAL_MS / 1000}s`);
}

export function stopCctpAttestationPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (inFlightPromise) return inFlightPromise;

  inFlightPromise = (async () => {
    let rows: CctpTransfer[];
    try {
      rows = await listNonTerminal();
    } catch (e) {
      console.error('[cctp] failed to list in-flight transfers:', (e as Error).message);
      return;
    }

    for (const row of rows) {
      if (row.stage === 'created') continue; // nothing on-chain yet — not ours to advance
      try {
        await advance(row);
      } catch (e) {
        console.error(`[cctp] transfer ${row.id} advance error:`, (e as Error).message);
      }
    }
  })();

  try {
    await inFlightPromise;
  } finally {
    inFlightPromise = null;
  }
}

// Exported for direct unit testing of the stage-transition logic (see
// cctpAttestationPoller.test.ts) — startCctpAttestationPoller()/tick() are
// the real entry points; this stays the same shape either way.
export async function advance(row: CctpTransfer): Promise<void> {
  const source = getCctpChain(row.source_chain);
  if (!source) {
    await updateTransfer(row.id, { stage: 'failed', error_message: `source chain ${row.source_chain} no longer configured` });
    return;
  }

  if (row.stage === 'burn_submitted') {
    if (!row.burn_tx_hash) {
      await updateTransfer(row.id, { stage: 'failed', error_message: 'burn_submitted with no burn_tx_hash recorded' });
      return;
    }
    const receipt = await source.rpc.getTransactionReceipt(row.burn_tx_hash);
    if (!receipt) return; // still pending
    if (receipt.status === 0) {
      await updateTransfer(row.id, { stage: 'failed', error_message: 'burn transaction reverted' });
      return;
    }
    await updateTransfer(row.id, { stage: 'burn_confirmed', burn_block_number: String(receipt.blockNumber) });
    return;
  }

  if (row.stage === 'burn_confirmed' || row.stage === 'attestation_pending' || row.stage === 'attestation_ready') {
    if (!row.burn_tx_hash) return; // inbound row awaiting /confirm — nothing to poll yet
    const msg = await pollIrisAttestation(config.cctp.irisApiBase, row.source_domain, row.burn_tx_hash);
    if (!msg) {
      if (row.stage !== 'attestation_pending') await updateTransfer(row.id, { stage: 'attestation_pending' });
      return;
    }

    if (msg.delayReason) {
      console.warn(`[cctp] transfer ${row.id} delayed: ${msg.delayReason} (maxFeeRaw=${row.max_fee_raw})`);
    }

    // Forwarding Service already completed the destination mint — reported
    // through this same endpoint (forwardTxHash), no separate relay call needed.
    if (msg.forwardTxHash) {
      await updateTransfer(row.id, {
        stage: 'mint_confirmed',
        cctp_message_hex: msg.message,
        cctp_attestation_hex: msg.attestation,
        mint_tx_hash: msg.forwardTxHash,
      });
      return;
    }

    if (msg.status === 'complete') {
      if (row.stage !== 'attestation_ready') {
        await updateTransfer(row.id, {
          stage: 'attestation_ready',
          cctp_message_hex: msg.message,
          cctp_attestation_hex: msg.attestation,
        });
      } else {
        const stalledMs = Date.now() - new Date(row.updated_at).getTime();
        if (stalledMs > FORWARDING_STALL_WARNING_MS) {
          console.warn(`[cctp] transfer ${row.id} attested ${Math.round(stalledMs / 1000)}s ago with no Forwarding Service mint yet — may need manual self-relay`);
        }
      }
      return;
    }

    if (row.stage !== 'attestation_pending') {
      await updateTransfer(row.id, { stage: 'attestation_pending', cctp_message_hex: msg.message });
    }
    return;
  }

  if (row.stage === 'mint_submitted') {
    const dest = getCctpChain(row.dest_chain);
    if (!dest || !row.mint_tx_hash) return;
    const receipt = await dest.rpc.getTransactionReceipt(row.mint_tx_hash);
    if (!receipt) return;
    if (receipt.status === 0) {
      await updateTransfer(row.id, { stage: 'failed', error_message: 'mint transaction reverted' });
      return;
    }
    await updateTransfer(row.id, { stage: 'mint_confirmed' });
  }
}
