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
import type { TaskChain } from './taskChain.js';

export interface SettlementUnit {
  symbol: 'USDC' | '0G';
  decimals: 6 | 18;
}

const USDC: SettlementUnit = { symbol: 'USDC', decimals: 6 };
const NATIVE_0G: SettlementUnit = { symbol: '0G', decimals: 18 };
const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

export function settlementToken(): SettlementUnit {
  return config.baseEscrowAddress ? USDC : NATIVE_0G;
}

/**
 * The unit of a task escrowed in `token` on `chain`, or null when that is not
 * the token BlindMarket settles in on that chain. Keyed by chain as well as
 * token because address(0) means a different asset on each chain: native 0G
 * on 0G, but native 18-decimal USDC on Arc. A new settlement chain is a new
 * case here, and the `never` check makes a missing case a type error.
 */
export function payoutCurrency(chain: TaskChain, token: string): SettlementUnit | null {
  const t = token.toLowerCase();
  switch (chain) {
    case '0g':
      return t === NATIVE_TOKEN ? NATIVE_0G : null;
    case 'base':
      return config.baseUsdcAddress && t === config.baseUsdcAddress.toLowerCase() ? USDC : null;
    default: {
      const unhandled: never = chain;
      void unhandled;
      return null;
    }
  }
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
