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
  CCTP_POLYGON_CHAIN_ID: '', ARC_CHAIN_ID: '', ARC_RPC_URL: '', ARC_ESCROW_ADDRESS: '', ARC_AGENT_FACTORY_ADDRESS: '',
  CCTP_ENABLED: '', CCTP_ARC_CHAIN_ID: '', CCTP_ARC_RPC_URL: '', CCTP_BASE_RPC_URL: '', CCTP_BASE_USDC_ADDRESS: '',
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
      ogRpcUrl: 'https://0g-rpc.publicnode.com',
      baseChainId: 8453,
      baseRpcUrl: 'https://base-rpc.publicnode.com',
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

  it('is mainnet under NODE_ENV=production; each chain keeps its own default when tier is set explicitly', async () => {
    // NODE_ENV=production is the single switch: it derives tier=mainnet, so
    // every chain picks the mainnet chain id by default.
    const { config } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532' });
    expect(config.settlementTier).toBe('mainnet');
    expect(config.ogChainId).toBe(16661);
    // Explicit SETTLEMENT_TIER still wins over the NODE_ENV default.
    const explicit = await load({ NODE_ENV: 'production', SETTLEMENT_TIER: 'testnet' });
    expect(explicit.config.settlementTier).toBe('testnet');
  });

  it('throws on a value that is not a tier', async () => {
    await expect(load({ SETTLEMENT_TIER: 'main' })).rejects.toThrow(/SETTLEMENT_TIER="main" is not a network tier/);
  });
});

describe('Arc follows ARC_CHAIN_ID, and CCTP follows Arc', () => {
  const TESTNET_FACTORY = '0x1E9Abb2F2e66b8Af35BED730500A94760E133a3B';

  it('the mainnet tier puts Arc on mainnet, read through its public RPC by default, and CCTP mints there', async () => {
    const { config, ARC_MAINNET_PUBLIC_RPC_URL, arcGeneratedRecord } = await load({ SETTLEMENT_TIER: 'mainnet', NODE_ENV: 'development' });
    expect(config).toMatchObject({ arcChainId: 5042, arcRpcUrl: ARC_MAINNET_PUBLIC_RPC_URL });
    expect(config.cctp).toMatchObject({ mainnet: true, arcChainId: 5042, arcRpcUrl: ARC_MAINNET_PUBLIC_RPC_URL });
    // The mainnet record's factory, or none: never the testnet one, which
    // would be polled for credits on mainnet.
    expect(config.arcAgentFactoryAddress).toBe(arcGeneratedRecord(5042)?.addresses.agentFactory ?? '');
    expect(config.arcAgentFactoryAddress).not.toBe(TESTNET_FACTORY);
  });

  it('NODE_ENV=production moves Arc to mainnet by default; ARC_CHAIN_ID keeps testnet when set', async () => {
    // NODE_ENV=production now derives tier=mainnet, so Arc follows to mainnet.
    const { config } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532' });
    expect(config).toMatchObject({ arcChainId: 5042, arcRpcUrl: 'https://arc-rpc.publicnode.com' });
    expect(config.cctp).toMatchObject({ mainnet: true, arcChainId: 5042 });
    // Explicit ARC_CHAIN_ID still wins for the mixed-shape legacy stacks.
    const testnet = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532', ARC_CHAIN_ID: '5042002' });
    expect(testnet.config.arcChainId).toBe(5042002);
  });

  it('ARC_CHAIN_ID=5042 alone moves Arc and CCTP to mainnet; the Base escrow can stay on Sepolia', async () => {
    const { config, arcGeneratedRecord } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532', ARC_CHAIN_ID: '5042' });
    expect(config).toMatchObject({ arcChainId: 5042, baseChainId: 84532, baseRpcUrl: 'https://base-sepolia-rpc.publicnode.com' });
    expect(config.cctp).toMatchObject({
      mainnet: true,
      arcChainId: 5042,
      // CCTP's Base leg is Base mainnet, apart from the Sepolia escrow's RPC.
      baseRpcUrl: 'https://base-rpc.publicnode.com',
      baseUsdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });
    expect(config.arcAgentFactoryAddress).toBe(arcGeneratedRecord(5042)?.addresses.agentFactory ?? '');
  });

  it('the Arc escrow and its deploy block follow ARC_CHAIN_ID; address env is ignored', async () => {
    const { arcGeneratedRecord } = await load({ NODE_ENV: 'production' });
    const mainnet = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532', ARC_CHAIN_ID: '5042' });
    const record = arcGeneratedRecord(5042);
    expect(mainnet.config.arcEscrowAddress).toBe(record?.addresses.blindEscrow ?? '');
    expect(mainnet.config.arcEscrowDeploymentBlock).toBe(record?.blocks.blindEscrow ?? 0);
    const testnet = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532', ARC_CHAIN_ID: '5042002' });
    const testnetRecord = arcGeneratedRecord(5042002);
    expect(testnet.config.arcEscrowAddress).toBe(testnetRecord?.addresses.blindEscrow ?? '');
    expect(testnet.config.arcEscrowDeploymentBlock).toBe(testnetRecord?.blocks.blindEscrow ?? 0);
    // An address env var no longer defines anything on the default set: it is
    // ignored (with a warning) in favour of the record. Only a staging stack
    // reads addresses from env.
    const ignored = await load({
      NODE_ENV: 'production', BASE_CHAIN_ID: '84532', ARC_CHAIN_ID: '5042',
      ARC_ESCROW_ADDRESS: '0x1111111111111111111111111111111111111111',
    });
    expect(ignored.config.arcEscrowAddress).toBe(record?.addresses.blindEscrow ?? '');
    expect(ignored.config.arcEscrowDeploymentBlock).toBe(record?.blocks.blindEscrow ?? 0);
    expect(warned.join('\n')).toMatch(/ARC_ESCROW_ADDRESS is set but ignored/);
    // The deploy-block env still tunes rescans: it wins over the record.
    const tuned = await load({
      NODE_ENV: 'production', BASE_CHAIN_ID: '84532', ARC_CHAIN_ID: '5042',
      ARC_ESCROW_DEPLOYMENT_BLOCK: '12345',
    });
    expect(tuned.config.arcEscrowDeploymentBlock).toBe(12345);
  });

  // The one default that moves for production: CCTP's Arc leg reads through
  // ARC_RPC_URL (the same network) unless CCTP_ARC_RPC_URL names another.
  it("reads CCTP's Arc leg through ARC_RPC_URL unless CCTP_ARC_RPC_URL is set", async () => {
    const env = { NODE_ENV: 'production', BASE_CHAIN_ID: '84532', ARC_RPC_URL: 'https://arc-testnet.example/key' };
    expect((await load(env)).config.cctp.arcRpcUrl).toBe('https://arc-testnet.example/key');
    expect((await load({ ...env, CCTP_ARC_RPC_URL: 'https://cctp-arc.example' })).config.cctp.arcRpcUrl).toBe('https://cctp-arc.example');
  });

  it('refuses a CCTP chain id that is not a number while bridging is on', async () => {
    const { assertBootConfig } = await load({ NODE_ENV: 'development', CCTP_ENABLED: 'true', CCTP_POLYGON_CHAIN_ID: 'polygon' });
    expect(() => assertBootConfig()).toThrow(/1 fatal problem/);
    expect(errored.join('\n')).toMatch(/CCTP_POLYGON_CHAIN_ID=polygon is not a chain id\./);
  });

  it('refuses ARC_CHAIN_ID off the tier', async () => {
    const { assertBootConfig } = await load({ SETTLEMENT_TIER: 'testnet', NODE_ENV: 'development', ARC_CHAIN_ID: '5042' });
    expect(() => assertBootConfig()).toThrow(/1 fatal problem/);
    expect(errored.join('\n')).toMatch(/ARC_CHAIN_ID=5042 is mainnet, but SETTLEMENT_TIER=testnet expects 5042002/);
  });

  it('refuses a CCTP Arc leg on another network than the escrow', async () => {
    const { assertBootConfig } = await load({ NODE_ENV: 'development', CCTP_ENABLED: 'true', ARC_CHAIN_ID: '5042', CCTP_ARC_CHAIN_ID: '5042002' });
    expect(() => assertBootConfig()).toThrow(/1 fatal problem/);
    expect(errored.join('\n')).toMatch(
      /CCTP's Arc leg is chain 5042002 \(CCTP_ARC_CHAIN_ID\) and tasks settle on Arc chain 5042 \(ARC_CHAIN_ID\); both must be Arc mainnet \(5042\)/,
    );
    // Bridging off, the CCTP settings are unused.
    const off = await load({ NODE_ENV: 'development', ARC_CHAIN_ID: '5042', CCTP_ARC_CHAIN_ID: '5042002' });
    expect(() => off.assertBootConfig()).not.toThrow();
    // Left to its default, the leg follows ARC_CHAIN_ID.
    const followed = await load({ NODE_ENV: 'development', CCTP_ENABLED: 'true', ARC_CHAIN_ID: '5042' });
    expect(() => followed.assertBootConfig()).not.toThrow();
  });

  it('warns when production reads Arc mainnet through the public RPC', async () => {
    // NODE_ENV=production auto-derives tier=mainnet, so the whole stack is
    // mainnet. A keyed URL silences the public-RPC warning.
    const env = { NODE_ENV: 'production', ARC_CHAIN_ID: '5042', ARC_ESCROW_ADDRESS: '0x1111111111111111111111111111111111111111' };
    (await load(env)).assertBootConfig();
    expect(warned.join('\n')).toMatch(/Arc mainnet is read through the public RPC https:\/\/arc-rpc\.publicnode\.com, the default/);
    warned.length = 0;
    (await load({ ...env, ARC_RPC_URL: 'https://arc-mainnet.example/key' })).assertBootConfig();
    expect(warned.join('\n')).not.toMatch(/public RPC/);
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
    expect(config.ogRpcUrl).toBe('https://0g-rpc.publicnode.com');
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
  // NODE_ENV=production auto-derives tier=mainnet, so every chain follows it.
  // An explicit chain id that contradicts the tier is refused at boot.
  it('refuses a chain id that contradicts the NODE_ENV-derived tier', async () => {
    const { assertBootConfig } = await load({ NODE_ENV: 'production', BASE_CHAIN_ID: '84532' });
    expect(() => assertBootConfig()).toThrow(/1 fatal problem/);
    expect(errored.join('\n')).toMatch(/BASE_CHAIN_ID=84532 is testnet, but SETTLEMENT_TIER=mainnet expects 8453/);
  });

  it('says nothing when both chains are on the same tier', async () => {
    const { assertBootConfig } = await load({ NODE_ENV: 'production' });
    assertBootConfig();
    expect(warned.join('\n')).not.toMatch(/half mainnet/);
  });
});

describe('a production backend on the testnet tier', () => {
  it('warns that it advertises production URLs it does not own', async () => {
    const { assertBootConfig } = await load({ SETTLEMENT_TIER: 'testnet', NODE_ENV: 'production', ALLOW_NONMAINNET_PROD: 'true' });
    assertBootConfig();
    const text = warned.join('\n');
    expect(text).toMatch(/PUBLIC_API_URL and PUBLIC_APP_URL are unset/);
    // Both fall back, so both addresses are named.
    expect(text).toMatch(/production's own addresses \(https:\/\/api\.blindmarket\.xyz, https:\/\/blindmarket\.xyz\)/);
  });

  it('names only the URL that is missing', async () => {
    const { assertBootConfig } = await load({
      SETTLEMENT_TIER: 'testnet', NODE_ENV: 'production', ALLOW_NONMAINNET_PROD: 'true',
      PUBLIC_API_URL: 'https://staging-api.blindmarket.xyz',
    });
    assertBootConfig();
    const text = warned.join('\n');
    expect(text).toMatch(/PUBLIC_APP_URL is unset/);
    expect(text).not.toMatch(/PUBLIC_API_URL is unset|PUBLIC_API_URL and/);
    // The address named is the one actually falling back.
    expect(text).toMatch(/\(https:\/\/blindmarket\.xyz\)/);
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

