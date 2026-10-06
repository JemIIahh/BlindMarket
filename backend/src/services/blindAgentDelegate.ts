/**
 * The BlindAgentDelegate contract as the relayer sees it: its ABI, the
 * EIP-712 call an agent signs, and the escrow events that prove a sponsored
 * call did its job (docs/AGENT-GAS-FUNDING.md, "The delegate contract").
 *
 * The agent's wallet delegates to the contract (EIP-7702), so the relayer
 * calls execute() on the WALLET's address. The signed struct names the escrow
 * the delegate is bound to; the call itself does not carry it.
 * worker.js signs the same struct (its copy is checked against this one in
 * agents/sponsored-gas.test.ts).
 *
 * Versions: a version-2 delegate (DELEGATE_VERSION() = 2) also relays
 * submitOpen for open-submission tasks. The delegates deployed on Arc testnet
 * and mainnet as of 2026-10 are version 1, which has no DELEGATE_VERSION and
 * relays submitEvidence and releaseUnjudgedWork only; delegateVersion() tells
 * them apart. The signed struct and domain are the same under both.
 */
import { ethers } from 'ethers';

export const DELEGATE_ABI = [
  'function execute((uint8 kind, uint256 taskId, bytes32 evidenceHash, uint256 nonce, uint256 deadline) c, bytes signature)',
  'function nonce() view returns (uint256)',
  'function ESCROW() view returns (address)',
  'function DELEGATE_VERSION() view returns (uint256)',
  'event SponsoredCall(uint8 kind, uint256 taskId, uint256 nonce)',
  'error ZeroAddress()',
  'error Expired()',
  'error InvalidNonce(uint256 current)',
  'error InvalidSignature()',
  'error UnexpectedEvidenceHash()',
] as const;

export const delegateInterface = new ethers.Interface(DELEGATE_ABI);

/** BlindAgentDelegate.Kind. SubmitOpen needs a version-2 delegate (SUBMIT_OPEN_DELEGATE_VERSION). */
export enum DelegateKind {
  SubmitEvidence = 0,
  ReleaseUnjudgedWork = 1,
  SubmitOpen = 2,
}

/** The first BlindAgentDelegate version that relays DelegateKind.SubmitOpen. */
export const SUBMIT_OPEN_DELEGATE_VERSION = 2n;

/**
 * The delegate's version: DELEGATE_VERSION(), or 1 when that call reverts,
 * as it does on version 1, which has no such function. Null when the answer
 * is unknown (the RPC failed, or nothing sensible came back): a caller must
 * then not offer anything a later version adds.
 */
export async function delegateVersion(provider: Pick<ethers.Provider, 'call'>, delegate: string): Promise<bigint | null> {
  let raw: string;
  try {
    raw = await provider.call({ to: delegate, data: delegateInterface.encodeFunctionData('DELEGATE_VERSION') });
  } catch (e) {
    return ethers.isError(e, 'CALL_EXCEPTION') ? 1n : null;
  }
  try {
    return BigInt(delegateInterface.decodeFunctionResult('DELEGATE_VERSION', raw)[0]);
  } catch {
    return null;
  }
}

export interface DelegateCall {
  kind: DelegateKind;
  taskId: bigint;
  evidenceHash: string;
  nonce: bigint;
  deadline: bigint;
}

/** The EIP-712 types of a signed call: the call plus the bound escrow. */
export const CALL_TYPES: Record<string, ethers.TypedDataField[]> = {
  Call: [
    { name: 'kind', type: 'uint8' },
    { name: 'escrow', type: 'address' },
    { name: 'taskId', type: 'uint256' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

/** The signing domain: bound to the wallet itself and the chain. */
export function callDomain(chainId: number | bigint, wallet: string): ethers.TypedDataDomain {
  return { name: 'BlindAgentDelegate', version: '1', chainId, verifyingContract: ethers.getAddress(wallet) };
}

/** Who signed `call` for `wallet`, or null when the signature is malformed. */
export function callSigner(chainId: number | bigint, wallet: string, escrow: string, call: DelegateCall, signature: string): string | null {
  try {
    return ethers.verifyTypedData(
      callDomain(chainId, wallet),
      CALL_TYPES,
      { kind: call.kind, escrow: ethers.getAddress(escrow), taskId: call.taskId, evidenceHash: call.evidenceHash, nonce: call.nonce, deadline: call.deadline },
      signature,
    );
  } catch {
    return null;
  }
}

export function encodeExecute(call: DelegateCall, signature: string): string {
  return delegateInterface.encodeFunctionData('execute', [
    [call.kind, call.taskId, call.evidenceHash, call.nonce, call.deadline],
    signature,
  ]);
}

/** The delegate error an eth_estimateGas / eth_call revert carries, if it is one. */
export function delegateError(data: string | null | undefined): ethers.ErrorDescription | null {
  if (!data || data.length < 10) return null;
  try {
    return delegateInterface.parseError(data);
  } catch {
    return null;
  }
}

const ESCROW_EVENTS = new ethers.Interface([
  'event EvidenceSubmitted(uint256 indexed taskId, address indexed worker, bytes32 evidenceHash, uint8 attempt)',
  'event UnjudgedWorkReleased(uint256 indexed taskId, uint256 workerPayout, uint256 platformFee)',
  'event OpenSubmission(uint256 indexed taskId, address indexed submitter, bytes32 evidenceHash, uint256 count)',
]);

const PROOF_EVENT: Record<DelegateKind, string> = {
  [DelegateKind.SubmitEvidence]: 'EvidenceSubmitted',
  [DelegateKind.ReleaseUnjudgedWork]: 'UnjudgedWorkReleased',
  [DelegateKind.SubmitOpen]: 'OpenSubmission',
};

/**
 * Whether a receipt holds the escrow event a sponsored call of `kind` must
 * produce for `taskId`: EvidenceSubmitted by `wallet`, UnjudgedWorkReleased,
 * or OpenSubmission by `wallet`. A stale or foreign 7702 authorization leaves
 * a successful receipt with none of them.
 */
export function receiptProvesCall(
  logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }>,
  escrow: string,
  kind: DelegateKind,
  taskId: bigint,
  wallet: string,
): boolean {
  const want = PROOF_EVENT[kind];
  return logs.some((log) => {
    if (log.address.toLowerCase() !== escrow.toLowerCase()) return false;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = ESCROW_EVENTS.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      return false;
    }
    if (!parsed || parsed.name !== want || BigInt(parsed.args.taskId) !== taskId) return false;
    if (want === 'EvidenceSubmitted') return String(parsed.args.worker).toLowerCase() === wallet.toLowerCase();
    if (want === 'OpenSubmission') return String(parsed.args.submitter).toLowerCase() === wallet.toLowerCase();
    return true;
  });
}
