import { describe, it, expect } from 'vitest';
import { readSettlementTier, tierMismatches, chainTier, TIER_CHAIN_IDS } from './settlementTier.js';

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

describe('readSettlementTier', () => {
  it('reads a tier, ignoring case and surrounding space', () => {
    expect(readSettlementTier(env({ SETTLEMENT_TIER: 'mainnet' }))).toBe('mainnet');
    expect(readSettlementTier(env({ SETTLEMENT_TIER: ' Testnet ' }))).toBe('testnet');
  });

  it('is null when unset or empty', () => {
    expect(readSettlementTier(env({}))).toBeNull();
    expect(readSettlementTier(env({ SETTLEMENT_TIER: '   ' }))).toBeNull();
  });

  it('throws on anything else, rather than reading a typo as unset', () => {
    expect(() => readSettlementTier(env({ SETTLEMENT_TIER: 'main' }))).toThrow(/SETTLEMENT_TIER="main" is not a network tier/);
    expect(() => readSettlementTier(env({ SETTLEMENT_TIER: 'prod' }))).toThrow(/mainnet or testnet/);
  });
});

describe('chainTier', () => {
  it('names the tier of a known chain id', () => {
    expect(chainTier('0g', 16661)).toBe('mainnet');
    expect(chainTier('0g', 16602)).toBe('testnet');
    expect(chainTier('base', 8453)).toBe('mainnet');
    expect(chainTier('base', 84532)).toBe('testnet');
  });

  it('is null for a chain id it does not know', () => {
    expect(chainTier('base', 31337)).toBeNull();
  });

  it('keeps the chain ids the rest of the backend hard-coded before', () => {
    expect(TIER_CHAIN_IDS['0g']).toMatchObject({ mainnet: 16661, testnet: 16602, env: 'OG_CHAIN_ID' });
    expect(TIER_CHAIN_IDS.base).toMatchObject({ mainnet: 8453, testnet: 84532, env: 'BASE_CHAIN_ID' });
    expect(TIER_CHAIN_IDS.arc).toMatchObject({ mainnet: 5042, testnet: 5042002, env: 'ARC_CHAIN_ID' });
  });
});

describe('tierMismatches', () => {
  it('finds nothing when nothing is set — every chain takes the tier default', () => {
    expect(tierMismatches(env({}), 'mainnet')).toEqual([]);
    expect(tierMismatches(env({}), 'testnet')).toEqual([]);
  });

  it('finds nothing when the ids agree with the tier', () => {
    expect(tierMismatches(env({ OG_CHAIN_ID: '16661', BASE_CHAIN_ID: '8453', CCTP_ETHEREUM_CHAIN_ID: '1' }), 'mainnet')).toEqual([]);
  });

  it("names a chain on the other tier, and says which tier it's on", () => {
    expect(tierMismatches(env({ OG_CHAIN_ID: '16602' }), 'mainnet')).toEqual([
      'OG_CHAIN_ID=16602 is testnet, but SETTLEMENT_TIER=mainnet expects 16661',
    ]);
    expect(tierMismatches(env({ BASE_CHAIN_ID: '8453' }), 'testnet')).toEqual([
      'BASE_CHAIN_ID=8453 is mainnet, but SETTLEMENT_TIER=testnet expects 84532',
    ]);
  });

  it("checks Arc and CCTP's Arc leg too", () => {
    expect(tierMismatches(env({ ARC_CHAIN_ID: '5042002', CCTP_ARC_CHAIN_ID: '5042002' }), 'mainnet')).toEqual([
      'ARC_CHAIN_ID=5042002 is testnet, but SETTLEMENT_TIER=mainnet expects 5042',
      'CCTP_ARC_CHAIN_ID=5042002 is testnet, but SETTLEMENT_TIER=mainnet expects 5042',
    ]);
    expect(tierMismatches(env({ ARC_CHAIN_ID: '5042', CCTP_ARC_CHAIN_ID: '5042' }), 'mainnet')).toEqual([]);
  });

  it('reads ids the way config.ts does: only a plain decimal is a chain id', () => {
    // Number() accepted these while config's parseInt read 0 / 84532.
    expect(tierMismatches(env({ BASE_CHAIN_ID: '0x14a34' }), 'testnet')).toEqual([
      'BASE_CHAIN_ID=0x14a34 is not a decimal chain id, but SETTLEMENT_TIER=testnet expects 84532',
    ]);
    expect(tierMismatches(env({ BASE_CHAIN_ID: '84532.0' }), 'testnet')).toEqual([
      'BASE_CHAIN_ID=84532.0 is not a decimal chain id, but SETTLEMENT_TIER=testnet expects 84532',
    ]);
    expect(tierMismatches(env({ BASE_CHAIN_ID: ' 84532 ' }), 'testnet')).toEqual([]);
  });

  it('reports a chain id belonging to no tier', () => {
    expect(tierMismatches(env({ BASE_CHAIN_ID: '31337' }), 'testnet')).toEqual([
      'BASE_CHAIN_ID=31337 is not a chain this tier knows, but SETTLEMENT_TIER=testnet expects 84532',
    ]);
  });

  it("checks CCTP's other legs too, and reports every setting at fault", () => {
    expect(
      tierMismatches(
        env({ OG_CHAIN_ID: '16602', CCTP_ETHEREUM_CHAIN_ID: '1', CCTP_ARBITRUM_CHAIN_ID: '421614', CCTP_OPTIMISM_CHAIN_ID: '10' }),
        'testnet',
      ),
    ).toEqual([
      // OG_CHAIN_ID and CCTP_ARBITRUM_CHAIN_ID are on the named tier, so they are not reported.
      'CCTP_ETHEREUM_CHAIN_ID=1 is mainnet, but SETTLEMENT_TIER=testnet expects 11155111',
      'CCTP_OPTIMISM_CHAIN_ID=10 is mainnet, but SETTLEMENT_TIER=testnet expects 11155420',
    ]);
  });
});
