import { describe, it, expect, vi } from 'vitest';

/**
 * A contract's address comes from its deployer and nonce, so the Arc mainnet
 * factory can share the testnet factory's address. Each network must then
 * start indexing from its own record's block: the testnet block (~63.6M) is
 * past the mainnet head (~22.7M), so taking it would index nothing.
 */

const SAME = '0x1E9Abb2F2e66b8Af35BED730500A94760E133a3B';
const TESTNET_BLOCK = 63_589_837;
const MAINNET_BLOCK = 22_700_000;

vi.mock('../contractAddresses.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../contractAddresses.js')>();
  return {
    ...mod,
    CONTRACT_ADDRESSES: {
      ...mod.CONTRACT_ADDRESSES,
      arcTestnet: { ...mod.CONTRACT_ADDRESSES.arcTestnet, agentFactory: SAME },
      arc: { agentFactory: SAME, USDC: '0x3600000000000000000000000000000000000000' },
    },
    DEPLOYMENT_BLOCKS: {
      ...mod.DEPLOYMENT_BLOCKS,
      arcTestnet: { ...mod.DEPLOYMENT_BLOCKS.arcTestnet, agentFactory: TESTNET_BLOCK },
      arc: { agentFactory: MAINNET_BLOCK },
    },
  };
});
vi.mock('./chain.js', () => ({ arcProvider: {} }));
vi.mock('./redis.js', () => ({ redis: {} }));
vi.mock('./deploymentIdentity.js', () => ({ backgroundWritesAllowed: () => true }));

const { factoryDeploymentBlock } = await import('./agentFactoryListener.js');

describe('factoryDeploymentBlock with a mainnet factory at the testnet address', () => {
  it("starts each network from its own record's block", () => {
    expect(factoryDeploymentBlock(SAME, {}, 5042)).toBe(MAINNET_BLOCK);
    expect(factoryDeploymentBlock(SAME.toLowerCase(), {}, 5042002)).toBe(TESTNET_BLOCK);
  });

  it('knows no block on a network with no record, or for another factory', () => {
    expect(factoryDeploymentBlock(SAME, {}, 1234)).toBe(0);
    expect(factoryDeploymentBlock('0x1111111111111111111111111111111111111111', {}, 5042)).toBe(0);
  });
});
