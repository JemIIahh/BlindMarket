import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettlement, mergeSettlement, resetSettlement, setSettlement } from '../config/settlement';
import { providerFor, baseProvider, relayChainNameFor, signAndSendTx } from './txSigner';

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
  it('polls the chain the relay name points at, which is Base while only Base has a relay', () => {
    expect(providerFor()).toBe(baseProvider);
    expect(providerFor('base')).toBe(baseProvider);
    // 0G has no relay, so a "0G" hint still relays (and polls) on Base.
    expect(providerFor('0g')).toBe(baseProvider);
  });

  it('never disagrees with the relay name on a backend that posts on 0G', () => {
    setSettlement({ ...defaultSettlement(), postingChain: '0g' });
    expect(relayChainNameFor()).toBe('base-sepolia');
    expect(providerFor()).toBe(baseProvider);
    expect(relayChainNameFor('0g')).toBe('base-sepolia');
    expect(providerFor('0g')).toBe(baseProvider);
  });

  it('would poll 0G once the backend names a relay for it', () => {
    const d = defaultSettlement();
    setSettlement({ ...d, postingChain: '0g', chains: { ...d.chains, '0g': { ...d.chains['0g'], relayChain: '0g' } } });
    expect(relayChainNameFor()).toBe('0g');
    expect(providerFor()).not.toBe(baseProvider);
    expect(providerFor()).toBe(providerFor('0g'));
  });
});

describe('signAndSendTx wiring', () => {
  it("sends the hinted chain's relay name in the relay body", async () => {
    const bodies: any[] = [];
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: false, status: 500, json: async () => ({ success: false, error: { code: 'STOP', message: 'stop here' } }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const signer = { getAddress: async () => '0x1111111111111111111111111111111111111111' } as any;
      const tx = { to: '0x2222222222222222222222222222222222222222', data: '0x', from: '0x1111111111111111111111111111111111111111' };
      const d = defaultSettlement();
      setSettlement(mergeSettlement(d, {
        postingChain: 'base',
        chains: [{ chain: 'base', chainId: 8453, tier: 'mainnet', escrowAddress: d.chains.base.escrow, token: { kind: 'erc20', address: d.chains.base.token.address, symbol: 'USDC', decimals: 6 }, relayChain: 'base-mainnet', gasSymbol: 'ETH', postable: true }],
      }));
      await expect(signAndSendTx(signer, tx, undefined, { chain: 'base' })).rejects.toThrow('stop here');
      await expect(signAndSendTx(signer, tx)).rejects.toThrow('stop here');
      await expect(signAndSendTx(signer, tx, undefined, { chain: '0g' })).rejects.toThrow('stop here');
      expect(bodies.map((b) => b.chain)).toEqual(['base-mainnet', 'base-mainnet', 'base-mainnet']);
      resetSettlement();
      await expect(signAndSendTx(signer, tx)).rejects.toThrow('stop here');
      expect(bodies[3].chain).toBe('base-sepolia');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
