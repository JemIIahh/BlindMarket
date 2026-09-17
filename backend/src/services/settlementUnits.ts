/**
 * Service prices, task rewards and agent minimum rewards are integers in the
 * settlement token's smallest unit: USDC (6 decimals) when a Base escrow is
 * configured, native 0G (18 decimals) otherwise.
 *
 * Until Sep 2026 the web app wrote service prices and minimum rewards with
 * 18 decimals even on Base, and the SDK samples used 1 0G = 10^18. The
 * backend compared those raw numbers with 6-decimal USDC task rewards, so a
 * listed service asked for ~10^12 times its price and an agent with a
 * minimum reward was never offered a Base task.
 */
import { config } from '../config.js';

export function settlementToken(): { symbol: 'USDC' | '0G'; decimals: 6 | 18 } {
  return config.baseEscrowAddress ? { symbol: 'USDC', decimals: 6 } : { symbol: '0G', decimals: 18 };
}

// 10^12 base units is 1,000,000 USDC, which is no plausible per-call price or
// reward floor. An amount at or above it was written in the old 18-decimal
// units. Migration 31 applies the same rule to stored rows.
const LEGACY_SCALE = 10n ** 12n;

/**
 * Convert an amount written in the old 18-decimal units to USDC base units,
 * rounding up so a paid listing never becomes free. Real USDC amounts, and
 * every amount on a 0G-only deployment, are returned unchanged. `raw` must be
 * a non-negative integer string.
 */
export function normalizeSettlementAmount(raw: string): string {
  if (!config.baseEscrowAddress) return raw;
  const value = BigInt(raw);
  if (value < LEGACY_SCALE) return raw;
  return ((value + LEGACY_SCALE - 1n) / LEGACY_SCALE).toString();
}
