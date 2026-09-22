import { CONTRACT_ADDRESSES } from './contractAddresses';

export const API_BASE_URL = import.meta.env.VITE_API_URL || '';

// Platform fee — DISPLAY values only. The authoritative feeBps lives on-chain
// in BlindEscrow (read at settlement time; changed via
// contracts/scripts/set-fee.ts). Keep this in sync when the fee changes so
// marketing/product copy stays truthful. 1000 bps = 10% platform / 90% worker
// (since 2026-07-14; previously 1500 = 15/85).
export const PLATFORM_FEE_BPS = 1000;
export const PLATFORM_FEE_PCT = PLATFORM_FEE_BPS / 100; // 10
export const WORKER_SHARE_PCT = 100 - PLATFORM_FEE_PCT; // 90
export const FEE_SPLIT_LABEL = `${WORKER_SHARE_PCT}/${PLATFORM_FEE_PCT}`; // "90/10"

// Chain/network configuration is driven by a single `VITE_NETWORK` env var.
// Valid values: mainnet | testnet. Defaults to testnet.
// Individual chain IDs / RPCs can still be overridden with VITE_OG_CHAIN_ID,
// VITE_BASE_CHAIN_ID, VITE_OG_RPC_URL and VITE_BASE_RPC_URL.
const NETWORK = (import.meta.env.VITE_NETWORK as 'mainnet' | 'testnet') || 'testnet';
const networkIsMainnet = NETWORK === 'mainnet';

// Contract-address fallbacks are single-sourced from contracts/deployments/*.json
// via contracts/scripts/sync-addresses.ts (do not hand-edit contractAddresses.ts).
const OG_CHAIN_ID = Number(
  import.meta.env.VITE_OG_CHAIN_ID || (networkIsMainnet ? '16661' : '16602'),
);
const BASE_CHAIN_ID = Number(
  import.meta.env.VITE_BASE_CHAIN_ID || (networkIsMainnet ? '8453' : '84532'),
);
// Arc (Circle's L1, USDC is the gas token) is testnet-only here, matching the
// backend's own Arc default. Mainnet (5042) has no default RPC, so it must be
// set explicitly via VITE_ARC_CHAIN_ID / VITE_ARC_RPC_URL.
const ARC_CHAIN_ID = Number(
  import.meta.env.VITE_ARC_CHAIN_ID || '5042002',
);

const isMainnet = OG_CHAIN_ID === 16661;
const isBaseMainnet = BASE_CHAIN_ID === 8453;
const isArcMainnet = ARC_CHAIN_ID === 5042;

const ADDR = isMainnet ? CONTRACT_ADDRESSES.mainnet : CONTRACT_ADDRESSES.testnet;
const BASE_ADDR = isBaseMainnet
  ? (CONTRACT_ADDRESSES as any).base
  : (CONTRACT_ADDRESSES as any).baseTestnet;

// ── 0G Chain (agent infra) ─────────────────────────────────────────────────

export { OG_CHAIN_ID };
export { isMainnet };

export const OG_RPC_URL =
  import.meta.env.VITE_OG_RPC_URL ||
  (networkIsMainnet ? 'https://evmrpc.0g.ai' : 'https://evmrpc-testnet.0g.ai');

export const BLIND_ESCROW_ADDRESS =
  import.meta.env.VITE_BLIND_ESCROW_ADDRESS || ADDR.blindEscrow;

export const TASK_REGISTRY_ADDRESS =
  import.meta.env.VITE_TASK_REGISTRY_ADDRESS || ADDR.taskRegistry;

export const BLIND_REPUTATION_ADDRESS =
  import.meta.env.VITE_BLIND_REPUTATION_ADDRESS || ADDR.blindReputation;

// ── Base Chain (settlement — USDC payouts) ──────────────────────────────────

export { BASE_CHAIN_ID };

// The Base leg's CCTP chainKey — used as the fixed source/dest of a CCTP
// quote, since neither Phase A (Base -> elsewhere) nor Phase B (elsewhere ->
// Base) ever varies this side of the route. The backend derives its CCTP tier
// from its own BASE_CHAIN_ID the same way (backend/src/config.ts).
export const BASE_CCTP_CHAIN_KEY = isBaseMainnet ? 'base' : 'base-sepolia';

/** CCTP is usable only when the backend's CCTP Base leg is the Base chain
 *  this app settles on. A mismatched deployment (e.g. backend on Base mainnet,
 *  app on Base Sepolia) hides bridging entirely instead of listing the other
 *  network tier's chains — a real mainnet burn from a testnet app. */
export function isCctpUsable(cfg: { enabled: boolean; baseChainId?: number | null }): boolean {
  return cfg.enabled && cfg.baseChainId === BASE_CHAIN_ID;
}

export const BASE_RPC_URL =
  import.meta.env.VITE_BASE_RPC_URL ||
  (networkIsMainnet ? 'https://mainnet.base.org' : 'https://sepolia.base.org');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Collapse an undeployed placeholder address to '' so callers can treat it as unset. */
export const unsetIfZero = (a: string | undefined): string =>
  !a || a.toLowerCase() === ZERO_ADDRESS ? '' : a;

export const BASE_ESCROW_ADDRESS = unsetIfZero(
  import.meta.env.VITE_BASE_ESCROW_ADDRESS || BASE_ADDR?.blindEscrow || '',
);

export const BASE_USDC_ADDRESS =
  import.meta.env.VITE_BASE_USDC_ADDRESS ||
  (isBaseMainnet
    ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    : '0x036CbD53842c5426634e7929541eC2318f3dCF7e');

// ── Arc Chain (settlement — USDC payouts, gas in USDC) ───────────────────────

export { ARC_CHAIN_ID };

export const ARC_RPC_URL =
  import.meta.env.VITE_ARC_RPC_URL ||
  (isArcMainnet ? 'https://rpc.mainnet.arc.io' : 'https://rpc.testnet.arc.io');

// Arc settlement is not deployed yet, so the escrow has no generated fallback;
// it is set per environment once Arc's escrow deploys.
export const ARC_ESCROW_ADDRESS = unsetIfZero(import.meta.env.VITE_ARC_ESCROW_ADDRESS || '');

// USDC on Arc is one balance with two views: 18-dec native (the gas coin) and
// 6-dec ERC-20 at the precompile above any normal address. The escrow only ever
// allowlists the ERC-20.
export const ARC_USDC_ADDRESS =
  import.meta.env.VITE_ARC_USDC_ADDRESS || '0x3600000000000000000000000000000000000000';

// Privy signer ID for the backend's PRIVY_AUTHORIZATION_KEY (Privy-app-specific).
export const PRIVY_RELAY_SIGNER_ID: string =
  import.meta.env.VITE_PRIVY_RELAY_SIGNER_ID || 'ed0tw7ng40gyfd6zu77cf0ol';

// ── Payment token ───────────────────────────────────────────────────────────

// Marketplace payment token as this BUILD assumes it: Base USDC when Base is
// configured, else native 0G. Anything that pays or prices reads
// config/settlement.ts (getMarketplaceTokenAddress & co.), which starts from
// this and then follows the backend's posting chain.
export const MARKETPLACE_TOKEN_ADDRESS =
  BASE_ESCROW_ADDRESS
    ? BASE_USDC_ADDRESS
    : (import.meta.env.VITE_MOCK_ERC20_ADDRESS as string | undefined) ||
      '0x0000000000000000000000000000000000000000';

// Founder addresses (comma-separated, lowercase). Used to gate the /metrics page.
export const FOUNDER_ADDRESSES: string[] = (import.meta.env.VITE_FOUNDER_ADDRESSES || '')
  .split(',')
  .map((s: string) => s.trim().toLowerCase())
  .filter(Boolean);

export const OG_CHAIN_CONFIG = {
  chainId: `0x${OG_CHAIN_ID.toString(16)}`,
  chainName: OG_CHAIN_ID === 16661 ? '0G Mainnet' : '0G Testnet',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: [OG_RPC_URL],
  // chainscan-newton was the old testnet's explorer and no longer resolves;
  // Galileo (16602) lives at chainscan-galileo, as config/chains.ts already said.
  blockExplorerUrls: [OG_CHAIN_ID === 16661 ? 'https://chainscan.0g.ai' : 'https://chainscan-galileo.0g.ai'],
} as const;

export const BASE_CHAIN_CONFIG = {
  chainId: `0x${BASE_CHAIN_ID.toString(16)}`,
  chainName: BASE_CHAIN_ID === 8453 ? 'Base' : 'Base Sepolia',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: [BASE_RPC_URL],
  blockExplorerUrls: [BASE_CHAIN_ID === 8453 ? 'https://basescan.org' : 'https://sepolia.basescan.org'],
} as const;

export const ARC_CHAIN_CONFIG = {
  chainId: `0x${ARC_CHAIN_ID.toString(16)}`,
  chainName: isArcMainnet ? 'Arc' : 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: [ARC_RPC_URL],
  blockExplorerUrls: [isArcMainnet ? 'https://arcscan.app' : 'https://testnet.arcscan.app'],
} as const;

// Single user-facing wallet chain: Arc (settlement). Base is legacy read-only
// and 0G is agent infra — neither is connectable from the wallet.
export const SUPPORTED_CHAINS = ['arc'] as const;
export type SupportedChain = typeof SUPPORTED_CHAINS[number];

/**
 * Active chain — driven by localStorage (set by the chain selector), falling
 * back to VITE_ACTIVE_CHAIN env var, then 'og'.
 *
 * Components should prefer the reactive `useChain()` hook from ChainContext
 * so they re-render when the user switches chains. This constant is a
 * synchronous snapshot for non-React code (e.g. API interceptors).
 */
export const ACTIVE_CHAIN: SupportedChain = getActiveChain();

export function getActiveChain(): SupportedChain {
  try {
    const saved = localStorage.getItem('bb.chain');
    if (saved && (SUPPORTED_CHAINS as readonly string[]).includes(saved)) {
      return saved as SupportedChain;
    }
  } catch {}
  // Default to 'arc' — the settlement chain.
  return (import.meta.env.VITE_ACTIVE_CHAIN as SupportedChain | undefined) ?? 'arc';
}

export const CHAIN_CONFIGS = {
  arc: ARC_CHAIN_CONFIG,
} as const;

export function getChainConfig(chain: SupportedChain) {
  return CHAIN_CONFIGS[chain];
}

export function getNativeCurrency(chain: SupportedChain) {
  return getChainConfig(chain).nativeCurrency;
}

// getPaymentDecimals / getPaymentSymbol live in config/settlement.ts: they
// follow the backend's posting chain, not "is a Base escrow configured?".