import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * CCTP network tier = the Base network the deployment settles on, NOT
 * NODE_ENV. The deployed app runs NODE_ENV=production on Base Sepolia — it
 * must get the TESTNET tier (Sepolia chains + Arc Testnet, testnet messenger,
 * Iris sandbox). Only a Base-mainnet deployment (BASE_CHAIN_ID=8453) gets the
 * mainnet tier. Re-imports the real config + cctpChains under each env.
 */

vi.mock('./chain.js', () => ({ baseProvider: {} }));

const ORIGINAL = { ...process.env };

// '' (not undefined) so dotenv — which config.ts loads on import — can't
// backfill these from the developer's local .env; optional() treats '' as unset.
const CLEAR_CCTP_OVERRIDES = {
  CCTP_TOKEN_MESSENGER_ADDRESS: '',
  CCTP_MESSAGE_TRANSMITTER_ADDRESS: '',
  CCTP_IRIS_API_BASE: '',
};

async function load(env: Record<string, string>) {
  vi.resetModules();
  // A DATABASE_URL is required for CCTP to report as configured; these tests never query it.
  process.env = { ...ORIGINAL, CCTP_ENABLED: 'true', DATABASE_URL: 'postgres://tier-test@localhost:1/none', ...CLEAR_CCTP_OVERRIDES, ...env };
  const { config } = await import('../config.js');
  const chains = await import('./cctpChains.js');
  return { config, chains };
}

afterEach(() => {
  process.env = { ...ORIGINAL };
});

const TESTNET_KEYS = ['arbitrum-sepolia', 'arc-testnet', 'base-sepolia', 'ethereum-sepolia', 'optimism-sepolia'];
const MAINNET_KEYS = ['arbitrum', 'base', 'ethereum', 'optimism'];
const keys = (list: { chainKey: string }[]) => list.map((c) => c.chainKey).sort();

describe('CCTP network tier follows the Base chain, not NODE_ENV', () => {
  it('deployed app (NODE_ENV=production) on Base Sepolia gets the TESTNET tier', async () => {
    const { config, chains } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532' });
    expect(config.cctp.mainnet).toBe(false);
    expect(keys(chains.supportedCctpChains())).toEqual(TESTNET_KEYS);
    expect(chains.getSettlementCctpChain()?.chainKey).toBe('arc-testnet');
    expect(config.cctp.tokenMessengerAddress).toBe('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA');
    expect(config.cctp.irisApiBase).toBe('https://iris-api-sandbox.circle.com');
    expect(config.cctp.ethereumChainId).toBe(11155111);
  });

  it('local dev with no BASE_CHAIN_ID defaults to Base Sepolia → testnet tier', async () => {
    const { config, chains } = await load({ NODE_ENV: 'development', BASE_CHAIN_ID: '' });
    expect(config.baseChainId).toBe(84532);
    expect(config.cctp.mainnet).toBe(false);
    expect(keys(chains.supportedCctpChains())).toEqual(TESTNET_KEYS);
  });

  it('only a Base-mainnet deployment (8453) gets the MAINNET tier', async () => {
    const { config, chains } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '8453' });
    expect(config.cctp.mainnet).toBe(true);
    expect(keys(chains.supportedCctpChains())).toEqual(MAINNET_KEYS);
    expect(chains.getSettlementCctpChain()?.chainKey).toBe('arc-testnet');
    expect(config.cctp.tokenMessengerAddress).toBe('0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d');
    expect(config.cctp.irisApiBase).toBe('https://iris-api.circle.com');
  });

  it('even NODE_ENV=development pointed at Base mainnet gets the mainnet tier — the Base leg decides', async () => {
    const { config } = await load({ NODE_ENV: 'development', BASE_CHAIN_ID: '8453' });
    expect(config.cctp.mainnet).toBe(true);
  });
});

describe('Base defaults follow BASE_CHAIN_ID too', () => {
  // Prod ran NODE_ENV=production on Base Sepolia and got Base MAINNET's USDC
  // address — no contract on Sepolia, so balances read 0, /health/bridge
  // reported signerUsdcBalance: null, and a CCTP burn would revert.
  it('production on Base Sepolia uses Base SEPOLIA USDC + RPC', async () => {
    const { config } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532', BASE_USDC_ADDRESS: '', BASE_RPC_URL: '' });
    expect(config.baseUsdcAddress).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(config.baseRpcUrl).toBe('https://sepolia.base.org');
  });

  it('a Base mainnet deployment uses mainnet USDC + RPC', async () => {
    const { config } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '8453', BASE_USDC_ADDRESS: '', BASE_RPC_URL: '' });
    expect(config.baseUsdcAddress).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(config.baseRpcUrl).toBe('https://mainnet.base.org');
  });

  it('an explicit BASE_USDC_ADDRESS still wins', async () => {
    const { config } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532', BASE_USDC_ADDRESS: '0x1111111111111111111111111111111111111111', BASE_RPC_URL: '' });
    expect(config.baseUsdcAddress).toBe('0x1111111111111111111111111111111111111111');
  });
});

describe('without a database, CCTP is unavailable instead of failing mid-transfer', () => {
  // Prod bridging 500'd with "Cannot read properties of undefined (reading 'id')":
  // no DATABASE_URL → neonDb's no-op pool → INSERT … RETURNING * gave no row.
  it('reports CCTP as not configured, offers no chains and no Base leg', async () => {
    const { chains } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532', DATABASE_URL: '' });
    expect(chains.isCctpConfigured()).toBe(false);
    expect(chains.supportedCctpChains()).toEqual([]);
    expect(chains.getSettlementCctpChain()).toBeNull();
  });

  it('createTransfer fails with a clear reason instead of returning undefined', async () => {
    await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532', DATABASE_URL: '' });
    const store = await import('./cctpTransferStore.js');
    await expect(store.createTransfer({
      idempotencyKey: 'k', direction: 'inbound', agentId: null, ownerAddress: '0x1111111111111111111111111111111111111111',
      sourceChain: 'ethereum-sepolia', sourceDomain: 0, destChain: 'base-sepolia', destDomain: 6,
      usdcAmountRaw: '1000000', mintRecipient: '0x2222222222222222222222222222222222222222',
      maxFeeRaw: '1000', minFinalityThreshold: 1000, relayMethod: 'forwarding_service',
    })).rejects.toThrow(/database is not configured/);
  });

  it('createApiKey fails with a clear reason instead of "reading \'id\'"', async () => {
    await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532', DATABASE_URL: '' });
    const keys = await import('./apiKeyStore.js');
    await expect(keys.createApiKey({ ownerAddress: '0x1111111111111111111111111111111111111111', name: 'k' }))
      .rejects.toThrow(/database is not configured/);
  });
});
