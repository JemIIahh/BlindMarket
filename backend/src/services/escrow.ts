import { buildUnsignedTx } from './chain.js';
import { chainRuntime } from './chainRuntime.js';
// The key type comes from the registry, not taskChain.ts, which imports this
// module back.
import { settlementChainConfig, type SettlementChainKey as TaskChain } from './settlementChains.js';
import type { OnChainTask } from '../types.js';
import { ethers } from 'ethers';

/** The read-only BlindEscrow on `chain`. Throws when this deployment has none there. */
export function escrowFor(chain: TaskChain): ethers.Contract {
  const contract = chainRuntime(chain).escrow;
  if (!contract) {
    const { label, escrowEnv } = settlementChainConfig(chain);
    throw new Error(`${label} escrow not configured (${escrowEnv})`);
  }
  return contract;
}

/** Read a single task from BlindEscrow */
export async function getTask(taskId: number): Promise<OnChainTask & { taskId: string }> {
  return getTaskOn('0g', taskId);
}

/** Get the next task ID (tells us how many tasks exist) */
export async function nextTaskId(): Promise<number> {
  return Number(await escrowFor('0g').nextTaskId());
}

/** Get fee basis points */
/** The 0G escrow's fee. Prefer feeBpsOn: each chain's escrow has its own. */
export async function feeBps(): Promise<number> {
  return feeBpsOn('0g');
}

/** The platform fee, in basis points, the escrow on `chain` applies at settlement. */
export async function feeBpsOn(chain: TaskChain): Promise<number> {
  return Number(await escrowFor(chain).feeBps());
}

/**
 * Read the per-task verifier (taskVerifier mapping). ZeroAddress means the
 * task was funded via plain createTask — completeVerification is then gated
 * on the GLOBAL marketplace verifier, and a poster-designated verifier agent
 * can never settle it (its tx reverts NotVerifier).
 */
export async function getTaskVerifier(taskId: number): Promise<string> {
  return getTaskVerifierOn('0g', taskId);
}

/** Read per-task verifier from Base escrow */
export async function getTaskVerifierBase(taskId: number): Promise<string> {
  return getTaskVerifierOn('base', taskId);
}

/** Build unsigned assignWorker transaction */
export async function buildAssignWorker(
  from: string,
  taskId: number,
  worker: string,
): Promise<ethers.TransactionRequest> {
  return buildUnsignedTx(escrowFor('0g'), 'assignWorker', [taskId, worker], from);
}

/** Build unsigned cancelTask transaction */
export async function buildCancelTask(
  from: string,
  taskId: number,
): Promise<ethers.TransactionRequest> {
  return buildCancelTaskOn('0g', from, taskId);
}

/** Build unsigned claimTimeout transaction */
export async function buildClaimTimeout(
  from: string,
  taskId: number,
): Promise<ethers.TransactionRequest> {
  return buildClaimTimeoutOn('0g', from, taskId);
}

/** Build unsigned submitEvidence transaction */
export async function buildSubmitEvidence(
  from: string,
  taskId: number,
  evidenceHash: string,
): Promise<ethers.TransactionRequest> {
  return buildUnsignedTx(escrowFor('0g'), 'submitEvidence', [taskId, evidenceHash], from);
}

/** Build unsigned completeVerification transaction */
export async function buildCompleteVerification(
  from: string,
  taskId: number,
  passed: boolean,
): Promise<ethers.TransactionRequest> {
  return buildUnsignedTx(escrowFor('0g'), 'completeVerification', [taskId, passed], from);
}

// ── Base escrow (settlement — USDC payouts) ────────────────────────────────

/** Read a single task from the Base escrow. */
export async function getTaskBase(taskId: number): Promise<OnChainTask & { taskId: string }> {
  return getTaskOn('base', taskId);
}

/** Build unsigned cancelTask transaction against the Base escrow. */
export async function buildCancelTaskBase(
  from: string,
  taskId: number,
): Promise<ethers.TransactionRequest> {
  return buildCancelTaskOn('base', from, taskId);
}

/** Build unsigned claimTimeout transaction against the Base escrow. */
export async function buildClaimTimeoutBase(
  from: string,
  taskId: number,
): Promise<ethers.TransactionRequest> {
  return buildClaimTimeoutOn('base', from, taskId);
}

/** Build unsigned submitEvidence transaction against the Base escrow. */
export async function buildSubmitEvidenceBase(
  from: string,
  taskId: number,
  evidenceHash: string,
): Promise<ethers.TransactionRequest> {
  return buildUnsignedTx(escrowFor('base'), 'submitEvidence', [taskId, evidenceHash], from);
}

// ── Chain-aware functions ──────────────────────────────────────────────────
//
// A taskHash resolves to a chain via taskChain.resolveTaskByHash; these pick
// the matching escrow so a caller never has to branch. Without them a Base
// task read through the 0G escrow returns whatever unrelated task happens to
// share that id, or an empty one.

/** Build an unsigned createTask on `chain`. */
export async function buildCreateTaskOn(
  chain: TaskChain,
  from: string,
  taskHash: string,
  token: string,
  amount: bigint,
  category: string,
  locationZone: string,
  duration: bigint,
  value?: bigint,
  verifierAgent?: string,
): Promise<ethers.TransactionRequest> {
  const escrow = escrowFor(chain);
  // When the poster designates a verifier (verificationMode='agent'), commit it
  // on-chain at creation via createTaskWithVerifier so settlement is trustless —
  // only that verifier can call completeVerification. Otherwise the plain path
  // (auto/manual, settled by the global marketplace verifier).
  if (verifierAgent && verifierAgent !== ethers.ZeroAddress) {
    return buildUnsignedTx(
      escrow,
      'createTaskWithVerifier',
      [taskHash, token, amount, category, locationZone, duration, verifierAgent],
      from,
      value,
    );
  }
  return buildUnsignedTx(escrow, 'createTask', [taskHash, token, amount, category, locationZone, duration], from, value);
}

/** Read a task from whichever chain holds it. */
export async function getTaskOn(
  chain: TaskChain,
  taskId: number,
): Promise<OnChainTask & { taskId: string }> {
  const t = await escrowFor(chain).getTask(taskId);
  return {
    taskId: taskId.toString(),
    agent: t.agent,
    worker: t.worker,
    token: t.token,
    amount: t.amount,
    taskHash: t.taskHash,
    evidenceHash: t.evidenceHash,
    status: Number(t.status),
    createdAt: t.createdAt,
    deadline: t.deadline,
    submissionAttempts: Number(t.submissionAttempts),
  };
}

/** Poster refund before a worker is assigned, on whichever chain holds the task. */
export async function buildCancelTaskOn(
  chain: TaskChain,
  from: string,
  taskId: number,
): Promise<ethers.TransactionRequest> {
  return buildUnsignedTx(escrowFor(chain), 'cancelTask', [taskId], from);
}

/** Post-deadline refund, on whichever chain holds the task. */
export async function buildClaimTimeoutOn(
  chain: TaskChain,
  from: string,
  taskId: number,
): Promise<ethers.TransactionRequest> {
  return buildUnsignedTx(escrowFor(chain), 'claimTimeout', [taskId], from);
}

/**
 * Worker evidence submission, on whichever chain holds the task.
 *
 * The worker signs and broadcasts this, so aiming it at the wrong escrow is
 * unrecoverable from the backend: the tx reverts (or silently no-ops if the
 * wallet is on the other network, since the address has no code there), the
 * task never reaches Submitted, and settleVerification then fails InvalidStatus
 * forever with the escrow still funded.
 */
export async function buildSubmitEvidenceOn(
  chain: TaskChain,
  from: string,
  taskId: number,
  evidenceHash: string,
): Promise<ethers.TransactionRequest> {
  const tx = await buildUnsignedTx(escrowFor(chain), 'submitEvidence', [taskId, evidenceHash], from);
  // Pin the chain into the request. buildUnsignedTx deliberately emits no
  // chainId, and until now nothing downstream added one — so a Base
  // submitEvidence handed to a signer bound to the 0G RPC was simply
  // broadcast there. ethers refuses to send a tx whose chainId disagrees with
  // its provider's network, which turns that silent wrong-chain broadcast into
  // a loud error at the signer regardless of how the caller chose it.
  return { ...tx, chainId: settlementChainConfig(chain).chainId };
}

/** Read the per-task verifier from whichever chain holds the task. */
export async function getTaskVerifierOn(chain: TaskChain, taskId: number): Promise<string> {
  const contract = chainRuntime(chain).escrow;
  // This read has always named the missing escrow without its env var.
  if (!contract) throw new Error(`${settlementChainConfig(chain).label} escrow not configured`);
  return await contract.taskVerifier(taskId);
}
