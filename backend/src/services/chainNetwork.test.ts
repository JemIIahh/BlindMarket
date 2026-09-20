import { describe, it, expect, vi, beforeEach } from 'vitest';

const cfg = vi.hoisted(() => ({ arcChainId: 5042002, baseChainId: 84532, deploymentSet: '' }));
vi.mock('../config.js', () => ({ config: cfg }));

const { chainNetwork, contractsEnvPrefix } = await import('./chainNetwork.js');

beforeEach(() => Object.assign(cfg, { arcChainId: 5042002, baseChainId: 84532, deploymentSet: '' }));

describe('chainNetwork', () => {
  it('takes each chain tier from its own chain id', () => {
    expect(chainNetwork('arc')).toEqual({ tier: 'testnet', hardhatNetwork: 'arc-testnet' });
    expect(chainNetwork('base')).toEqual({ tier: 'testnet', hardhatNetwork: 'base-sepolia' });
  });

  it('names the mainnet networks', () => {
    Object.assign(cfg, { arcChainId: 5042, baseChainId: 8453 });
    expect(chainNetwork('arc')).toEqual({ tier: 'mainnet', hardhatNetwork: 'arc-mainnet' });
    expect(chainNetwork('base')).toEqual({ tier: 'mainnet', hardhatNetwork: 'base' });
  });

  it('throws on a chain it does not know', () => {
    expect(() => chainNetwork('0g' as never)).toThrow(/unknown settlement chain 0g/);
  });
});

describe('contractsEnvPrefix', () => {
  const ESCROW = '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf';

  it('names the escrow without DEPLOYMENT_SET for the default set', () => {
    expect(contractsEnvPrefix(ESCROW)).toBe(`EXPECTED_ESCROW=${ESCROW} `);
    expect(contractsEnvPrefix(null)).toBe('');
  });

  it('selects the set and names the escrow when DEPLOYMENT_SET is set', () => {
    cfg.deploymentSet = 'staging';
    expect(contractsEnvPrefix(ESCROW)).toBe(`DEPLOYMENT_SET=staging EXPECTED_ESCROW=${ESCROW} `);
  });

  it('leaves EXPECTED_ESCROW out when the escrow is unknown', () => {
    cfg.deploymentSet = 'staging';
    expect(contractsEnvPrefix(null)).toBe('DEPLOYMENT_SET=staging ');
    expect(contractsEnvPrefix('0x0000000000000000000000000000000000000000')).toBe('DEPLOYMENT_SET=staging ');
  });
});
