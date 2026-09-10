import { JsonRpcProvider } from 'ethers';

/**
 * Which chain escrow settles on, and how this process pays for it.
 *
 * The backend decides the chain: POST /api/v1/tasks builds against the Base
 * escrow whenever BASE_ESCROW_ADDRESS is set, else against 0G (legacy). The
 * MCP has to agree with that decision or it funds the wrong thing — sending
 * native 0G value for a task the backend built as a USDC transferFrom, or
 * signing a Base tx on the 0G RPC. So instead of a parallel config here, ask
 * the backend which mode it is in (GET /health/bridge, public) and derive the
 * rest from the chain id.
 *
 * The two modes pay differently, and that is the whole reason this file
 * exists:
 *
 *   0g   — the local wallet (BLINDMARKET_PRIVATE_KEY) signs and broadcasts
 *          itself. Native 0G is the escrow token and the gas token.
 *   base — nothing signs locally. Transactions go to POST /api/v1/tx/relay-tx,
 *          where the backend has Privy sign from the caller's embedded wallet
 *          with gas paid in USDC. The wallet is the sk_ API key's owner
 *          (GET /api/v1/api-keys/whoami) — it must be a Privy embedded wallet,
 *          which is what the web app creates on login. No private key here.
 *
 * Discovery is memoised per process. BLINDMARKET_SETTLEMENT=0g|base forces a
 * mode (0g skips discovery entirely; base fails loudly if the backend is not
 * actually in Base mode rather than silently posting native tasks).
 */

export type SettlementMode = '0g' | 'base';

export interface OgSettlement {
  mode: '0g';
  decimals: 18;
  symbol: '0G';
}

export interface BaseSettlement {
  mode: 'base';
  chainId: number;
  escrowAddress: string;
  usdcAddress: string;
  decimals: 6;
  symbol: 'USDC';
  /** the `chain` value relay-tx expects — see backend CHAIN_CAIP2 */
  relayChain: 'base-mainnet' | 'base-sepolia';
  rpcUrl: string;
  /** read-only: allowance/balance checks and receipt polling. Never signs. */
  provider: JsonRpcProvider;
  /** the relay signs from this wallet — the API key's owner (Privy embedded) */
  payFrom: string;
}

export type Settlement = OgSettlement | BaseSettlement;

export const OG_SETTLEMENT: OgSettlement = { mode: '0g', decimals: 18, symbol: '0G' };

// Mirrors frontend/src/config/constants.ts BASE_USDC_ADDRESS. Overridable via
// BLINDMARKET_USDC_ADDRESS for a chain not listed here.
export const BASE_USDC: Readonly<Record<number, string>> = {
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

export const BASE_RPC: Readonly<Record<number, string>> = {
  8453: 'https://mainnet.base.org',
  84532: 'https://sepolia.base.org',
};

export function relayChainFor(chainId: number): BaseSettlement['relayChain'] | null {
  if (chainId === 8453) return 'base-mainnet';
  if (chainId === 84532) return 'base-sepolia';
  return null;
}

export function usdcFor(chainId: number, override?: string): string | null {
  if (override && /^0x[0-9a-fA-F]{40}$/.test(override)) return override;
  return BASE_USDC[chainId] ?? null;
}

export interface SettlementError extends Error { code: string }

function err(code: string, message: string): SettlementError {
  const e = new Error(message) as SettlementError;
  e.code = code;
  return e;
}

export interface DiscoverDeps {
  apiBase: string;
  /** authenticated GET — only used for whoami, which needs the API key */
  api: <T = any>(method: string, path: string, body?: unknown) => Promise<T>;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** One discovery. Wrap with createSettlementResolver for the memoised form. */
export async function discoverSettlement(deps: DiscoverDeps): Promise<Settlement> {
  const env = deps.env ?? process.env;
  const forced = env.BLINDMARKET_SETTLEMENT;
  if (forced && forced !== '0g' && forced !== 'base') {
    throw err('BAD_SETTLEMENT', `BLINDMARKET_SETTLEMENT must be "0g" or "base", got "${forced}"`);
  }
  if (forced === '0g') return OG_SETTLEMENT;

  const f = deps.fetchImpl ?? fetch;
  let bridge: any;
  try {
    const res = await f(`${deps.apiBase}/health/bridge`);
    const json: any = await res.json();
    // ApiResponse envelope: { success, data: { base: {...} } } — tolerate a
    // flat shape too so a future trim of the envelope does not break spends.
    bridge = json?.data?.base ?? json?.base ?? null;
  } catch (e) {
    throw err(
      'SETTLEMENT_UNKNOWN',
      `Could not reach ${deps.apiBase}/health/bridge to learn which chain escrow settles on (${(e as Error).message}). ` +
      'Set BLINDMARKET_SETTLEMENT=0g to force the legacy local-wallet path, or =base to require the relay.',
    );
  }

  if (!bridge?.configured) {
    if (forced === 'base') {
      throw err('SETTLEMENT_MISMATCH', 'BLINDMARKET_SETTLEMENT=base but the backend reports no Base escrow configured — it would build 0G tasks.');
    }
    return OG_SETTLEMENT;
  }

  const chainId = Number(bridge.chainId);
  const relayChain = relayChainFor(chainId);
  if (!relayChain) {
    throw err('UNSUPPORTED_BASE_CHAIN', `Backend reports Base chainId ${bridge.chainId}, which relay-tx does not support (8453 or 84532).`);
  }
  const escrowAddress = String(bridge.escrowAddress ?? '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(escrowAddress)) {
    throw err('SETTLEMENT_UNKNOWN', `Backend reports Base configured but no escrow address (${bridge.escrowAddress}).`);
  }
  const usdcAddress = usdcFor(chainId, env.BLINDMARKET_USDC_ADDRESS);
  if (!usdcAddress) {
    throw err('USDC_UNKNOWN', `No USDC address known for chainId ${chainId} — set BLINDMARKET_USDC_ADDRESS.`);
  }
  const rpcUrl = env.BLINDMARKET_BASE_RPC_URL ?? BASE_RPC[chainId];
  if (!rpcUrl) {
    throw err('RPC_UNKNOWN', `No RPC known for chainId ${chainId} — set BLINDMARKET_BASE_RPC_URL.`);
  }

  // The relay refuses any wallet not linked to the caller — and the caller of
  // an sk_ key IS its owner wallet, so that is the only address it can sign
  // from. whoami is the endpoint built for exactly this boot-time check.
  const who = await deps.api<{ address: string }>('GET', '/api/v1/api-keys/whoami');
  const payFrom = String(who?.address ?? '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(payFrom)) {
    throw err(
      'RELAY_WALLET_UNKNOWN',
      `whoami returned "${who?.address}" — the API key must belong to a wallet (not the legacy AGENT_API_KEY principal) for the relay to sign from it.`,
    );
  }

  return {
    mode: 'base',
    chainId,
    escrowAddress,
    usdcAddress,
    decimals: 6,
    symbol: 'USDC',
    relayChain,
    rpcUrl,
    provider: new JsonRpcProvider(rpcUrl, chainId),
    payFrom,
  };
}

/** Memoised discovery — one lookup per process, errors are not cached so a
 *  transient backend outage can be retried on the next spend call. */
export function createSettlementResolver(deps: DiscoverDeps): () => Promise<Settlement> {
  let cached: Settlement | null = null;
  return async () => {
    if (cached) return cached;
    cached = await discoverSettlement(deps);
    return cached;
  };
}
