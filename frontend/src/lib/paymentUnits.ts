import { formatUnits, parseUnits } from 'ethers';
import { getPaymentDecimals } from '../config/constants';

/**
 * Task rewards, service prices and agent minimum rewards are stored in the
 * settlement token's base units: USDC (6 decimals) on Base, native 0G (18)
 * only when no Base escrow is configured. Use these instead of hardcoding 18 —
 * that turned a 1 USDC listing into a request to escrow 10^18 base units.
 */
export function formatPaymentAmount(raw: string | bigint): string {
  return formatUnits(raw, getPaymentDecimals());
}

/** Throws on malformed input or more decimals than the token has. */
export function parsePaymentAmount(value: string): bigint {
  return parseUnits(value.trim(), getPaymentDecimals());
}
