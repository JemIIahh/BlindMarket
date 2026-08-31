import { escrow, baseEscrow, buildUnsignedTx } from './chain.js';
import type { OnChainTask } from '../types.js';
import { ethers } from 'ethers';

/** Read a single task from BlindEscrow */
export async function getTask(taskId: number): Promise<OnChainTask & { taskId: string }> {
  const t = await escrow.getTask(taskId);
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

/** Get the next task ID (tells us how many tasks exist) */
export async function nextTaskId(): Promise<number> {
  return Number(await escrow.nextTaskId());
}

/** Get fee basis points */
export async function feeBps(): Promise<number> {
  return Number(await escrow.feeBps());
}

/**
 * Read the per-task verifier (taskVerifier mapping). ZeroAddress means the
 * task was funded via plain createTask — completeVerification is then gated
 * on the GLOBAL marketplace verifier, and a poster-designated verifier agent
 * can never settle it (its tx reverts NotVerifier).
 */
export async function getTaskVerifier(taskId: number): Promise<string> {
  return await escrow.taskVerifier(taskId);
}

/** Read per-task verifier from Base escrow */
export async function getTaskVerifierBase(taskId: number): Promise<string> {
  if (!baseEscrow) throw new Error('Base escrow not configured');
  return await baseEscrow.taskVerifier(taskId);
}

/** Build unsigned createTask transaction */
export async function buildCreateTask(
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

/** Build unsigned assignWorker transaction */
export async function buildAssignWorker(
  from: string,
  taskId: number,
  worker: string,
): Promise<ethers.TransactionRequest> {
  return buildUnsignedTx(escrow, 'assignWorker', [taskId, worker], from);
}

/** Build unsigned cancelTask transaction */
export async function buildCancelTask(
  from: string,
  taskId: number,
): Promise<ethers.TransactionRequest> {
  return buildUnsignedTx(escrow, 'cancelTask', [taskId], from);
}

/** Build unsigned claimTimeout transaction */
export async function buildClaimTimeout(
  from: string,
  taskId: number,
): Promise<ethers.TransactionRequest> {
  return buildUnsignedTx(escrow, 'claimTimeout', [taskId], from);
}

/** Build unsigned submitEvidence transaction */
export async function buildSubmitEvidence(
  from: string,
  taskId: number,
  evidenceHash: string,
): Promise<ethers.TransactionRequest> {
  return buildUnsignedTx(escrow, 'submitEvidence', [taskId, evidenceHash], from);
}

/** Build unsigned completeVerification transaction */
export async function buildCompleteVerification(
  from: string,
  taskId: number,
  passed: boolean,
): Promise<ethers.TransactionRequest> {
  return buildUnsignedTx(escrow, 'completeVerification', [taskId, passed], from);
}

// ── Base escrow (settlement — USDC payouts) ────────────────────────────────

/** Build unsigned createTask transaction against Base escrow */
export async function buildCreateTaskBase(
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
  if (!baseEscrow) throw new Error('Base escrow not configured (BASE_ESCROW_ADDRESS)');
  if (verifierAgent && verifierAgent !== ethers.ZeroAddress) {
    return buildUnsignedTx(
      baseEscrow,
      'createTaskWithVerifier',
      [taskHash, token, amount, category, locationZone, duration, verifierAgent],
      from,
      value,
    );
  }
  return buildUnsignedTx(baseEscrow, 'createTask', [taskHash, token, amount, category, locationZone, duration], from, value);
}
