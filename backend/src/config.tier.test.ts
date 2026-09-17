import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

/**
 * SETTLEMENT_TIER names one network tier for every chain at once: chain ids
 * default from it, and an explicit chain id that contradicts it stops the
 * boot. With no tier set, each chain keeps its own default (pinned in
 * config.legacy.test.ts) and a half-mainnet stack is only warned about,
 * because production is one today.
 */

const ORIGINAL = { ...process.env };

// '' rather than deleted: config.ts loads dotenv on import.
const CLEARED = {
  SETTLEMENT_TIER: '', OG_RPC_URL: '', OG_CHAIN_ID: '', BASE_RPC_URL: '', BASE_CHAIN_ID: '',
  BLIND_ESCROW_ADDRESS: '', TASK_REGISTRY_ADDRESS: '', BLIND_REPUTATION_ADDRESS: '', INFT_ADDRESS: '',
  BASE_ESCROW_ADDRESS: '', BASE_USDC_ADDRESS: '', AGENT_FACTORY_ADDRESS: '', DEPLOYMENT_SET: '',
  CCTP_ETHEREUM_CHAIN_ID: '', CCTP_ARBITRUM_CHAIN_ID: '', CCTP_OPTIMISM_CHAIN_ID: '',
  PUBLIC_API_URL: '', PUBLIC_APP_URL: '',
  // Production boot needs these; they are not what these tests are about.
  JWT_SECRET: 'test-secret', DATABASE_URL: 'postgres://tier-test@localhost:1/none',
  ALLOW_NONMAINNET_PROD: '', ALLOW_SQLITE_PROD: '',
};

async function load(env: Record<string, string>) {
  vi.resetModules();
  process.env = { ...ORIGINAL, ...CLEARED, ...env };
  return import('./config.js');
}

let warned: string[];
let errored: string[];

beforeEach(() => {
  warned = [];
  errored = [];
  vi.spyOn(console, 'warn').mockImplementation((line: string) => { warned.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line: string) => { errored.push(String(line)); });
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe('chain ids default from SETTLEMENT_TIER', () => {
  it('mainnet: 0G and Base mainnet, mainnet addresses and CCTP', async () => {
    const { config } = await load({ SETTLEMENT_TIER: 'mainnet', NODE_ENV: 'development' });
    expect(config).toMatchObject({
      settlementTier: 'mainnet',
      ogChainId: 16661,
      ogRpcUrl: 'https://evmrpc.0g.ai',
      baseChainId: 8453,
      baseRpcUrl: 'https://mainnet.base.org',
      baseUsdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });
    expect(config.cctp.mainnet).toBe(true);
    expect(config.cctp.ethereumChainId).toBe(1);
  });

  it('testnet: 0G and Base testnets, testnet addresses and CCTP, even in production', async () => {
    const { config } = await load({ SETTLEMENT_TIER: 'testnet', NODE_ENV: 'production' });
    expect(config).toMatchObject({
      settlementTier: 'testnet',
      ogChainId: 16602,
      ogRpcUrl: 'https://evmrpc-testnet.0g.ai',
      baseChainId: 84532,
      baseUsdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    });
    expect(config.cctp.mainnet).toBe(false);
  });

  it('is null when unset, and each chain keeps its own default', async () => {
    const { config } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532' });
    expect(config.settlementTier).toBeNull();
    expect(config.ogChainId).toBe(16661);
  });

  it('throws on a value that is not a tier', async () => {
    await expect(load({ SETTLEMENT_TIER: 'main' })).rejects.toThrow(/SETTLEMENT_TIER="main" is not a network tier/);
  });
});

// BEHAVIOUR CHANGE: the 0G contract table follows OG_CHAIN_ID, not NODE_ENV,
// the same rule Base has followed since BASE_CHAIN_ID. The two combinations
// that run are unaffected (config.legacy.test.ts pins them); only a chain id
// from one tier with a NODE_ENV from the other moves, and it moves to the
// addresses that actually exist on the chain being talked to.
describe('a 0G chain id that disagrees with NODE_ENV', () => {
  it('production on 0G testnet gets TESTNET addresses (it got mainnet ones before)', async () => {
    const { config } = await load({ NODE_ENV: 'production', OG_CHAIN_ID: '16602' });
    expect(config.ogChainId).toBe(16602);
    expect(config.blindEscrowAddress).toBe('0x037529B296a89E6Dd1abAF84D413cb2dD70C5be5');
    expect(config.ogRpcUrl).toBe('https://evmrpc-testnet.0g.ai');
  });

  it('a script on 0G mainnet with no NODE_ENV gets MAINNET addresses (it got testnet ones before)', async () => {
    const { config } = await load({ NODE_ENV: 'development', OG_CHAIN_ID: '16661' });
    expect(config.blindEscrowAddress).toBe('0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff');
    expect(config.ogRpcUrl).toBe('https://evmrpc.0g.ai');
  });
});

describe('a chain id that contradicts the tier', () => {
  it('refuses to boot, naming every setting at fault', async () => {
    const { assertBootConfig } = await load({
      SETTLEMENT_TIER: 'mainnet', NODE_ENV: 'development', BASE_CHAIN_ID: '84532', CCTP_ETHEREUM_CHAIN_ID: '11155111',
    });
    expect(() => assertBootConfig()).toThrow(/2 fatal problem/);
    const text = errored.join('\n');
    expect(text).toMatch(/BASE_CHAIN_ID=84532 is testnet, but SETTLEMENT_TIER=mainnet expects 8453/);
    expect(text).toMatch(/CCTP_ETHEREUM_CHAIN_ID=11155111 is testnet, but SETTLEMENT_TIER=mainnet expects 1\b/);
  });

  it('boots when every explicit id is on the tier', async () => {
    const { assertBootConfig } = await load({
      SETTLEMENT_TIER: 'testnet', NODE_ENV: 'development', OG_CHAIN_ID: '16602', BASE_CHAIN_ID: '84532',
    });
    expect(() => assertBootConfig()).not.toThrow();
  });
});

describe('a stack with no tier named', () => {
  it('warns when its chains are on different tiers — production today', async () => {
    const { assertBootConfig } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532' });
    assertBootConfig();
    expect(warned.join('\n')).toMatch(
      /0G is on mainnet \(16661\) and Base is on testnet \(84532\) — this stack is half mainnet, half testnet/,
    );
  });

  it('says nothing when both chains are on the same tier', async () => {
    const { assertBootConfig } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '8453' });
    assertBootConfig();
    expect(warned.join('\n')).not.toMatch(/half mainnet/);
  });
});

describe('a production backend on the testnet tier', () => {
  it('warns that it advertises production URLs it does not own', async () => {
    const { assertBootConfig } = await load({ SETTLEMENT_TIER: 'testnet', NODE_ENV: 'production', ALLOW_NONMAINNET_PROD: 'true' });
    assertBootConfig();
    expect(warned.join('\n')).toMatch(/PUBLIC_API_URL\/PUBLIC_APP_URL are not both set/);
  });

  it('says nothing once it names its own URLs', async () => {
    const { assertBootConfig } = await load({
      SETTLEMENT_TIER: 'testnet', NODE_ENV: 'production', ALLOW_NONMAINNET_PROD: 'true',
      PUBLIC_API_URL: 'https://staging-api.blindmarket.xyz', PUBLIC_APP_URL: 'https://staging.blindmarket.xyz',
    });
    assertBootConfig();
    expect(warned.join('\n')).not.toMatch(/PUBLIC_API_URL/);
  });

  // ALLOW_NONMAINNET_PROD is unchanged by the tier: a production backend on a
  // testnet 0G chain still has to opt in explicitly.
  it('still refuses a non-mainnet production 0G chain without ALLOW_NONMAINNET_PROD', async () => {
    const { assertBootConfig } = await load({ SETTLEMENT_TIER: 'testnet', NODE_ENV: 'production' });
    expect(() => assertBootConfig()).toThrow(/fatal problem/);
    expect(errored.join('\n')).toMatch(/OG_CHAIN_ID=16602 in production/);
  });
});
