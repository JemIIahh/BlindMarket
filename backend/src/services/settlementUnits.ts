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
import {
  isSettlementChainKey,
  postingChain,
  settlementChainConfig,
  NATIVE_0G_UNIT,
  USDC_UNIT,
  type SettlementUnit,
} from './settlementChains.js';
import type { TaskChain } from './taskChain.js';

export type { SettlementUnit };

export function settlementToken(): SettlementUnit {
  return config.baseEscrowAddress ? USDC_UNIT : NATIVE_0G_UNIT;
}

/**
 * Throws when new tasks would be posted in a different unit from the one
 * service prices and reward floors are written in (settlementToken()). Only an
 * explicit POSTING_CHAIN can cause that: 0G on a stack with a Base escrow.
 * Clients pick their token by the same rule as settlementToken(), so every
 * post would get a 400, and a "Use now" task funded in the posting chain's
 * token could never be indexed. Called at boot.
 */
export function assertPostingUnitMatchesPricing(): void {
  const { key, token } = settlementChainConfig(postingChain());
  const pricing = settlementToken();
  if (token.unit.symbol !== pricing.symbol || token.unit.decimals !== pricing.decimals) {
    throw new Error(
      `Invalid POSTING_CHAIN: ${key} settles in ${token.unit.symbol}, but service prices and reward floors ` +
        `are in ${pricing.symbol} on this stack (BASE_ESCROW_ADDRESS is set). Unset POSTING_CHAIN, ` +
        `or leave out the Base escrow on a stack that posts on 0G.`,
    );
  }
}

/**
 * The unit of a task escrowed in `token` on `chain`, or null when that is not
 * the token BlindMarket settles in on that chain (settlementChains.ts), or the
 * chain is one this code does not know. Keyed by chain as well as token
 * because address(0) means a different asset on each chain: native 0G on 0G,
 * but native 18-decimal USDC on Arc, where only the ERC-20 is the settlement
 * token. A chain whose ERC-20 is not configured books nothing.
 */
export function payoutCurrency(chain: TaskChain, token: string): SettlementUnit | null {
  if (!isSettlementChainKey(chain)) return null;
  const { address, unit } = settlementChainConfig(chain).token;
  return address && token.toLowerCase() === address.toLowerCase() ? unit : null;
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
