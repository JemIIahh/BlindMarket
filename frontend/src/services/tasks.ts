import { get, authedGet, authedPost } from '../lib/api';
import type { OnChainTask, TaskMeta, Application, UnsignedTx } from '../types/api';
import { getSettlement, isSettlementChainKey } from '../config/settlement';

interface TasksResponse {
  tasks: TaskMeta[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export async function getOpenTasks(offset = 0, limit = 20): Promise<TaskMeta[]> {
  const res = await get<TasksResponse>(`/api/v1/tasks?offset=${offset}&limit=${limit}`);
  return res.tasks;
}

export async function getTask(taskId: string): Promise<{ onChain: OnChainTask; meta: TaskMeta }> {
  // Backend returns task fields at top level + nested meta. Authed so the
  // poster/worker gets a2aState.resultData (the deliverable) — the backend
  // withholds it from anonymous callers.
  const raw = await authedGet<OnChainTask & { meta: TaskMeta | null }>(`/api/v1/tasks/${taskId}`);
  const { meta, ...onChain } = raw;
  return {
    onChain,
    meta: meta ?? {
      taskId,
      agent: onChain.agent,
      category: 'unknown',
      locationZone: 'Global',
      reward: onChain.amount,
      createdAt: onChain.createdAt,
      isOpen: onChain.status === 0,
    },
  };
}

export async function applyToTask(taskId: string, message?: string): Promise<{ application_id: string }> {
  return authedPost<{ application_id: string }>(`/api/v1/tasks/${taskId}/apply`, { message });
}

export async function getApplications(taskId: string): Promise<Application[]> {
  const res = await authedGet<{ applications: Application[] }>(`/api/v1/tasks/${taskId}/applications`);
  return res.applications;
}

/** A refund tx (cancel / claimTimeout) and the chain the backend built it for. */
export interface RefundTx {
  unsignedTx: UnsignedTx;
  chain?: string;
}

/**
 * Numeric task ids collide across chains (Arc starts at 1, Base has 1-24), so
 * the caller names the task's chain and the backend resolves only there.
 */
export async function buildCancelTask(taskId: string, chain: string): Promise<RefundTx> {
  return authedPost<RefundTx>(`/api/v1/tasks/${taskId}/cancel`, { chain });
}

export async function buildClaimTimeout(taskId: string, chain: string): Promise<RefundTx> {
  return authedPost<RefundTx>(`/api/v1/tasks/${taskId}/timeout`, { chain });
}

/**
 * Refuse to sign a refund tx that is not for the task on screen: it must be
 * built for the task's chain and call that chain's escrow. A Base escrow
 * address has no code on Arc, so signing one there "succeeds" and refunds
 * nothing.
 */
export function assertRefundTarget(built: RefundTx, taskChain: string | null | undefined): UnsignedTx {
  if (!isSettlementChainKey(taskChain)) {
    throw new Error(`This task's chain (${String(taskChain)}) is not one this app can send refunds on.`);
  }
  if (built.chain !== taskChain) {
    throw new Error(`The refund was built for ${String(built.chain)}, but this task is on ${taskChain}. Nothing was signed.`);
  }
  const escrow = getSettlement().chains[taskChain].escrow;
  if (!escrow || built.unsignedTx.to?.toLowerCase() !== escrow.toLowerCase()) {
    throw new Error(`The refund does not target the ${taskChain} escrow. Nothing was signed.`);
  }
  return built.unsignedTx;
}
