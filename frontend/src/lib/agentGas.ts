import { formatUnits } from 'ethers';

/**
 * What a hosted agent's wallet must hold before its worker takes a task,
 * where gas is paid in the payment token (Arc: native USDC with 18 decimals,
 * the same balance the 6-decimal ERC-20 shows). The worker accepts a task
 * only when its wallet holds one transaction's gas budget at the chain's
 * current max fee (backend/agents/worker.js preflightGas). This is Arc's
 * budget, backend settlementChains.ts gas.workerTxGasLimit.
 */
export const WORKER_TX_GAS_LIMIT = 200_000n;

/** The gas budget of one worker transaction at `feePerGasWei`, in a token with `decimals`, rounded up. */
export function minGasBalance(feePerGasWei: bigint, decimals: number): bigint {
  const wei = WORKER_TX_GAS_LIMIT * feePerGasWei;
  if (decimals >= 18) return wei * 10n ** BigInt(decimals - 18);
  const scale = 10n ** BigInt(18 - decimals);
  return (wei + scale - 1n) / scale;
}

const SHOWN_DECIMALS = 4;

/** `raw` in a token with `decimals`, to at most 4 decimals, rounded up so the amount shown is never short. */
export function formatMinGas(raw: bigint, decimals: number): string {
  const step = decimals > SHOWN_DECIMALS ? 10n ** BigInt(decimals - SHOWN_DECIMALS) : 1n;
  const s = formatUnits(((raw + step - 1n) / step) * step, decimals);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
