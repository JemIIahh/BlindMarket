import { defineChain } from 'viem';
import { mainnet, sepolia, arbitrum, arbitrumSepolia, optimism, optimismSepolia, polygon, polygonAmoy, arcTestnet } from 'viem/chains';
import { OG_CHAIN_ID, OG_RPC_URL, BASE_CHAIN_ID, BASE_RPC_URL, ARC_RPC_URL } from './constants';

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

// CCTP source chains (Ethereum, Arbitrum, Optimism, Base) — needed in Privy's
// PrivyProvider `supportedChains` so `wallet.switchChain()` will actually
// switch an external wallet to them (Privy validates the target chain
// against this app-level list before ever touching the wallet; omitting a
// chain here surfaces as "Unsupported chainId: <id>", not a wallet error).
// Arc is NOT here: it is the settlement chain this app's wallet already sits
// on, not a bridge source. Base is here so legacy Base USDC can be bridged in.
export const ethereumChain = isBaseMainnet ? mainnet : sepolia;
export const arbitrumChain = isBaseMainnet ? arbitrum : arbitrumSepolia;
export const optimismChain = isBaseMainnet ? optimism : optimismSepolia;
export const polygonChain = isBaseMainnet ? polygon : polygonAmoy;

// Arc (Circle's L1, USDC is the gas token) — testnet only; the app doesn't
// offer Arc mainnet as a CCTP chain (see backend config.ts). viem's canonical
// def still points at the old rpc.testnet.arc.network domain; the RPC URL
// follows constants.ARC_RPC_URL (dRPC by default).
export const arcChain = defineChain({
  ...arcTestnet,
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
});

// Every CCTP chain for this tier, for Privy's `supportedChains`.
export const cctpSourceChains = isBaseMainnet
  ? [ethereumChain, arbitrumChain, polygonChain, baseChain]
  : [ethereumChain, arbitrumChain, optimismChain, polygonChain, baseChain];
