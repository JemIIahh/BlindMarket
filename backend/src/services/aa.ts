import { ethers } from 'ethers';
import { config } from '../config.js';
import { baseMarketplaceSigner } from './chain.js';
import { appendLog } from './redis.js';

// Minimal ABIs for on-chain AA interactions
export const BlindAccountFactoryABI = [
  'function createAccount(address owner, bytes32 salt) returns (address)',
  'function accounts(address) view returns (address)',
] as const;

export const BlindAccountABI = [
  'function execute(address to, uint256 value, bytes calldata data)',
  'function executeBatch(address[] calldata to, uint256[] calldata value, bytes[] calldata data)',
  'function owner() view returns (address)',
] as const;

// Salt for deterministic CREATE2 address — matches off-chain computation
function computeSalt(walletAddress: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`blind-account:${walletAddress}`));
}

/**
 * Deploy a BlindAccount for the given agent wallet via BlindAccountFactory.
 * Idempotent: if the factory already has an account for this owner, returns
 * the existing address without sending a tx.
 *
 * Requires `baseMarketplaceSigner` (the backend's Base ETH wallet) to pay
 * the gas for the CREATE2 deploy. On success the smart account address is
 * persisted to `agent.smartAccountAddress`.
 *
 * Returns the deployed smart account address, or undefined if deployment
 * was skipped (no factory configured, no signer, or silent failure).
 */
export async function deploySmartAccount(
  agent: { id: string; walletAddress: string; smartAccountAddress?: string },
  log: (msg: string) => void = (msg) => appendLog(agent.id, msg),
  opts?: { force?: boolean },
): Promise<string | undefined> {
  // Already deployed — just return the stored address, unless force asks for
  // a fresh deployment (e.g. the factory was redeployed and CREATE2 addresses
  // changed, so the stored address belongs to the old factory).
  if (agent.smartAccountAddress && !opts?.force) return agent.smartAccountAddress;

  // Bail if AA infra is not configured
  const factoryAddress = config.blindAccountFactoryAddress;
  const signer = baseMarketplaceSigner;
  if (!factoryAddress || !signer) {
    log('[aa] BlindAccountFactory or Base signer not configured — skipping smart account deployment');
    return undefined;
  }

  const ownerAddress = agent.walletAddress;
  const salt = computeSalt(ownerAddress);

  try {
    const factory = new ethers.Contract(factoryAddress, BlindAccountFactoryABI, signer);

    // Check if already deployed (idempotent — no tx if it exists)
    const existing: string = await factory.accounts(ownerAddress);
    if (existing && existing !== ethers.ZeroAddress) {
      log(`[aa] BlindAccount already deployed for ${ownerAddress}: ${existing}`);
      return existing;
    }

    // Deploy — this is a cheap CREATE2 call (~100k gas)
    const tx = await factory.createAccount(ownerAddress, salt);
    log(`[aa] BlindAccount deploy tx: ${tx.hash}`);
    const receipt = await tx.wait();

    // Read back the address from the factory mapping
    const smartAccountAddress: string = await factory.accounts(ownerAddress);
    log(`[aa] BlindAccount deployed at ${smartAccountAddress} (tx: ${receipt?.hash})`);
    return smartAccountAddress;
  } catch (e) {
    // Non-fatal: agent can still run on 0G without a smart account
    log(`[aa] BlindAccount deployment failed (non-fatal): ${(e as Error).message}`);
    return undefined;
  }
}
