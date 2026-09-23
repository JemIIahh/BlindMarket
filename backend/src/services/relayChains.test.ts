/**
 * The relay's chain names: the fixed ones keep their meaning whatever this
 * deployment settles on, and a registry chain the relay serves is added under
 * its own key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { cfg, relayOverride } = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  relayOverride: {} as Record<string, string | null>,
}));
vi.mock('../config.js', () => ({ config: cfg }));
vi.mock('./settlementChains.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./settlementChains.js')>();
  const withOverride = (entry: ReturnType<typeof mod.settlementChainConfig>) =>
    entry.key in relayOverride ? { ...entry, relayCaip2: relayOverride[entry.key] } : entry;
  return {
    ...mod,
    settlementChainConfig: (key: Parameters<typeof mod.settlementChainConfig>[0]) => withOverride(mod.settlementChainConfig(key)),
    settlementChainConfigs: () => mod.settlementChainConfigs().map(withOverride),
  };
});

const { relayChainTable, relayChainName } = await import('./relayChains.js');
const { settlementChainConfig } = await import('./settlementChains.js');

beforeEach(() => {
  for (const key of Object.keys(cfg)) delete cfg[key];
  for (const key of Object.keys(relayOverride)) delete relayOverride[key];
  Object.assign(cfg, { ogChainId: 16661, baseChainId: 84532, blindEscrowAddress: '', baseEscrowAddress: '' });
});

describe('relayChainTable', () => {
  it('is exactly the names the relay accepted before the registry', () => {
    expect([...relayChainTable()]).toEqual([
      ['base', 'eip155:8453'],
      ['base-mainnet', 'eip155:8453'],
      ['base-sepolia', 'eip155:84532'],
      ['ethereum', 'eip155:1'],
      ['ethereum-sepolia', 'eip155:11155111'],
      ['arbitrum', 'eip155:42161'],
      ['arbitrum-sepolia', 'eip155:421614'],
      ['optimism-sepolia', 'eip155:11155420'],
      ['polygon', 'eip155:137'],
      ['polygon-amoy', 'eip155:80002'],
    ]);
  });

  it("keeps 'base' on Base mainnet when this deployment runs Base Sepolia", () => {
    expect(settlementChainConfig('base').relayCaip2).toBe('eip155:84532');
    expect(relayChainTable().get('base')).toBe('eip155:8453');
  });

  it('adds a registry chain the relay serves under its own key, after the fixed names', () => {
    relayOverride['arc'] = 'eip155:16661';
    expect([...relayChainTable().keys()]).toEqual(['base', 'base-mainnet', 'base-sepolia', 'ethereum', 'ethereum-sepolia', 'arbitrum', 'arbitrum-sepolia', 'optimism-sepolia', 'polygon', 'polygon-amoy', 'arc']);
    expect(relayChainTable().get('arc')).toBe('eip155:16661');
  });

  it('has no entry for inherited object keys', () => {
    expect(relayChainTable().get('constructor')).toBeUndefined();
    expect(relayChainTable().get('__proto__')).toBeUndefined();
  });
});

describe('relayChainName', () => {
  it('names Base Sepolia and Base mainnet by their unambiguous names', () => {
    expect(relayChainName(settlementChainConfig('base'))).toBe('base-sepolia');
    cfg.baseChainId = 8453;
    expect(relayChainName(settlementChainConfig('base'))).toBe('base-mainnet');
  });

  it('is null for a chain the relay does not serve', () => {
    expect(relayChainName(settlementChainConfig('arc'))).toBeNull();
    cfg.baseChainId = 31337;
    expect(relayChainName(settlementChainConfig('base'))).toBeNull();
  });

  it("is a registry chain's own key when only that key reaches it", () => {
    relayOverride['arc'] = 'eip155:16661';
    expect(relayChainName(settlementChainConfig('arc'))).toBe('arc');
  });

  it("never names a chain by a key the fixed names point elsewhere", () => {
    // 'base' is a fixed name for eip155:8453, so a Base entry on another
    // chain id can't be reached through it.
    relayOverride.base = 'eip155:31337';
    expect(relayChainName(settlementChainConfig('base'))).toBeNull();
  });
});
