import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * What config resolves to with no chain env vars set, pinned after NODE_ENV
 * became the single switch.
 *
 * Two coherent stacks only — production (full mainnet) and development (testnet
 * defaults). A mixed-tier "production on testnet" shape no longer exists; it
 * was the source of the 2026-05-25 cross-env poaching incident and the live
 * verifier-mismatch that has been unresolved since. Moving to mainnet also
 * fixes the verifier role drift on Arc.
 *
 * Every chain var is cleared to '' rather than deleted, because config.ts
 * loads dotenv on import and would otherwise pick up the developer's .env.
 */

const ORIGINAL = { ...process.env };

const CLEARED = {
  STACK: '',
  SETTLEMENT_TIER: '',
  OG_RPC_URL: '',
  OG_CHAIN_ID: '',
  BASE_RPC_URL: '',
  BASE_CHAIN_ID: '',
  BLIND_ESCROW_ADDRESS: '',
  TASK_REGISTRY_ADDRESS: '',
  BLIND_REPUTATION_ADDRESS: '',
  INFT_ADDRESS: '',
  BASE_ESCROW_ADDRESS: '',
  BASE_USDC_ADDRESS: '',
  AGENT_FACTORY_ADDRESS: '',
  CCTP_TOKEN_MESSENGER_ADDRESS: '',
  CCTP_MESSAGE_TRANSMITTER_ADDRESS: '',
  CCTP_IRIS_API_BASE: '',
  CCTP_ETHEREUM_CHAIN_ID: '',
  CCTP_ARBITRUM_CHAIN_ID: '',
  CCTP_OPTIMISM_CHAIN_ID: '',
  CCTP_ARC_CHAIN_ID: '',
  CCTP_ARC_RPC_URL: '',
  CCTP_BASE_RPC_URL: '',
  CCTP_BASE_USDC_ADDRESS: '',
  ARC_CHAIN_ID: '',
  ARC_RPC_URL: '',
  ARC_AGENT_FACTORY_ADDRESS: '',
  DEPLOYMENT_SET: '',
};

async function load(env: Record<string, string>) {
  vi.resetModules();
  process.env = { ...ORIGINAL, ...CLEARED, ...env };
  const { config } = await import('./config.js');
  return config;
}

afterEach(() => {
  process.env = { ...ORIGINAL };
});

/** The chain facts a deployment would break on if they moved. */
const shape = (config: Awaited<ReturnType<typeof load>>) => ({
  ogChainId: config.ogChainId,
  ogRpcUrl: config.ogRpcUrl,
  blindEscrowAddress: config.blindEscrowAddress,
  taskRegistryAddress: config.taskRegistryAddress,
  blindReputationAddress: config.blindReputationAddress,
  inftAddress: config.inftAddress,
  baseChainId: config.baseChainId,
  baseRpcUrl: config.baseRpcUrl,
  baseEscrowAddress: config.baseEscrowAddress,
  baseUsdcAddress: config.baseUsdcAddress,
  arcChainId: config.arcChainId,
  arcRpcUrl: config.arcRpcUrl,
  arcAgentFactoryAddress: config.arcAgentFactoryAddress,
  cctpMainnet: config.cctp.mainnet,
  cctpEthereumChainId: config.cctp.ethereumChainId,
  cctpArcChainId: config.cctp.arcChainId,
  cctpBaseRpcUrl: config.cctp.baseRpcUrl,
  irisApiBase: config.cctp.irisApiBase,
});

// Arc mainnet: the production shape. Full mainnet — 0G mainnet, Base mainnet,
// Arc mainnet, mainnet CCTP.
const ARC_MAINNET = {
  arcChainId: 5042,
  arcRpcUrl: 'https://arc-rpc.publicnode.com',
  arcAgentFactoryAddress: '0x5A3312575F66c403ebcFfD1D9Fb868736B5102eb',
  cctpArcChainId: 5042,
};

// Arc testnet: the development shape. Testnet on every chain.
const ARC_TESTNET = {
  arcChainId: 5042002,
  arcRpcUrl: 'https://arc-testnet-rpc.publicnode.com',
  arcAgentFactoryAddress: '0x1E9Abb2F2e66b8Af35BED730500A94760E133a3B',
  cctpArcChainId: 5042002,
};

describe('config with no chain env vars', () => {
  it('production: full mainnet on every chain', async () => {
    expect(shape(await load({ NODE_ENV: 'production' }))).toEqual({
      ogChainId: 16661,
      ogRpcUrl: 'https://0g-rpc.publicnode.com',
      blindEscrowAddress: '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff',
      taskRegistryAddress: '0x9CCF9c196006B573FaA9C9c9CebDd1296dbd5cE0',
      blindReputationAddress: '0x3af9232009C5da30AdA366B6E09849A040162A1a',
      inftAddress: '0xfE70a007AFD022A4824d1975A1facFA266F66E28',
      baseChainId: 8453,
      baseRpcUrl: 'https://base-rpc.publicnode.com',
      // Base mainnet escrow is not deployed yet (contracts/deployments/base.json
      // has USDC only); reads default to '' until the escrow ships.
      baseEscrowAddress: '',
      baseUsdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      ...ARC_MAINNET,
      cctpMainnet: true,
      cctpEthereumChainId: 1,
      cctpBaseRpcUrl: 'https://base-rpc.publicnode.com',
      irisApiBase: 'https://iris-api.circle.com',
    });
  });

  it('development: 0G testnet, Base Sepolia, Arc testnet', async () => {
    expect(shape(await load({ NODE_ENV: 'development' }))).toEqual({
      ogChainId: 16602,
      ogRpcUrl: 'https://evmrpc-testnet.0g.ai',
      blindEscrowAddress: '0x037529B296a89E6Dd1abAF84D413cb2dD70C5be5',
      taskRegistryAddress: '0xF6AaCce326fD7f25860f383f18A771E5d089ea8c',
      blindReputationAddress: '0xFEAFe4ab073FfB47aBb5AD458622b3F9B10C81dD',
      inftAddress: '0xc4498099413f8a7D709175eC252aFa7543c6d39a',
      baseChainId: 84532,
      baseRpcUrl: 'https://base-sepolia-rpc.publicnode.com',
      baseEscrowAddress: '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf',
      baseUsdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      ...ARC_TESTNET,
      cctpMainnet: false,
      cctpEthereumChainId: 11155111,
      cctpBaseRpcUrl: 'https://base-sepolia-rpc.publicnode.com',
      irisApiBase: 'https://iris-api-sandbox.circle.com',
    });
  });
});
