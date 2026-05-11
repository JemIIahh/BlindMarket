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

/**
 * Read-only JSON-RPC provider for 0G Chain.
 *
 * batchMaxCount: 1 disables ethers v6's default JSON-RPC batching. The 0G
 * testnet RPC returns clean single requests in <1s but consistently times
 * out / drops the connection on batched eth_getLogs calls — observed via
 * the escrowEvents poller spiraling on TIMEOUT/ECONNRESET while a direct
 * curl of the same query returns []. Single-request mode trades some
 * efficiency for reliability, which is the right call here.
 *
 * staticNetwork: true skips ethers' periodic chainId re-detection probe
 * (one fewer thing that can fail in flight).
 */
export const provider = new ethers.JsonRpcProvider(config.ogRpcUrl, config.ogChainId, {
  batchMaxCount: 1,
  staticNetwork: true,
});

/** Signing wallet for backend-initiated transactions (e.g. INFT mint) */
export const signer = config.ogStoragePrivateKey
  ? new ethers.Wallet(config.ogStoragePrivateKey, provider)
  : null;

/**
 * Marketplace signer — holds the verifier role on BlindEscrow. Used by
 * services/a2aSettlement.ts to call marketplaceAssign + completeVerification
 * on A2A tasks. Null when MARKETPLACE_SIGNER_PRIVATE_KEY isn't configured,
 * which disables the settlement bridge but doesn't break other flows.
 */
export const marketplaceSigner = config.marketplaceSignerPrivateKey
  ? new ethers.Wallet(config.marketplaceSignerPrivateKey, provider)
  : null;

/** Read-only contract instances */
export const escrow = new ethers.Contract(config.blindEscrowAddress, loadAbi('BlindEscrow'), provider);
export const registry = new ethers.Contract(config.taskRegistryAddress, loadAbi('TaskRegistry'), provider);
export const reputation = new ethers.Contract(config.blindReputationAddress, loadAbi('BlindReputation'), provider);

/** Write-capable BlindEscrow bound to the marketplace signer (verifier role). */
export const escrowAsMarketplace = marketplaceSigner
  ? new ethers.Contract(config.blindEscrowAddress, loadAbi('BlindEscrow'), marketplaceSigner)
  : null;

/** INFT contract — write-capable when signer is available */
export const inft = config.inftAddress
  ? new ethers.Contract(config.inftAddress, loadAbi('INFT'), signer ?? provider)
  : null;

/** Encode an unsigned transaction for a contract call (frontend signs) */
export async function buildUnsignedTx(
  contract: ethers.Contract,
  method: string,
  args: unknown[],
  from: string,
): Promise<ethers.TransactionRequest> {
  const data = contract.interface.encodeFunctionData(method, args);
  const to = await contract.getAddress();
  return { to, data, from: ethers.getAddress(from) };
}
/** Get decimals for an ERC-20 token */
export async function getTokenDecimals(tokenAddress: string): Promise<number> {
  try {
    const token = new ethers.Contract(tokenAddress, ['function decimals() view returns (uint8)'], provider);
    return Number(await token.decimals());
  } catch (err) {
    console.warn(`[chain] Failed to fetch decimals for ${tokenAddress}, defaulting to 18:`, err);
    return 18;
  }
}
