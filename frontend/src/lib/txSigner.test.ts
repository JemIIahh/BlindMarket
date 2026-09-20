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

  it('refuses a chain the relay does not serve, rather than relaying it onto Base', () => {
    // A task's cancel on an unrelayed chain used to go to Base with that
    // chain's escrow as `to`: a no-op there, gas paid by the platform, task
    // left funded. Arc has no relay yet.
    expect(() => relayChainNameFor('arc')).toThrow(/not relayed here/);
    expect(() => relayChainNameFor('0g')).toThrow(/not relayed here/);
  });

  it("follows the backend's relay name for the posting chain (same network)", () => {
    const d = defaultSettlement();
    setSettlement(mergeSettlement(d, {
      postingChain: 'base',
      chains: [{ chain: 'base', chainId: d.chains.base.chainId, tier: 'testnet', escrowAddress: d.chains.base.escrow, token: { kind: 'erc20', address: d.chains.base.token.address, symbol: 'USDC', decimals: 6 }, relayChain: 'base-sepolia-2', gasSymbol: 'ETH', postable: true }],
    }));
    expect(relayChainNameFor()).toBe('base-sepolia-2');
    expect(relayChainNameFor('base')).toBe('base-sepolia-2');
  });

  it("does not follow a backend on another network (a Base-mainnet backend on this testnet build)", () => {
    const d = defaultSettlement();
    setSettlement(mergeSettlement(d, {
      postingChain: 'base',
      chains: [{ chain: 'base', chainId: 8453, tier: 'mainnet', escrowAddress: d.chains.base.escrow, token: { kind: 'erc20', address: d.chains.base.token.address, symbol: 'USDC', decimals: 6 }, relayChain: 'base-mainnet', gasSymbol: 'ETH', postable: true }],
    }));
    expect(relayChainNameFor()).toBe('base-sepolia');
  });
});

describe('providerFor', () => {
  it('polls the chain the relay name points at, which is Base while only Base has a relay', () => {
    expect(providerFor()).toBe(baseProvider);
    expect(providerFor('base')).toBe(baseProvider);
  });

  it('unhinted callers still go to Base', () => {
    expect(providerFor()).toBe(baseProvider);
    expect(relayChainNameFor()).toBe('base-sepolia');
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
        chains: [{ chain: 'base', chainId: d.chains.base.chainId, tier: 'testnet', escrowAddress: d.chains.base.escrow, token: { kind: 'erc20', address: d.chains.base.token.address, symbol: 'USDC', decimals: 6 }, relayChain: 'base-sepolia-2', gasSymbol: 'ETH', postable: true }],
      }));
      await expect(signAndSendTx(signer, tx, undefined, { chain: 'base' })).rejects.toThrow('stop here');
      await expect(signAndSendTx(signer, tx)).rejects.toThrow('stop here');
      await expect(signAndSendTx(signer, tx, undefined, { chain: 'arc' })).rejects.toThrow(/not relayed here/);
      expect(bodies.map((b) => b.chain)).toEqual(['base-sepolia-2', 'base-sepolia-2']);
      resetSettlement();
      await expect(signAndSendTx(signer, tx)).rejects.toThrow('stop here');
      expect(bodies[2].chain).toBe('base-sepolia');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
