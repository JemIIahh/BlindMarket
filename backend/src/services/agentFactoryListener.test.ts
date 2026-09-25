import { afterEach, describe, it, expect, vi } from 'vitest';

/**
 * Where the AgentFactory indexer starts on Arc. It used to fall back to
 * AGENT_FACTORY_DEPLOYMENT_BLOCK, a Base block number, which on Arc points
 * about half the chain back: a day of catch-up before any credit.
 */

vi.mock('./chain.js', () => ({ arcProvider: {} }));
vi.mock('./redis.js', () => ({ redis: {} }));
vi.mock('./deploymentIdentity.js', () => ({ backgroundWritesAllowed: () => true }));

// The Arc network the backend runs on, switchable per test.
const net = vi.hoisted(() => ({ arc: 5042002 }));
vi.mock('./settlementChains.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./settlementChains.js')>();
  return {
    ...mod,
    settlementChainConfig: (key: 'arc' | 'base') =>
      key === 'arc' ? { ...mod.settlementChainConfig(key), chainId: net.arc } : mod.settlementChainConfig(key),
  };
});

const { factoryCheckpointKey, factoryDeploymentBlock } = await import('./agentFactoryListener.js');
const { CONTRACT_ADDRESSES, DEPLOYMENT_BLOCKS } = await import('../contractAddresses.js');

const GENERATED = (CONTRACT_ADDRESSES as { arcTestnet: { agentFactory: string } }).arcTestnet.agentFactory;
const OTHER = '0x1111111111111111111111111111111111111111';

describe('factoryDeploymentBlock', () => {
  it("uses the generated record's block for the generated factory, whatever the letter case", () => {
    expect(factoryDeploymentBlock(GENERATED.toLowerCase(), {})).toBe(DEPLOYMENT_BLOCKS.arcTestnet.agentFactory);
  });

  it('lets ARC_AGENT_FACTORY_DEPLOYMENT_BLOCK win', () => {
    expect(factoryDeploymentBlock(GENERATED, { ARC_AGENT_FACTORY_DEPLOYMENT_BLOCK: '123' })).toBe(123);
    expect(factoryDeploymentBlock(OTHER, { ARC_AGENT_FACTORY_DEPLOYMENT_BLOCK: '123' })).toBe(123);
  });

  it("does not guess for a factory that isn't the generated one", () => {
    expect(factoryDeploymentBlock(OTHER, {})).toBe(0);
  });

  it("ignores the Base factory's block number", () => {
    expect(factoryDeploymentBlock(OTHER, { AGENT_FACTORY_DEPLOYMENT_BLOCK: '31000000' })).toBe(0);
    expect(factoryDeploymentBlock(GENERATED, { AGENT_FACTORY_DEPLOYMENT_BLOCK: '31000000' })).toBe(DEPLOYMENT_BLOCKS.arcTestnet.agentFactory);
  });
});

describe('factoryCheckpointKey', () => {
  afterEach(() => { net.arc = 5042002; });

  it('keeps the key it has always had on Arc testnet', () => {
    expect(factoryCheckpointKey(OTHER.toUpperCase().replace('0X', '0x'))).toBe(`agentfactory:events:checkpoint:${OTHER}`);
  });

  it('moves to its own key on another network, even for a factory at the same address', () => {
    net.arc = 5042;
    expect(factoryCheckpointKey(GENERATED)).toBe(`agentfactory@5042:events:checkpoint:${GENERATED.toLowerCase()}`);
  });
});
