import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_CHAIN_ID,
  BASE_ESCROW_ADDRESS,
  BASE_USDC_ADDRESS,
  BLIND_ESCROW_ADDRESS,
  MARKETPLACE_TOKEN_ADDRESS,
} from './constants';
import {
  defaultSettlement,
  explorerUrlFor,
  getMarketplaceTokenAddress,
  getPaymentDecimals,
  getPaymentSymbol,
  getPostingChain,
  getPostingEscrowAddress,
  isNativePayment,
  mergeSettlement,
  relayChainFor,
  resetSettlement,
  setSettlement,
  unitFor,
  type BackendSettlement,
} from './settlement';

const ZERO = '0x0000000000000000000000000000000000000000';
const OG_ESCROW = '0x037529B296a89E6Dd1abAF84D413cb2dD70C5be5';

/** What the testnet build's /health/settlement looks like today (production posts on Base too). */
const backendBasePosting: BackendSettlement = {
  postingChain: 'base',
  chains: [
    { chain: '0g', chainId: 16602, tier: 'testnet', escrowAddress: OG_ESCROW, token: { kind: 'native', address: ZERO, symbol: '0G', decimals: 18 }, relayChain: null, gasSymbol: '0G', postable: false },
    { chain: 'base', chainId: 84532, tier: 'testnet', escrowAddress: BASE_ESCROW_ADDRESS, token: { kind: 'erc20', address: BASE_USDC_ADDRESS, symbol: 'USDC', decimals: 6 }, relayChain: 'base-sepolia', gasSymbol: 'ETH', postable: true },
  ],
};

afterEach(() => resetSettlement());

describe('build-time defaults', () => {
  it('follow the rule every file used before: Base USDC when a Base escrow is configured', () => {
    // The testnet build has a Base escrow (contractAddresses.ts baseTestnet).
    expect(BASE_ESCROW_ADDRESS).not.toBe('');
    const d = defaultSettlement();
    expect(d.source).toBe('defaults');
    expect(d.postingChain).toBe('base');
    expect(getPaymentDecimals()).toBe(6);
    expect(getPaymentSymbol()).toBe('USDC');
    expect(getMarketplaceTokenAddress()).toBe(MARKETPLACE_TOKEN_ADDRESS);
    expect(getMarketplaceTokenAddress()).toBe(BASE_USDC_ADDRESS);
    expect(getPostingEscrowAddress()).toBe(BASE_ESCROW_ADDRESS);
    expect(isNativePayment()).toBe(false);
  });

  it("relay on the same name txSigner hard-coded, keyed on the Base chain id", () => {
    expect(BASE_CHAIN_ID).toBe(84532);
    expect(relayChainFor()).toBe('base-sepolia');
    expect(relayChainFor('base')).toBe('base-sepolia');
    expect(relayChainFor('0g')).toBeNull();
  });

  it('know both chains with their escrows, units and explorers', () => {
    const { chains } = defaultSettlement();
    expect(chains['0g']).toMatchObject({
      chainId: 16602,
      tier: 'testnet',
      escrow: BLIND_ESCROW_ADDRESS,
      token: { kind: 'native', address: ZERO, unit: { symbol: '0G', decimals: 18 } },
      walletChain: 'og',
      explorer: 'https://chainscan-galileo.0g.ai',
    });
    expect(chains.base).toMatchObject({
      chainId: 84532,
      tier: 'testnet',
      escrow: BASE_ESCROW_ADDRESS,
      token: { kind: 'erc20', address: BASE_USDC_ADDRESS, unit: { symbol: 'USDC', decimals: 6 } },
      walletChain: 'base',
      explorer: 'https://sepolia.basescan.org',
    });
  });
});

describe('build-time defaults with no Base escrow', () => {
  it('post on 0G in native 0G, as every file assumed before', async () => {
    // A build whose Base escrow is the zero placeholder (VITE override), as a
    // 0G-only stack is configured. Fresh module graph so constants.ts
    // re-reads the env.
    vi.stubEnv('VITE_BASE_ESCROW_ADDRESS', ZERO);
    vi.resetModules();
    try {
      const constants = await import('./constants');
      const settlement = await import('./settlement');
      expect(constants.BASE_ESCROW_ADDRESS).toBe('');
      const d = settlement.defaultSettlement();
      expect(d.postingChain).toBe('0g');
      expect(settlement.getPaymentDecimals()).toBe(18);
      expect(settlement.getPaymentSymbol()).toBe('0G');
      expect(settlement.getMarketplaceTokenAddress()).toBe(ZERO);
      expect(settlement.getPostingEscrowAddress()).toBe(constants.BLIND_ESCROW_ADDRESS);
      expect(settlement.isNativePayment()).toBe(true);
      expect(settlement.relayChainFor()).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('unitFor', () => {
  it('uses the unit the backend reported for the task first', () => {
    expect(unitFor('base', { symbol: '0G', decimals: 18 })).toEqual({ symbol: '0G', decimals: 18 });
  });

  it("falls back to the chain's settlement token, then the posting chain's", () => {
    expect(unitFor('base')).toEqual({ symbol: 'USDC', decimals: 6 });
    expect(unitFor('0g')).toEqual({ symbol: '0G', decimals: 18 });
    expect(unitFor('0g', { symbol: null, decimals: null })).toEqual({ symbol: '0G', decimals: 18 });
    expect(unitFor(undefined)).toEqual({ symbol: 'USDC', decimals: 6 });
    expect(unitFor('arc')).toEqual({ symbol: 'USDC', decimals: 6 });
  });

  it('gives each chain its own explorer, unknown chains the posting chain’s', () => {
    expect(explorerUrlFor('0g')).toBe('https://chainscan-galileo.0g.ai');
    expect(explorerUrlFor('base')).toBe('https://sepolia.basescan.org');
    expect(explorerUrlFor(undefined)).toBe('https://sepolia.basescan.org');
  });
});

describe('mergeSettlement', () => {
  it("leaves today's stack exactly as the defaults had it", () => {
    const merged = mergeSettlement(defaultSettlement(), backendBasePosting);
    const { source: _s, ...rest } = merged;
    const { source: _d, ...defaults } = defaultSettlement();
    expect(merged.source).toBe('backend');
    expect(rest).toEqual(defaults);
  });

  it('switches every reader when the backend posts on 0G', () => {
    setSettlement(mergeSettlement(defaultSettlement(), { ...backendBasePosting, postingChain: '0g' }));
    expect(getPostingChain().key).toBe('0g');
    expect(getPaymentDecimals()).toBe(18);
    expect(getPaymentSymbol()).toBe('0G');
    expect(getMarketplaceTokenAddress()).toBe(ZERO);
    expect(getPostingEscrowAddress()).toBe(OG_ESCROW);
    expect(isNativePayment()).toBe(true);
    expect(relayChainFor()).toBeNull();
    // Per-task units still follow the task's chain.
    expect(unitFor('base')).toEqual({ symbol: 'USDC', decimals: 6 });
  });

  it("takes the backend's token, escrow and relay name over the build's, on the same network", () => {
    const token = '0x3333333333333333333333333333333333333333';
    const escrow = '0x4444444444444444444444444444444444444444';
    const backend: BackendSettlement = {
      postingChain: 'base',
      chains: [{ ...backendBasePosting.chains[1], escrowAddress: escrow, token: { kind: 'erc20', address: token, symbol: 'USDC', decimals: 6 }, relayChain: 'base-sepolia-2' }],
    };
    setSettlement(mergeSettlement(defaultSettlement(), backend));
    expect(getMarketplaceTokenAddress()).toBe(token);
    expect(getPostingEscrowAddress()).toBe(escrow);
    expect(relayChainFor()).toBe('base-sepolia-2');
    // The chain the backend did not mention keeps its defaults.
    expect(unitFor('0g')).toEqual({ symbol: '0G', decimals: 18 });
  });

  it('never follows a chain onto another network: a Base-mainnet backend on this testnet build is ignored', () => {
    const mainnetBase: BackendSettlement = {
      postingChain: 'base',
      chains: [{ ...backendBasePosting.chains[1], chainId: 8453, tier: 'mainnet', escrowAddress: '0x9999999999999999999999999999999999999999', token: { kind: 'erc20', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 }, relayChain: 'base-mainnet' }],
    };
    const merged = mergeSettlement(defaultSettlement(), mainnetBase);
    const { source: _s, ...rest } = merged;
    const { source: _d, ...defaults } = defaultSettlement();
    expect(rest).toEqual(defaults);
    setSettlement(merged);
    expect(getMarketplaceTokenAddress()).toBe(BASE_USDC_ADDRESS);
    expect(relayChainFor()).toBe('base-sepolia');
  });

  it('ignores malformed entries instead of throwing (a throw above the ErrorBoundary blanked the app)', () => {
    const bad = {
      postingChain: 'base',
      chains: [
        { ...backendBasePosting.chains[0], token: null },
        { ...backendBasePosting.chains[1], token: { ...backendBasePosting.chains[1].token, decimals: 'six' } },
        null,
        'base',
      ],
    } as unknown as BackendSettlement;
    expect(() => mergeSettlement(defaultSettlement(), bad)).not.toThrow();
    const { source: _s, ...rest } = mergeSettlement(defaultSettlement(), bad);
    const { source: _d, ...defaults } = defaultSettlement();
    expect(rest).toEqual(defaults);
    expect(() => mergeSettlement(defaultSettlement(), {} as BackendSettlement)).not.toThrow();
    expect(() => mergeSettlement(defaultSettlement(), null as unknown as BackendSettlement)).not.toThrow();
  });

  it('keeps the default posting chain when the backend names one this build cannot pay on', () => {
    const noEscrow: BackendSettlement = {
      postingChain: '0g',
      chains: [{ ...backendBasePosting.chains[0], escrowAddress: null }, backendBasePosting.chains[1]],
    };
    expect(mergeSettlement(defaultSettlement(), noEscrow).postingChain).toBe('base');
    const noToken: BackendSettlement = {
      postingChain: '0g',
      chains: [{ ...backendBasePosting.chains[0], token: { kind: 'native', address: null, symbol: '0G', decimals: 18 } }, backendBasePosting.chains[1]],
    };
    expect(mergeSettlement(defaultSettlement(), noToken).postingChain).toBe('base');
    expect(mergeSettlement(defaultSettlement(), { ...backendBasePosting, postingChain: 'arc' }).postingChain).toBe('base');
    expect(mergeSettlement(defaultSettlement(), { ...backendBasePosting, postingChain: null }).postingChain).toBe('base');
  });

  it('never posts on a chain whose backend entry it rejected, even though the build has defaults for it', () => {
    // A 0G-mainnet backend (16661) on this testnet build (16602), posting on 0G.
    const otherNetwork: BackendSettlement = {
      postingChain: '0g',
      chains: [{ ...backendBasePosting.chains[0], chainId: 16661, tier: 'mainnet' }, backendBasePosting.chains[1]],
    };
    expect(mergeSettlement(defaultSettlement(), otherNetwork).postingChain).toBe('base');
    const malformed = { postingChain: '0g', chains: [{ ...backendBasePosting.chains[0], token: null }, backendBasePosting.chains[1]] } as unknown as BackendSettlement;
    expect(mergeSettlement(defaultSettlement(), malformed).postingChain).toBe('base');
  });

  it.each([
    ['a tier that is not a tier', { tier: 'staging' }],
    ['an escrow that is not an address', { escrowAddress: '0x1234' }],
    ['a token address that is not an address', { token: { kind: 'erc20', address: 'usdc', symbol: 'USDC', decimals: 6 } }],
    ['decimals other than 6 or 18', { token: { kind: 'erc20', address: BASE_USDC_ADDRESS, symbol: 'USDC', decimals: 8 } }],
    ['a token kind it does not know', { token: { kind: 'nft', address: BASE_USDC_ADDRESS, symbol: 'USDC', decimals: 6 } }],
    ['an empty symbol', { token: { kind: 'erc20', address: BASE_USDC_ADDRESS, symbol: '', decimals: 6 } }],
    ['a relay name that is not a string', { relayChain: 5 }],
  ])('rejects a base entry with %s, leaving the defaults', (_label, patch) => {
    const backend = { postingChain: 'base', chains: [{ ...backendBasePosting.chains[1], escrowAddress: '0x4444444444444444444444444444444444444444', ...patch }] } as unknown as BackendSettlement;
    const { source: _s, ...rest } = mergeSettlement(defaultSettlement(), backend);
    const { source: _d, ...defaults } = defaultSettlement();
    expect(rest).toEqual(defaults);
  });

  it('ignores a chain this build does not know', () => {
    const withArc: BackendSettlement = {
      ...backendBasePosting,
      chains: [...backendBasePosting.chains, { chain: 'arc', chainId: 5042002, tier: 'testnet', escrowAddress: '0x5555555555555555555555555555555555555555', token: { kind: 'erc20', address: '0x3600000000000000000000000000000000000000', symbol: 'USDC', decimals: 6 }, relayChain: null, gasSymbol: 'USDC', postable: false }],
    };
    const merged = mergeSettlement(defaultSettlement(), withArc);
    expect(Object.keys(merged.chains).sort()).toEqual(['0g', 'base']);
  });

  it('is what useSettlement subscribers see after setSettlement', () => {
    // useSyncExternalStore reads getSettlement; the sync readers share it.
    setSettlement({ ...defaultSettlement(), postingChain: '0g' });
    expect(getPaymentSymbol()).toBe('0G');
    resetSettlement();
    expect(getPaymentSymbol()).toBe('USDC');
  });
});
