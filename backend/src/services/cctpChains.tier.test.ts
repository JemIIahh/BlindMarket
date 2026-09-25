import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * CCTP network tier = the Arc network tasks settle on, NOT Base or NODE_ENV.
 * Every transfer mints into (or burns from) the user's Arc wallet, so Arc is
 * one leg of each. The deployed app runs NODE_ENV=production on Arc testnet:
 * it must get the TESTNET tier (Sepolia chains + Arc Testnet, testnet
 * messenger, Iris sandbox). It used to follow Base, so a Base-mainnet stack
 * offered mainnet sources while minting into Arc testnet. Re-imports the real
 * config + cctpChains under each env.
 */

vi.mock('./chain.js', () => ({ baseProvider: {} }));

const ORIGINAL = { ...process.env };

// '' (not undefined) so dotenv — which config.ts loads on import — can't
// backfill these from the developer's local .env; optional() treats '' as unset.
const CLEAR_CCTP_OVERRIDES = {
  SETTLEMENT_TIER: '',
  CCTP_TOKEN_MESSENGER_ADDRESS: '',
  CCTP_MESSAGE_TRANSMITTER_ADDRESS: '',
  CCTP_IRIS_API_BASE: '',
  CCTP_ARC_CHAIN_ID: '',
  CCTP_ARC_RPC_URL: '',
  CCTP_BASE_RPC_URL: '',
  CCTP_BASE_USDC_ADDRESS: '',
  CCTP_POLYGON_RPC_URL: '',
  ARC_CHAIN_ID: '',
  ARC_RPC_URL: '',
  BASE_RPC_URL: '',
};

async function load(env: Record<string, string>) {
  vi.resetModules();
  // A DATABASE_URL is required for CCTP to report as configured; these tests never query it.
  process.env = { ...ORIGINAL, CCTP_ENABLED: 'true', DATABASE_URL: 'postgres://tier-test@localhost:1/none', ...CLEAR_CCTP_OVERRIDES, ...env };
  const { config } = await import('../config.js');
  const chains = await import('./cctpChains.js');
  const chain = await import('./chain.js');
  return { config, chains, chain };
}

afterEach(() => {
  process.env = { ...ORIGINAL };
});

const TESTNET_KEYS = ['arbitrum-sepolia', 'arc-testnet', 'base-sepolia', 'ethereum-sepolia', 'optimism-sepolia', 'polygon-amoy'];
const MAINNET_KEYS = ['arbitrum', 'arc', 'base', 'ethereum', 'polygon'];
const keys = (list: { chainKey: string }[]) => list.map((c) => c.chainKey).sort();

describe('CCTP network tier follows the Arc chain it mints into, not Base or NODE_ENV', () => {
  it('deployed app (NODE_ENV=production) on Arc testnet gets the TESTNET tier', async () => {
    const { config, chains } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532' });
    expect(config.cctp.mainnet).toBe(false);
    expect(keys(chains.supportedCctpChains())).toEqual(TESTNET_KEYS);
    expect(chains.getSettlementCctpChain()).toMatchObject({ chainKey: 'arc-testnet', chainId: 5042002, domain: 26 });
    expect(config.cctp.tokenMessengerAddress).toBe('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA');
    expect(config.cctp.irisApiBase).toBe('https://iris-api-sandbox.circle.com');
    expect(config.cctp.ethereumChainId).toBe(11155111);
  });

  it('local dev with no chain ids gets the testnet tier', async () => {
    const { config, chains } = await load({ NODE_ENV: 'development', BASE_CHAIN_ID: '' });
    expect(config.baseChainId).toBe(84532);
    expect(config.cctp.mainnet).toBe(false);
    expect(keys(chains.supportedCctpChains())).toEqual(TESTNET_KEYS);
  });

  it('Arc mainnet (5042) gets the MAINNET tier, whatever NODE_ENV says', async () => {
    const { config, chains } = await load({ NODE_ENV: 'development', ARC_CHAIN_ID: '5042' });
    expect(config.cctp.mainnet).toBe(true);
    expect(keys(chains.supportedCctpChains())).toEqual(MAINNET_KEYS);
    expect(chains.getSettlementCctpChain()).toMatchObject({
      chainKey: 'arc', chainId: 5042, domain: 26, isTestnet: false, supportsFastTransfer: false,
      usdcAddress: '0x3600000000000000000000000000000000000000',
    });
    expect(config.cctp.tokenMessengerAddress).toBe('0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d');
    expect(config.cctp.messageTransmitterAddress).toBe('0x81D40F21F12A8F0E3252Bccb954D722d4c464B64');
    expect(config.cctp.irisApiBase).toBe('https://iris-api.circle.com');
    expect(config.cctp.ethereumChainId).toBe(1);
  });

  it('Base mainnet with Arc on testnet stays on the testnet tier', async () => {
    const { config, chains } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '8453' });
    expect(config.cctp.mainnet).toBe(false);
    expect(keys(chains.supportedCctpChains())).toEqual(TESTNET_KEYS);
    expect(chains.getSettlementCctpChain()?.chainKey).toBe('arc-testnet');
  });
});

describe("CCTP's Base leg", () => {
  it('is the settlement Base network, through its provider, when that is on the CCTP tier', async () => {
    const { chains, chain } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532' });
    const leg = chains.getCctpChain('base-sepolia');
    expect(leg?.rpc).toBe(chain.baseProvider);
    expect(leg?.usdcAddress).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  });

  it('is Base on the CCTP tier, through its own RPC, when the Base escrow stays on another tier', async () => {
    // Arc mainnet next to the Base Sepolia escrow kept for its older tasks.
    const { config, chains, chain } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532', ARC_CHAIN_ID: '5042' });
    expect(config.baseRpcUrl).toBe('https://sepolia.base.org');
    const leg = chains.getCctpChain('base');
    expect(leg).toMatchObject({ chainId: 8453, usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' });
    expect(leg?.rpc).not.toBe(chain.baseProvider);
    expect((await leg!.rpc.getNetwork()).chainId).toBe(8453n);
    expect(keys(chains.supportedCctpChains())).toContain('base');
  });

  it('takes CCTP_BASE_RPC_URL when it is set', async () => {
    const { config } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532', ARC_CHAIN_ID: '5042', CCTP_BASE_RPC_URL: 'https://base.example/key' });
    expect(config.cctp.baseRpcUrl).toBe('https://base.example/key');
  });
});

describe('which CCTP chains this backend serves', () => {
  it('resolves no chain off its tier, so a transfer left there after Arc moves is failed, not polled forever', async () => {
    const { chains } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532', ARC_CHAIN_ID: '5042' });
    expect(chains.getCctpChain('arc-testnet')).toBeNull();
    expect(chains.getCctpChain('base-sepolia')).toBeNull();
    expect(chains.getCctpChain('arc')?.chainId).toBe(5042);
  });

  it('stops offering a leg turned off for its RPC, but keeps it for transfers already on it', async () => {
    const { chains } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532' });
    chains.disableCctpLeg('polygon-amoy');
    expect(keys(chains.supportedCctpChains())).toEqual(TESTNET_KEYS.filter((k) => k !== 'polygon-amoy'));
    expect(chains.isSupportedCctpChain('polygon-amoy')).toBe(false);
    expect(chains.getCctpChain('polygon-amoy')?.chainId).toBe(80002);
    expect(chains.isCctpConfigured()).toBe(true);
  });

  it('turns CCTP off with its Arc leg: every transfer uses it', async () => {
    const { chains } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532' });
    chains.disableCctpLeg('arc-testnet');
    expect(chains.isCctpConfigured()).toBe(false);
    expect(chains.supportedCctpChains()).toEqual([]);
    expect(chains.getSettlementCctpChain()).toBeNull();
  });

  it('defaults Polygon to RPCs that answer (polygon-rpc.com and rpc-amoy.polygon.technology no longer do)', async () => {
    expect((await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532' })).config.cctp.polygonRpcUrl).toBe('https://polygon-amoy-bor-rpc.publicnode.com');
    expect((await load({ NODE_ENV: 'production', ARC_CHAIN_ID: '5042' })).config.cctp.polygonRpcUrl).toBe('https://polygon-bor-rpc.publicnode.com');
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
