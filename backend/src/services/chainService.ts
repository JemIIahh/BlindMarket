/**
 * Chain service — provides the active chain configuration.
 *
 * 0G: agent infra (TaskRegistry, Reputation, INFT)
 * Base: settlement (BlindEscrow, USDC payouts)
 */
import { configuredChainKeys, settlementChainConfig, settlementChainConfigs } from './settlementChains.js';

/**
 * Log each settlement chain the registry knows, and which of them this
 * deployment settles on, at boot.
 */
export function logChainConfig(): void {
  for (const { label, chainId, tier, rpcUrl, escrowAddress } of settlementChainConfigs()) {
    console.log(`[chain] ${label} — chainId: ${chainId} (${tier}), RPC: ${rpcUrl}, escrow: ${escrowAddress ?? '(not configured)'}`);
  }
  const settles = configuredChainKeys().map((key) => settlementChainConfig(key).label);
  console.log(`[chain] Settles on: ${settles.length > 0 ? settles.join(', ') : '(no chain has an escrow)'}`);
}
