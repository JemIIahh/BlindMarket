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
  process.env = { ...ORIGINAL, CCTP_ENABLED: 'true', ...CLEAR_CCTP_OVERRIDES, ...env };
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
    expect(chains.getBaseCctpChain()?.chainKey).toBe('base-sepolia');
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
    expect(chains.getBaseCctpChain()?.chainKey).toBe('base');
    expect(config.cctp.tokenMessengerAddress).toBe('0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d');
    expect(config.cctp.irisApiBase).toBe('https://iris-api.circle.com');
  });

  it('even NODE_ENV=development pointed at Base mainnet gets the mainnet tier — the Base leg decides', async () => {
    const { config } = await load({ NODE_ENV: 'development', BASE_CHAIN_ID: '8453' });
    expect(config.cctp.mainnet).toBe(true);
  });
});
