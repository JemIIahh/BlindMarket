import { afterEach, describe, expect, it } from 'vitest';
import {
  ARC_ESCROW_ADDRESS,
  BASE_CHAIN_ID,
  BASE_ESCROW_ADDRESS,
  BASE_USDC_ADDRESS,
} from './constants';
import {
  agentFundingAddress,
  defaultSettlement,
  explorerUrlFor,
  gasIsSettlementToken,
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

/** A backend that posts on Base, as production did before #73. Its Base entry
 *  is the one the entry-validation tests below patch. */
const backendBasePosting: BackendSettlement = {
  postingChain: 'base',
  chains: [
    { chain: 'base', chainId: 84532, tier: 'testnet', escrowAddress: BASE_ESCROW_ADDRESS, token: { kind: 'erc20', address: BASE_USDC_ADDRESS, symbol: 'USDC', decimals: 6 }, relayChain: 'base-sepolia', gasSymbol: 'ETH', postable: true },
    { chain: 'arc', chainId: 5042002, tier: 'testnet', escrowAddress: null, token: { kind: 'erc20', address: ARC_USDC, symbol: 'USDC', decimals: 6 }, relayChain: null, gasSymbol: 'USDC', postable: false },
  ],
};

/** What production's /health/settlement answers today: new tasks post on Arc. */
const backendArcPosting: BackendSettlement = {
  postingChain: 'arc',
  chains: [
    { ...backendBasePosting.chains[0], postable: false },
    { ...backendBasePosting.chains[1], escrowAddress: ARC_ESCROW_ADDRESS, postable: true },
  ],
};

afterEach(() => resetSettlement());

describe('build-time defaults', () => {
  it('post on Arc, whose escrow the build names from contracts/deployments/arc-testnet.json', () => {
    // Before arc-testnet.json was a default record the build had no Arc
    // escrow, and these defaults (what the app uses when /health/settlement
    // does not answer) posted in Base USDC to a backend that escrows on Arc.
    expect(ARC_ESCROW_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const d = defaultSettlement();
    expect(d.source).toBe('defaults');
    expect(d.postingChain).toBe('arc');
    expect(getPaymentDecimals()).toBe(6);
    expect(getPaymentSymbol()).toBe('USDC');
    expect(getMarketplaceTokenAddress()).toBe(ARC_USDC);
    expect(getPostingEscrowAddress()).toBe(ARC_ESCROW_ADDRESS);
    expect(isNativePayment()).toBe(false);
  });

  it('relay only Base, on the name keyed on its chain id; Arc is signed by the wallet', () => {
    expect(BASE_CHAIN_ID).toBe(84532);
    expect(relayChainFor()).toBeNull();
    expect(relayChainFor('base')).toBe('base-sepolia');
    expect(relayChainFor('arc')).toBeNull();
  });

  it('know both chains with their escrows, units and explorers', () => {
    const { chains } = defaultSettlement();
    expect(chains.arc).toMatchObject({
      key: 'arc',
      chainId: 5042002,
      tier: 'testnet',
      escrow: ARC_ESCROW_ADDRESS,
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
    expect(explorerUrlFor(undefined)).toBe('https://testnet.arcscan.app');
  });
});

describe('mergeSettlement', () => {
  it("leaves today's stack exactly as the defaults had it", () => {
    const merged = mergeSettlement(defaultSettlement(), backendArcPosting);
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
    // The mainnet escrow, token and relay name were not adopted.
    expect(getMarketplaceTokenAddress()).toBe(ARC_USDC);
    expect(relayChainFor('base')).toBe('base-sepolia');
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

  it('never posts on a chain the backend reports without an escrow, even the build default', () => {
    // backendBasePosting reports Arc with no escrow: neither naming Arc nor
    // falling back to the build's Arc default may post there.
    const noEscrow: BackendSettlement = {
      postingChain: 'arc',
      chains: [...backendBasePosting.chains],
    };
    expect(mergeSettlement(defaultSettlement(), noEscrow).postingChain).toBe('base');
    expect(mergeSettlement(defaultSettlement(), { ...backendBasePosting, postingChain: '0g' as never }).postingChain).toBe('base');
    expect(mergeSettlement(defaultSettlement(), { ...backendBasePosting, postingChain: null }).postingChain).toBe('base');
  });

  it('keeps the build default when the backend names no chain it can post on and says nothing against the default', () => {
    expect(mergeSettlement(defaultSettlement(), { postingChain: null, chains: [] }).postingChain).toBe('arc');
    expect(mergeSettlement(defaultSettlement(), { postingChain: '0g' as never, chains: [] }).postingChain).toBe('arc');
  });

  it('never posts on a chain whose backend entry it rejected, even though the build has defaults for it', () => {
    const otherNetwork: BackendSettlement = {
      postingChain: 'base',
      chains: [{ ...backendBasePosting.chains[0], chainId: 8453, tier: 'mainnet' }],
    };
    expect(mergeSettlement(defaultSettlement(), otherNetwork).postingChain).toBe('arc');
    const otherArc: BackendSettlement = {
      postingChain: 'arc',
      chains: [backendBasePosting.chains[0], { ...backendArcPosting.chains[1], chainId: 5042, tier: 'mainnet' }],
    };
    expect(mergeSettlement(defaultSettlement(), otherArc).postingChain).toBe('base');
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
describe('gasIsSettlementToken', () => {
  afterEach(() => resetSettlement());

  it('is true on Arc (gas is native USDC) and false on Base (gas is ETH)', () => {
    expect(gasIsSettlementToken('arc')).toBe(true);
    expect(gasIsSettlementToken('base')).toBe(false);
  });

  it("follows the backend's gasSymbol", () => {
    const d = defaultSettlement();
    setSettlement(mergeSettlement(d, {
      postingChain: 'base',
      chains: [{ chain: 'base', chainId: d.chains.base.chainId, tier: 'testnet', escrowAddress: d.chains.base.escrow || null, token: { kind: 'erc20', address: d.chains.base.token.address || null, symbol: 'USDC', decimals: 6 }, relayChain: 'base-sepolia', gasSymbol: 'USDC', postable: true }],
    }));
    expect(gasIsSettlementToken('base')).toBe(true);
  });
});
