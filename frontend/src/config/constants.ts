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

const IS_PROD = import.meta.env.PROD;

// Contract-address fallbacks are single-sourced from contracts/deployments/*.json
// via contracts/scripts/sync-addresses.ts (do not hand-edit contractAddresses.ts).
// VITE_* env vars still win at build time; these are the no-env defaults.
const ADDR = IS_PROD ? CONTRACT_ADDRESSES.mainnet : CONTRACT_ADDRESSES.testnet;
const BASE_ADDR = IS_PROD ? (CONTRACT_ADDRESSES as any).base : (CONTRACT_ADDRESSES as any).baseTestnet;

// ── 0G Chain (agent infra) ─────────────────────────────────────────────────

export const OG_CHAIN_ID = Number(
  import.meta.env.VITE_OG_CHAIN_ID || (IS_PROD ? '16661' : '16602')
);

export const isMainnet = OG_CHAIN_ID === 16661;

export const OG_RPC_URL =
  import.meta.env.VITE_OG_RPC_URL ||
  (IS_PROD ? 'https://evmrpc.0g.ai' : 'https://evmrpc-testnet.0g.ai');

export const BLIND_ESCROW_ADDRESS =
  import.meta.env.VITE_BLIND_ESCROW_ADDRESS || ADDR.blindEscrow;

export const TASK_REGISTRY_ADDRESS =
  import.meta.env.VITE_TASK_REGISTRY_ADDRESS || ADDR.taskRegistry;

export const BLIND_REPUTATION_ADDRESS =
  import.meta.env.VITE_BLIND_REPUTATION_ADDRESS || ADDR.blindReputation;

// ── Base Chain (settlement — USDC payouts) ──────────────────────────────────

export const BASE_CHAIN_ID = Number(
  import.meta.env.VITE_BASE_CHAIN_ID || (IS_PROD ? '8453' : '84532')
);

// The Base leg's CCTP chainKey — used as the fixed source/dest of a CCTP
// quote, since neither Phase A (Base -> elsewhere) nor Phase B (elsewhere ->
// Base) ever varies this side of the route. The backend derives its CCTP tier
// from its own BASE_CHAIN_ID the same way (backend/src/config.ts).
export const BASE_CCTP_CHAIN_KEY = BASE_CHAIN_ID === 8453 ? 'base' : 'base-sepolia';

/** CCTP is usable only when the backend's CCTP Base leg is the Base chain
 *  this app settles on. A mismatched deployment (e.g. backend on Base mainnet,
 *  app on Base Sepolia) hides bridging entirely instead of listing the other
 *  network tier's chains — a real mainnet burn from a testnet app. */
export function isCctpUsable(cfg: { enabled: boolean; baseChainId?: number | null }): boolean {
  return cfg.enabled && cfg.baseChainId === BASE_CHAIN_ID;
}

export const BASE_RPC_URL =
  import.meta.env.VITE_BASE_RPC_URL ||
  (IS_PROD ? 'https://mainnet.base.org' : 'https://sepolia.base.org');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Collapse an undeployed placeholder address to '' so callers can treat it as unset. */
export const unsetIfZero = (a: string | undefined): string =>
  !a || a.toLowerCase() === ZERO_ADDRESS ? '' : a;

export const BASE_ESCROW_ADDRESS = unsetIfZero(
  import.meta.env.VITE_BASE_ESCROW_ADDRESS || BASE_ADDR?.blindEscrow || '',
);

export const BASE_USDC_ADDRESS =
  import.meta.env.VITE_BASE_USDC_ADDRESS ||
  (IS_PROD ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : '0x036CbD53842c5426634e7929541eC2318f3dCF7e');

// ── Payment token ───────────────────────────────────────────────────────────

// Marketplace payment token — Base USDC when Base is configured, else native 0G.
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
  blockExplorerUrls: [OG_CHAIN_ID === 16661 ? 'https://chainscan.0g.ai' : 'https://chainscan-newton.0g.ai'],
} as const;

export const BASE_CHAIN_CONFIG = {
  chainId: `0x${BASE_CHAIN_ID.toString(16)}`,
  chainName: BASE_CHAIN_ID === 8453 ? 'Base' : 'Base Sepolia',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: [BASE_RPC_URL],
  blockExplorerUrls: [BASE_CHAIN_ID === 8453 ? 'https://basescan.org' : 'https://sepolia.basescan.org'],
} as const;

// Supported chains: 'base' for settlement, 'og' for agent infra
export const SUPPORTED_CHAINS = ['base', 'og'] as const;
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
  // Default to 'base' for settlement — users interact with Base
  return (import.meta.env.VITE_ACTIVE_CHAIN as SupportedChain | undefined) ?? 'base';
}

export const CHAIN_CONFIGS = {
  base: BASE_CHAIN_CONFIG,
  og: OG_CHAIN_CONFIG,
} as const;

export function getChainConfig(chain: SupportedChain) {
  return CHAIN_CONFIGS[chain];
}

export function getNativeCurrency(chain: SupportedChain) {
  return getChainConfig(chain).nativeCurrency;
}

/**
 * Payment decimals and symbol for the settlement chain. Task rewards are
 * denominated in the settlement chain's payment token (USDC on Base = 6
 * decimals; native 0G when Base is not configured = 18 decimals).
 */
export function getPaymentDecimals(): number {
  return BASE_ESCROW_ADDRESS ? 6 : 18;
}

export function getPaymentSymbol(): string {
  return BASE_ESCROW_ADDRESS ? 'USDC' : getNativeCurrency('og').symbol;
}