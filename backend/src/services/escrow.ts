import { escrow, buildUnsignedTx } from './chain.js';
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
): Promise<ethers.TransactionRequest> {
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
