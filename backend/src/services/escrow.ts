import { buildUnsignedTx } from './chain.js';
import { chainRuntime } from './chainRuntime.js';
// The key type comes from the registry, not taskChain.ts, which imports this
// module back.
import { postingChain, settlementChainConfig, type SettlementChainKey as TaskChain } from './settlementChains.js';
import type { OnChainTask } from '../types.js';
import { ethers } from 'ethers';

// Convenience helpers that default to the posting chain for legacy callers that
// only have a numeric task id. New code should prefer the *On variants and pass
// the chain explicitly.

/** Read a single task from the posting chain's escrow. */
export async function getTask(taskId: number): Promise<OnChainTask & { taskId: string }> {
  return getTaskOn(postingChain(), taskId);
}

/** Read the per-task verifier from the posting chain's escrow. */
export async function getTaskVerifier(taskId: number): Promise<string> {
  return getTaskVerifierOn(postingChain(), taskId);
}

/** Build unsigned assignWorker transaction on the posting chain. */
export async function buildAssignWorker(
  from: string,
  taskId: number,
  worker: string,
): Promise<ethers.TransactionRequest> {
  return buildUnsignedTx(escrowFor(postingChain()), 'assignWorker', [taskId, worker], from);
}

/** Build unsigned submitEvidence transaction on the posting chain. */
export async function buildSubmitEvidence(
  from: string,
  taskId: number,
  evidenceHash: string,
): Promise<ethers.TransactionRequest> {
  return buildSubmitEvidenceOn(postingChain(), from, taskId, evidenceHash);
}

/** Build unsigned completeVerification transaction on the posting chain. */
export async function buildCompleteVerification(
  from: string,
  taskId: number,
  passed: boolean,
): Promise<ethers.TransactionRequest> {
  return buildUnsignedTx(escrowFor(postingChain()), 'completeVerification', [taskId, passed], from);
}

/** The read-only BlindEscrow on `chain`. Throws when this deployment has none there. */
export function escrowFor(chain: TaskChain): ethers.Contract {
  const contract = chainRuntime(chain).escrow;
  if (!contract) {
    const { label, escrowEnv } = settlementChainConfig(chain);
    throw new Error(`${label} escrow not configured (${escrowEnv})`);
  }
  return contract;
}

/** The platform fee, in basis points, the escrow on `chain` applies at settlement. */
export async function feeBpsOn(chain: TaskChain): Promise<number> {
  return Number(await escrowFor(chain).feeBps());
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

/** One task of a createTasks batch: BlindEscrow.TaskInput. */
export interface CreateTaskInput {
  taskHash: string;
  amount: bigint;
  category: string;
  locationZone: string;
  duration: bigint;
  /** The verifier committed on-chain for this task; unset or the zero address for none. */
  verifierAgent?: string;
}

/** EIP-7825 (Osaka) caps one transaction at 2^24 gas, below the block gas limit. */
export const TX_GAS_CAP = 16_777_216n;

/** How long a build waits for the gas estimate before falling back to createTasksGasFallback. */
const ESTIMATE_TIMEOUT_MS = 5_000;

/** Storage words a string takes beyond its own slot: none up to 31 bytes, one per 32 bytes above that. */
function extraStringWords(value: string): bigint {
  const bytes = Buffer.byteLength(value, 'utf8');
  return bytes > 31 ? BigInt(Math.ceil(bytes / 32)) : 0n;
}

/**
 * The gas limit for createTasks of `inputs` when it can't be estimated.
 * Measured on an escrow with no TaskRegistry (Base and Arc have none): about
 * 202k per task plus 57k, with short strings and no verifier. That is rounded
 * up to 210k and 100k; a category or locationZone longer than 31 bytes is
 * stored in one more slot per 32 bytes (~22k each), and a verifier is one
 * more slot and an event. A fifth goes on top, and the result never passes
 * TX_GAS_CAP. Never a single task's limit: a batch reusing it runs out of gas.
 */
export function createTasksGasFallback(inputs: readonly CreateTaskInput[]): bigint {
  let gas = 100_000n;
  for (const input of inputs) {
    gas += 210_000n + 25_000n * (extraStringWords(input.category) + extraStringWords(input.locationZone));
    if (input.verifierAgent && input.verifierAgent !== ethers.ZeroAddress) gas += 30_000n;
  }
  const buffered = (gas * 120n) / 100n;
  return buffered < TX_GAS_CAP ? buffered : TX_GAS_CAP;
}

/**
 * Build an unsigned createTasks on `chain`: every input escrowed in one
 * transaction, in `token` (an ERC-20; the escrow refuses address(0) and any
 * value, so the tx carries none). The escrow checks each task as createTask
 * does and reverts the whole batch if one fails.
 *
 * The tx carries a gasLimit: the escrow's estimate for `from` plus a fifth,
 * or createTasksGasFallback when the estimate fails (the poster may approve
 * the total after building) or is slow. Only `from`'s wallet can say which,
 * so a revert here does not refuse the build.
 */
export async function buildCreateTasksOn(
  chain: TaskChain,
  from: string,
  token: string,
  inputs: readonly CreateTaskInput[],
): Promise<ethers.TransactionRequest> {
  const escrow = escrowFor(chain);
  const tasks = inputs.map((input) => ({
    taskHash: input.taskHash,
    amount: input.amount,
    category: input.category,
    locationZone: input.locationZone,
    duration: input.duration,
    verifierAgent: input.verifierAgent || ethers.ZeroAddress,
  }));
  const tx = await buildUnsignedTx(escrow, 'createTasks', [token, tasks], from);
  let gasLimit = createTasksGasFallback(inputs);
  try {
    const { provider } = chainRuntime(chain);
    const estimate = await Promise.race([
      provider.estimateGas({ from: tx.from, to: tx.to, data: tx.data }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('estimate timed out')), ESTIMATE_TIMEOUT_MS).unref()),
    ]);
    const buffered = (estimate * 120n) / 100n;
    gasLimit = buffered < TX_GAS_CAP ? buffered : TX_GAS_CAP;
  } catch {
    // Keep the fallback.
  }
  // A number (at most 2^24, so exact), as the web app's UnsignedTx types it;
  // chainId pins the network as buildSubmitEvidenceOn does.
  return { ...tx, gasLimit: Number(gasLimit), chainId: settlementChainConfig(chain).chainId };
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

/** An eth_call the contract reverted (as opposed to an RPC failure). */
function isCallException(err: unknown): err is { code: 'CALL_EXCEPTION'; revert?: { name?: string } | null } {
  return (err as { code?: string } | null)?.code === 'CALL_EXCEPTION';
}

/**
 * Dry-run the poster's claimTimeout as `from`. Resolves to null when the
 * escrow would accept it, or to the name of the custom error it would revert
 * with ('reverted' when the revert carries none this ABI decodes). An RPC
 * failure throws. The escrow's own rules decide (deadline moved by pauses,
 * appeal and dispute windows, escalated work), so they are not restated here.
 */
export async function claimTimeoutRevertOn(chain: TaskChain, from: string, taskId: number): Promise<string | null> {
  try {
    await escrowFor(chain).claimTimeout.staticCall(taskId, { from: ethers.getAddress(from) });
    return null;
  } catch (err) {
    if (!isCallException(err)) throw err;
    return err.revert?.name ?? 'reverted';
  }
}

/**
 * The deadline the escrow enforces: the task's deadline moved by the time the
 * escrow spent paused since it was created (BlindEscrow.effectiveDeadline,
 * security audit run 1, C36). Null on an escrow from before that upgrade,
 * which enforces the raw getTask().deadline.
 */
export async function effectiveDeadlineOn(chain: TaskChain, taskId: number): Promise<bigint | null> {
  try {
    return BigInt(await escrowFor(chain).effectiveDeadline(taskId));
  } catch (err) {
    if (isCallException(err)) return null;
    throw err;
  }
}

/**
 * Whether the escrow on `chain` escalates delivered, unjudged work instead of
 * refunding it at the deadline (security audit run 1, C18). False on an
 * escrow from before that upgrade, where claimTimeout on a Submitted task
 * still refunds the poster.
 */
export async function escalatesUnjudgedWorkOn(chain: TaskChain, taskId: number): Promise<boolean> {
  try {
    await escrowFor(chain).unjudgedEscalation(taskId);
    return true;
  } catch (err) {
    if (isCallException(err)) return false;
    throw err;
  }
}

/** Read the per-task verifier from whichever chain holds the task. */
export async function getTaskVerifierOn(chain: TaskChain, taskId: number): Promise<string> {
  const contract = chainRuntime(chain).escrow;
  if (!contract) throw new Error(`${settlementChainConfig(chain).label} escrow not configured`);
  return await contract.taskVerifier(taskId);
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

/** Build an unsigned submitOpen (an open-submission task) on `chain`, for the submitting agent to sign. */
export async function buildSubmitOpenOn(
  chain: TaskChain,
  from: string,
  taskId: number,
  evidenceHash: string,
): Promise<ethers.TransactionRequest> {
  const tx = await buildUnsignedTx(escrowFor(chain), 'submitOpen', [taskId, evidenceHash], from);
  return { ...tx, chainId: settlementChainConfig(chain).chainId };
}

/** Build an unsigned selectWinner (the poster's pick on an open task) on `chain`, for the poster to sign. */
export async function buildSelectWinnerOn(
  chain: TaskChain,
  from: string,
  taskId: number,
  winner: string,
  scorecardHash: string,
): Promise<ethers.TransactionRequest> {
  const tx = await buildUnsignedTx(escrowFor(chain), 'selectWinner', [taskId, winner, scorecardHash], from);
  return { ...tx, chainId: settlementChainConfig(chain).chainId };
}


