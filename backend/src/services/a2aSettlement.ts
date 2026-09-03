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
 * contract — see contracts/scripts/rotate-verifier.ts). Both return a
 * SettleResult and never throw; route handlers AWAIT them and gate state
 * transitions / worker credit on `success` — crediting before the chain
 * confirms is how the inverse earnings drift ("N tasks credited · 0 0G
 * received") happened.
 *
 * Idempotency: the contract reverts with InvalidStatus if you try to assign
 * an already-Assigned task or verify an already-Verified one. The bridge
 * detects that error and treats it as success ("already settled, nothing to
 * do") rather than a failure to retry. This makes it safe to call repeatedly
 * — useful when route handlers fire the bridge speculatively and the operator
 * triggers a second time during a flaky run.
 */

import type { ContractTransactionResponse } from 'ethers';
import { isAddress, verifyMessage, toUtf8Bytes, isHexString, hexlify, getBytes } from 'ethers';
import { escrowAsMarketplace, marketplaceSigner, baseEscrowAsMarketplace, baseMarketplaceSigner } from './chain.js';
import { config } from '../config.js';
import { resolveTaskByHash, type TaskChain, type ResolvedTask } from './taskChain.js';
import * as a2aStore from './a2aStore.js';
import { rooms } from './socket.js';

// How long to wait for the TaskCreated event listener to populate the
// taskHash → taskId mapping before giving up on a settlement attempt.
// 30s easily covers a few testnet block times plus the 30s polling tick.
const HASH_LOOKUP_TIMEOUT_MS = 30_000;
const HASH_LOOKUP_POLL_INTERVAL_MS = 2_000;

/**
 * Serial tx queues — one per signer (0G and Base use different wallets).
 *
 * All marketplaceAssign calls go through the 0G signer; all
 * completeVerification calls go through the Base signer. Each queue
 * serialises nonces within its own chain.
 */
let ogSignerTxQueue: Promise<unknown> = Promise.resolve();
let baseSignerTxQueue: Promise<unknown> = Promise.resolve();

function enqueueOgSignerTx<T>(fn: () => Promise<T>): Promise<T> {
  const next = ogSignerTxQueue.then(fn, fn);
  ogSignerTxQueue = next.catch(() => {});
  return next;
}

function enqueueBaseSignerTx<T>(fn: () => Promise<T>): Promise<T> {
  const next = baseSignerTxQueue.then(fn, fn);
  baseSignerTxQueue = next.catch(() => {});
  return next;
}

/**
 * The escrow a task actually lives on, plus the signer that can act on it.
 *
 * Both halves of the bridge used to be hard-wired to one chain each —
 * assignment to 0G, verification to Base — which only works if every task
 * exists on both with the same id. It doesn't: a task is funded on exactly one
 * escrow, so one half was always pointed at the wrong contract. A 0G task
 * could never be settled and a Base task could never be assigned.
 */
function bridgeFor(chain: TaskChain): {
  escrow: typeof escrowAsMarketplace;
  ready: boolean;
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
  label: string;
} {
  if (chain === 'base') {
    return {
      escrow: baseEscrowAsMarketplace,
      ready: !!(baseEscrowAsMarketplace && baseMarketplaceSigner),
      enqueue: enqueueBaseSignerTx,
      label: 'Base (BASE_MARKETPLACE_SIGNER_PRIVATE_KEY)',
    };
  }
  return {
    escrow: escrowAsMarketplace,
    ready: !!(escrowAsMarketplace && marketplaceSigner),
    enqueue: enqueueOgSignerTx,
    label: '0G (MARKETPLACE_SIGNER_PRIVATE_KEY)',
  };
}

/**
 * Wait for the indexer to catch up, and report which chain holds the task.
 * A create tx that just confirmed may not be indexed for a few seconds.
 */
async function waitForResolvedTask(taskHash: string): Promise<ResolvedTask | null> {
  const deadline = Date.now() + HASH_LOOKUP_TIMEOUT_MS;
  while (true) {
    const resolved = await resolveTaskByHash(taskHash);
    if (resolved) return resolved;
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

function isDeadlineReached(err: unknown): boolean {
  // marketplaceAssign reverts DeadlineReached() once block.timestamp passes
  // the task deadline. Unlike InvalidStatus this is TERMINAL for assignment —
  // the task can never be assigned again, only reclaimed by the poster. It
  // must NOT be classed as a retryable failure: releaseToOpen would re-list
  // the task for the next /accept to hit the exact same revert, forever.
  const msg = (err as Error).message || '';
  return msg.includes('DeadlineReached');
}

export interface SettleResult {
  success: boolean;
  error?: string;
  txHash?: string;
  alreadySettled?: boolean;
  /** Terminal: the on-chain deadline has passed — do not release/retry. */
  expired?: boolean;
  /** Terminal for this caller: the chain has a DIFFERENT worker assigned.
   *  Do not releaseToOpen (every future /accept would bounce off the same
   *  revert) and do not return key material to the caller. */
  workerMismatch?: boolean;
  onChainWorker?: string;
  /** Terminal: the task was cancelled/refunded on-chain (no worker). Close
   *  the off-chain state; do not reconcile to the zero address. */
  cancelled?: boolean;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * InvalidStatus on marketplaceAssign means "task is past Funded" — which is
 * idempotent success ONLY if the on-chain worker is the executor we were
 * settling for. A retry by the rightful worker must succeed quietly; a second
 * executor racing in from a divergent Redis (cross-deployment poaching on a
 * shared instance, a restored snapshot, or a manual on-chain assignWorker the
 * indexer never saw) must NOT be told success — the accept route would hand
 * them the brief key for a task someone else owns.
 */
async function confirmAssignedWorker(
  taskId: number | string,
  executor: string,
  taskHash: string,
  chain: TaskChain = '0g',
): Promise<SettleResult> {
  try {
    const t = await bridgeFor(chain).escrow!.getTask(BigInt(taskId));
    const onChainWorker = String(t.worker);
    if (onChainWorker.toLowerCase() === executor.toLowerCase()) {
      console.log(`[a2aSettlement] assignment skipped — task ${taskId} already assigned to this executor`);
      return { success: true, alreadySettled: true, onChainWorker };
    }
    // marketplaceAssign reverts InvalidStatus for ANY non-Funded status. The
    // only non-Funded state with no worker is Cancelled (poster reclaimed the
    // escrow) — treating 0x0 as "a different executor" would write the zero
    // address into Redis and 409 ASSIGNED_ELSEWHERE a task that no longer
    // exists. Surface it as cancelled instead. No assignError persisted: this
    // is terminal-closed by the caller, not a retryable bridge fault.
    if (onChainWorker.toLowerCase() === ZERO_ADDRESS) {
      console.warn(`[a2aSettlement] assignment refused — task ${taskId} is cancelled on-chain (no worker)`);
      return { success: false, cancelled: true };
    }
    const msg = `task ${taskId} is already assigned on-chain to ${onChainWorker}, not ${executor}`;
    console.error(`[a2aSettlement] ${msg} — Redis/chain divergence (check /health/bridge for cross-env poaching)`);
    // Deliberately do NOT persist assignError here: the accept route closes
    // this off-chain and reconciles executorAddress to the real worker, who
    // must then pass /submit — and /submit short-circuits BRIDGE_FAILED on a
    // lingering assignError that nothing else would ever clear.
    return { success: false, error: msg, workerMismatch: true, onChainWorker };
  } catch (readErr) {
    // Can't prove the caller is the assigned worker → fail closed. The caller
    // sees a retryable settlement failure, not a key handout.
    const msg = `task ${taskId} reverted InvalidStatus and the follow-up worker read failed: ${(readErr as Error).message}`;
    console.error(`[a2aSettlement] ${msg}`);
    await safePersistAssignError(taskHash, msg);
    return { success: false, error: msg };
  }
}

/**
 * Translate an A2A `accepted` transition into an on-chain assignment.
 * Looks up the on-chain taskId from the taskHash (waiting for the
 * TaskCreated event listener if needed), then calls marketplaceAssign as the
 * verifier. Persists the tx hash to the A2A state on success.
 *
 * Returns a SettleResult so callers can await and respond accordingly.
 * Unexpected errors (not bridge-not-ready, not already-settled) propagate.
 */
export async function settleAssignment(taskHash: string, executor: string): Promise<SettleResult> {
  if (!isAddress(executor)) {
    const msg = `Executor address is not a valid EVM address: ${executor}`;
    await safePersistAssignError(taskHash, msg);
    return { success: false, error: msg };
  }

  const resolved = await waitForResolvedTask(taskHash);
  if (resolved === null) {
    const msg = `hash2id lookup timed out — createTask event never seen by indexer on either chain (taskHash=${taskHash.slice(0, 10)}…)`;
    console.error(`[a2aSettlement] ${msg}`);
    await safePersistAssignError(taskHash, msg);
    return { success: false, error: msg };
  }

  const { taskId, chain } = resolved;
  const bridge = bridgeFor(chain);
  if (!bridge.ready) {
    const msg = `Bridge disabled for ${chain}: signer not configured — ${bridge.label}`;
    console.error(`[a2aSettlement] ${msg}`);
    await safePersistAssignError(taskHash, msg);
    return { success: false, error: msg };
  }

  let tx: ContractTransactionResponse;
  try {
    try {
      await bridge.escrow!.marketplaceAssign.staticCall(BigInt(taskId), executor);
    } catch (staticErr) {
      if (isAlreadySettled(staticErr)) {
        return confirmAssignedWorker(taskId, executor, taskHash, chain);
      }
      if (isDeadlineReached(staticErr)) {
        console.warn(`[a2aSettlement] assignment refused — task ${taskId} deadline has passed (terminal)`);
        return { success: false, expired: true, error: 'Task deadline has passed' };
      }
      console.error(`[a2aSettlement] staticCall failed for taskId=${taskId}: ${(staticErr as Error).message}`);
      throw staticErr;
    }

    tx = await bridge.enqueue(() =>
      bridge.escrow!.marketplaceAssign(BigInt(taskId), executor) as Promise<ContractTransactionResponse>,
    );
  } catch (err) {
    if (isAlreadySettled(err)) {
      return confirmAssignedWorker(taskId, executor, taskHash, chain);
    }
    if (isDeadlineReached(err)) {
      console.warn(`[a2aSettlement] assignment refused — task ${taskId} deadline has passed (terminal)`);
      return { success: false, expired: true, error: 'Task deadline has passed' };
    }
    const msg = (err as Error).message;
    console.error(`[a2aSettlement] assignment failed for hash=${taskHash.slice(0, 10)}…:`, msg);
    await safePersistAssignError(taskHash, msg);
    return { success: false, error: msg };
  }

  await a2aStore.updateState(taskHash, { assignTxHash: tx.hash, assignError: undefined });
  console.log(`[a2aSettlement] marketplaceAssign broadcast taskId=${taskId} tx=${tx.hash}`);

  const receipt = await tx.wait();
  console.log(
    `[a2aSettlement] marketplaceAssign confirmed taskId=${taskId} block=${receipt?.blockNumber} status=${receipt?.status}`,
  );
  if (receipt?.status !== 1) {
    const msg = `marketplaceAssign tx ${tx.hash} reverted on chain`;
    await safePersistAssignError(taskHash, msg);
    return { success: false, error: msg, txHash: tx.hash };
  }

  return { success: true, txHash: tx.hash };
}

// Writing to Redis can itself fail (network blip, key missing if releaseToOpen
// raced us). Don't let the bookkeeping write blow up the bridge — the bridge
// is already in an error path, surfacing a second error here just buries the
// real one. Log and continue.
async function safePersistAssignError(taskHash: string, msg: string): Promise<void> {
  try {
    await a2aStore.updateState(taskHash, { assignError: truncate(msg) });
  } catch (e) {
    console.error(
      `[a2aSettlement] could not persist assignError for ${taskHash.slice(0, 10)}…:`,
      (e as Error).message,
    );
  }
}

async function safePersistVerifyError(taskHash: string, msg: string): Promise<void> {
  try {
    await a2aStore.updateState(taskHash, { verifyError: truncate(msg) });
  } catch (e) {
    console.error(
      `[a2aSettlement] could not persist verifyError for ${taskHash.slice(0, 10)}…:`,
      (e as Error).message,
    );
  }
}

// Bridge errors include stack traces and full RPC payloads. Cap at 240 chars
// so the Redis value stays small and the worker log line doesn't wrap into
// the next century. The first ~240 chars contain the actual revert reason.
function truncate(s: string): string {
  return s.length > 240 ? s.slice(0, 240) + '…' : s;
}

/**
 * Translate an A2A `verified` or `failed` transition into an on-chain
 * completeVerification(taskId, passed) on the BASE escrow. On Base, passed=true
 * releases USDC to the worker (90/10 split); passed=false only moves the task
 * to Verified. After a terminal failure the only exits are the poster's
 * claimTimeout (post-deadline refund) or an admin resolveDispute.
 *
 * When a valid 0G TEE attestation is provided, uses completeVerificationWithTEE
 * for trustless settlement — the on-chain ecrecover verifies the TEE signature
 * against the registered teeSigner, removing the backend as trusted party.
 */
export type TeeAttestation = {
  signature: string;
  signer?: string;
  signedText: string;
  chatID?: string;
  verified?: boolean;
};

/**
 * The 0G provider returns the signed commitment as plain text, but the contract
 * takes `bytes`. ethers rejects a non-hex string for a bytes parameter with
 * "invalid BytesLike value", so it has to be encoded before it goes anywhere
 * near the ABI encoder — or the signature check below.
 */
export function normalizeSignedText(signedText: string): string {
  return isHexString(signedText) ? signedText : hexlify(toUtf8Bytes(signedText));
}

/**
 * Recover the enclave signature and check it against the configured TEE signer.
 *
 * The attestation is supplied by the worker agent, so nothing in it — the
 * `verified` flag least of all — can be taken on trust. Note this establishes
 * only that a registered enclave signed the given text: the 0G TEE signs a
 * commitment over an inference request/response and cannot bind that to a task
 * id or a verdict, which is why the on-chain path keeps its verifier gate.
 */
export function isTeeAttestationValid(att?: TeeAttestation | null): boolean {
  if (!att?.signature || !att.signedText) return false;

  const expected = config.teeSignerAddress;
  if (!expected) return false;

  try {
    // Verify over exactly the bytes that will be sent on-chain, so a signature
    // that passes here cannot fail the contract's own ecrecover.
    const recovered = verifyMessage(getBytes(normalizeSignedText(att.signedText)), att.signature);
    return recovered.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}

const TEE_READY_TTL_MS = 5 * 60_000;
const teeReadyCache = new Map<TaskChain, { signer: string | null; at: number }>();

/**
 * Whether the escrow on `chain` can actually settle via TEE right now.
 *
 * A valid attestation is not enough: `completeVerificationWithTEE` and
 * `teeSigner` were added to BlindEscrow in 69d1335, long after the 0G mainnet
 * escrow was deployed, and that proxy has never been upgraded — calling the
 * selector there reverts with no data, which escapes the InvalidStatus catch
 * below and leaves the worker unpaid. Even on an upgraded contract the signer
 * is per-deployment, so `teeSigner` unset (or set to a different key than the
 * one we just recovered against) reverts too.
 *
 * Reading `teeSigner()` answers all three cases at once, and lets a later 0G
 * upgrade start using the TEE path without a code change. Anything unexpected
 * resolves to "not ready", which only costs us the legacy path — that still
 * settles correctly.
 */
export async function teeSettlementReady(
  chain: TaskChain,
  escrow: NonNullable<typeof escrowAsMarketplace>,
): Promise<boolean> {
  const expected = config.teeSignerAddress?.toLowerCase();
  if (!expected) return false;

  const cached = teeReadyCache.get(chain);
  let signer = cached && Date.now() - cached.at < TEE_READY_TTL_MS ? cached.signer : undefined;

  if (signer === undefined) {
    try {
      signer = ((await escrow.teeSigner()) as string).toLowerCase();
    } catch {
      // Selector missing (un-upgraded proxy) or the read failed.
      signer = null;
    }
    teeReadyCache.set(chain, { signer, at: Date.now() });
  }

  return signer !== null && signer !== ZERO_ADDRESS && signer === expected;
}

export async function settleVerification(
  taskHash: string,
  passed: boolean,
  teeAttestation?: TeeAttestation | null,
): Promise<SettleResult> {

  const _vState = await a2aStore.getState(taskHash).catch(() => null);
  const _vExecutor = _vState?.executorAddress;
  if (_vExecutor && !isAddress(_vExecutor)) {
    const msg = `Executor address is not a valid EVM address: ${_vExecutor}`;
    await safePersistVerifyError(taskHash, msg);
    return { success: false, error: msg };
  }

  // Determine whether to use TEE settlement.
  //
  // `verified` arrives in the worker's own /submit payload, so it is a claim by
  // the party being paid, not evidence. Recover the signer here instead: an
  // attestation that doesn't check out falls back to the legacy path rather
  // than sending a transaction the contract would revert.
  const attestationValid = isTeeAttestationValid(teeAttestation);

  try {
    const resolved = await waitForResolvedTask(taskHash);
    if (resolved === null) {
      const msg = `hash2id lookup timed out — createTask event never seen by indexer on either chain (taskHash=${taskHash.slice(0, 10)}…)`;
      console.error(`[a2aSettlement] ${msg}`);
      await safePersistVerifyError(taskHash, msg);
      return { success: false, error: msg };
    }

    const { taskId, chain } = resolved;
    const bridge = bridgeFor(chain);
    if (!bridge.ready) {
      const msg = `Verification bridge disabled for ${chain}: signer not configured — ${bridge.label}`;
      console.error(`[a2aSettlement] ${msg}`);
      await safePersistVerifyError(taskHash, msg);
      return { success: false, error: msg };
    }

    // TEE settlement is a property of the contract we are about to call, not
    // of the attestation alone — the two can disagree per chain.
    const useTEE = attestationValid && (await teeSettlementReady(chain, bridge.escrow!));
    if (attestationValid && !useTEE) {
      console.warn(
        `[a2aSettlement] valid TEE attestation but ${chain} escrow has no matching teeSigner — settling via the legacy path for taskId=${taskId}`,
      );
    }

    let tx: ContractTransactionResponse;
    try {
      if (useTEE) {
        console.log(`[a2aSettlement] using TEE settlement for taskId=${taskId}`);
        tx = await bridge.enqueue(() =>
          bridge.escrow!.completeVerificationWithTEE(
            BigInt(taskId),
            passed,
            teeAttestation!.signature,
            normalizeSignedText(teeAttestation!.signedText),
          ) as Promise<ContractTransactionResponse>,
        );
      } else {
        tx = await bridge.enqueue(() =>
          bridge.escrow!.completeVerification(BigInt(taskId), passed) as Promise<ContractTransactionResponse>,
        );
      }
    } catch (err) {
      if (isAlreadySettled(err)) {
        try {
          const t = await bridge.escrow!.getTask(BigInt(taskId));
          const status = Number(t.status);
          if (status === (passed ? 4 : 3)) {
            console.log(
              `[a2aSettlement] verification skipped — task ${taskId} already settled with matching outcome (status=${status})`,
            );
            return { success: true, alreadySettled: true };
          }
          const msg = `task ${taskId} already settled with status=${status}, which does not match passed=${passed}`;
          console.error(`[a2aSettlement] ${msg}`);
          await safePersistVerifyError(taskHash, msg);
          return { success: false, error: msg };
        } catch (readErr) {
          const msg = `task ${taskId} reverted InvalidStatus and the follow-up status read failed: ${(readErr as Error).message}`;
          await safePersistVerifyError(taskHash, msg);
          return { success: false, error: msg };
        }
      }
      throw err;
    }

    await a2aStore.updateState(taskHash, { verifyTxHash: tx.hash, verifyError: undefined });
    const mode = useTEE ? 'TEE' : 'legacy';
    console.log(
      `[a2aSettlement] completeVerification (${mode}, ${chain}) broadcast taskId=${taskId} passed=${passed} tx=${tx.hash}`,
    );

    const receipt = await tx.wait(1, 60_000);
    console.log(
      `[a2aSettlement] completeVerification (${mode}, ${chain}) confirmed taskId=${taskId} passed=${passed} block=${receipt?.blockNumber} status=${receipt?.status}`,
    );
    if (receipt?.status !== 1) {
      const msg = `completeVerification tx ${tx.hash} reverted on the ${chain} chain`;
      await safePersistVerifyError(taskHash, msg);
      return { success: false, error: msg, txHash: tx.hash };
    }

    if (passed) {
      rooms.tasks('task:completed', { taskId });
      rooms.task(taskId, 'task:completed', { taskId });
    }
    return { success: true, txHash: tx.hash };
  } catch (err) {
    const msg = (err as Error).message;
    console.error(
      `[a2aSettlement] verification failed for hash=${taskHash.slice(0, 10)}…:`,
      msg,
    );
    await safePersistVerifyError(taskHash, msg);
    return { success: false, error: msg };
  }
}

/** True if both assignment (0G) and verification (Base) bridges are configured. */
export function isBridgeConfigured(): boolean {
  return !!(escrowAsMarketplace && marketplaceSigner && baseEscrowAsMarketplace && baseMarketplaceSigner);
}