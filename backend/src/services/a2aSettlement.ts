/**
 * A2A settlement bridge.
 *
 * Translates off-chain A2A state transitions into on-chain BlindEscrow calls.
 * Without this, an A2A executor can complete work and have it auto-verified
 * in Redis — but the on-chain task stays in Funded state and the escrow
 * never releases.
 *
 * Two operations:
 *   - settleAssignment(taskHash, executor)  → marketplaceAssign(taskId, executor)
 *   - settleVerification(taskHash, passed)  → completeVerification(taskId, passed)
 *
 * Both use the marketplace signer (which holds the verifier role on the
 * contract — see contracts/scripts/rotate-verifier.ts). Both are designed to
 * be called fire-and-forget from route handlers: errors are logged, never
 * thrown. The HTTP response should never block on chain confirmation.
 *
 * Idempotency: the contract reverts with InvalidStatus if you try to assign
 * an already-Assigned task or verify an already-Verified one. The bridge
 * detects that error and treats it as success ("already settled, nothing to
 * do") rather than a failure to retry. This makes it safe to call repeatedly
 * — useful when route handlers fire the bridge speculatively and the operator
 * triggers a second time during a flaky run.
 */

import type { ContractTransactionResponse } from 'ethers';
import { escrowAsMarketplace, marketplaceSigner } from './chain.js';
import { getTaskIdByHash } from './escrowEvents.js';
import * as a2aStore from './a2aStore.js';

// How long to wait for the TaskCreated event listener to populate the
// taskHash → taskId mapping before giving up on a settlement attempt.
// 30s easily covers a few testnet block times plus the 30s polling tick.
const HASH_LOOKUP_TIMEOUT_MS = 30_000;
const HASH_LOOKUP_POLL_INTERVAL_MS = 2_000;

function bridgeReady(): boolean {
  if (!escrowAsMarketplace || !marketplaceSigner) {
    console.error(
      '[a2aSettlement] bridge disabled — MARKETPLACE_SIGNER_PRIVATE_KEY is not set in backend env. ' +
        'Run contracts/scripts/generate-marketplace-signer.ts and rotate-verifier.ts to provision it.',
    );
    return false;
  }
  return true;
}

async function waitForTaskId(taskHash: string): Promise<string | null> {
  const deadline = Date.now() + HASH_LOOKUP_TIMEOUT_MS;
  // First lookup runs immediately (no upfront delay) — covers the common case
  // where the event listener has already captured the mapping.
  while (true) {
    const id = await getTaskIdByHash(taskHash);
    if (id) return id;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, HASH_LOOKUP_POLL_INTERVAL_MS));
  }
}

function isAlreadySettled(err: unknown): boolean {
  // BlindEscrow's marketplaceAssign/completeVerification revert with
  // InvalidStatus when the task is no longer in the expected state. From the
  // bridge's perspective that's the same as "already done" — log and continue.
  const msg = (err as Error).message || '';
  return msg.includes('InvalidStatus');
}

/**
 * Translate an A2A `accepted` transition into an on-chain assignment.
 * Looks up the on-chain taskId from the taskHash (waiting for the
 * TaskCreated event listener if needed), then calls marketplaceAssign as the
 * verifier. Persists the tx hash to the A2A state on success.
 */
export async function settleAssignment(taskHash: string, executor: string): Promise<void> {
  if (!bridgeReady()) return;

  try {
    const taskId = await waitForTaskId(taskHash);
    if (taskId === null) {
      console.error(
        `[a2aSettlement] hash2id lookup timed out for ${taskHash.slice(0, 10)}… — abandoning assignment. ` +
          `Either the create-task tx never confirmed, or the escrow event listener is stalled.`,
      );
      return;
    }

    let tx: ContractTransactionResponse;
    try {
      tx = await escrowAsMarketplace!.marketplaceAssign(BigInt(taskId), executor) as ContractTransactionResponse;
    } catch (err) {
      if (isAlreadySettled(err)) {
        console.log(`[a2aSettlement] assignment skipped — task ${taskId} already past Funded state`);
        return;
      }
      throw err;
    }

    // Record the broadcast immediately so a crash here doesn't lose the trace.
    await a2aStore.updateState(taskHash, { assignTxHash: tx.hash });
    console.log(`[a2aSettlement] marketplaceAssign broadcast taskId=${taskId} tx=${tx.hash}`);

    const receipt = await tx.wait();
    console.log(
      `[a2aSettlement] marketplaceAssign confirmed taskId=${taskId} block=${receipt?.blockNumber} status=${receipt?.status}`,
    );
  } catch (err) {
    console.error(
      `[a2aSettlement] assignment failed for hash=${taskHash.slice(0, 10)}…:`,
      (err as Error).message,
    );
  }
}

/**
 * Translate an A2A `verified` or `failed` transition into an on-chain
 * completeVerification(taskId, passed). On the contract, passed=true releases
 * escrow to the worker; passed=false reverts escrow to the agent (after
 * MAX_SUBMISSION_ATTEMPTS retries the contract auto-cancels).
 */
export async function settleVerification(taskHash: string, passed: boolean): Promise<void> {
  if (!bridgeReady()) return;

  try {
    const taskId = await waitForTaskId(taskHash);
    if (taskId === null) {
      console.error(
        `[a2aSettlement] hash2id lookup timed out for ${taskHash.slice(0, 10)}… — abandoning verification.`,
      );
      return;
    }

    let tx: ContractTransactionResponse;
    try {
      tx = await escrowAsMarketplace!.completeVerification(BigInt(taskId), passed) as ContractTransactionResponse;
    } catch (err) {
      if (isAlreadySettled(err)) {
        console.log(
          `[a2aSettlement] verification skipped — task ${taskId} already past expected status`,
        );
        return;
      }
      throw err;
    }

    await a2aStore.updateState(taskHash, { verifyTxHash: tx.hash });
    console.log(
      `[a2aSettlement] completeVerification broadcast taskId=${taskId} passed=${passed} tx=${tx.hash}`,
    );

    const receipt = await tx.wait();
    console.log(
      `[a2aSettlement] completeVerification confirmed taskId=${taskId} passed=${passed} block=${receipt?.blockNumber} status=${receipt?.status}`,
    );
  } catch (err) {
    console.error(
      `[a2aSettlement] verification failed for hash=${taskHash.slice(0, 10)}…:`,
      (err as Error).message,
    );
  }
}

/** True if the bridge has all its prerequisites configured. */
export function isBridgeConfigured(): boolean {
  return !!(escrowAsMarketplace && marketplaceSigner);
}
