/**
 * The only transactions a backend may hand this client to sign.
 *
 * The backend builds createTask (or createTasks), submitEvidence, cancelTask and claimTimeout
 * for the client's own key to sign, and for open-submission tasks createTaskOpen, submitOpen,
 * selectWinner (the poster's pick) and voidOpenTask (the poster's refund when nothing was
 * submitted). Whoever answers at `apiBase` (a
 * compromised or malicious backend, an untrusted apiBase, a network attacker
 * on plain http) controls that JSON, so a client that signs it as given signs
 * anything: a native transfer, an ERC-20 approve or transfer, on any chain it
 * has an RPC for. Before a key signs, the transaction is decoded and checked
 * to be exactly the escrow call the caller asked for, with zero value (or the
 * escrow amount the client computed itself), and only `{ to, data }` is kept.
 * Gas, fee, nonce, type and chainId fields from the backend are never
 * forwarded (security audit run 1, C41).
 *
 * The escrow address itself comes from the same backend (/health/settlement),
 * so the target check catches misrouting; the function, argument and value
 * checks are what bound a malicious answer.
 */
import { ethers } from 'ethers';
import { ApiError } from './apiError.js';

export const ESCROW_CALLS = new ethers.Interface([
  'function createTask(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration)',
  'function createTaskWithVerifier(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration, address verifierAgent)',
  // Several tasks in one transaction, on an escrow that has it (docs/BULK-POSTING.md).
  'function createTasks(address token, tuple(bytes32 taskHash, uint256 amount, string category, string locationZone, uint256 duration, address verifierAgent)[] tasks)',
  'function submitEvidence(uint256 taskId, bytes32 evidenceHash)',
  'function cancelTask(uint256 taskId)',
  'function claimTimeout(uint256 taskId)',
  // Open submission, on an escrow that has it (docs/OPEN-SUBMISSION-TASKS.md).
  'function createTaskOpen(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration, address verifierAgent, uint8 mode, uint256 creatorWindow)',
  'function submitOpen(uint256 taskId, bytes32 evidenceHash)',
  'function selectWinner(uint256 taskId, address winner, bytes32 scorecardHash)',
  'function voidOpenTask(uint256 taskId, bytes32 scorecardHash)',
]);

export type EscrowFunction =
  | 'createTask'
  | 'createTaskWithVerifier'
  | 'createTasks'
  | 'submitEvidence'
  | 'cancelTask'
  | 'claimTimeout'
  | 'createTaskOpen'
  | 'submitOpen'
  | 'selectWinner'
  | 'voidOpenTask';

/**
 * The evidence hash the backend commits for a result: keccak256 of the UTF-8
 * JSON of `resultData`, exactly as POST /a2a/tasks/:id/submit computes it
 * (backend/src/routes/a2a.ts). JSON.stringify of the parsed request body gives
 * the same string the client serialized.
 */
export function evidenceHashOf(resultData: Record<string, unknown>): string {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(resultData)));
}

export interface ExpectedEscrowCall {
  /** The escrow the transaction must target. */
  escrow: string;
  fn: EscrowFunction;
  /** The decoded arguments must satisfy this. */
  args: (args: ethers.Result) => boolean;
  /** The only value the backend may name (default 0). A transaction that names none is fine: it is never forwarded. */
  value?: bigint;
  /** When the backend's transaction names a chainId, it must be this one. */
  chainId?: number;
}

/**
 * Check a backend-built transaction is exactly `expect`, and return the only
 * fields the client signs. Throws, with nothing sent: ESCROW_MISMATCH for
 * another target, CHAIN_MISMATCH for another chain id, TX_MISMATCH for
 * another function, other arguments, non-canonical calldata or a value.
 */
export function checkEscrowCall(tx: unknown, expect: ExpectedEscrowCall, what: string): { to: string; data: string } {
  const t = (tx !== null && typeof tx === 'object' ? tx : {}) as { to?: unknown; data?: unknown; value?: unknown; chainId?: unknown };
  if (typeof t.to !== 'string' || t.to.toLowerCase() !== expect.escrow.toLowerCase()) {
    throw new ApiError(
      409,
      `${what}: the backend built the transaction for ${String(t.to)}, not the escrow ${expect.escrow}. Nothing was sent.`,
      undefined,
      'ESCROW_MISMATCH',
    );
  }
  if (expect.chainId !== undefined && t.chainId != null && Number(t.chainId) !== expect.chainId) {
    throw new ApiError(
      409,
      `${what}: the backend built the transaction for chain ${String(t.chainId)}, not chain ${expect.chainId}. Nothing was sent.`,
      undefined,
      'CHAIN_MISMATCH',
    );
  }
  const data = typeof t.data === 'string' ? t.data.toLowerCase() : '';
  let args: ethers.Result | undefined;
  try {
    const decoded = ESCROW_CALLS.decodeFunctionData(expect.fn, data);
    // Canonical ABI encoding only: nothing may ride along after the arguments.
    if (ESCROW_CALLS.encodeFunctionData(expect.fn, decoded).toLowerCase() === data) args = decoded;
  } catch {
    // Another function, or not ABI data at all.
  }
  let valueOk = t.value == null;
  if (!valueOk) {
    try {
      valueOk = ethers.getBigInt(t.value as ethers.BigNumberish) === (expect.value ?? 0n);
    } catch {
      valueOk = false;
    }
  }
  let argsOk = false;
  if (args) {
    try {
      argsOk = expect.args(args);
    } catch {
      argsOk = false;
    }
  }
  if (!args || !argsOk || !valueOk) {
    const why = !args ? `is not a ${expect.fn} call` : !argsOk ? `is a ${expect.fn} call with other arguments than this one` : 'carries a value';
    throw new ApiError(
      409,
      `${what}: the transaction the backend built ${why}. Only the escrow call you asked for is signed. Nothing was sent.`,
      undefined,
      'TX_MISMATCH',
    );
  }
  return { to: ethers.getAddress(expect.escrow.toLowerCase()), data };
}

/** `id` as a uint256 task id, or undefined when it is not a whole number. */
export function taskIdOf(id: unknown): bigint | undefined {
  if (typeof id === 'bigint') return id;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) return BigInt(id);
  if (typeof id === 'string' && /^\d+$/.test(id)) return BigInt(id);
  return undefined;
}
