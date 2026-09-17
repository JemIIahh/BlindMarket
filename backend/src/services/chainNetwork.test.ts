import { describe, it, expect, vi, beforeEach } from 'vitest';

const cfg = vi.hoisted(() => ({ ogChainId: 16661, baseChainId: 84532 }));
vi.mock('../config.js', () => ({ config: cfg }));

const { chainNetwork } = await import('./chainNetwork.js');

beforeEach(() => Object.assign(cfg, { ogChainId: 16661, baseChainId: 84532 }));

describe('chainNetwork', () => {
  it("takes each chain's tier from its own chain id (production: 0G mainnet with Base Sepolia)", () => {
    expect(chainNetwork('0g')).toEqual({ tier: 'mainnet', hardhatNetwork: '0g-mainnet' });
    expect(chainNetwork('base')).toEqual({ tier: 'testnet', hardhatNetwork: 'base-sepolia' });
  });

  it('names the other networks', () => {
    Object.assign(cfg, { ogChainId: 16602, baseChainId: 8453 });
    expect(chainNetwork('0g')).toEqual({ tier: 'testnet', hardhatNetwork: '0g-testnet' });
    expect(chainNetwork('base')).toEqual({ tier: 'mainnet', hardhatNetwork: 'base' });
  });

  it('throws on a chain it does not know', () => {
    expect(() => chainNetwork('arc' as never)).toThrow(/unknown settlement chain arc/);
  });
});
