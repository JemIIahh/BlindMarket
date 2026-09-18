import { JsonRpcProvider, getAddress } from 'ethers';

/**
 * Which chain escrow settles on, and how this process pays for it.
 *
 * The backend decides the chain: POST /api/v1/tasks builds against the Base
 * escrow whenever BASE_ESCROW_ADDRESS is set, else against 0G (legacy). The
 * MCP has to agree with that decision or it funds the wrong thing — sending
 * native 0G value for a task the backend built as a USDC transferFrom, or
 * signing a Base tx on the 0G RPC. So instead of a parallel config here, ask
 * the backend which chain it posts on (GET /health/bridge, public) and
 * derive the rest from the chain id.
 *
 * Precedence: an explicit BLINDMARKET_SETTLEMENT override wins; otherwise the
 * backend's reported `postingChain` wins; otherwise (backends older than the
 * field) fall back to inferring from the Base signer capability below. That
 * inference can answer "0G" while the backend posts Base tasks (Base escrow
 * set, no Base marketplace signer) — which is exactly why postingChain
 * exists. Either way, discovery is a HINT, not a proof. The send paths in
 * rent.ts therefore verify the `to` of every unsigned tx against the escrow
 * this mode expects before broadcasting, and a mismatch invalidates the
 * cache. That check, not this lookup, is what stops native value going to a
 * Base address on the 0G RPC.
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
 * Discovery is memoised with a short TTL (MCP servers are long-lived; a
 * process must notice when prod flips). BLINDMARKET_SETTLEMENT=0g|base forces
 * a mode (0g skips discovery entirely; base fails loudly if the backend is not
 * actually in Base mode rather than silently posting native tasks).
 */

export type SettlementMode = '0g' | 'base';

export interface OgSettlement {
  mode: '0g';
  decimals: 18;
  symbol: '0G';
  /** the 0G escrow as /health/bridge reports it (current backends report it
   *  even when 0G can't settle); undefined from older backends or when
   *  forced to 0g. Used to verify unsigned txs. */
  escrowAddress?: string;
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
  /** read-only: allowance/balance/task-state checks and receipt polling. Never signs. */
  provider: JsonRpcProvider;
  /** the relay signs from this wallet — the API key's owner (Privy embedded).
   *  Checksummed: the backend stores owners lowercased and passes the address
   *  straight to Privy's lookup, which the web app only ever exercises with
   *  checksummed input. */
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

/** How long a discovered mode is trusted before being re-asked. Short enough
 *  that a long-lived server notices a prod flip within minutes; long enough
 *  that a quote→confirm pair never straddles two lookups. */
export const DISCOVERY_TTL_MS = 5 * 60 * 1000;

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

const isAddress = (a: unknown): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
// An escrow is never address(0); treating it as one would send value there.
const isEscrowAddress = (a: unknown): a is string => isAddress(a) && !/^0x0{40}$/.test(a);

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
  let json: any;
  try {
    const res = await f(`${deps.apiBase}/health/bridge`);
    json = await res.json();
  } catch (e) {
    throw err(
      'SETTLEMENT_UNKNOWN',
      `Could not reach ${deps.apiBase}/health/bridge to learn which chain escrow settles on (${(e as Error).message}). ` +
      'Set BLINDMARKET_SETTLEMENT=0g to force the legacy local-wallet path, or =base to require the relay.',
    );
  }
  // The backend wraps every error (4xx/5xx) in the same JSON envelope with
  // success:false. That is an answer we cannot use, not an answer of "0G".
  if (json?.success === false || typeof json !== 'object' || json === null) {
    throw err(
      'SETTLEMENT_UNKNOWN',
      `${deps.apiBase}/health/bridge answered with an error envelope (${json?.error?.code ?? 'no code'}: ${json?.error?.message ?? 'no message'}). ` +
      'Refusing to guess the settlement chain. Set BLINDMARKET_SETTLEMENT=0g to force the legacy path.',
    );
  }
  const data = json?.data ?? json;
  const bridge = data?.base ?? null;

  // R15: trust the backend's posting chain over signer-capability inference
  // (an explicit BLINDMARKET_SETTLEMENT=base override is handled below and
  // keeps its precedence — this branch only runs unforced).
  if (!forced) {
    const posted = await settlementFromPostingChain(data, deps, env);
    if (posted) return posted;
  }

  if (!bridge?.configured) {
    if (forced === 'base') {
      // /health/bridge reports Base only when the backend can sign for it
      // (Base escrow and Base marketplace signer), while POST /tasks routes
      // on config.baseEscrowAddress alone — which itself falls back to the
      // generated contractAddresses.ts, so a backend with nothing about Base
      // in its .env still builds Base transactions. Refusing here would block
      // exactly that (very common) setup. So when the operator has forced
      // base, let them name the escrow explicitly instead of asking health to
      // vouch for it. This is not a loosening of safety: verifyTarget still
      // checks every unsigned tx against this address before anything is
      // sent, so a wrong guess refuses rather than misfunding.
      const escrowOverride = env.BLINDMARKET_BASE_ESCROW_ADDRESS;
      if (!isAddress(escrowOverride)) {
        throw err(
          'SETTLEMENT_MISMATCH',
          'BLINDMARKET_SETTLEMENT=base but /health/bridge does not report a Base escrow. That endpoint needs the Base marketplace signer, while task creation needs only the Base escrow address — so this is expected on a backend that posts Base tasks without the Base signer. Set BLINDMARKET_BASE_ESCROW_ADDRESS (and BLINDMARKET_BASE_CHAIN_ID if not 84532) to the escrow the backend builds against, or complete the bridge config.',
        );
      }
      const forcedChainId = Number(env.BLINDMARKET_BASE_CHAIN_ID ?? 84532);
      return buildBaseSettlement(forcedChainId, escrowOverride, env, deps);
    }
    // Carry the 0G escrow address when the bridge reports it, so the 0G send
    // path can verify the backend really built a 0G tx (see file comment).
    return isEscrowAddress(data?.escrowAddress)
      ? { ...OG_SETTLEMENT, escrowAddress: getAddress(data.escrowAddress) }
      : OG_SETTLEMENT;
  }

  if (!isEscrowAddress(bridge.escrowAddress)) {
    throw err('SETTLEMENT_UNKNOWN', `Backend reports Base configured but no escrow address (${bridge.escrowAddress}).`);
  }
  return buildBaseSettlement(Number(bridge.chainId), bridge.escrowAddress, env, deps);
}

/** Settle from the backend's reported posting chain (R15). Returns null when
 *  the backend predates the field so the caller falls back to the legacy
 *  signer-capability inference. A present-but-unknown chain, or a Base claim
 *  with no usable escrow/chain id, throws rather than guessing: falling back
 *  to 0G there would fund the wrong escrow. */
async function settlementFromPostingChain(
  data: any,
  deps: DiscoverDeps,
  env: NodeJS.ProcessEnv,
): Promise<Settlement | null> {
  const postingChain = data?.postingChain;
  if (postingChain == null) return null;
  if (postingChain === '0g') {
    return isEscrowAddress(data?.postingEscrowAddress)
      ? { ...OG_SETTLEMENT, escrowAddress: getAddress(data.postingEscrowAddress) }
      : OG_SETTLEMENT;
  }
  if (postingChain === 'base') {
    if (!isEscrowAddress(data?.postingEscrowAddress)) {
      throw err('SETTLEMENT_UNKNOWN', `Backend says it posts on Base but reports no escrow address (${data?.postingEscrowAddress}).`);
    }
    const chainId = Number(data?.postingChainId);
    if (!Number.isInteger(chainId)) {
      throw err('SETTLEMENT_UNKNOWN', `Backend says it posts on Base but reports no chain id (${data?.postingChainId}).`);
    }
    return buildBaseSettlement(chainId, data.postingEscrowAddress, env, deps);
  }
  throw err('SETTLEMENT_UNKNOWN', `Backend posts on "${postingChain}", which this MCP cannot settle — update @blindmarket/mcp-server.`);
}

/** Assemble a Base settlement from a chain id and escrow address, whichever
 *  way they were learned (health, or an explicit override). Everything else —
 *  USDC, RPC, relay label, the paying wallet — is derived here so both routes
 *  agree. */
async function buildBaseSettlement(
  chainId: number,
  escrow: string,
  env: NodeJS.ProcessEnv,
  deps: DiscoverDeps,
): Promise<BaseSettlement> {
  const relayChain = relayChainFor(chainId);
  if (!relayChain) {
    throw err('UNSUPPORTED_BASE_CHAIN', `Base chainId ${chainId} is not one relay-tx supports (8453 or 84532).`);
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
  if (!isAddress(who?.address)) {
    throw err(
      'RELAY_WALLET_UNKNOWN',
      `whoami returned "${who?.address}" — the API key must belong to a wallet (not the legacy AGENT_API_KEY principal) for the relay to sign from it.`,
    );
  }

  return {
    mode: 'base',
    chainId,
    escrowAddress: getAddress(escrow),
    usdcAddress: getAddress(usdcAddress),
    decimals: 6,
    symbol: 'USDC',
    relayChain,
    rpcUrl,
    provider: new JsonRpcProvider(rpcUrl, chainId),
    payFrom: getAddress(who.address),
  };
}

export interface SettlementResolver {
  (): Promise<Settlement>;
  /** Drop the cached answer. Called when a send path proves it wrong (the
   *  backend built a tx for an escrow this mode does not expect). */
  invalidate(): void;
}

/** Memoised discovery with a TTL. Errors are not cached, so a transient
 *  backend outage can be retried on the next spend call. */
export function createSettlementResolver(deps: DiscoverDeps, ttlMs = DISCOVERY_TTL_MS, now = Date.now): SettlementResolver {
  let cached: { value: Settlement; at: number } | null = null;
  const resolve = (async () => {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    const value = await discoverSettlement(deps);
    cached = { value, at: now() };
    return value;
  }) as SettlementResolver;
  resolve.invalidate = () => { cached = null; };
  return resolve;
}
