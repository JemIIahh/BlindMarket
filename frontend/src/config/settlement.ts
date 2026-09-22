/**
 * The settlement chains as this app knows them, and the one new tasks post on.
 *
 * Until Sep 2026 every file decided the payment token by "is a Base escrow
 * configured?" — the rule the backend itself dropped in R12, when POST /tasks
 * started following POSTING_CHAIN. A backend that has a Base escrow but posts
 * on 0G refused every task this app built (TOKEN_NOT_SETTLEMENT) and showed
 * each amount out by 10^12. The backend now serves its posting chain and each
 * chain's token, escrow and relay name at GET /api/v1/health/settlement, and
 * this module holds the answer.
 *
 * Two layers:
 * - a build-time TABLE from the env/generated addresses, keyed by the
 *   backend's chain key ('base' | 'arc'), with the same default posting rule
 *   as before — so nothing moves until the backend says otherwise, and the
 *   app still renders when the request fails;
 * - a SNAPSHOT the SettlementProvider overwrites from the backend at boot.
 *   Sync getters (getPaymentDecimals & co.) read it, and `useSettlement()`
 *   re-renders components when it changes.
 *
 * Wallet-side chain choice (the 'og' | 'base' | 'arc' selector) stays in
 * ChainContext; this is about where money is escrowed, not which chain the
 * wallet shows.
 */
import { useSyncExternalStore } from 'react';
import {
  ARC_CHAIN_CONFIG,
  ARC_CHAIN_ID,
  ARC_ESCROW_ADDRESS,
  ARC_USDC_ADDRESS,
  BASE_CHAIN_CONFIG,
  BASE_CHAIN_ID,
  BASE_ESCROW_ADDRESS,
  BASE_USDC_ADDRESS,
  MARKETPLACE_TOKEN_ADDRESS,
  type SupportedChain,
} from './constants';

/** The backend's settlement chain keys. */
export type SettlementChainKey = 'base' | 'arc';

export interface SettlementUnit {
  symbol: string;
  decimals: number;
}

export interface SettlementChainInfo {
  key: SettlementChainKey;
  label: string;
  chainId: number;
  tier: 'mainnet' | 'testnet';
  /** Block explorer base URL. */
  explorer: string;
  /** The escrow tasks on this chain are held in, or '' when this app knows none. */
  escrow: string;
  token: {
    kind: 'native' | 'erc20';
    /** address(0) for a native token; '' when unknown. */
    address: string;
    unit: SettlementUnit;
  };
  /** The `chain` name POST /tx/relay-tx takes for this chain, or null when the relay does not serve it. */
  relayChain: string | null;
  /** The wallet chain (ChainContext) that pays on this chain. Base is legacy and has no wallet. */
  walletChain: SupportedChain | 'base';
}

export interface SettlementSnapshot {
  /** The chain new tasks are escrowed on. */
  postingChain: SettlementChainKey;
  chains: Record<SettlementChainKey, SettlementChainInfo>;
  /** Where the snapshot came from: the build-time table, or the backend. */
  source: 'defaults' | 'backend';
}

/** The relay name for a Base chain id; the backend's relayChains.ts uses these same fixed names. */
function baseRelayChain(chainId: number): string {
  return chainId === 8453 ? 'base-mainnet' : 'base-sepolia';
}

/** The build-time table. Exported for tests; callers read the snapshot. */
export function defaultSettlement(): SettlementSnapshot {
  return {
    // The posting rule the backend follows: Arc when it has an escrow, else
    // Base (the legacy settlement chain).
    postingChain: ARC_ESCROW_ADDRESS ? 'arc' : BASE_ESCROW_ADDRESS ? 'base' : 'arc',
    chains: {
      base: {
        key: 'base',
        label: BASE_CHAIN_CONFIG.chainName,
        chainId: BASE_CHAIN_ID,
        tier: BASE_CHAIN_ID === 8453 ? 'mainnet' : 'testnet',
        explorer: BASE_CHAIN_CONFIG.blockExplorerUrls[0],
        escrow: BASE_ESCROW_ADDRESS,
        token: { kind: 'erc20', address: BASE_USDC_ADDRESS, unit: { symbol: 'USDC', decimals: 6 } },
        relayChain: baseRelayChain(BASE_CHAIN_ID),
        walletChain: 'base',
      },
      arc: {
        key: 'arc',
        label: ARC_CHAIN_CONFIG.chainName,
        chainId: ARC_CHAIN_ID,
        tier: ARC_CHAIN_ID === 5042 ? 'mainnet' : 'testnet',
        explorer: ARC_CHAIN_CONFIG.blockExplorerUrls[0],
        escrow: ARC_ESCROW_ADDRESS,
        token: { kind: 'erc20', address: ARC_USDC_ADDRESS, unit: { symbol: 'USDC', decimals: 6 } },
        relayChain: null,
        walletChain: 'arc',
      },
    },
    source: 'defaults',
  };
}

/** One entry of GET /api/v1/health/settlement `chains[]`. */
export interface BackendSettlementChain {
  chain: string;
  chainId: number;
  tier: 'mainnet' | 'testnet';
  escrowAddress: string | null;
  token: { kind: 'native' | 'erc20'; address: string | null; symbol: string; decimals: number };
  relayChain: string | null;
  gasSymbol: string;
  postable: boolean;
}

export interface BackendSettlement {
  postingChain: string | null;
  chains: BackendSettlementChain[];
  postingChainError?: string;
}

export function isSettlementChainKey(value: unknown): value is SettlementChainKey {
  return value === 'base' || value === 'arc';
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * A backend `chains[]` entry this build can take: a chain it knows, ON THE
 * SAME NETWORK (chain id) as the build, with a well-formed token. Anything
 * else is ignored, never trusted:
 * - a different chain id for the same key means another network tier — a
 *   testnet build pointed at a Base-mainnet backend would otherwise approve
 *   the mainnet escrow and relay createTask on base-mainnet from the user's
 *   wallet with no wallet prompt (the same rule constants.ts isCctpUsable
 *   states for bridging);
 * - a malformed entry (null token, non-numeric decimals) used to throw inside
 *   the SettlementProvider's effect, above the ErrorBoundary, and blank the
 *   whole app.
 */
function usableEntry(entry: unknown, defaults: SettlementSnapshot): entry is BackendSettlementChain & { chain: SettlementChainKey } {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Partial<BackendSettlementChain>;
  if (!isSettlementChainKey(e.chain)) return false;
  if (e.chainId !== defaults.chains[e.chain].chainId) return false;
  if (e.tier !== 'mainnet' && e.tier !== 'testnet') return false;
  if (e.escrowAddress !== null && e.escrowAddress !== undefined && !ADDRESS_RE.test(e.escrowAddress)) return false;
  const t = e.token;
  if (!t || typeof t !== 'object') return false;
  if (t.kind !== 'native' && t.kind !== 'erc20') return false;
  if (t.address !== null && t.address !== undefined && !ADDRESS_RE.test(t.address)) return false;
  if (typeof t.symbol !== 'string' || t.symbol === '') return false;
  if (t.decimals !== 6 && t.decimals !== 18) return false;
  if (e.relayChain !== null && e.relayChain !== undefined && typeof e.relayChain !== 'string') return false;
  return true;
}

/**
 * The backend's answer laid over the table. Entries usableEntry() rejects are
 * ignored (this build cannot pay on them); a table chain the backend omits
 * keeps its defaults. `postingChain` is taken only when it names a chain this
 * app has an escrow and token for after the merge — otherwise the table's
 * rule stands, as it did before. Never throws: a bad answer leaves the
 * defaults in place.
 */
export function mergeSettlement(defaults: SettlementSnapshot, backend: BackendSettlement): SettlementSnapshot {
  const chains = { ...defaults.chains };
  const entries = Array.isArray(backend?.chains) ? backend.chains : [];
  // Keys the backend described in a way this build rejected (another
  // network, a malformed entry). Such a chain keeps the build's defaults in
  // the table, but must not become the posting chain on the strength of them.
  const rejected = new Set<string>();
  for (const entry of entries) {
    if (!usableEntry(entry, defaults)) {
      const key = (entry as { chain?: unknown } | null)?.chain;
      if (isSettlementChainKey(key)) rejected.add(key);
      continue;
    }
    const prev = chains[entry.chain];
    chains[entry.chain] = {
      ...prev,
      tier: entry.tier,
      escrow: entry.escrowAddress ?? '',
      token: {
        kind: entry.token.kind,
        address: entry.token.address ?? '',
        unit: { symbol: entry.token.symbol, decimals: entry.token.decimals },
      },
      relayChain: entry.relayChain ?? null,
    };
  }
  const named = backend?.postingChain;
  const posting =
    isSettlementChainKey(named) && !rejected.has(named) && chains[named].escrow && chains[named].token.address
      ? named
      : defaults.postingChain;
  return { postingChain: posting, chains, source: 'backend' };
}

// ── The snapshot ────────────────────────────────────────────────────────────

let snapshot: SettlementSnapshot = defaultSettlement();
const listeners = new Set<() => void>();

export function getSettlement(): SettlementSnapshot {
  return snapshot;
}

/** Replace the snapshot (the SettlementProvider, and tests). */
export function setSettlement(next: SettlementSnapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

/** Back to the build-time table (tests). */
export function resetSettlement(): void {
  setSettlement(defaultSettlement());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current snapshot, re-rendering when the backend's answer arrives. */
export function useSettlement(): SettlementSnapshot {
  return useSyncExternalStore(subscribe, getSettlement, getSettlement);
}

// ── Sync readers ────────────────────────────────────────────────────────────

export function getPostingChain(): SettlementChainInfo {
  return snapshot.chains[snapshot.postingChain];
}

/** The unit every price on this deployment is written in: the posting chain's token. */
export function getPricingUnit(): SettlementUnit {
  return getPostingChain().token.unit;
}

/**
 * Payment decimals and symbol for new tasks, service prices and reward floors.
 * Same names as the helpers constants.ts used to export; they now follow the
 * posting chain rather than "is a Base escrow configured?".
 */
export function getPaymentDecimals(): number {
  return getPricingUnit().decimals;
}

export function getPaymentSymbol(): string {
  return getPricingUnit().symbol;
}

/**
 * The token a new task is escrowed in: what POST /tasks accepts. Replaces the
 * build-time MARKETPLACE_TOKEN_ADDRESS constant where a transaction is built
 * or a balance in the payment token is read.
 */
export function getMarketplaceTokenAddress(): string {
  return getPostingChain().token.address || MARKETPLACE_TOKEN_ADDRESS;
}

/** The escrow a new task's funds go to — the `spender` of a USDC approval. */
export function getPostingEscrowAddress(): string {
  return getPostingChain().escrow;
}

/** Whether new tasks are paid in the chain's native coin (sent as tx value). */
export function isNativePayment(): boolean {
  return getPostingChain().token.kind === 'native';
}

/**
 * The `chain` name to relay a transaction on `key` with, or null when the
 * relay does not serve that chain. Unhinted callers relay on the posting chain.
 */
export function relayChainFor(key: SettlementChainKey = snapshot.postingChain): string | null {
  return snapshot.chains[key]?.relayChain ?? null;
}

/**
 * The unit of a task on `chain`. A unit the backend reported for that task
 * wins (it read the escrow's token); otherwise the chain's settlement token;
 * otherwise the posting chain's, as before. `chain` can be undefined or
 * unknown for a task the indexer has not resolved yet.
 */
export function unitFor(
  chain: string | null | undefined,
  backendUnit?: { symbol?: string | null; decimals?: number | null } | null,
): SettlementUnit {
  if (backendUnit && typeof backendUnit.decimals === 'number' && backendUnit.symbol) {
    return { symbol: backendUnit.symbol, decimals: backendUnit.decimals };
  }
  if (isSettlementChainKey(chain)) return snapshot.chains[chain].token.unit;
  return getPricingUnit();
}

/** The chain's explorer base URL; unknown chains fall back to the posting chain's. */
export function explorerUrlFor(chain: string | null | undefined): string {
  return isSettlementChainKey(chain) ? snapshot.chains[chain].explorer : getPostingChain().explorer;
}
