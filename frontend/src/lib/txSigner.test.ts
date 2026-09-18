import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettlement, mergeSettlement, resetSettlement, setSettlement } from '../config/settlement';
import { providerFor, baseProvider, relayChainNameFor } from './txSigner';

/**
 * The relay `chain` name this app sends. It was hard-coded from the build's
 * Base chain id; now it follows the backend's posting chain, with that same
 * hard-coded name as the fallback.
 */
afterEach(() => resetSettlement());

describe('relayChainNameFor', () => {
  it('sends the name the file always sent on the testnet build', () => {
    expect(relayChainNameFor()).toBe('base-sepolia');
    expect(relayChainNameFor('base')).toBe('base-sepolia');
    expect(relayChainNameFor(undefined)).toBe('base-sepolia');
  });

  it("falls back to the build's Base name for a chain the relay does not serve", () => {
    // 0G transactions are not relayed today; a caller that asks anyway gets
    // what it always got.
    expect(relayChainNameFor('0g')).toBe('base-sepolia');
    expect(relayChainNameFor('arc')).toBe('base-sepolia');
  });

  it("follows the backend's relay name for the posting chain", () => {
    const d = defaultSettlement();
    setSettlement(mergeSettlement(d, {
      postingChain: 'base',
      chains: [{ chain: 'base', chainId: 8453, tier: 'mainnet', escrowAddress: d.chains.base.escrow, token: { kind: 'erc20', address: d.chains.base.token.address, symbol: 'USDC', decimals: 6 }, relayChain: 'base-mainnet', gasSymbol: 'ETH', postable: true }],
    }));
    expect(relayChainNameFor()).toBe('base-mainnet');
    expect(relayChainNameFor('base')).toBe('base-mainnet');
  });
});

describe('providerFor', () => {
  it('polls Base for Base and unhinted transactions, and 0G for 0G ones', () => {
    expect(providerFor()).toBe(baseProvider);
    expect(providerFor('base')).toBe(baseProvider);
    expect(providerFor('0g')).not.toBe(baseProvider);
    expect(providerFor('0g')).toBe(providerFor('0g'));
  });
});
