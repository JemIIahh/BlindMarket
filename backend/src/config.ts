import 'dotenv/config';

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

const IS_PROD = process.env.NODE_ENV === 'production';

export const config = {
  port: parseInt(optional('PORT', '3001'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),

  // 0G Chain
  ogRpcUrl: optional('OG_RPC_URL', IS_PROD ? 'https://evmrpc.0g.ai' : 'https://evmrpc-testnet.0g.ai'),
  ogChainId: parseInt(optional('OG_CHAIN_ID', IS_PROD ? '16661' : '16602'), 10),

  // Contracts
  blindEscrowAddress: optional('BLIND_ESCROW_ADDRESS', IS_PROD ? '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff' : '0x7B420523E2b5d6C0f0e5deF75b1D9a901167f041'),
  taskRegistryAddress: optional('TASK_REGISTRY_ADDRESS', IS_PROD ? '0x9CCF9c196006B573FaA9C9c9CebDd1296dbd5cE0' : '0xF6AaCce326fD7f25860f383f18A771E5d089ea8c'),
  blindReputationAddress: optional('BLIND_REPUTATION_ADDRESS', IS_PROD ? '0x3af9232009C5da30AdA366B6E09849A040162A1a' : '0xFEAFe4ab073FfB47aBb5AD458622b3F9B10C81dD'),
  inftAddress: optional('INFT_ADDRESS', IS_PROD ? '0xfE70a007AFD022A4824d1975A1facFA266F66E28' : '0xff29617270b3B6f565e1eC206C0A69F8966aBd2b'),

  // Auth — Privy is the sole identity provider; agent API key for service callers
  agentApiKey: process.env.AGENT_API_KEY || '',
  privyAppId: required('PRIVY_APP_ID').trim(),
  // Used only by registration.ts to mint long-lived agent CLI tokens.
  // No longer accepted by requireAuth — that path is Privy-only.
  jwtSecret: process.env.JWT_SECRET || '',

  // CORS
  corsOrigin: optional('CORS_ORIGIN', 'http://localhost:5173').split(',').map(s => s.trim()),

  // 0G Storage (Phase 3)
  ogStorageIndexerRpc: process.env.OG_STORAGE_INDEXER_RPC || '',
  ogStoragePrivateKey: process.env.OG_STORAGE_PRIVATE_KEY || '',

  // Marketplace signer — holds the verifier role on BlindEscrow. Used by the
  // A2A settlement bridge (services/a2aSettlement.ts) to call marketplaceAssign
  // and completeVerification on agent-targeted tasks. Generated and rotated
  // via contracts/scripts/generate-marketplace-signer.ts + rotate-verifier.ts.
  marketplaceSignerPrivateKey: process.env.MARKETPLACE_SIGNER_PRIVATE_KEY || '',

  // Forensic verification
  forensicMaxPhotoAgeMs: parseInt(optional('FORENSIC_MAX_PHOTO_AGE_MS', '1800000'), 10),  // 30 min
  forensicPhashThreshold: parseInt(optional('FORENSIC_PHASH_THRESHOLD', '10'), 10),

  // 0G Compute / Sealed Inference (Phase 4)
  // Private key for the broker wallet (pays for inference requests)
  ogComputePrivateKey: process.env.OG_COMPUTE_PRIVATE_KEY || '',
  // Optional: preferred provider address (if empty, auto-selects from available services)
  ogComputeProviderAddress: process.env.OG_COMPUTE_PROVIDER_ADDRESS || '',
  // RPC for compute network (defaults to testnet)
  ogComputeRpcUrl: optional('OG_COMPUTE_RPC_URL', 'https://evmrpc-testnet.0g.ai'),
} as const;
