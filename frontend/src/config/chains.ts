import { defineChain, type Chain } from 'viem';
import { mainnet, sepolia, arbitrum, arbitrumSepolia, optimism, optimismSepolia, polygon, polygonAmoy, base, baseSepolia, arc, arcTestnet } from 'viem/chains';
import { OG_CHAIN_ID, OG_RPC_URL, BASE_CHAIN_ID, BASE_RPC_URL, ARC_CHAIN_ID, ARC_RPC_URL, ARC_CHAIN_CONFIG } from './constants';

// 0G chain (agent infra)
const isMainnetChain = OG_CHAIN_ID === 16661;

export const ogTestnet = defineChain({
  id: OG_CHAIN_ID,
  name: isMainnetChain ? '0G Mainnet' : '0G Testnet',
  network: isMainnetChain ? '0g-mainnet' : '0g-testnet',
  nativeCurrency: { decimals: 18, name: '0G', symbol: '0G' },
  rpcUrls: { default: { http: [OG_RPC_URL] } },
  blockExplorers: {
    default: {
      name: '0G Scan',
      url: isMainnetChain ? 'https://chainscan.0g.ai' : 'https://chainscan-galileo.0g.ai',
    },
  },
});

// Base chain (settlement — USDC payouts)
const isBaseMainnet = BASE_CHAIN_ID === 8453;

export const baseChain = defineChain({
  id: BASE_CHAIN_ID,
  name: isBaseMainnet ? 'Base' : 'Base Sepolia',
  network: isBaseMainnet ? 'base' : 'base-sepolia',
  nativeCurrency: { decimals: 18, name: 'ETH', symbol: 'ETH' },
  rpcUrls: { default: { http: [BASE_RPC_URL] } },
  blockExplorers: {
    default: {
      name: 'Basescan',
      url: isBaseMainnet ? 'https://basescan.org' : 'https://sepolia.basescan.org',
    },
  },
});

// Arc (Circle's L1, USDC is the gas token), the settlement chain, on the
// network constants.ARC_CHAIN_ID names. viem's defs carry no RPC we use:
// mainnet's has none, testnet's still points at the old
// rpc.testnet.arc.network domain. The RPC follows constants.ARC_RPC_URL (a
// public endpoint by default), and mainnet's explorer ARC_CHAIN_CONFIG.
const isArcMainnet = ARC_CHAIN_ID === 5042;

export const arcChain: Chain = isArcMainnet
  ? defineChain({
      ...arc,
      rpcUrls: { default: { http: [ARC_RPC_URL] } },
      blockExplorers: { default: { name: 'Arc Explorer', url: ARC_CHAIN_CONFIG.blockExplorerUrls[0] } },
    })
  : defineChain({
      ...arcTestnet,
      rpcUrls: { default: { http: [ARC_RPC_URL] } },
    });

// CCTP source chains (Ethereum, Arbitrum, Optimism, Polygon, Base) — needed in
// Privy's PrivyProvider `supportedChains` so `wallet.switchChain()` will
// actually switch an external wallet to them (Privy validates the target
// chain against this app-level list before ever touching the wallet; omitting
// a chain here surfaces as "Unsupported chainId: <id>", not a wallet error).
// Arc is NOT here: it is the settlement chain this app's wallet already sits
// on, not a bridge source. Base is here so legacy Base USDC can be bridged in.
//
// Their tier is Arc's, as the backend's CCTP tier is: every transfer mints
// into (or burns from) the Arc wallet. It followed Base's before, so a build
// on Base mainnet offered mainnet sources while minting into Arc testnet.
export const ethereumChain = isArcMainnet ? mainnet : sepolia;
export const arbitrumChain = isArcMainnet ? arbitrum : arbitrumSepolia;
export const optimismChain = isArcMainnet ? optimism : optimismSepolia;
export const polygonChain = isArcMainnet ? polygon : polygonAmoy;
// The settlement Base chain when it is on that tier; otherwise Base on the
// tier (Arc mainnet next to a Base Sepolia escrow kept for its older tasks).
export const cctpBaseChain = isBaseMainnet === isArcMainnet ? baseChain : isArcMainnet ? base : baseSepolia;

// Every CCTP chain for this tier, for Privy's `supportedChains`.
export const cctpSourceChains = isArcMainnet
  ? [ethereumChain, arbitrumChain, polygonChain, cctpBaseChain]
  : [ethereumChain, arbitrumChain, optimismChain, polygonChain, cctpBaseChain];

// Privy's `supportedChains`: Arc, the CCTP sources, and the settlement Base
// chain (legacy Base tasks), each chain once.
export const privySupportedChains: Chain[] = [arcChain, ...cctpSourceChains, baseChain]
  .filter((chain, i, all) => all.findIndex((c) => c.id === chain.id) === i);
