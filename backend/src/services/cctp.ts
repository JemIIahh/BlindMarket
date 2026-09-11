import { ethers } from 'ethers';
import type { CctpChainConfig } from './cctpChains.js';

/**
 * Circle CCTP V2 — raw contract + Iris attestation API calls. No route/auth
 * logic here; callers (routes/agentsCctp.ts, routes/cctp.ts,
 * services/cctpAttestationPoller.ts) own persistence and authorization.
 *
 * Signatures below were confirmed verbatim against
 * developers.circle.com/cctp/references/contract-interfaces (Sept 2026):
 *
 *   function depositForBurn(uint256 amount, uint32 destinationDomain,
 *     bytes32 mintRecipient, address burnToken, bytes32 destinationCaller,
 *     uint256 maxFee, uint32 minFinalityThreshold) external
 *
 *   function receiveMessage(bytes calldata message, bytes calldata attestation) external
 *
 * CCTP V1 is being deprecated starting Oct 31, 2026 — this module is V2 only.
 */

export const FAST_TRANSFER_FINALITY_THRESHOLD = 1000;
export const STANDARD_TRANSFER_FINALITY_THRESHOLD = 2000;

const TOKEN_MESSENGER_ABI = [
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) external',
];

const MESSAGE_TRANSMITTER_ABI = [
  'function receiveMessage(bytes calldata message, bytes calldata attestation) external',
];

export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

/** CCTP recipients/callers are bytes32 (the protocol also targets non-EVM
 *  chains like Solana) — left-pad a 20-byte EVM address to 32 bytes. */
export function addressToBytes32(address: string): string {
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

export interface DepositForBurnParams {
  amountRaw: bigint;
  destinationDomain: number;
  mintRecipient: string; // plain 0x address; padded to bytes32 internally
  maxFeeRaw: bigint;
  minFinalityThreshold: number;
}

/** Encode depositForBurn calldata against a given source chain's TokenMessengerV2. */
export function buildDepositForBurnCall(
  source: CctpChainConfig,
  params: DepositForBurnParams,
): { to: string; data: string } {
  const iface = new ethers.Interface(TOKEN_MESSENGER_ABI);
  const data = iface.encodeFunctionData('depositForBurn', [
    params.amountRaw,
    params.destinationDomain,
    addressToBytes32(params.mintRecipient),
    source.usdcAddress,
    ethers.ZeroHash, // destinationCaller = anyone may call receiveMessage (Circle's Forwarding Service or our self-relay fallback)
    params.maxFeeRaw,
    params.minFinalityThreshold,
  ]);
  return { to: source.tokenMessengerAddress, data };
}

export interface DecodedDepositForBurn {
  amount: bigint;
  destinationDomain: number;
  mintRecipient: string; // bytes32, left-padded
  burnToken: string;
  destinationCaller: string; // bytes32
  maxFee: bigint;
  minFinalityThreshold: number;
}

/**
 * Decode a depositForBurn call's input data — used by routes/cctp.ts's
 * /confirm endpoint to independently verify a user-submitted burn tx against
 * the parameters recorded at deposit-intent time, rather than trusting the
 * client's claim about what it signed.
 */
export function decodeDepositForBurnCalldata(data: string): DecodedDepositForBurn {
  const iface = new ethers.Interface(TOKEN_MESSENGER_ABI);
  const result = iface.decodeFunctionData('depositForBurn', data);
  return {
    amount: result[0] as bigint,
    destinationDomain: Number(result[1]),
    mintRecipient: result[2] as string,
    burnToken: result[3] as string,
    destinationCaller: result[4] as string,
    maxFee: result[5] as bigint,
    minFinalityThreshold: Number(result[6]),
  };
}

/**
 * Phase A: sign and BROADCAST depositForBurn from a server-held wallet.
 * Deliberately does not await confirmation — the caller must persist the
 * returned hash immediately (before any other await) so a crash right after
 * broadcast still leaves a recoverable row; services/cctpAttestationPoller.ts
 * polls the receipt separately from the 'burn_submitted' stage.
 */
export async function executeDepositForBurn(
  source: CctpChainConfig,
  wallet: ethers.Wallet,
  params: DepositForBurnParams,
): Promise<{ txHash: string }> {
  const contract = new ethers.Contract(source.tokenMessengerAddress, TOKEN_MESSENGER_ABI, wallet);
  const tx = await contract.depositForBurn(
    params.amountRaw,
    params.destinationDomain,
    addressToBytes32(params.mintRecipient),
    source.usdcAddress,
    ethers.ZeroHash,
    params.maxFeeRaw,
    params.minFinalityThreshold,
  );
  return { txHash: tx.hash as string };
}

/** Self-relay fallback — only reachable because destinationCaller is zero
 *  (permissionless). Used when Circle's Forwarding Service stalls. */
export async function executeReceiveMessage(
  dest: CctpChainConfig,
  wallet: ethers.Wallet,
  messageHex: string,
  attestationHex: string,
): Promise<{ txHash: string; blockNumber: number }> {
  const contract = new ethers.Contract(dest.messageTransmitterAddress, MESSAGE_TRANSMITTER_ABI, wallet);
  const tx = await contract.receiveMessage(messageHex, attestationHex);
  const receipt = await tx.wait();
  return { txHash: tx.hash as string, blockNumber: receipt?.blockNumber ?? 0 };
}

// ── Iris attestation API ─────────────────────────────────────────────────
// Confirmed verbatim against developers.circle.com/api-reference/cctp/all/
// get-messages-v2 (Sept 2026): GET {base}/v2/messages/{sourceDomain}?transactionHash=...

export type IrisMessageStatus = 'complete' | 'pending_confirmations';
export type IrisDelayReason = 'insufficient_fee' | 'amount_above_max' | 'insufficient_allowance_available' | null;

export interface IrisMessage {
  message: string;
  eventNonce: string;
  attestation: string | null;
  cctpVersion: number;
  status: IrisMessageStatus;
  delayReason: IrisDelayReason;
  /** Forwarding Service state for this message, when Circle is auto-relaying
   *  the destination mint — reported through this same polling endpoint. */
  forwardState?: string;
  forwardTxHash?: string;
  decodedMessage?: {
    sourceDomain: string;
    destinationDomain: string;
    nonce: string;
    sender: string;
    recipient: string;
    destinationCaller: string;
    minFinalityThreshold: string;
    finalityThresholdExecuted: string;
    decodedMessageBody?: {
      burnToken: string;
      mintRecipient: string;
      amount: string;
      messageSender: string;
      maxFee: string;
      feeExecuted: string;
    };
  };
}

/**
 * Single non-blocking poll attempt — never loop internally. Callers
 * (cctpAttestationPoller.ts) call this once per tick so a slow/unavailable
 * Iris never blocks an HTTP request or the poller's other in-flight rows.
 */
export async function pollIrisAttestation(
  irisApiBase: string,
  sourceDomain: number,
  burnTxHash: string,
): Promise<IrisMessage | null> {
  const url = `${irisApiBase}/v2/messages/${sourceDomain}?transactionHash=${burnTxHash}`;
  const res = await fetch(url);
  if (res.status === 404) return null; // not indexed by Iris yet
  if (!res.ok) throw new Error(`Iris ${res.status}: ${await res.text().catch(() => '')}`);
  const body = (await res.json()) as { messages?: IrisMessage[] };
  return body.messages?.[0] ?? null;
}

/**
 * Fee quote for a route — GET /v2/burn/USDC/fees/{src}/{dst}. `minimumFee` is
 * in basis points; multiply by the transfer amount for the CCTP protocol
 * portion of maxFee.
 *
 * UNVERIFIED (Step 0 item deliberately left open — see plan): `forwardFee`
 * (low/medium/high, flat USDC minor units) is Circle's SEPARATE Forwarding
 * Service fee for auto-relaying the destination mint. How it's actually
 * attached to a plain `depositForBurn` call (folded into `maxFee`? requires
 * `depositForBurnWithHook`? automatic whenever `minFinalityThreshold=1000`?)
 * was not confirmed against a real testnet round-trip. This function folds
 * the `medium` tier into `maxFeeRaw` as a conservative default — TODO:
 * confirm against an actual Base Sepolia -> Ethereum Sepolia transfer
 * (does `forwardState`/`forwardTxHash` populate with this maxFee, or does
 * the message sit `delayReason: 'insufficient_fee'` regardless?) before
 * relying on this in production.
 */
export async function estimateMaxFeeRaw(
  irisApiBase: string,
  sourceDomain: number,
  destinationDomain: number,
  amountRaw: bigint,
  minFinalityThreshold: number,
): Promise<bigint> {
  const url = `${irisApiBase}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Iris fee quote ${res.status}: ${await res.text().catch(() => '')}`);
  const quotes = (await res.json()) as Array<{
    finalityThreshold: number;
    minimumFee: number;
    forwardFee?: { low: number; medium: number; high: number };
  }>;
  const quote = quotes.find((q) => q.finalityThreshold === minFinalityThreshold) ?? quotes[0];
  if (!quote) throw new Error('Iris returned no fee quote for this route');

  const bpsFee = (amountRaw * BigInt(Math.ceil(quote.minimumFee))) / 10_000n;
  const forwardFee = BigInt(quote.forwardFee?.medium ?? 0);
  return bpsFee + forwardFee;
}
