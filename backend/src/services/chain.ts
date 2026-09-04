import { ethers } from 'ethers';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const abiDir = join(__dirname, '..', 'abi');

function loadAbi(name: string): ethers.InterfaceAbi {
  return JSON.parse(readFileSync(join(abiDir, `${name}.json`), 'utf-8')) as ethers.InterfaceAbi;
}

// ═══════════════════════════════════════════════════════════════════════════
// 0G / EVM Chain (agent infra — TaskRegistry, Reputation, INFT)
// ═══════════════════════════════════════════════════════════════════════════

export const provider: ethers.JsonRpcProvider = new ethers.JsonRpcProvider(config.ogRpcUrl, config.ogChainId, {
  batchMaxCount: 1,
  staticNetwork: true,
});

/** Signing wallet for backend-initiated transactions (e.g. INFT mint) */
export const signer: ethers.Wallet | null = config.ogStoragePrivateKey
  ? new ethers.Wallet(config.ogStoragePrivateKey, provider)
  : null;

export const marketplaceSigner: ethers.Wallet | null = config.marketplaceSignerPrivateKey
  ? new ethers.Wallet(config.marketplaceSignerPrivateKey, provider)
  : null;

/** Read-only contract instances — 0G (agent infra) */
export const escrow: ethers.Contract = new ethers.Contract(config.blindEscrowAddress, loadAbi('BlindEscrow'), provider);
export const registry: ethers.Contract = new ethers.Contract(config.taskRegistryAddress, loadAbi('TaskRegistry'), provider);
export const reputation: ethers.Contract = new ethers.Contract(config.blindReputationAddress, loadAbi('BlindReputation'), provider);

/** Write-capable BlindEscrow bound to the marketplace signer (verifier role) on 0G. */
export const escrowAsMarketplace: ethers.Contract | null = marketplaceSigner
  ? new ethers.Contract(config.blindEscrowAddress, loadAbi('BlindEscrow'), marketplaceSigner)
  : null;

/** INFT contract — write-capable when signer is available */
export const inft: ethers.Contract | null = config.inftAddress
  ? new ethers.Contract(config.inftAddress, loadAbi('INFT'), signer ?? provider)
  : null;

// ═══════════════════════════════════════════════════════════════════════════
// Base Chain (settlement — BlindEscrow, USDC payouts)
// ═══════════════════════════════════════════════════════════════════════════

const baseFetchRequest = new ethers.FetchRequest(config.baseRpcUrl);
baseFetchRequest.timeout = 120_000; // 2 min — public Base RPC can be slow

export const baseProvider: ethers.JsonRpcProvider = new ethers.JsonRpcProvider(baseFetchRequest, config.baseChainId, {
  batchMaxCount: 1,
  staticNetwork: true,
});

/** Marketplace signer for Base escrow (holds verifier role on Base BlindEscrow). */
export const baseMarketplaceSigner: ethers.Wallet | null = config.baseMarketplaceSignerPrivateKey
  ? new ethers.Wallet(config.baseMarketplaceSignerPrivateKey, baseProvider)
  : null;

/** Read-only BlindEscrow on Base. Null when BASE_ESCROW_ADDRESS is unset. */
export const baseEscrow: ethers.Contract | null = config.baseEscrowAddress
  ? new ethers.Contract(config.baseEscrowAddress, loadAbi('BlindEscrow'), baseProvider)
  : null;

/** Write-capable BlindEscrow on Base bound to the Base marketplace signer. */
export const baseEscrowAsMarketplace: ethers.Contract | null = config.baseEscrowAddress && baseMarketplaceSigner
  ? new ethers.Contract(config.baseEscrowAddress, loadAbi('BlindEscrow'), baseMarketplaceSigner)
  : null;

/** Encode an unsigned transaction for a contract call (frontend signs) */
export async function buildUnsignedTx(
  contract: ethers.Contract,
  method: string,
  args: unknown[],
  from: string,
  value?: bigint,
): Promise<ethers.TransactionRequest> {
  const data = contract.interface.encodeFunctionData(method, args);
  const to = await contract.getAddress();
  return {
    to,
    data,
    from: ethers.getAddress(from),
    ...(value !== undefined ? { value } : {}),
  };
}

/**
 * Get decimals for an ERC-20 token. Returns 18 for a native-currency task
 * (token == address(0)).
 *
 * `chain` selects the provider to ask. It matters: USDC on Base has 6
 * decimals, but querying that address against the 0G provider finds no
 * contract, throws, and falls back to 18 — silently recording a USDC amount
 * 1e12 times too small. Callers holding a Base task must pass 'base'.
 */
export async function getTokenDecimals(
  tokenAddress: string,
  chain: 'base' | '0g' = '0g',
): Promise<number> {
  if (tokenAddress === '0x0000000000000000000000000000000000000000') return 18;

  const rpc = chain === 'base' ? baseProvider : provider;
  if (!rpc) return 18;

  try {
    const token = new ethers.Contract(tokenAddress, ['function decimals() view returns (uint8)'], rpc);
    return Number(await token.decimals());
  } catch {
    return 18;
  }
}