/**
 * Chain service — provides the active chain configuration.
 *
 * 0G: agent infra (TaskRegistry, Reputation, INFT)
 * Base: settlement (BlindEscrow, USDC payouts)
 */
import { config } from '../config.js';


/**
 * Log the active chain configuration at boot.
 */
export function logChainConfig(): void {
  console.log(`[chain] 0G agent chain  — chainId: ${config.ogChainId}, RPC: ${config.ogRpcUrl}`);
  console.log(`[chain] Base settlement — chainId: ${config.baseChainId}, RPC: ${config.baseRpcUrl}`);
  console.log(`[chain] Base escrow     — ${config.baseEscrowAddress || '(not configured)'}`);
}