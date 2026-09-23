import { AA_ADDRESSES } from '../contractAddresses.js';

/**
 * ERC-4337 infrastructure per CCTP chain, for the external-wallet USDC-gas
 * path: the user's BlindAccount runs the source-chain approve+burn as a
 * UserOp, and this chain's USDCPaymaster fronts the native gas for USDC in
 * postOp. Chains without AA (Arc — gas is USDC natively) yield null.
 *
 * Source of truth is the generated AA_ADDRESSES (companions written by
 * contracts/scripts/deploy-aa.ts via sync-addresses); AA_<CHAINKEY>_<FIELD>
 * env vars (e.g. AA_BASE_SEPOLIA_PAYMASTER) override per field for stacks
 * with their own deployments. Deliberately NOT in
 * DEPLOYMENT_SET_REQUIRED_ENV: testnet AA is shared infra on shared chains,
 * so inheriting the default is correct until a stack deploys its own.
 */

export interface ChainAA {
  paymaster: string;
  factory: string;
  entrypoint: string;
  usdc: string;
}

type AaField = 'USDCPaymaster' | 'BlindAccountFactory' | 'EntryPoint' | 'USDC';

function generated(chainKey: string, field: AaField): string {
  const rec = (AA_ADDRESSES as Record<string, Record<string, string> | undefined>)[chainKey];
  const v = rec?.[field] ?? '';
  return /^0x[0-9a-fA-F]{40}$/.test(v) ? v : '';
}

function pick(chainKey: string, field: AaField, envField: string): string {
  const envName = `AA_${chainKey.toUpperCase().replace(/-/g, '_')}_${envField}`;
  const envVal = (process.env[envName] ?? '').trim();
  if (envVal) return envVal;
  return generated(chainKey, field);
}

export function getChainAA(chainKey: string): ChainAA | null {
  const paymaster = pick(chainKey, 'USDCPaymaster', 'PAYMASTER');
  const factory = pick(chainKey, 'BlindAccountFactory', 'FACTORY');
  const entrypoint = pick(chainKey, 'EntryPoint', 'ENTRYPOINT');
  const usdc = pick(chainKey, 'USDC', 'USDC');
  if (!paymaster || !factory || !entrypoint || !usdc) return null;
  return { paymaster, factory, entrypoint, usdc };
}
