import { CONTRACT_ADDRESSES } from './contractAddresses';
import NETWORKS from './networks.json';

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
// Valid values: mainnet | testnet. Defaults to testnet. Individual chain IDs
// are derived from VITE_NETWORK; only RPCs can be overridden with env vars.
const NETWORK = (import.meta.env.VITE_NETWORK as 'mainnet' | 'testnet') || 'testnet';
const networkIsMainnet = NETWORK === 'mainnet';

// Contract-address fallbacks are single-sourced from contracts/deployments/*.json
// via contracts/scripts/sync-addresses.ts (do not hand-edit contractAddresses.ts).
// All chain ids come from VITE_NETWORK only. No env overrides: mainnet build
// gets 0G mainnet (16661), Base mainnet (8453), Arc mainnet (5042); testnet
// build gets 0G testnet (16602), Base Sepolia (84532), Arc testnet (5042002).
const OG_CHAIN_ID = Number(networkIsMainnet ? '16661' : '16602');
const BASE_CHAIN_ID = Number(networkIsMainnet ? '8453' : '84532');
const ARC_CHAIN_ID = Number(networkIsMainnet ? '5042' : '5042002');

const isMainnet = OG_CHAIN_ID === 16661;
const isBaseMainnet = BASE_CHAIN_ID === 8453;
const isArcMainnet = ARC_CHAIN_ID === 5042;

const ADDR = isMainnet ? CONTRACT_ADDRESSES.mainnet : CONTRACT_ADDRESSES.testnet;
const BASE_ADDR = isBaseMainnet
  ? (CONTRACT_ADDRESSES as any).base
  : (CONTRACT_ADDRESSES as any).baseTestnet;
// Present once contracts/deployments/arc-{testnet,mainnet}.json exists. Only
// this network's record: another network's contracts are not on this one.
const ARC_ADDR = isArcMainnet
  ? (CONTRACT_ADDRESSES as any).arc
  : ARC_CHAIN_ID === 5042002 ? (CONTRACT_ADDRESSES as any).arcTestnet : undefined;

// ── 0G Chain (agent infra) ─────────────────────────────────────────────────

export { OG_CHAIN_ID };
export { isMainnet };

export const OG_RPC_URL =
  import.meta.env.VITE_OG_RPC_URL ||
  (networkIsMainnet ? NETWORKS.networks.og.mainnet.rpcUrl : NETWORKS.networks.og.testnet.rpcUrl);

export const BLIND_ESCROW_ADDRESS =
  import.meta.env.VITE_BLIND_ESCROW_ADDRESS || ADDR.blindEscrow;

export const TASK_REGISTRY_ADDRESS =
  import.meta.env.VITE_TASK_REGISTRY_ADDRESS || ADDR.taskRegistry;

export const BLIND_REPUTATION_ADDRESS =
  import.meta.env.VITE_BLIND_REPUTATION_ADDRESS || ADDR.blindReputation;

// ── Base Chain (settlement — USDC payouts) ──────────────────────────────────

export { BASE_CHAIN_ID };

// The settlement leg's CCTP chainKey — the fixed source/dest of a CCTP quote.
// Phase A burns FROM here, Phase B mints INTO here (the user's Arc wallet):
// the backend's CCTP entry for this Arc network.
export const SETTLEMENT_CCTP_CHAIN_KEY = isArcMainnet ? 'arc' : 'arc-testnet';

/** CCTP is usable only when the backend's CCTP Arc leg is the chain
 *  this app settles on. A mismatched deployment hides bridging entirely
 *  instead of bridging onto the wrong network — a real burn/mint on the
 *  wrong tier. */
export function isCctpUsable(cfg: { enabled: boolean; arcChainId?: number | null; baseChainId?: number | null; network?: 'mainnet' | 'testnet' | null }): boolean {
  if (!cfg.enabled) return false;
  if (cfg.arcChainId != null) return cfg.arcChainId === ARC_CHAIN_ID;
  // Legacy backends (pre-arcChainId): trust the backend's `network` field —
  // it tracks the CCTP Arc leg tier, so matching it against this build's tier
  // is correct on both testnet (Arc testnet + Base Sepolia leg) and mainnet
  // (Arc mainnet + Base mainnet leg).
  const frontendTier = ARC_CHAIN_ID === 5042 ? 'mainnet' : 'testnet';
  if (cfg.network === frontendTier) return true;
  // Last-resort fallback for the very oldest backends (no arcChainId, no
  // network): the legacy production shape is Arc testnet + Base Sepolia, so
  // assume testnet when neither is reported.
  return frontendTier === 'testnet';
}

export const BASE_RPC_URL =
  import.meta.env.VITE_BASE_RPC_URL ||
  (networkIsMainnet ? NETWORKS.networks.base.mainnet.rpcUrl : NETWORKS.networks.base.testnet.rpcUrl);

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
    ? NETWORKS.networks.base.mainnet.usdc
    : NETWORKS.networks.base.testnet.usdc);

// ── Arc Chain (settlement — USDC payouts, gas in USDC) ───────────────────────

export { ARC_CHAIN_ID };

/**
 * Arc's public RPC for a chain id. Reads from the shared network config
 * (config/networks.json) so backend, CLI, and MCP see the same defaults.
 */
export function arcPublicRpcUrl(chainId: number): string {
  return chainId === 5042 ? NETWORKS.networks.arc.mainnet.rpcUrl : NETWORKS.networks.arc.testnet.rpcUrl;
}

export const ARC_PUBLIC_RPC_URL = arcPublicRpcUrl(ARC_CHAIN_ID);

// Override with VITE_ARC_RPC_URL; WSS (wss://arc-testnet-rpc.publicnode.com)
// also tested working.
export const ARC_RPC_URL = import.meta.env.VITE_ARC_RPC_URL || ARC_PUBLIC_RPC_URL;

// The escrow new tasks post on, generated from contracts/deployments like
// Base's, so the build-time settlement table (config/settlement.ts) names it
// even when VITE_ARC_ESCROW_ADDRESS is unset: without it that table fell back
// to Base whenever GET /health/settlement did not answer. The env var still
// overrides it (a staging stack sets its own).
export const ARC_ESCROW_ADDRESS = unsetIfZero(
  import.meta.env.VITE_ARC_ESCROW_ADDRESS || ARC_ADDR?.blindEscrow || '',
);

// USDC on Arc is one balance with two views: 18-dec native (the gas coin) and
// 6-dec ERC-20 at the precompile above any normal address. The escrow only ever
// allowlists the ERC-20.
export const ARC_USDC_ADDRESS =
  import.meta.env.VITE_ARC_USDC_ADDRESS || ARC_ADDR?.USDC || NETWORKS.networks.arc.mainnet.usdc;

// The AgentFactory the deploy fee is paid to, from this Arc network's record:
// none on Arc mainnet until its deploy is recorded, never the testnet one. The
// backend names the factory too (the deploy fee terms), and that wins.
export const ARC_AGENT_FACTORY_ADDRESS = unsetIfZero(
  import.meta.env.VITE_ARC_AGENT_FACTORY_ADDRESS || ARC_ADDR?.agentFactory || '',
);

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
  chainName: networkIsMainnet ? NETWORKS.networks.og.mainnet.name : NETWORKS.networks.og.testnet.name,
  nativeCurrency: networkIsMainnet ? NETWORKS.networks.og.mainnet.nativeCurrency : NETWORKS.networks.og.testnet.nativeCurrency,
  rpcUrls: [OG_RPC_URL],
  blockExplorerUrls: [networkIsMainnet ? NETWORKS.networks.og.mainnet.blockExplorer : NETWORKS.networks.og.testnet.blockExplorer],
} as const;

export const BASE_CHAIN_CONFIG = {
  chainId: `0x${BASE_CHAIN_ID.toString(16)}`,
  chainName: networkIsMainnet ? NETWORKS.networks.base.mainnet.name : NETWORKS.networks.base.testnet.name,
  nativeCurrency: networkIsMainnet ? NETWORKS.networks.base.mainnet.nativeCurrency : NETWORKS.networks.base.testnet.nativeCurrency,
  rpcUrls: [BASE_RPC_URL],
  blockExplorerUrls: [networkIsMainnet ? NETWORKS.networks.base.mainnet.blockExplorer : NETWORKS.networks.base.testnet.blockExplorer],
} as const;

export const ARC_CHAIN_CONFIG = {
  chainId: `0x${ARC_CHAIN_ID.toString(16)}`,
  chainName: isArcMainnet ? NETWORKS.networks.arc.mainnet.name : NETWORKS.networks.arc.testnet.name,
  nativeCurrency: isArcMainnet ? NETWORKS.networks.arc.mainnet.nativeCurrency : NETWORKS.networks.arc.testnet.nativeCurrency,
  rpcUrls: [ARC_RPC_URL],
  blockExplorerUrls: [isArcMainnet ? NETWORKS.networks.arc.mainnet.blockExplorer : NETWORKS.networks.arc.testnet.blockExplorer],
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