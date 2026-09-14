import { defineChain } from 'viem';
import { mainnet, sepolia, arbitrum, arbitrumSepolia, optimism, optimismSepolia } from 'viem/chains';
import { OG_CHAIN_ID, OG_RPC_URL, BASE_CHAIN_ID, BASE_RPC_URL } from './constants';

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

// CCTP source chains (Ethereum, Arbitrum, Optimism) — needed in Privy's
// PrivyProvider `supportedChains` so `wallet.switchChain()` will actually
// switch an external wallet to them (Privy validates the target chain
// against this app-level list before ever touching the wallet; omitting a
// chain here surfaces as "Unsupported chainId: <id>", not a wallet error).
// Uses viem's canonical pre-built definitions rather than hand-rolling RPC
// URLs, following the same mainnet-tier-follows-Base convention as
// baseChain/ogTestnet above (this app has no separate "IS_PROD" flag at
// this layer).
export const ethereumChain = isBaseMainnet ? mainnet : sepolia;
export const arbitrumChain = isBaseMainnet ? arbitrum : arbitrumSepolia;
export const optimismChain = isBaseMainnet ? optimism : optimismSepolia;
