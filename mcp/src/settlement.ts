import { JsonRpcProvider, getAddress } from 'ethers';

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
 * Discovery is a HINT, not a proof. /health/bridge reports Base only when the
 * backend can sign for Base (its escrow and marketplace signer), while task
 * creation routes on BASE_ESCROW_ADDRESS alone — so a backend with a Base
 * escrow but no Base signer answers "0G" here and builds Base transactions
 * there. The send paths in rent.ts
 * therefore verify the `to` of every unsigned tx against the escrow this
 * mode expects before broadcasting, and a mismatch invalidates the cache.
 * That check, not this lookup, is what stops native value going to a Base
 * address on the 0G RPC.
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
 * Backends that name their posting chain (`postingChain` plus a `chains[]`
 * entry per settlement chain on /health/bridge) are read directly: the
 * posting chain is where POST /api/v1/tasks builds, and its entry says what
 * the escrow is paid in, which picks the payment path (`payment`):
 *
 *   relay-erc20  — an ERC-20 settlement token on a chain the relay serves.
 *   local-erc20  — an ERC-20 settlement token on a chain the relay does not
 *                  serve (Arc: gas is paid in USDC, and there is no Privy
 *                  relay). The local wallet (BLINDMARKET_PRIVATE_KEY) signs
 *                  the approve and the createTask itself, over that chain's
 *                  RPC. It must be the API key's owner: tasks are posted as
 *                  that wallet, so any other escrow would be funded and then
 *                  refused at /a2a/tasks/index (NOT_TASK_AGENT).
 *   local-native — the native coin, which this process pays only on 0G.
 *
 * Anything else is UNSUPPORTED_SETTLEMENT rather than a guess. An older
 * backend (no `postingChain`) keeps the `base`-block discovery above.
 *
 * Discovery is memoised with a short TTL (MCP servers are long-lived; a
 * process must notice when prod flips). BLINDMARKET_SETTLEMENT names a chain
 * key: 0g skips discovery entirely; any other key must be a chain the backend
 * has an escrow on, which is how an executor finishes (or a poster refunds) a
 * task on a chain the backend no longer posts on. New tasks can only be
 * funded on the posting chain, so post_task and rent_service refuse on any
 * other (NOT_POSTING_CHAIN). On an older backend only "base" exists, and it
 * fails loudly if the backend is not in Base mode rather than silently
 * posting native tasks.
 */

/** The backend's chain key: '0g', 'base', and whatever it adds later. The
 *  spend ledger records it, so it is never re-derived from the payment path. */
export type SettlementMode = string;

/** How a spend is paid; the send paths branch on this, never on the key. */
export type PaymentKind = 'local-native' | 'relay-erc20' | 'local-erc20';

/** The escrow's settlement token, as the backend describes it. */
export interface SettlementToken {
  kind: 'native' | 'erc20';
  /** the zero address for a native coin */
  address: string;
  symbol: string;
  decimals: number;
}

/** What a chain-aware backend said besides the chain this process settles on.
 *  Absent on an older backend, or when forced to 0g without asking. */
interface BackendChains {
  /** where POST /api/v1/tasks builds new tasks */
  postingChain?: SettlementMode;
  /** every chain the backend has an escrow on */
  escrowChains?: SettlementMode[];
}

export interface OgSettlement extends BackendChains {
  payment: 'local-native';
  mode: '0g';
  chain: '0g';
  /** from the backend; undefined when forced to 0g */
  chainId?: number;
  token: SettlementToken;
  decimals: 18;
  symbol: '0G';
  /** the 0G escrow as /health/bridge reports it (current backends report it
   *  even when 0G can't settle); undefined from older backends or when
   *  forced to 0g. Used to verify unsigned txs. */
  escrowAddress?: string;
}

export interface RelaySettlement extends BackendChains {
  payment: 'relay-erc20';
  mode: SettlementMode;
  chain: SettlementMode;
  chainId: number;
  escrowAddress: string;
  token: SettlementToken;
  /** the settlement token's address (`token.address`; USDC on every relay
   *  chain so far), kept under its old name for existing readers */
  usdcAddress: string;
  decimals: number;
  symbol: string;
  /** the `chain` value relay-tx expects — see backend relayChains.ts */
  relayChain: string;
  rpcUrl: string;
  /** read-only: allowance/balance/task-state checks and receipt polling. Never signs. */
  provider: JsonRpcProvider;
  /** the relay signs from this wallet — the API key's owner (Privy embedded).
   *  Checksummed: the backend stores owners lowercased and passes the address
   *  straight to Privy's lookup, which the web app only ever exercises with
   *  checksummed input. */
  payFrom: string;
}

/** Every relay settlement. The name predates chains other than Base. */
export type BaseSettlement = RelaySettlement;

/** An ERC-20 escrow on a chain the relay does not serve: the local wallet
 *  signs everything itself, over this chain's RPC. */
export interface LocalErc20Settlement extends BackendChains {
  payment: 'local-erc20';
  mode: SettlementMode;
  chain: SettlementMode;
  chainId: number;
  escrowAddress: string;
  token: SettlementToken;
  /** the settlement token's address, under the name the relay settlement uses */
  usdcAddress: string;
  decimals: number;
  symbol: string;
  rpcUrl: string;
  /** reads, and the transport the local wallet signs over; checked to serve `chainId` */
  provider: JsonRpcProvider;
  /** the local wallet, checksummed: checked at discovery to be the API key's owner */
  payFrom: string;
}

/** Every settlement that escrows an ERC-20, however it is signed. */
export type Erc20Settlement = RelaySettlement | LocalErc20Settlement;

export type Settlement = OgSettlement | RelaySettlement | LocalErc20Settlement;

export function isErc20Settlement(s: Settlement): s is Erc20Settlement {
  return s.payment === 'relay-erc20' || s.payment === 'local-erc20';
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const OG_TOKEN: SettlementToken = { kind: 'native', address: ZERO_ADDRESS, symbol: '0G', decimals: 18 };

export const OG_SETTLEMENT: OgSettlement = { payment: 'local-native', mode: '0g', chain: '0g', token: OG_TOKEN, decimals: 18, symbol: '0G' };

const USDC_ON_BASE = { symbol: 'USDC', decimals: 6 } as const;

// Mirrors frontend/src/config/constants.ts BASE_USDC_ADDRESS. Overridable via
// BLINDMARKET_USDC_ADDRESS for a chain not listed here.
export const BASE_USDC: Readonly<Record<number, string>> = {
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
};

export const BASE_RPC: Readonly<Record<number, string>> = {
  8453: 'https://base-rpc.publicnode.com',
  84532: 'https://base-sepolia-rpc.publicnode.com',
};

/** Public RPCs for chains this process may sign on, by chain id. An env
 *  override (BLINDMARKET_<CHAIN>_RPC_URL) always wins. Arc mainnet and Arc
 *  Testnet share the chain key 'arc', so the id the backend names picks one. */
export const PUBLIC_RPC: Readonly<Record<number, string>> = {
  ...BASE_RPC,
  5042: 'https://arc-rpc.publicnode.com',
  5042002: 'https://arc-testnet-rpc.publicnode.com',
};

/** How long a discovered mode is trusted before being re-asked. Short enough
 *  that a long-lived server notices a prod flip within minutes; long enough
 *  that a quote→confirm pair never straddles two lookups. */
export const DISCOVERY_TTL_MS = 5 * 60 * 1000;

export function relayChainFor(chainId: number): 'base-mainnet' | 'base-sepolia' | null {
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
/** The shape of a backend chain key (backend a2a.ts registerSchema). */
const CHAIN_KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
// An escrow is never address(0); treating it as one would send value there.
const isEscrowAddress = (a: unknown): a is string => isAddress(a) && !/^0x0{40}$/.test(a);

export interface DiscoverDeps {
  apiBase: string;
  /** authenticated GET — only used for whoami, which needs the API key */
  api: <T = any>(method: string, path: string, body?: unknown) => Promise<T>;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** The local wallet's address (BLINDMARKET_PRIVATE_KEY), when one is set:
   *  what pays on an ERC-20 chain the relay does not serve. */
  localWallet?: string;
}

/** One discovery. Wrap with createSettlementResolver for the memoised form. */
export async function discoverSettlement(deps: DiscoverDeps): Promise<Settlement> {
  const env = deps.env ?? process.env;
  const forced = env.BLINDMARKET_SETTLEMENT;
  if (forced && !CHAIN_KEY.test(forced)) {
    throw err('BAD_SETTLEMENT', `BLINDMARKET_SETTLEMENT must be a chain key such as "0g" or "base", got "${forced}"`);
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
  if (data && typeof data === 'object' && 'postingChain' in data) return settlementFromPostingChain(data, forced, env, deps);

  // An older backend: only 0G and Base exist, and Base is read from `base`.
  if (forced && forced !== 'base') {
    throw err('BAD_SETTLEMENT', `BLINDMARKET_SETTLEMENT="${forced}", but this backend predates chain keys and settles only on "0g" or "base".`);
  }
  const bridge = data?.base ?? null;

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

/**
 * A backend that names its posting chain: POST /api/v1/tasks builds there, so
 * that chain's `chains[]` entry decides the payment path. Its escrow, token and
 * relay label come from the backend, not from tables here.
 */
async function settlementFromPostingChain(
  data: any,
  forced: string | undefined,
  env: NodeJS.ProcessEnv,
  deps: DiscoverDeps,
): Promise<Settlement> {
  const posting = data.postingChain;
  if (typeof posting !== 'string' || !CHAIN_KEY.test(posting)) {
    throw err(
      'SETTLEMENT_UNKNOWN',
      `${deps.apiBase}/health/bridge names no usable posting chain (${data.postingChainError ?? JSON.stringify(posting)}). ` +
      'Refusing to guess where new tasks are escrowed. Set BLINDMARKET_SETTLEMENT=0g to force the legacy local-wallet path.',
    );
  }
  const chains: any[] = Array.isArray(data.chains) ? data.chains : [];
  const escrowChains: string[] = chains
    .filter((c) => typeof c?.chain === 'string' && isEscrowAddress(c.escrowAddress))
    .map((c) => c.chain);
  const backendChains = { postingChain: posting, escrowChains };

  // Forced to another chain the backend has an escrow on: tasks already there
  // can still be delivered, cancelled and reclaimed; post_task and
  // rent_service refuse (they fund on the posting chain only).
  const target = forced ?? posting;
  if (forced && !escrowChains.includes(forced)) {
    throw err(
      'BAD_SETTLEMENT',
      `BLINDMARKET_SETTLEMENT="${forced}" is not a chain this backend has an escrow on (${escrowChains.join(', ') || 'none'}).`,
    );
  }

  const entry = chains.find((c) => c?.chain === target);
  if (!entry) {
    throw err('SETTLEMENT_UNKNOWN', `The backend posts on ${posting} but lists no such chain in chains[] on /health/bridge.`);
  }
  if (target === posting && (!entry.postable || !isEscrowAddress(entry.escrowAddress))) {
    throw err(
      'SETTLEMENT_NOT_POSTABLE',
      `The backend posts on ${posting} but has no escrow or settlement token configured there, so POST /api/v1/tasks refuses (CHAIN_NOT_CONFIGURED). Fix the backend's config for ${posting}.`,
    );
  }
  const chainId = Number(entry.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw err('SETTLEMENT_UNKNOWN', `The backend lists ${target} with no usable chain id (${JSON.stringify(entry.chainId)}).`);
  }
  // The backend serves addresses as configured, so a mixed-case one may carry
  // a bad checksum; it compares them lowercased, and so does this.
  const escrow = String(entry.escrowAddress).toLowerCase();
  const token = entry.token;

  if (token?.kind === 'native') {
    // The local wallet signs over BLINDMARKET_RPC_URL, a 0G RPC, and native
    // 0G is all it has ever paid. A native coin anywhere else is not a guess
    // worth making with real value.
    if (target !== '0g' || token.decimals !== 18) {
      throw err(
        'UNSUPPORTED_SETTLEMENT',
        `The backend settles ${target} in native ${token.symbol} (${token.decimals} decimals). This MCP pays native escrow only on 0G, from BLINDMARKET_PRIVATE_KEY.`,
      );
    }
    return { ...OG_SETTLEMENT, ...backendChains, chainId, escrowAddress: getAddress(escrow) };
  }

  if (token?.kind === 'erc20') {
    if (!isEscrowAddress(token.address) || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36 || typeof token.symbol !== 'string') {
      throw err('SETTLEMENT_UNKNOWN', `The backend describes ${target}'s settlement token incompletely (${JSON.stringify(token)}).`);
    }
    if (typeof entry.relayChain !== 'string' || !entry.relayChain) {
      // No relay on this chain (Arc): the local wallet signs, or nothing does.
      if (!deps.localWallet) {
        throw err(
          'UNSUPPORTED_SETTLEMENT',
          `The backend settles ${target} in ${token.symbol} (ERC-20), and its relay does not serve ${target}, so this process has to sign there itself. ` +
          `Set BLINDMARKET_PRIVATE_KEY to the key of the wallet that owns BLINDMARKET_API_KEY; it pays the escrow and ${target}'s gas (${entry.gasSymbol ?? 'the native coin'}).`,
        );
      }
      const local = await buildLocalErc20Settlement(
        { chain: target, chainId, escrow, token: { kind: 'erc20', address: String(token.address).toLowerCase(), symbol: token.symbol, decimals: token.decimals } },
        env,
        deps,
      );
      return { ...local, ...backendChains };
    }
    // The env override predates backends that name the token. Here it can
    // only disagree with the one token POST /api/v1/tasks accepts.
    const override = env.BLINDMARKET_USDC_ADDRESS;
    if (isAddress(override) && override.toLowerCase() !== token.address.toLowerCase()) {
      throw err(
        'TOKEN_MISMATCH',
        `BLINDMARKET_USDC_ADDRESS=${override}, but the backend settles ${target} in ${token.symbol} at ${token.address}; POST /api/v1/tasks refuses any other token. Unset it.`,
      );
    }
    const relay = await buildRelaySettlement(
      { chain: target, chainId, escrow, token: { kind: 'erc20', address: String(token.address).toLowerCase(), symbol: token.symbol, decimals: token.decimals }, relayChain: entry.relayChain },
      env,
      deps,
    );
    return { ...relay, ...backendChains };
  }

  throw err('UNSUPPORTED_SETTLEMENT', `The backend settles ${target} in a token this MCP cannot pay (${JSON.stringify(token)}).`);
}

/** The env var that overrides a chain's RPC. */
export function rpcEnvName(chain: string): string {
  return chain === 'base' ? 'BLINDMARKET_BASE_RPC_URL' : `BLINDMARKET_${chain.toUpperCase().replace(/-/g, '_')}_RPC_URL`;
}

/** An RPC for a chain: its env override, else a public one this file knows. */
export function rpcFor(chain: string, chainId: number, env: NodeJS.ProcessEnv): string | null {
  return env[rpcEnvName(chain)] ?? PUBLIC_RPC[chainId] ?? null;
}

/** A local-signing settlement on an ERC-20 chain the relay does not serve.
 *  Checked before any spend can use it: the RPC must serve the chain the
 *  backend names (a wrong RPC would sign on another network), and the local
 *  wallet must be the API key's owner (the task is posted as that wallet). */
async function buildLocalErc20Settlement(
  p: { chain: string; chainId: number; escrow: string; token: SettlementToken },
  env: NodeJS.ProcessEnv,
  deps: DiscoverDeps,
): Promise<LocalErc20Settlement> {
  const { chain, chainId } = p;
  const rpcUrl = rpcFor(chain, chainId, env);
  if (!rpcUrl) {
    throw err('RPC_UNKNOWN', `No RPC known for ${chain} (chainId ${chainId}) — set ${rpcEnvName(chain)}.`);
  }
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  let served: number;
  try {
    served = Number(BigInt(await provider.send('eth_chainId', [])));
  } catch (e) {
    throw err('RPC_UNREACHABLE', `${rpcEnvName(chain)} (${rpcUrl}) did not answer eth_chainId: ${(e as Error).message}`);
  }
  if (served !== chainId) {
    throw err('WRONG_RPC', `${rpcEnvName(chain)} serves chain ${served}, not ${chain} (${chainId}). Nothing is signed until it points at ${chain}.`);
  }

  const who = await deps.api<{ address: string; addresses?: string[] }>('GET', '/api/v1/api-keys/whoami');
  if (!isAddress(who?.address)) {
    throw err('OWNER_UNKNOWN', `whoami returned "${who?.address}" — the API key must belong to a wallet (not the legacy AGENT_API_KEY principal) to post on ${chain}.`);
  }
  const local = getAddress(deps.localWallet!);
  if (who.address.toLowerCase() !== local.toLowerCase()) {
    throw err(
      'OWNER_MISMATCH',
      `BLINDMARKET_API_KEY belongs to ${who.address} but BLINDMARKET_PRIVATE_KEY is ${local}. On ${chain} the local wallet signs, and tasks are posted and delivered as the API key's wallet, ` +
      'so an escrow funded from any other wallet is refused at listing (NOT_TASK_AGENT). Use that wallet\'s key, or mint an API key signed in as this one. Nothing was sent.',
    );
  }

  const tokenAddress = getAddress(p.token.address);
  return {
    payment: 'local-erc20',
    mode: chain,
    chain,
    chainId,
    escrowAddress: getAddress(p.escrow),
    token: { ...p.token, address: tokenAddress },
    usdcAddress: tokenAddress,
    decimals: p.token.decimals,
    symbol: p.token.symbol,
    rpcUrl,
    provider,
    payFrom: local,
  };
}

/** Assemble a Base settlement from a chain id and escrow address, whichever
 *  way an older backend let them be learned (health, or an explicit
 *  override). USDC and the relay label come from the tables here. */
async function buildBaseSettlement(
  chainId: number,
  escrow: string,
  env: NodeJS.ProcessEnv,
  deps: DiscoverDeps,
): Promise<RelaySettlement> {
  const relayChain = relayChainFor(chainId);
  if (!relayChain) {
    throw err('UNSUPPORTED_BASE_CHAIN', `Base chainId ${chainId} is not one relay-tx supports (8453 or 84532).`);
  }
  const usdcAddress = usdcFor(chainId, env.BLINDMARKET_USDC_ADDRESS);
  if (!usdcAddress) {
    throw err('USDC_UNKNOWN', `No USDC address known for chainId ${chainId} — set BLINDMARKET_USDC_ADDRESS.`);
  }
  return buildRelaySettlement(
    { chain: 'base', chainId, escrow, token: { kind: 'erc20', address: usdcAddress, ...USDC_ON_BASE }, relayChain },
    env,
    deps,
  );
}

/** A relay settlement from its chain facts, however they were learned. The
 *  RPC and the paying wallet are resolved here so every route agrees. */
async function buildRelaySettlement(
  p: { chain: string; chainId: number; escrow: string; token: SettlementToken; relayChain: string },
  env: NodeJS.ProcessEnv,
  deps: DiscoverDeps,
): Promise<RelaySettlement> {
  const { chain, chainId } = p;
  const rpcUrl = rpcFor(chain, chainId, env);
  if (!rpcUrl) {
    throw err('RPC_UNKNOWN', `No RPC known for ${chain} (chainId ${chainId}) — set ${rpcEnvName(chain)}.`);
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

  const tokenAddress = getAddress(p.token.address);
  return {
    payment: 'relay-erc20',
    mode: chain,
    chain,
    chainId,
    escrowAddress: getAddress(p.escrow),
    token: { ...p.token, address: tokenAddress },
    usdcAddress: tokenAddress,
    decimals: p.token.decimals,
    symbol: p.token.symbol,
    relayChain: p.relayChain,
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
