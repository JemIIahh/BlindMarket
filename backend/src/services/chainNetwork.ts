import { config } from '../config.js';
import { settlementChainConfig } from './settlementChains.js';
import type { TaskChain } from './taskChain.js';

/**
 * Whether `chain` is configured for its mainnet, and the contracts/ hardhat
 * network that operates on it. Each chain has its own tier: production pairs
 * 0G mainnet with Base Sepolia, so one chain's id says nothing about another.
 * Throws on a chain this code does not know.
 */
export function chainNetwork(chain: TaskChain): { tier: 'mainnet' | 'testnet'; hardhatNetwork: string } {
  const { tier, hardhatNetwork } = settlementChainConfig(chain);
  return { tier, hardhatNetwork };
}

/**
 * Env prefix for a contracts/ ops command that must act on this backend's
 * escrow. It names the escrow whenever it is known: on chains that more than
 * one deployment set uses (Base Sepolia, 0G testnet) the scripts refuse to
 * send without EXPECTED_ESCROW. DEPLOYMENT_SET is added only when this
 * backend belongs to a non-default set.
 */
export function contractsEnvPrefix(escrowAddress: string | null): string {
  const set = config.deploymentSet ? `DEPLOYMENT_SET=${config.deploymentSet} ` : '';
  const known = !!escrowAddress && !/^0x0{40}$/i.test(escrowAddress);
  return set + (known ? `EXPECTED_ESCROW=${escrowAddress} ` : '');
}
