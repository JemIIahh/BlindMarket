import * as a2aStore from './a2aStore.js';
import { resolveCachedTaskByHash, resolveTaskByHash } from './taskChain.js';
import * as escrowService from './escrow.js';
import { loadAgentByWallet } from './deployedAgentStore.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * Whether an on-chain worker field belongs to an executor: either the EOA
 * itself (legacy assignment) or its BlindAccount (AA assignment on Base).
 */
export async function isOwnedOnChain(executor: string, onChainWorker: string): Promise<boolean> {
  if (onChainWorker.toLowerCase() === executor.toLowerCase()) return true;
  const agent = await loadAgentByWallet(executor).catch(() => null);
  return !!agent?.smartAccountAddress && onChainWorker.toLowerCase() === agent.smartAccountAddress.toLowerCase();
}

// ── Stuck-task triage ─────────────────────────────────────────────────────────
// Shared by the founder-gated admin routes (routes/admin.ts) and the operator
// scripts (scripts/stuck-tasks.ts, scripts/force-release.ts) so the two
// surfaces cannot drift apart. There are no founder addresses configured yet,
// so the scripts are the live surface; the routes are ready for when they are.

export type StuckVerdict = 'safe-to-release' | 'owned-on-chain' | 'unmapped' | 'chain-unreachable';

export interface StuckTaskRow {
  taskId: string;
  status: string;
  acceptedAt: string | null;
  ageMs: number | null;
  executorAddress: string | null;
  // Who the contract will accept evidence from (smart account when the agent
  // has one, else the EOA). Mismatches against onChainWorker pinpoint whether
  // a task predates the AA rollout (legacy EOA assignment).
  submitterAddress: string | null;
  chain: string | null;
  agent: { id: string; name: string; status: string; lastActiveAt: string | null } | null;
  assignTxHash: string | null;
  onChainId: string | null;
  onChainStatus: number | null;
  onChainWorker: string | null;
  verdict: StuckVerdict;
}

/**
 * List every task sitting in a non-terminal, non-open off-chain state with
 * the evidence needed to judge whether it can be freed. Read-only.
 */
export async function diagnoseStuckTasks(): Promise<StuckTaskRow[]> {
  const candidates = await a2aStore.listStuckCandidates();
  const rows: StuckTaskRow[] = [];
  for (const { taskId, state } of candidates) {
    const meta = await a2aStore.getMeta(taskId).catch(() => undefined);
    const executor = state.executorAddress;
    const agent = executor ? await loadAgentByWallet(executor).catch(() => null) : null;

    const acceptedAtMs = state.acceptedAt ? new Date(state.acceptedAt).getTime() : null;
    // The address the contract will accept evidence from: the smart account
    // for AA-assigned tasks, the EOA otherwise. The worker matches its
    // broadcast path (UserOp vs raw tx) to this address.
    const submitterAddress = agent?.smartAccountAddress || executor || null;
    const base: Omit<StuckTaskRow, 'onChainId' | 'onChainStatus' | 'onChainWorker' | 'verdict'> = {
      taskId,
      status: state.status,
      acceptedAt: state.acceptedAt ?? null,
      ageMs: acceptedAtMs ? Date.now() - acceptedAtMs : null,
      executorAddress: executor ?? null,
      submitterAddress,
      chain: meta?.chain ?? null,
      agent: agent
        ? { id: agent.id, name: agent.name, status: agent.status, lastActiveAt: agent.lastActiveAt ?? null }
        : null,
      assignTxHash: (state as { assignTxHash?: string }).assignTxHash ?? null,
    };

    // Prefer the cached mapping: the full resolve can trigger indexer ticks
    // and a deployment scan per task, which is too heavy for a list view.
    const resolved = await resolveCachedTaskByHash(taskId).catch(() => null);
    if (!resolved) {
      rows.push({ ...base, onChainId: null, onChainStatus: null, onChainWorker: null, verdict: 'unmapped' });
      continue;
    }
    const onChain = await escrowService
      .getTaskOn(resolved.chain, Number(resolved.taskId))
      .catch(() => null);
    if (!onChain) {
      rows.push({ ...base, onChainId: resolved.taskId, onChainStatus: null, onChainWorker: null, verdict: 'chain-unreachable' });
      continue;
    }
    const statusNum = Number(onChain.status);
    rows.push({
      ...base,
      onChainId: resolved.taskId,
      onChainStatus: statusNum,
      onChainWorker: (onChain as { worker?: string }).worker ?? null,
      verdict: statusNum === 0 ? 'safe-to-release' : 'owned-on-chain',
    });
  }
  // Oldest first — the longest-stranded tasks are the ones to triage.
  rows.sort((a, b) => (b.ageMs ?? -1) - (a.ageMs ?? -1));
  return rows;
}

/**
 * Flip one stuck task back to 'open' so the board lists it again. Carries the
 * SAME on-chain guard as POST /a2a/tasks/:id/release: refuses with 409
 * ON_CHAIN_LOCKED when the escrow has moved past Funded (a worker really is
 * assigned — releasing would desync Redis from the contract), and with 503
 * when the chain can't be read. `actor` is only used for the audit log.
 */
export async function forceReleaseTask(
  taskHash: string,
  actor: string,
): Promise<{ taskId: string; status: string; noop?: boolean; forced?: boolean }> {
  const meta = await a2aStore.getMeta(taskHash);
  if (!meta) throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');
  const state = await a2aStore.getState(taskHash);
  if (!state) throw new AppError(404, 'NOT_FOUND', 'Task state missing');
  if (state.status === 'open') return { taskId: taskHash, status: 'open', noop: true };
  if (state.status !== 'accepted' && state.status !== 'in_progress' && state.status !== 'submitted') {
    throw new AppError(409, 'INVALID_STATE', `Cannot force-release in state: ${state.status}`);
  }

  const onChainIdResolved = await resolveTaskByHash(taskHash);
  const onChainId = onChainIdResolved?.taskId ?? null;
  const onChainIdChain = onChainIdResolved?.chain ?? '0g';
  if (onChainId) {
    let onChainStatus: number;
    try {
      const onChainTask = await escrowService.getTaskOn(onChainIdChain, Number(onChainId));
      onChainStatus = Number(onChainTask.status);
    } catch (err) {
      throw new AppError(
        503,
        'ON_CHAIN_CHECK_FAILED',
        `Could not verify on-chain task status before force-release: ${(err as Error).message}`,
      );
    }
    if (onChainStatus !== 0) {
      throw new AppError(
        409,
        'ON_CHAIN_LOCKED',
        `Task is on-chain status ${onChainStatus} (not Funded) — owned by the assigned worker, cannot force-release`,
      );
    }
  }

  await a2aStore.releaseToOpen(taskHash);
  // Drop stale routing artefacts pointing at the dead executor so the next
  // accept isn't gated by an exclusive offer/cascade that can never clear.
  await Promise.all([
    a2aStore.clearOffer(taskHash).catch(() => {}),
    a2aStore.clearCascade(taskHash).catch(() => {}),
  ]);
  console.log(`[stuckTasks] force-release: ${taskHash} reverted to open by ${actor}`);
  return { taskId: taskHash, status: 'open', forced: true };
}

/**
 * Rewind one task from off-chain 'submitted' back to 'accepted' so the
 * owning worker's resume path re-drives it (re-accept → fresh /submit →
 * broadcast → finalize).
 *
 * This heals the "submitted off-chain, Assigned on-chain, evidence never
 * broadcast" dead state: /submit flips state to 'submitted' at
 * unsigned-tx-build time, BEFORE broadcast, so a worker that dies (or hits a
 * local build bug, e.g. the UserOp `.from` parse failure) in that gap leaves
 * evidence nowhere. From there nothing can heal it: /submit 409s
 * INVALID_STATE on 'submitted', resume treats 'submitted' as finalize-only
 * (which 503s NOT_SUBMITTED_ON_CHAIN forever), and /release refuses with
 * ON_CHAIN_LOCKED because the escrow is Assigned.
 *
 * Guards (all must hold, else 409/503):
 *   - off-chain state is exactly 'submitted'
 *   - on-chain status is Assigned(1) AND on-chain worker == recorded executor
 *     (evidence never landed AND nobody else can drive it — rewinding a
 *     Submitted task would fork a second evidence round; rewinding a task
 *     whose worker differs would hand it to the wrong agent)
 *
 * Caveat: if evidence WAS broadcast but the backend's RPC view is lagging
 * (pending tx invisible), rewinding causes a duplicate submitEvidence, which
 * reverts on-chain once the first confirms (wasted gas, no state corruption).
 * Only rewind tasks whose broadcast is known-never-sent (build error in the
 * worker log) or long-stale with no tx hash anywhere.
 */
export async function rewindSubmittedTask(
  taskHash: string,
  actor: string,
): Promise<{ taskId: string; status: string; rewound: boolean }> {
  const meta = await a2aStore.getMeta(taskHash);
  if (!meta) throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');
  const state = await a2aStore.getState(taskHash);
  if (!state) throw new AppError(404, 'NOT_FOUND', 'Task state missing');
  if (state.status !== 'submitted') {
    throw new AppError(409, 'INVALID_STATE', `Cannot rewind in state: ${state.status} (need 'submitted')`);
  }
  const executor = state.executorAddress;
  if (!executor) throw new AppError(409, 'INVALID_STATE', 'Submitted state has no recorded executor');

  const onChainIdResolved = await resolveTaskByHash(taskHash);
  const onChainId = onChainIdResolved?.taskId ?? null;
  const onChainIdChain = onChainIdResolved?.chain ?? '0g';
  if (!onChainId) {
    throw new AppError(409, 'UNMAPPED', 'No on-chain mapping for this task — re-index before rewinding');
  }
  let onChainStatus: number;
  let onChainWorker: string;
  try {
    const onChainTask = await escrowService.getTaskOn(onChainIdChain, Number(onChainId));
    onChainStatus = Number(onChainTask.status);
    onChainWorker = (onChainTask as { worker?: string }).worker ?? '';
  } catch (err) {
    throw new AppError(
      503,
      'ON_CHAIN_CHECK_FAILED',
      `Could not verify on-chain task status before rewind: ${(err as Error).message}`,
    );
  }
  if (onChainStatus !== 1 || !(await isOwnedOnChain(executor, onChainWorker))) {
    throw new AppError(
      409,
      'NOT_REWINDABLE',
      `On-chain status is ${onChainStatus} worker ${onChainWorker || '?'} — rewind needs Assigned(1) to ${executor} or its smart account (evidence never landed)`,
    );
  }

  // Patch-merge: executor, acceptedAt, resultData and round bookkeeping stay;
  // only the status moves, so resume treats it as owed work again.
  await a2aStore.updateState(taskHash, { status: 'accepted' });
  await Promise.all([
    a2aStore.clearOffer(taskHash).catch(() => {}),
    a2aStore.clearCascade(taskHash).catch(() => {}),
  ]);
  console.log(`[stuckTasks] rewind: ${taskHash} submitted→accepted by ${actor}`);
  return { taskId: taskHash, status: 'accepted', rewound: true };
}
