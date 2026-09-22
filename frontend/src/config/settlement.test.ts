import { afterEach, describe, expect, it } from 'vitest';
import {
  BASE_CHAIN_ID,
  BASE_ESCROW_ADDRESS,
  BASE_USDC_ADDRESS,
  MARKETPLACE_TOKEN_ADDRESS,
} from './constants';
import {
  agentFundingAddress,
  defaultSettlement,
  explorerUrlFor,
  getMarketplaceTokenAddress,
  getPaymentDecimals,
  getPaymentSymbol,
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
const ARC_USDC = '0x3600000000000000000000000000000000000000';

/** What the testnet build's /health/settlement looks like today (production posts on Base). */
const backendBasePosting: BackendSettlement = {
  postingChain: 'base',
  chains: [
    { chain: 'base', chainId: 84532, tier: 'testnet', escrowAddress: BASE_ESCROW_ADDRESS, token: { kind: 'erc20', address: BASE_USDC_ADDRESS, symbol: 'USDC', decimals: 6 }, relayChain: 'base-sepolia', gasSymbol: 'ETH', postable: true },
    { chain: 'arc', chainId: 5042002, tier: 'testnet', escrowAddress: null, token: { kind: 'erc20', address: ARC_USDC, symbol: 'USDC', decimals: 6 }, relayChain: null, gasSymbol: 'USDC', postable: false },
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
    expect(relayChainFor('arc')).toBeNull();
  });

  it('know both chains with their escrows, units and explorers', () => {
    const { chains } = defaultSettlement();
    expect(chains.arc).toMatchObject({
      key: 'arc',
      chainId: 5042002,
      tier: 'testnet',
      escrow: '',
      token: { kind: 'erc20', address: ARC_USDC, unit: { symbol: 'USDC', decimals: 6 } },
      relayChain: null,
      explorer: 'https://testnet.arcscan.app',
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

describe('agentFundingAddress', () => {
  const agent = { walletAddress: '0xE0A', smartAccountAddress: '0x5A' };

  it("funds the EOA on Arc, whose escrow records no smart account: the worker signs and pays gas there", () => {
    expect(agentFundingAddress(agent, defaultSettlement().chains.arc)).toBe('0xE0A');
  });

  it('funds the smart account on Base, and the EOA for an agent without one', () => {
    const { base } = defaultSettlement().chains;
    expect(agentFundingAddress(agent, base)).toBe('0x5A');
    expect(agentFundingAddress({ walletAddress: '0xE0A' }, base)).toBe('0xE0A');
    expect(agentFundingAddress(null, base)).toBeUndefined();
  });

  it('keeps the flag through a backend merge, which does not send it', () => {
    const merged = mergeSettlement(defaultSettlement(), { postingChain: 'arc', chains: [] });
    expect(merged.chains.arc.aa).toBe(false);
    expect(merged.chains.base.aa).toBe(true);
  });
});

describe('unitFor', () => {
  it('uses the unit the backend reported for the task first', () => {
    expect(unitFor('base', { symbol: 'USDC', decimals: 18 })).toEqual({ symbol: 'USDC', decimals: 18 });
  });

  it("falls back to the chain's settlement token, then the posting chain's", () => {
    expect(unitFor('base')).toEqual({ symbol: 'USDC', decimals: 6 });
    expect(unitFor('arc')).toEqual({ symbol: 'USDC', decimals: 6 });
    expect(unitFor('arc', { symbol: null, decimals: null })).toEqual({ symbol: 'USDC', decimals: 6 });
    expect(unitFor(undefined)).toEqual({ symbol: 'USDC', decimals: 6 });
    expect(unitFor('bogus')).toEqual({ symbol: 'USDC', decimals: 6 });
  });

  it('gives each chain its own explorer, unknown chains the posting chain’s', () => {
    expect(explorerUrlFor('arc')).toBe('https://testnet.arcscan.app');
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

  it("takes the backend's token, escrow and relay name over the build's, on the same network", () => {
    const token = '0x3333333333333333333333333333333333333333';
    const escrow = '0x4444444444444444444444444444444444444444';
    const backend: BackendSettlement = {
      postingChain: 'base',
      chains: [{ ...backendBasePosting.chains[0], escrowAddress: escrow, token: { kind: 'erc20', address: token, symbol: 'USDC', decimals: 6 }, relayChain: 'base-sepolia-2' }],
    };
    setSettlement(mergeSettlement(defaultSettlement(), backend));
    expect(getMarketplaceTokenAddress()).toBe(token);
    expect(getPostingEscrowAddress()).toBe(escrow);
    expect(relayChainFor()).toBe('base-sepolia-2');
    // The chain the backend did not mention keeps its defaults.
    expect(unitFor('arc')).toEqual({ symbol: 'USDC', decimals: 6 });
  });

  it('never follows a chain onto another network: a Base-mainnet backend on this testnet build is ignored', () => {
    const mainnetBase: BackendSettlement = {
      postingChain: 'base',
      chains: [{ ...backendBasePosting.chains[0], chainId: 8453, tier: 'mainnet', escrowAddress: '0x9999999999999999999999999999999999999999', token: { kind: 'erc20', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 }, relayChain: 'base-mainnet' }],
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
      postingChain: 'arc',
      chains: [...backendBasePosting.chains],
    };
    expect(mergeSettlement(defaultSettlement(), noEscrow).postingChain).toBe('base');
    expect(mergeSettlement(defaultSettlement(), { ...backendBasePosting, postingChain: '0g' as never }).postingChain).toBe('base');
    expect(mergeSettlement(defaultSettlement(), { ...backendBasePosting, postingChain: null }).postingChain).toBe('base');
  });

  it('never posts on a chain whose backend entry it rejected, even though the build has defaults for it', () => {
    const otherNetwork: BackendSettlement = {
      postingChain: 'base',
      chains: [{ ...backendBasePosting.chains[0], chainId: 8453, tier: 'mainnet' }],
    };
    expect(mergeSettlement(defaultSettlement(), otherNetwork).postingChain).toBe('base');
  });

  it.each([
    ['a tier that is not a tier', { tier: 'staging' }],
    ['an escrow that is not an address', { escrowAddress: '0x1234' }],
    ['a token address that is not an address', { token: { kind: 'erc20', address: 'usdc', symbol: 'USDC', decimals: 6 } }],
    ['decimals other than 6 or 18', { token: { kind: 'erc20', address: BASE_USDC_ADDRESS, symbol: 'USDC', decimals: 8 } }],
    ['a token kind it does not know', { token: { kind: 'nft', address: BASE_USDC_ADDRESS, symbol: 'USDC', decimals: 6 } }],
    ['an empty symbol', { token: { kind: 'erc20', address: BASE_USDC_ADDRESS, symbol: '', decimals: 6 } }],
    ['a relay name that is not a string', { relayChain: 5 }],
  ])('rejects a base entry with %s, leaving the defaults', (_label: string, patch: Record<string, unknown>) => {
    const backend = { postingChain: 'base', chains: [{ ...backendBasePosting.chains[0], escrowAddress: '0x4444444444444444444444444444444444444444', ...patch }] } as unknown as BackendSettlement;
    const { source: _s, ...rest } = mergeSettlement(defaultSettlement(), backend);
    const { source: _d, ...defaults } = defaultSettlement();
    expect(rest).toEqual(defaults);
  });

  it('ignores a chain this build does not know', () => {
    const withUnknown: BackendSettlement = {
      ...backendBasePosting,
      chains: [...backendBasePosting.chains, { chain: '0g', chainId: 16602, tier: 'testnet', escrowAddress: '0x5555555555555555555555555555555555555555', token: { kind: 'native', address: ZERO, symbol: '0G', decimals: 18 }, relayChain: null, gasSymbol: '0G', postable: false }],
    };
    const merged = mergeSettlement(defaultSettlement(), withUnknown);
    expect(Object.keys(merged.chains).sort()).toEqual(['arc', 'base']);
  });

  it('is what useSettlement subscribers see after setSettlement', () => {
    // useSyncExternalStore reads getSettlement; the sync readers share it.
    setSettlement({ ...defaultSettlement(), postingChain: 'base' });
    expect(getPaymentSymbol()).toBe('USDC');
    resetSettlement();
    expect(getPaymentSymbol()).toBe('USDC');
  });
});