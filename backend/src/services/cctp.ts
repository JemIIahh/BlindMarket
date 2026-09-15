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
 *   function depositForBurnWithHook(uint256 amount, uint32 destinationDomain,
 *     bytes32 mintRecipient, address burnToken, bytes32 destinationCaller,
 *     uint256 maxFee, uint32 minFinalityThreshold, bytes calldata hookData) external
 *
 *   function receiveMessage(bytes calldata message, bytes calldata attestation) external
 *
 * We always use the *WithHook variant, not plain depositForBurn — Circle's
 * Forwarding Service (auto-completing the destination mint so the caller
 * never needs destination gas) is opt-in via hook data, confirmed verbatim
 * against developers.circle.com/cctp/concepts/forwarding-service:
 * "Must use: depositForBurnWithHook instead of plain depositForBurn. The
 * forwarding request embeds in the hook data of the burn transaction on the
 * source chain." Calling plain depositForBurn (as an earlier version of this
 * file did) never requests forwarding at all — every transfer would sit at
 * 'attestation_ready' forever, needing manual self-relay for every single
 * transfer, which defeats the entire point of choosing this relay method.
 *
 * That same page confirms maxFee must cover BOTH the CCTP protocol fee and
 * the separate Forwarding Service fee ("Service fees range from $0.05-$1.20
 * USDC depending on route... maxFee parameter must cover both CCTP protocol
 * fees and Forwarding Service fees"), and that an insufficient maxFee
 * doesn't fail the transfer — "CCTP will prioritize forwarding execution
 * over Fast Transfer, executing as Standard Transfer instead" (~15-19 min
 * instead of ~8-20s, but it still completes). See estimateMaxFeeRaw() below.
 *
 * CCTP V1 is being deprecated starting Oct 31, 2026 — this module is V2 only.
 *
 * Forwarding Service went generally available on CCTP mainnet Jan 28, 2026
 * (was Early-Access/testnet-only before that), and its supported-route list
 * explicitly includes both Base and Ethereum — no special enrollment should
 * be needed for this integration's routes by the time it reaches mainnet.
 */

export const FAST_TRANSFER_FINALITY_THRESHOLD = 1000;
export const STANDARD_TRANSFER_FINALITY_THRESHOLD = 2000;

/**
 * minFinalityThreshold for a burn — decided by the SOURCE chain (Fast Transfer
 * eligibility depends only on where the burn happens). Chains with no Fast
 * Transfer (Arc: its own finality is already instant) get Standard. Only an
 * explicit `false` opts out, so a config missing the flag keeps Fast.
 *
 * Observed on Arc testnet (Sept 2026): Iris doesn't reject a 1000 there — it
 * executes it at 2000 — so this is about recording/requesting what actually
 * happens, not about avoiding a stuck transfer.
 */
export function finalityThresholdFor(source: Pick<CctpChainConfig, 'supportsFastTransfer'>): number {
  return source.supportsFastTransfer === false
    ? STANDARD_TRANSFER_FINALITY_THRESHOLD
    : FAST_TRANSFER_FINALITY_THRESHOLD;
}

const TOKEN_MESSENGER_ABI = [
  'function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes calldata hookData) external',
];

const MESSAGE_TRANSMITTER_ABI = [
  'function receiveMessage(bytes calldata message, bytes calldata attestation) external',
];

/**
 * Forwarding Service hook data — V0 (single-hook, no extra developer
 * payload) format, confirmed verbatim against developers.circle.com/cctp/
 * concepts/forwarding-service: a `bytes24` name field ("cctp-forward",
 * right-padded with zero bytes — bytes24 is right-padded in raw/packed
 * encoding, unlike numeric/address types), followed by a `uint32` version
 * (0) and a `uint32` additional-data length (0). All 20 trailing bytes are
 * zero either way (12 padding bytes to fill bytes24 + 4 version + 4
 * length), so this is just the 12 ASCII bytes of "cctp-forward" followed by
 * 20 zero bytes — 32 bytes total. Built programmatically rather than a
 * hardcoded hex literal to avoid transcription error.
 */
function buildForwardingHookData(): string {
  const hookData = new Uint8Array(32);
  hookData.set(ethers.toUtf8Bytes('cctp-forward'), 0); // remaining 20 bytes stay zero
  return ethers.hexlify(hookData);
}

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

/** Encode depositForBurnWithHook calldata (Forwarding Service opt-in) against
 *  a given source chain's TokenMessengerV2. */
export function buildDepositForBurnCall(
  source: CctpChainConfig,
  params: DepositForBurnParams,
): { to: string; data: string } {
  const iface = new ethers.Interface(TOKEN_MESSENGER_ABI);
  const data = iface.encodeFunctionData('depositForBurnWithHook', [
    params.amountRaw,
    params.destinationDomain,
    addressToBytes32(params.mintRecipient),
    source.usdcAddress,
    ethers.ZeroHash, // destinationCaller = anyone may call receiveMessage (Forwarding Service requires this per Circle's docs, and it's also what permits our self-relay fallback)
    params.maxFeeRaw,
    params.minFinalityThreshold,
    buildForwardingHookData(),
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
  hookData: string;
}

/**
 * Decode a depositForBurnWithHook call's input data — used by routes/cctp.ts's
 * /confirm endpoint to independently verify a user-submitted burn tx against
 * the parameters recorded at deposit-intent time, rather than trusting the
 * client's claim about what it signed. Does not enforce hookData — a burn
 * missing the forwarding hook still succeeds and still burns/mints correctly,
 * it just won't auto-relay (recoverable via the self-relay fallback), so a
 * mismatch there risks a stuck transfer, not lost or redirected funds.
 */
export function decodeDepositForBurnCalldata(data: string): DecodedDepositForBurn {
  const iface = new ethers.Interface(TOKEN_MESSENGER_ABI);
  const result = iface.decodeFunctionData('depositForBurnWithHook', data);
  return {
    amount: result[0] as bigint,
    destinationDomain: Number(result[1]),
    mintRecipient: result[2] as string,
    burnToken: result[3] as string,
    destinationCaller: result[4] as string,
    maxFee: result[5] as bigint,
    minFinalityThreshold: Number(result[6]),
    hookData: result[7] as string,
  };
}

/**
 * Phase A: sign and BROADCAST depositForBurnWithHook from a server-held
 * wallet. Deliberately does not await confirmation — the caller must persist
 * the returned hash immediately (before any other await) so a crash right
 * after broadcast still leaves a recoverable row; services/
 * cctpAttestationPoller.ts polls the receipt separately from the
 * 'burn_submitted' stage.
 */
export async function executeDepositForBurn(
  source: CctpChainConfig,
  wallet: ethers.Wallet,
  params: DepositForBurnParams,
  overrides: { nonce?: number; gasLimit?: bigint } = {},
): Promise<{ txHash: string }> {
  const contract = new ethers.Contract(source.tokenMessengerAddress, TOKEN_MESSENGER_ABI, wallet);
  const tx = await contract.depositForBurnWithHook(
    params.amountRaw,
    params.destinationDomain,
    addressToBytes32(params.mintRecipient),
    source.usdcAddress,
    ethers.ZeroHash,
    params.maxFeeRaw,
    params.minFinalityThreshold,
    buildForwardingHookData(),
    overrides,
  );
  return { txHash: tx.hash as string };
}

/** Gas limit pinned on a burn sent right after its approve (see below).
 *  Observed depositForBurnWithHook on Base Sepolia: 105.5k–115.2k gas used
 *  (Sept 2026) — ~2x headroom; only gas actually used is charged. */
export const CCTP_BURN_GAS_LIMIT = 250_000n;

/**
 * Phase A: approve TokenMessengerV2 for exactly `amountRaw`, wait for it to
 * be mined, then BROADCAST depositForBurnWithHook. The burn pulls USDC via
 * transferFrom, so without the approve every burn reverts with "ERC20:
 * transfer amount exceeds allowance".
 *
 * Always approves (never reads the allowance first): the burn consumes
 * exactly the approved amount, so a leftover allowance is normally 0 anyway,
 * and a stale RPC read could report one a previous burn already spent.
 *
 * The burn pins nonce = approve.nonce + 1 and a fixed gas limit instead of
 * letting ethers look them up: Base Sepolia's RPC serves stale reads right
 * after a write, so the burn's own estimateGas could still see the
 * pre-approve allowance (and revert), and its nonce lookup could hand back
 * the approve's nonce. Nonce N+1 can't be mined before the approve (nonce N),
 * so on-chain ordering holds whichever node answers.
 *
 * Returns once the burn is broadcast, not mined — same contract as
 * executeDepositForBurn: the caller persists the hash before anything else.
 */
export async function executeApproveAndDepositForBurn(
  source: CctpChainConfig,
  wallet: ethers.Wallet,
  params: DepositForBurnParams,
): Promise<{ approveTxHash: string; txHash: string }> {
  const usdc = new ethers.Contract(source.usdcAddress, ERC20_ABI, wallet);
  const approveTx = await usdc.approve(source.tokenMessengerAddress, params.amountRaw);
  const approveReceipt = await approveTx.wait();
  if (!approveReceipt || approveReceipt.status !== 1) {
    throw new Error(`USDC approve for the CCTP burn did not succeed (tx ${approveTx.hash})`);
  }
  const { txHash } = await executeDepositForBurn(source, wallet, params, {
    nonce: approveTx.nonce + 1,
    gasLimit: CCTP_BURN_GAS_LIMIT,
  });
  return { approveTxHash: approveTx.hash as string, txHash };
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
 * Fee quote for a route — GET /v2/burn/USDC/fees/{src}/{dst}?forward=true.
 * `minimumFee` (bps) is the CCTP protocol's own Fast Transfer fee; multiply
 * by the transfer amount for that portion of maxFee. `forward` MUST be
 * `true` in the query string or Circle won't include `forwardFee` in the
 * response at all (it defaults to false) — `forwardFee` is Circle's
 * SEPARATE Forwarding Service fee (low/medium/high, flat USDC minor units)
 * for auto-relaying the destination mint, and per developers.circle.com/
 * cctp/concepts/forwarding-service, maxFee must cover BOTH fees together —
 * confirmed verbatim: "The maxFee parameter must cover both CCTP protocol
 * fees and Forwarding Service fees." An insufficient maxFee doesn't fail
 * the transfer, it silently downgrades to Standard Transfer (~15-19 min
 * instead of ~8-20s) per that same page. This function folds the `med`
 * forwardFee tier into maxFeeRaw as a reasonable default (not the cheapest
 * `low` tier, to bias toward actually landing as Fast Transfer).
 *
 * LIVE-VERIFIED against https://iris-api-sandbox.circle.com (2026-09-14):
 * confirmed `forward=true` is required — omitting it, `forwardFee` is
 * absent from the response entirely, exactly as documented. Also caught a
 * real bug this way: Circle's actual field is `forwardFee.med`, NOT
 * `.medium` as an earlier summarized doc fetch had it — that typo meant
 * this function was silently folding in 0 instead of the real fee (~0.05
 * USDC on ethereum-sepolia->base-sepolia, ~1.7 USDC the other direction,
 * on testnet) despite forward=true working correctly. Fixed below.
 */
export async function estimateMaxFeeRaw(
  irisApiBase: string,
  sourceDomain: number,
  destinationDomain: number,
  amountRaw: bigint,
  minFinalityThreshold: number,
): Promise<bigint> {
  const url = `${irisApiBase}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}?forward=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Iris fee quote ${res.status}: ${await res.text().catch(() => '')}`);
  const quotes = (await res.json()) as Array<{
    finalityThreshold: number;
    minimumFee: number;
    forwardFee?: { low: number; med: number; high: number };
  }>;
  const quote = quotes.find((q) => q.finalityThreshold === minFinalityThreshold) ?? quotes[0];
  if (!quote) throw new Error('Iris returned no fee quote for this route');

  const bpsFee = (amountRaw * BigInt(Math.ceil(quote.minimumFee))) / 10_000n;
  const forwardFee = BigInt(quote.forwardFee?.med ?? 0);
  return bpsFee + forwardFee;
}
