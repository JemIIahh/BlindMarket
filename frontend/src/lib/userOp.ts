import {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
  getAddress,
  keccak256,
  toBeHex,
  toUtf8Bytes,
  zeroPadValue,
} from 'ethers';
import { authedGet, authedPost } from './api';

/**
 * ERC-4337 v0.7 UserOps for external wallets: the user's BlindAccount runs
 * the CCTP approve+burn as one op, and the chain's USDCPaymaster fronts the
 * native gas for USDC in postOp. The backend only estimates/submits
 * (POST /cctp/userop keeps the Pimlico key server-side); everything is
 * built and signed here.
 *
 * Hash math mirrors backend/agents/userop.js exactly (same EntryPoint v0.7
 * packing). A wrong hash fails safe: the bundler rejects the signature and
 * nothing executes.
 */

export interface AaChain {
  paymaster: string;
  factory: string;
  entrypoint: string;
  usdc: string;
  chainId: number;
  rpcUrl: string;
}

export interface BatchCall {
  to: string;
  value?: bigint;
  data: string;
}

/** Unpacked v0.7 op — the shape Pimlico's RPC takes (and our backend forwards). */
export interface UnpackedUserOp {
  sender: string;
  nonce: string;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymaster?: string;
  paymasterVerificationGasLimit?: string;
  paymasterPostOpGasLimit?: string;
  paymasterData?: string;
  signature: string;
}

const ACCOUNT_ABI = [
  'function execute(address to, uint256 value, bytes data)',
  'function executeBatch(address[] to, uint256[] value, bytes[] data)',
  'function owner() view returns (address)',
  'function createAccount(address owner, bytes32 salt) returns (address)',
  'function accounts(address) view returns (address)',
];

const ENTRYPOINT_ABI = ['function getNonce(address sender, uint192 key) view returns (uint256)'];

/**
 * CREATE2 salt convention, mirroring the backend's (services/aa.ts
 * computeSalt). The exact value is an implementation detail — the factory
 * maps owner to account, so any stable per-owner salt deploys the same
 * account exactly once — but sharing the convention keeps future
 * counterfactual derivations on both sides identical.
 */
export function accountSalt(owner: string): string {
  return keccak256(toUtf8Bytes(`blind-account:${getAddress(owner)}`));
}

/** BlindAccount for `owner`, or zero when not deployed yet. */
export async function getSmartAccount(factory: string, owner: string, rpcUrl: string, chainId: number): Promise<string> {
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const c = new Contract(factory, ACCOUNT_ABI, provider);
  return c.accounts(getAddress(owner)) as Promise<string>;
}

/** BlindAccount.createAccount calldata for the setup step. */
export function encodeCreateAccount(owner: string): string {
  return new Interface(ACCOUNT_ABI).encodeFunctionData('createAccount', [getAddress(owner), accountSalt(owner)]);
}

export function encodeBatch(calls: BatchCall[]): string {
  return new Interface(ACCOUNT_ABI).encodeFunctionData('executeBatch', [
    calls.map((c) => getAddress(c.to)),
    calls.map((c) => c.value ?? 0n),
    calls.map((c) => c.data),
  ]);
}

// ── v0.7 packing (mirrors backend/agents/userop.js) ─────────────────────────

/** verificationGasLimit in the high 128 bits, callGasLimit in the low 128. */
export function packGasLimits(high: bigint, low: bigint): string {
  return zeroPadValue(toBeHex((high << 128n) | low), 32);
}

/** paymaster address + 16-byte verification/post-op limits + extra data. */
export function packPaymasterAndData(op: UnpackedUserOp): string {
  if (!op.paymaster) return '0x';
  return (
    getAddress(op.paymaster).toLowerCase() +
    zeroPadValue(toBeHex(BigInt(op.paymasterVerificationGasLimit ?? '0x186a0')), 16).slice(2) +
    zeroPadValue(toBeHex(BigInt(op.paymasterPostOpGasLimit ?? '0xc350')), 16).slice(2) +
    (op.paymasterData ?? '0x').slice(2)
  );
}

function hashUnpacked(op: UnpackedUserOp): string {
  const accountGasLimits = packGasLimits(BigInt(op.verificationGasLimit), BigInt(op.callGasLimit));
  const gasFees = packGasLimits(BigInt(op.maxPriorityFeePerGas), BigInt(op.maxFeePerGas));
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
      [
        op.sender,
        op.nonce,
        keccak256('0x'),
        keccak256(op.callData),
        accountGasLimits,
        op.preVerificationGas,
        gasFees,
        keccak256(packPaymasterAndData(op)),
      ],
    ),
  );
}

/** EntryPoint v0.7 getUserOpHash — what the account owner must raw-sign. */
export function userOpHash(op: UnpackedUserOp, entrypoint: string, chainId: number): string {
  const inner = hashUnpacked(op);
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'uint256'],
      [inner, getAddress(entrypoint), chainId],
    ),
  );
}

// ── build / estimate / submit / track ────────────────────────────────────────

export interface EstimateResult {
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
}

/**
 * The paymaster reverts past 1M total gas, and the bundler's estimator pads
 * limits past that cap (every estimate through it fails GasTooHigh), so
 * these fixed limits ARE the sizing: 830k total, comfortably above the
 * measured approve+burn cost (~200k) with margin to the cap. The backend
 * estimate is only ever applied when its total fits under the cap.
 */
export const FIXED_GAS_LIMITS = {
  callGasLimit: 350_000,
  verificationGasLimit: 300_000,
  preVerificationGas: 80_000,
} as const;

/** Largest estimate total the paymaster accepts (1M cap minus headroom). */
export const MAX_ESTIMATE_TOTAL = 950_000;

/** Assemble an unsigned op: on-chain nonce + fee data + fixed gas limits. */
export async function buildUnsignedOp(
  aa: AaChain,
  sender: string,
  callData: string,
): Promise<UnpackedUserOp> {
  const provider = new JsonRpcProvider(aa.rpcUrl, aa.chainId, { staticNetwork: true });
  const entrypoint = new Contract(aa.entrypoint, ENTRYPOINT_ABI, provider);
  const [nonce, feeData] = await Promise.all([
    entrypoint.getNonce(getAddress(sender), 0) as Promise<bigint>,
    provider.getFeeData(),
  ]);
  return {
    sender: getAddress(sender),
    nonce: toBeHex(nonce),
    callData,
    callGasLimit: toBeHex(FIXED_GAS_LIMITS.callGasLimit),
    verificationGasLimit: toBeHex(FIXED_GAS_LIMITS.verificationGasLimit),
    preVerificationGas: toBeHex(FIXED_GAS_LIMITS.preVerificationGas),
    maxFeePerGas: toBeHex(feeData.maxFeePerGas ?? 100_000_000n),
    maxPriorityFeePerGas: toBeHex(feeData.maxPriorityFeePerGas ?? 10_000_000n),
    paymaster: getAddress(aa.paymaster),
    paymasterVerificationGasLimit: toBeHex(100_000),
    paymasterPostOpGasLimit: toBeHex(50_000),
    paymasterData: '0x',
    signature: '0x',
  };
}

/** Total gas an op's limits imply (the paymaster's own accounting). */
export function opGasTotal(op: Pick<UnpackedUserOp, 'callGasLimit' | 'verificationGasLimit' | 'preVerificationGas'>): number {
  return Number(BigInt(op.callGasLimit) + BigInt(op.verificationGasLimit) + BigInt(op.preVerificationGas)) + 100_000;
}

/** Backend estimate (validates the op against the intent first). */
export async function estimateOp(transferId: number, op: UnpackedUserOp): Promise<EstimateResult> {
  const res = await authedPost<{ gas: EstimateResult }>('/api/v1/cctp/userop', {
    transferId,
    mode: 'estimate',
    userOp: op,
  });
  return res.gas;
}

/** Backend submit of the signed op. Returns the UserOp hash. */
export async function submitOp(transferId: number, op: UnpackedUserOp): Promise<string> {
  const res = await authedPost<{ userOpHash: string }>('/api/v1/cctp/userop', {
    transferId,
    mode: 'submit',
    userOp: op,
  });
  return res.userOpHash;
}

/**
 * Wait for the bundler to include the op; returns the L1 bundle tx hash.
 * Throws when the op reverts or stays unseen (~5 min).
 */
export async function pollOpReceipt(chainKey: string, opHash: string): Promise<string> {
  for (let i = 0; i < 75; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const row = await authedGet<{ found: boolean; success?: boolean; txHash?: string | null }>(
      `/api/v1/cctp/userop-receipt?chain=${chainKey}&hash=${opHash}`,
    );
    if (!row.found) continue;
    if (row.success && row.txHash) return row.txHash;
    throw new Error('The sponsored transaction reverted on-chain.');
  }
  throw new Error('The sponsored transaction was submitted but is still not visible. Wait a minute and check back.');
}
