/**
 * Service prices, task rewards and agent minimum rewards are integers in the
 * smallest unit of the token new tasks are posted in: USDC (6 decimals) on a
 * stack that posts on Base, native 0G (18 decimals) on one that posts on 0G.
 * See pricingUnit().
 *
 * Until Sep 2026 the web app wrote service prices and minimum rewards with
 * 18 decimals even on Base, and the SDK samples used 1 0G = 10^18. The
 * backend compared those raw numbers with 6-decimal USDC task rewards, so a
 * listed service asked for ~10^12 times its price and an agent with a
 * minimum reward was never offered a Base task.
 */
import {
  isSettlementChainKey,
  postingChain,
  settlementChainConfig,
  USDC_UNIT,
  type SettlementUnit,
} from './settlementChains.js';
import type { TaskChain } from './taskChain.js';

export type { SettlementUnit };

/**
 * The unit every price on this deployment is written in: service prices,
 * reward floors, and the earnings figure the UI shows. It is the settlement
 * token of the chain new tasks are posted on, because that is what a poster
 * actually escrows.
 *
 * Until R12 this asked a narrower question — "is a Base escrow configured?" —
 * which gave the same answer while the posting chain was implied by that same
 * setting, and needed a boot check (assertPostingUnitMatchesPricing, now
 * removed) to refuse the one configuration where the two disagreed:
 * POSTING_CHAIN=0g on a stack with a Base escrow. That stack now simply
 * prices in 0G.
 */
export function pricingUnit(): SettlementUnit {
  return settlementChainConfig(postingChain()).token.unit;
}

/** A task's reward, with the unit it is escrowed in — amounts are not comparable across units. */
export interface TaskReward {
  amount: bigint;
  unit: SettlementUnit;
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
  if (pricingUnit().decimals !== USDC_UNIT.decimals) return raw;
  const value = BigInt(raw);
  if (value < LEGACY_SCALE) return raw;
  return ((value + LEGACY_SCALE - 1n) / LEGACY_SCALE).toString();
}

/**
 * A native-coin amount in a token's own units, rounded up. The native coin has
 * 18 decimals. Used where the gas coin and the settlement token are one asset
 * (Arc's USDC: 18 decimals natively, 6 through its ERC-20), so a withdraw can
 * keep the gas reserve back while sweeping the ERC-20.
 */
export function nativeWeiToTokenUnits(wei: bigint, decimals: number): bigint {
  if (decimals >= 18) return wei * 10n ** BigInt(decimals - 18);
  const scale = 10n ** BigInt(18 - decimals);
  return (wei + scale - 1n) / scale;
}
