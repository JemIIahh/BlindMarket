/**
 * Which network a settlement chain's stored state belongs to.
 *
 * A chain key names a chain ('arc', 'base'), not a network: the same key runs
 * on Arc testnet today and on Arc mainnet after the move. Everything the
 * backend stores per chain (the hash<->id index and its checkpoints, the
 * escrow fingerprint, dispute markers and rounds, deploy credits, spent
 * deploy payments) describes one escrow on one network. Keyed by chain alone,
 * a move to another network would read the old network's state as the new
 * one's, and escrow ids restart at 1 on every escrow, so an old entry names
 * an unrelated task on the new escrow.
 *
 * So state is stored under chainScope(chain). The network each chain has run
 * on in production so far keeps the bare chain key, and existing state stays
 * where it is. Any other network gets its chain id ('arc@5042'), so moving a
 * chain starts from empty state.
 */
import { isSettlementChainKey, settlementChainConfig, type SettlementChainKey } from './settlementChains.js';

/** The network each chain ran on before any move, whose state keeps the bare key. */
export const FIRST_NETWORK_CHAIN_ID: Readonly<Record<SettlementChainKey, number>> = {
  base: 84532,
  arc: 5042002,
};

/**
 * Every network each chain runs on: its testnet (the first network) and its
 * mainnet. chainScope.test.ts checks them against settlementTier.ts
 * TIER_CHAIN_IDS.
 */
export const CHAIN_NETWORK_IDS: Readonly<Record<SettlementChainKey, readonly number[]>> = {
  base: [84532, 8453],
  arc: [5042002, 5042],
};

/** Key prefix for a chain's stored state on `chainId`, by default the network this backend runs the chain on. */
export function chainScope(chain: SettlementChainKey, chainId: number = settlementChainConfig(chain).chainId): string {
  return chainId === FIRST_NETWORK_CHAIN_ID[chain] ? chain : `${chain}@${chainId}`;
}

/**
 * The networks of `chain` whose stored state lives under another scope than
 * this backend's: state this backend did not write, whatever it holds
 * (deploymentIdentity.ts).
 */
export function otherNetworkIds(chain: SettlementChainKey): number[] {
  const own = chainScope(chain);
  return CHAIN_NETWORK_IDS[chain].filter((chainId) => chainScope(chain, chainId) !== own);
}

/**
 * Whether a task was listed on the network this backend runs its chain on.
 * A task listed on a network the chain has since moved off is retired here:
 * its escrow is not the one this backend reads. Rows listed before
 * A2ATaskMeta.chainId existed were listed on the chain's first network. A row
 * with no recorded chain predates the field and is left as it was.
 */
export function onCurrentNetwork(meta: { chain?: unknown; chainId?: number } | null | undefined): boolean {
  if (!meta || !isSettlementChainKey(meta.chain)) return true;
  const listedOn = meta.chainId ?? FIRST_NETWORK_CHAIN_ID[meta.chain];
  return listedOn === settlementChainConfig(meta.chain).chainId;
}
