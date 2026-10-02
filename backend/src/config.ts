import 'dotenv/config';
import { CONTRACT_ADDRESSES, DEPLOYMENT_BLOCKS } from './contractAddresses.js';
import NETWORKS from './config/networks.json' with { type: 'json' };
import { chainTier, readSettlementTier, tierMismatches, TIER_CHAIN_IDS } from './services/settlementTier.js';

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Collapse an undeployed placeholder address to '' so callers can treat it as unset. */
function unsetIfZero(address: string): string {
  return address.toLowerCase() === ZERO_ADDRESS ? '' : address;
}

/**
 * NODE_ENV is the single switch. Two values, two coherent stacks:
 *
 *   NODE_ENV=production   → SETTLEMENT_TIER=mainnet, DEPLOYMENT_ID=production,
 *                          ALLOW_NONMAINNET_PROD unset, boot prod posture
 *   NODE_ENV=development  → no tier, no DEPLOYMENT_ID, no Redis claim,
 *                          local dev posture
 *
 * SETTLEMENT_TIER and DEPLOYMENT_ID can still be set explicitly to override
 * (a testnet production deploy sets SETTLEMENT_TIER=testnet while keeping
 * NODE_ENV=production), but the common case needs one knob, not three.
 * A contradiction between NODE_ENV and SETTLEMENT_TIER/DEPLOYMENT_ID is
 * reported at boot, not silently overwritten.
 */
function deriveFromNodeEnv(): void {
  const nodeEnv = (process.env.NODE_ENV ?? '').trim().toLowerCase();
  if (nodeEnv === 'production') {
    if (!process.env.SETTLEMENT_TIER) process.env.SETTLEMENT_TIER = 'mainnet';
    if (!process.env.DEPLOYMENT_ID) process.env.DEPLOYMENT_ID = 'production';
  }
  // development: no tier, no id, dev posture — nothing to fill.
}

deriveFromNodeEnv();

const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * The network tier every chain follows, or null when each keeps its own
 * default (see services/settlementTier.ts). Read here, at import, so a typo
 * fails before anything is configured from it.
 */
const SETTLEMENT_TIER = readSettlementTier(process.env);

/**
 * Which deployment set this backend runs as: '' (default — production and
 * local dev, addresses from the generated records) or 'staging' (names its
 * own contracts via env, enforced by DEPLOYMENT_SET_REQUIRED_ENV).
 */
const DEPLOYMENT_SET = parseDeploymentSet(process.env.DEPLOYMENT_SET);

/**
 * A contract address from its generated record (contracts/deployments via
 * sync-addresses.ts), selected by chain id. The environment NEVER overrides
 * it on the default set: set the chain id (OG_CHAIN_ID, BASE_CHAIN_ID,
 * ARC_CHAIN_ID), not the address. A *_ADDRESS env var there is ignored with
 * a warning — delete it. Only a staging stack reads addresses from env.
 */
const warnedAddressEnv = new Set<string>();
function recordAddress(envKey: string, generated: string | undefined): string {
  const raw = (process.env[envKey] ?? '').trim();
  if (DEPLOYMENT_SET === 'staging') return raw;
  if (raw && raw.toLowerCase() !== (generated ?? '').toLowerCase()) {
    if (!warnedAddressEnv.has(envKey)) {
      warnedAddressEnv.add(envKey);
      console.warn(
        `[config] ${envKey} is set but ignored: contract addresses come from the generated record for this network. ` +
          `Unset it (staging stacks excepted).`,
      );
    }
  }
  return generated ?? '';
}

/** The tier's chain id for `key`, or `fallback` when no tier is set. */
function tierChainId(key: keyof typeof TIER_CHAIN_IDS, fallback: number): string {
  return String(SETTLEMENT_TIER ? TIER_CHAIN_IDS[key][SETTLEMENT_TIER] : fallback);
}

/**
 * contracts/ deployment set this backend's contracts are recorded in
 * (contracts/scripts/_deployments.ts). '' is the default set (production and
 * local dev); anything but default/staging is a typo and fails at load.
 */
export function parseDeploymentSet(raw: string | undefined): '' | 'staging' {
  const value = (raw ?? '').trim();
  if (value === '' || value === 'default') return '';
  if (value === 'staging') return 'staging';
  throw new Error(`DEPLOYMENT_SET="${value}" is not a deployment set. Use "default" (or leave it unset) or "staging".`);
}

/**
 * DEPLOYMENT_ID names one running stack ("production", "staging-testnet") for
 * the Redis ownership check in services/deploymentIdentity.ts. It is not
 * DEPLOYMENT_SET, which picks contract address records. Unset, the check never
 * claims a Redis and never stops this process. It is stored and logged
 * verbatim, so anything but a short lowercase name fails at load.
 */
export function parseDeploymentId(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (value === '') return null;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`DEPLOYMENT_ID="${value}" is not a deployment name: use lowercase letters, digits, ".", "_" or "-", at most 64 characters (e.g. "production", "staging-testnet").`);
  }
  return value;
}

/**
 * Which half of the backend this process runs, for split topologies (one API
 * container + one indexer container sharing a Redis, see docker-compose.yml).
 * `all` (default) is today's behaviour: HTTP + every background writer.
 * `api` serves HTTP and runs every writer EXCEPT the chain-event indexers;
 * `indexer` runs only those indexers and never binds a port. Anything else
 * fails at load — a typo must not silently drop indexing or double-poll.
 */
export type RunMode = 'all' | 'api' | 'indexer';

export function parseRunMode(raw: string | undefined): RunMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'all') return 'all';
  if (value === 'api' || value === 'indexer') return value;
  throw new Error(`RUN_MODE="${raw}" is not a run mode. Use "all" (HTTP + indexers), "api" (HTTP, no chain indexers) or "indexer" (chain indexers, no HTTP).`);
}

/** Where a production backend says it lives, when PUBLIC_*_URL is unset. */
export const PRODUCTION_PUBLIC_URLS = {
  PUBLIC_API_URL: 'https://api.blindmarket.xyz',
  PUBLIC_APP_URL: 'https://blindmarket.xyz',
} as const;

/**
 * Env vars a staging stack must set explicitly. Staging has no generated
 * records file, so it names its own contracts; a staging stack that forgot
 * one would otherwise fall back to production's addresses, production's RPC,
 * or production's public URLs. A zero address counts as set ("not deployed
 * on this stack"). VALIDATOR_POOL_ADDRESS has no production fallback either
 * (routes read it only on staging) but is listed so staging can't silently
 * omit its pool.
 */
export const DEPLOYMENT_SET_REQUIRED_ENV = [
  'OG_RPC_URL',
  'BLIND_ESCROW_ADDRESS',
  'TASK_REGISTRY_ADDRESS',
  'BLIND_REPUTATION_ADDRESS',
  'INFT_ADDRESS',
  'VALIDATOR_POOL_ADDRESS',
  'BASE_ESCROW_ADDRESS',
  'AGENT_FACTORY_ADDRESS',
  'ARC_ESCROW_ADDRESS',
  'ARC_AGENT_FACTORY_ADDRESS',
  'USDC_PAYMASTER_ADDRESS',
  'BLIND_ACCOUNT_FACTORY_ADDRESS',
  'ENTRY_POINT_ADDRESS',
  'PUBLIC_API_URL',
  'PUBLIC_APP_URL',
] as const;

/**
 * The chains each non-default set runs on, as contracts/scripts/
 * _deployments.ts SET_CHAINS lists them.
 */
const DEPLOYMENT_SET_CHAINS: Record<'staging', { og: number; base: number; arc: number }> = {
  staging: { og: 16602, base: 84532, arc: 5042002 },
};

/** Why a backend in `set` must not boot; empty for the default set. */
export function deploymentSetProblems(
  set: '' | 'staging',
  env: Record<string, string | undefined>,
  chainIds: { og: number; base: number; arc: number },
): string[] {
  if (!set) return [];
  const problems: string[] = [];
  const missing = DEPLOYMENT_SET_REQUIRED_ENV.filter((k) => !(env[k] ?? '').trim());
  if (missing.length > 0) {
    problems.push(
      `DEPLOYMENT_SET=${set} but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        `Unset or empty values fall back to production's; set each explicitly ` +
        `(0x0000000000000000000000000000000000000000 for a contract this stack does not deploy).`,
    );
  }
  for (const [key, url] of Object.entries(PRODUCTION_PUBLIC_URLS)) {
    if ((env[key] ?? '').trim().replace(/\/+$/, '') === url) {
      problems.push(`DEPLOYMENT_SET=${set} but ${key} is production's ${url}; point it at this stack.`);
    }
  }
  const want = DEPLOYMENT_SET_CHAINS[set];
  if (chainIds.og !== want.og || chainIds.base !== want.base) {
    problems.push(
      `DEPLOYMENT_SET=${set} runs on OG_CHAIN_ID=${want.og} and BASE_CHAIN_ID=${want.base}; ` +
        `this backend has ${chainIds.og} and ${chainIds.base}. Set both explicitly.`,
    );
  }
  if (chainIds.arc !== want.arc) {
    problems.push(`DEPLOYMENT_SET=${set} runs on Arc testnet (ARC_CHAIN_ID=${want.arc}); this backend has ARC_CHAIN_ID=${chainIds.arc}.`);
  }
  return problems;
}

// Base network this deployment settles on, and whether that network is Base
// MAINNET. Every Base default (RPC, USDC, contract table) keys off this chain
// id, not off NODE_ENV directly: a Base Sepolia deploy once got Base MAINNET's
// USDC address from NODE_ENV-keyed defaults (no contract on Sepolia → balances
// read 0, burns revert). NODE_ENV reaches it only through the tier it derives
// (deriveFromNodeEnv): production defaults to Base mainnet.
const BASE_CHAIN_ID = parseInt(optional('BASE_CHAIN_ID', tierChainId('base', IS_PROD ? 8453 : 84532)), 10);
const BASE_MAINNET = BASE_CHAIN_ID === TIER_CHAIN_IDS.base.mainnet;

const OG_CHAIN_ID = parseInt(optional('OG_CHAIN_ID', tierChainId('0g', IS_PROD ? 16661 : 16602)), 10);
const OG_MAINNET = OG_CHAIN_ID === TIER_CHAIN_IDS['0g'].mainnet;

// The settlement Base network's RPC and USDC. CCTP's Base leg reuses them when
// it is the same network (see cctp below). Defaults are sourced from
// config/networks.json (the shared network config) so backend, frontend,
// CLI, and MCP stay aligned.
const BASE_RPC_URL = optional('BASE_RPC_URL', BASE_MAINNET ? NETWORKS.networks.base.mainnet.rpcUrl : NETWORKS.networks.base.testnet.rpcUrl);
const BASE_USDC_ADDRESS = optional('BASE_USDC_ADDRESS', BASE_MAINNET ? NETWORKS.networks.base.mainnet.usdc : NETWORKS.networks.base.testnet.usdc);

// Arc network tasks settle on. It defaults from the tier: NODE_ENV=production
// derives SETTLEMENT_TIER=mainnet (deriveFromNodeEnv), so production runs Arc
// mainnet, and a stack with no tier (development) falls back to Arc testnet.
// An explicit ARC_CHAIN_ID wins; one that contradicts the tier is refused at
// boot (assertBootConfig).
const ARC_CHAIN_ID = parseInt(optional('ARC_CHAIN_ID', tierChainId('arc', TIER_CHAIN_IDS.arc.testnet)), 10);
const ARC_MAINNET = ARC_CHAIN_ID === TIER_CHAIN_IDS.arc.mainnet;

/** Arc mainnet RPC, sourced from config/networks.json. */
export const ARC_MAINNET_PUBLIC_RPC_URL = NETWORKS.networks.arc.mainnet.rpcUrl;
/**
 * Arc RPC. Defaults are read from config/networks.json so all packages
 * (backend, frontend, CLI, MCP) share the same endpoint table. Env vars
 * still override per-deployment.
 */
const ARC_RPC_URL = optional('ARC_RPC_URL', ARC_MAINNET ? NETWORKS.networks.arc.mainnet.rpcUrl : NETWORKS.networks.arc.testnet.rpcUrl);
// USDC's ERC-20 view has this address on Arc mainnet and testnet alike.
const ARC_USDC_ADDRESS = optional('ARC_USDC_ADDRESS', NETWORKS.networks.arc.mainnet.usdc);

// CCTP moves USDC into and out of the user's Arc wallet, so Arc is one leg of
// every transfer and the CCTP tier is Arc's. It used to be Base's, from when
// Base was the settlement chain: a Base-mainnet stack offered mainnet source
// chains while minting into Arc testnet.
const CCTP_MAINNET = ARC_MAINNET;

// Contract-address fallbacks are single-sourced from contracts/deployments/*.json
// via contracts/scripts/sync-addresses.ts (do not hand-edit contractAddresses.ts).
// Env vars still win at runtime; these are the no-env defaults.
// Keyed on the 0G chain this backend talks to, NOT NODE_ENV — the same rule
// Base has followed since BASE_CHAIN_ID. NODE_ENV=production with
// OG_CHAIN_ID=16602 used to load MAINNET addresses onto a testnet chain (and
// a script with OG_CHAIN_ID=16661 and no NODE_ENV got testnet ones). The two
// combinations that run — production on 16661, development on 16602 — resolve
// exactly as before; config.legacy.test.ts pins them.
const ADDR = OG_MAINNET ? CONTRACT_ADDRESSES.mainnet : CONTRACT_ADDRESSES.testnet;
// Cast to a shape with optional keys: the generator now omits `blindEscrow`/
// `agentFactory` entirely for a network that hasn't been deployed yet (e.g.
// `base` today), so the two branches of this union no longer share the same
// keys and a plain union type would make `BASE_ADDR.blindEscrow` a compile
// error even under optional chaining.
const BASE_ADDR = (BASE_MAINNET ? CONTRACT_ADDRESSES.base : CONTRACT_ADDRESSES.baseTestnet) as {
  readonly blindEscrow?: string;
  readonly agentFactory?: string;
  readonly USDC: string;
};

/** A generated Arc record: its addresses, and the blocks they were deployed in. */
export interface ArcGeneratedRecord {
  addresses: { readonly blindEscrow?: string; readonly agentFactory?: string; readonly USDC?: string; readonly blindAgentDelegate?: string };
  blocks: { readonly blindEscrow?: number; readonly agentFactory?: number };
}

/**
 * The generated record for the Arc network `chainId` (`arc` from
 * contracts/deployments/arc-mainnet.json, `arcTestnet` from arc-testnet.json),
 * or null for a network with no record. Nothing falls back to another
 * network's record, whose factory address would be polled for deploy credits
 * on a chain it is not on.
 */
export function arcGeneratedRecord(chainId: number): ArcGeneratedRecord | null {
  const tier = chainTier('arc', chainId);
  if (!tier) return null;
  const key = tier === 'mainnet' ? 'arc' : 'arcTestnet';
  const addresses = (CONTRACT_ADDRESSES as { readonly [k: string]: ArcGeneratedRecord['addresses'] | undefined })[key];
  if (!addresses) return null;
  const blocks = (DEPLOYMENT_BLOCKS as { readonly [k: string]: ArcGeneratedRecord['blocks'] | undefined })[key] ?? {};
  return { addresses, blocks };
}

const ARC_RECORD = arcGeneratedRecord(ARC_CHAIN_ID);
const ARC_ADDR = ARC_RECORD?.addresses;

// The escrow this backend polls: the generated record for this Arc network,
// selected by ARC_CHAIN_ID above. Set the chain id, not the address.
const ARC_ESCROW = unsetIfZero(recordAddress('ARC_ESCROW_ADDRESS', ARC_ADDR?.blindEscrow ?? ''));

/**
 * The block the Arc escrow was deployed in: nothing before it can hold one of
 * its events. ARC_ESCROW_DEPLOYMENT_BLOCK wins; otherwise the block in the
 * generated record for this Arc network, when the configured escrow is that
 * record's (same guard as the factory side: an escrow can share another
 * network's address with the same deployer and nonce, and the wrong network's
 * block would start the index past the head); otherwise 0 (unknown), and the
 * indexer starts at the head.
 */
function arcEscrowDeploymentBlock(): number {
  const fromEnv = Number(process.env.ARC_ESCROW_DEPLOYMENT_BLOCK ?? 0);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  if (
    ARC_RECORD &&
    ARC_ESCROW &&
    ARC_RECORD.addresses.blindEscrow?.toLowerCase() === ARC_ESCROW.toLowerCase()
  ) {
    return ARC_RECORD.blocks.blindEscrow ?? 0;
  }
  return 0;
}

export const config = {
  port: parseInt(optional('PORT', '3001'), 10),
  nodeEnv: optional('NODE_ENV', 'development'),
  // Error monitoring — unset DSN disables Sentry entirely (see middleware/errorHandler.ts).
  sentryDsn: optional('SENTRY_DSN', ''),
  sentryEnvironment: optional('SENTRY_ENVIRONMENT', optional('NODE_ENV', 'development')),
  // Public base URLs for discovery surfaces (agent cards, OpenAPI, MCP docs).
  // The agent card previously advertised config.corsOrigin (the FRONTEND
  // origin list) as the API url — wrong on both counts.
  publicApiUrl: optional('PUBLIC_API_URL', IS_PROD ? PRODUCTION_PUBLIC_URLS.PUBLIC_API_URL : 'http://localhost:3001'),
  publicAppUrl: optional('PUBLIC_APP_URL', IS_PROD ? PRODUCTION_PUBLIC_URLS.PUBLIC_APP_URL : 'http://localhost:5173'),
  // Verification fails CLOSED: with 0G Compute unconfigured the sealed
  // verifier refuses to verify instead of auto-passing. Only an explicit
  // opt-in (or the vitest 'test' env) re-enables the local auto-pass stub,
  // and production ignores the flag entirely. See services/verification.ts.
  allowInsecureLocalVerify: optional('ALLOW_INSECURE_LOCAL_VERIFY', 'false').toLowerCase() === 'true',

  // 0G Chain (agent infra — TaskRegistry, Reputation, INFT). Defaults from
  // config/networks.json (shared with frontend, CLI, MCP).
  ogRpcUrl: optional('OG_RPC_URL', OG_MAINNET ? NETWORKS.networks.og.mainnet.rpcUrl : NETWORKS.networks.og.testnet.rpcUrl),
  ogChainId: OG_CHAIN_ID,

  // Base Chain (settlement — BlindEscrow, USDC payouts)
  baseRpcUrl: BASE_RPC_URL,
  baseChainId: BASE_CHAIN_ID,
  /**
   * The tier SETTLEMENT_TIER names, or null when each chain follows its own
   * default. Null does NOT mean the chains disagree: /health/bridge derives
   * the tier the stack is actually on from the chain ids.
   */
  settlementTier: SETTLEMENT_TIER,

  // Contracts — 0G (agent infra). Generated records selected by OG_CHAIN_ID
  // above; the *_ADDRESS env vars only take effect on a staging stack.
  blindEscrowAddress: unsetIfZero(recordAddress('BLIND_ESCROW_ADDRESS', ADDR.blindEscrow)),
  taskRegistryAddress: unsetIfZero(recordAddress('TASK_REGISTRY_ADDRESS', ADDR.taskRegistry)),
  blindReputationAddress: unsetIfZero(recordAddress('BLIND_REPUTATION_ADDRESS', ADDR.blindReputation)),
  inftAddress: unsetIfZero(recordAddress('INFT_ADDRESS', ADDR.inft)),
  validatorPoolAddress: unsetIfZero(recordAddress('VALIDATOR_POOL_ADDRESS', ADDR.validatorPool)),

  // Contracts — Base (settlement)
  // Zero here means Base isn't deployed on this network yet. Left as-is it is a
  // truthy string, which switches POST /tasks onto the Base escrow and points
  // createTask at address(0) — so collapse it to ''.
  baseEscrowAddress: unsetIfZero(recordAddress('BASE_ESCROW_ADDRESS', BASE_ADDR?.blindEscrow ?? '')),
  baseUsdcAddress: BASE_USDC_ADDRESS,
  // The generated module carries a zero-address placeholder for networks the
  // factory hasn't been deployed to yet. Treat that as "not configured" so the
  // listener stays disabled instead of polling address(0) forever.
  agentFactoryAddress: unsetIfZero(recordAddress('AGENT_FACTORY_ADDRESS', BASE_ADDR?.agentFactory || '')),

  // Arc Chain (settlement — USDC payouts, gas in USDC). ARC_CHAIN_ID picks
  // the network (5042 mainnet, 5042002 testnet) and the addresses and blocks
  // below follow it via the generated record (ARC_ESCROW above). Set the
  // chain id; set an address or block only to override the record (a redeploy
  // not yet recorded, or a staging stack that must name its own).
  arcRpcUrl: ARC_RPC_URL,
  // Optional archive RPC for Arc log scans. Public/free RPCs often prune history,
  // so eth_getLogs on old blocks fails; set this to an endpoint that keeps full
  // archive (or at least enough for your escrow's age).
  arcArchiveRpcUrl: optional('ARC_ARCHIVE_RPC_URL', ''),
  arcChainId: ARC_CHAIN_ID,
  arcEscrowAddress: ARC_ESCROW,
  arcUsdcAddress: ARC_USDC_ADDRESS,
  arcMarketplaceSignerPrivateKey: process.env.ARC_MARKETPLACE_SIGNER_PRIVATE_KEY || '',
  arcEscrowDeploymentBlock: arcEscrowDeploymentBlock(),
  // AgentFactory on Arc — the factory DeployAgentForm pays and the listener
  // indexes for deploy credits. The generated record for this Arc network.
  // (The Base `agentFactoryAddress` above is legacy: the wallet is Arc-only
  // and nothing polls the Base factory anymore.)
  arcAgentFactoryAddress: unsetIfZero(recordAddress('ARC_AGENT_FACTORY_ADDRESS', ARC_ADDR?.agentFactory || '')),
  // BlindAgentDelegate on Arc — the EIP-7702 delegate a sponsored agent wallet
  // points at (docs/AGENT-GAS-FUNDING.md). The generated record for this Arc
  // network; empty until it is deployed there, and sponsorship stays off.
  arcAgentDelegateAddress: unsetIfZero(recordAddress('ARC_AGENT_DELEGATE_ADDRESS', ARC_ADDR?.blindAgentDelegate || '')),

  // ERC-4337 AA infrastructure (Base) — agents pay gas in USDC instead of ETH.
  usdcPaymasterAddress: unsetIfZero(recordAddress('USDC_PAYMASTER_ADDRESS', (BASE_ADDR as any)?.USDCPaymaster ?? '')),
  blindAccountFactoryAddress: unsetIfZero(recordAddress('BLIND_ACCOUNT_FACTORY_ADDRESS', (BASE_ADDR as any)?.BlindAccountFactory ?? '')),
  entryPointAddress: unsetIfZero(recordAddress('ENTRY_POINT_ADDRESS', (BASE_ADDR as any)?.EntryPoint ?? '')),
  // Pimlico bundler for UserOp submission on Base
  pimlicoBundlerUrl: optional('PIMLICO_BUNDLER_URL', ''),
  pimlicoApiKey: optional('PIMLICO_API_KEY', ''),

  // Address of the 0G TEE enclave key, as registered on-chain via
  // BlindEscrow.setTeeSigner. Unset disables TEE-attested settlement and the
  // bridge falls back to the plain verifier path.
  teeSignerAddress: unsetIfZero(optional('TEE_SIGNER_ADDRESS', '')),

  // Auth — Privy is the sole identity provider; agent API key for service callers
  agentApiKey: process.env.AGENT_API_KEY || '',
  privyAppId: required('PRIVY_APP_ID').trim(),
  privyAppSecret: optional('PRIVY_APP_SECRET', ''),
  privyAuthorizationKey: optional('PRIVY_AUTHORIZATION_KEY', ''),
  // Mints registration tokens AND is the verification secret requireAuth
  // uses to accept them — see verifyRegistrationToken in middleware/auth.ts.
  jwtSecret: process.env.JWT_SECRET || '',
  // Gates the CLI/SDK device-flow registration write routes while
  // registration hardening lands. Defaults off.
  registrationEnabled: process.env.REGISTRATION_ENABLED === 'true',

  // Database (Neon PostgreSQL)
  databaseUrl: process.env.DATABASE_URL || '',

  // CORS
  corsOrigin: optional('CORS_ORIGIN', 'http://localhost:5173').split(',').map(s => s.trim()),

  // 0G Storage (Phase 3)
  ogStorageIndexerRpc: process.env.OG_STORAGE_INDEXER_RPC || '',
  ogStoragePrivateKey: process.env.OG_STORAGE_PRIVATE_KEY || '',

  // Marketplace signer — holds the verifier role on BlindEscrow. Used by the
  // A2A settlement bridge (services/a2aSettlement.ts) to call marketplaceAssign
  // (0G) and completeVerification (Base). Generated and rotated via
  // contracts/scripts/generate-marketplace-signer.ts + rotate-verifier.ts.
  marketplaceSignerPrivateKey: process.env.MARKETPLACE_SIGNER_PRIVATE_KEY || '',

  // Base marketplace signer — separate key for Base escrow interactions
  // (completeVerification on Base releases USDC). Same pattern as above but
  // targets the Base BlindEscrow.
  baseMarketplaceSignerPrivateKey: process.env.BASE_MARKETPLACE_SIGNER_PRIVATE_KEY || '',

  // contracts/ deployment set holding this stack's records ('' = the default
  // records, i.e. production). Only used to print ops commands that target the
  // right escrow — see contractsEnvPrefix in services/chainNetwork.ts.
  deploymentSet: DEPLOYMENT_SET,
  deploymentId: parseDeploymentId(process.env.DEPLOYMENT_ID),
  // Which half of the backend this process runs (all | api | indexer).
  runMode: parseRunMode(process.env.RUN_MODE),
  // Set for ONE boot to take this Redis over for DEPLOYMENT_ID from the
  // owner it names, or "unclaimed". Read as set and checked where it is used
  // (services/deploymentIdentity.ts): production ignores it, so a value left
  // there must not stop production booting.
  deploymentClaim: (process.env.DEPLOYMENT_CLAIM ?? '').trim() || null,

  // Forensic verification
  forensicMaxPhotoAgeMs: parseInt(optional('FORENSIC_MAX_PHOTO_AGE_MS', '1800000'), 10),  // 30 min
  forensicPhashThreshold: parseInt(optional('FORENSIC_PHASH_THRESHOLD', '10'), 10),

  // 0G Compute / Sealed Inference (Phase 4)
  // Private key for the broker wallet (pays for inference requests)
  ogComputePrivateKey: process.env.OG_COMPUTE_PRIVATE_KEY || '',
  // Optional: preferred provider address (if empty, auto-selects from available services)
  ogComputeProviderAddress: process.env.OG_COMPUTE_PROVIDER_ADDRESS || '',
  // RPC for compute network (defaults to testnet)
  ogComputeRpcUrl: optional('OG_COMPUTE_RPC_URL', 'https://evmrpc-testnet.0g.ai'),

  // Cascade exclusive-offer system. When disabled, tasks go straight to
  // CAS-race broadcast (first-come-first-served). Disable for single-agent
  // deployments to skip the 12s exclusive-offer window.
  cascadeEnabled: optional('CASCADE_ENABLED', 'true').toLowerCase() === 'true',

  // Semantic matching (embeddings). Provider-abstracted; defaults to the 'mock'
  // provider (deterministic hash vectors) so the whole pipeline builds and
  // tests without a key. Set EMBEDDING_PROVIDER=voyage|openai + EMBEDDING_API_KEY
  // to switch on real embeddings. EMBEDDING_DIM must match the pgvector column
  // dimension (migration 17); changing it requires a re-embed migration.
  embeddingProvider: optional('EMBEDDING_PROVIDER', 'mock').toLowerCase(), // mock | voyage | openai
  embeddingModel: optional('EMBEDDING_MODEL', 'voyage-3-large'),
  embeddingApiKey: process.env.EMBEDDING_API_KEY || '',
  embeddingDim: parseInt(optional('EMBEDDING_DIM', '1024'), 10),
  // Retrieve-then-rerank second stage. Embeddings give broad recall (KNN);
  // the reranker (Voyage rerank-2.5 cross-encoder, same key) reorders the
  // top-N by true query↔doc fit — the precision lever toward OKX-level
  // matching. A knob the tuning loop toggles; default off (measure the gain
  // before enabling in routing).
  rerankEnabled: optional('RERANK_ENABLED', 'false').toLowerCase() === 'true',
  rerankModel: optional('RERANK_MODEL', 'rerank-2.5'),
  // Phase 2 FLIP: when true, the cascade's exclusive-offer queue is ranked by
  // MEANING (semanticRankedAgents: embeddings + optional rerank) instead of the
  // capability-tag scorer. The tag ranking stays as fallback whenever semantic
  // can't produce candidates (no routing text, no embedded agents, provider
  // error) and CAS-race broadcast remains the floor — the flip can never
  // strand a task. Default OFF; enable as a monitored canary only after the
  // shadow report agrees semantic ≥ tag on real outcomes.
  semanticRoutingEnabled: optional('SEMANTIC_ROUTING_ENABLED', 'true').toLowerCase() === 'true',
  // Unmatched-demand feed (the public "Wanted" board): a still-open task
  // counts as a GAP once it is older than minAge (the cascade + early
  // broadcast demonstrably found no taker) and its best semantic fit is below
  // the similarity threshold. Cosine sims are model-relative — for
  // voyage-3-large good matches land ≈0.65-0.75; tune from the shadow log.
  // NaN-guarded: a malformed env value would otherwise disable BOTH filters
  // (NaN comparisons are always false) and dump every open task on the board.
  demandGapSimThreshold: ((v) => (Number.isFinite(v) ? v : 0.55))(
    parseFloat(optional('DEMAND_GAP_SIM_THRESHOLD', '0.55')),
  ),
  demandGapMinAgeMs: ((v) => (Number.isFinite(v) && v >= 0 ? v : 10 * 60 * 1000))(
    parseInt(optional('DEMAND_GAP_MIN_AGE_MS', String(10 * 60 * 1000)), 10),
  ),
  // Proof re-key: at settlement the worker's closest installed skill (cosine
  // between the task's routing text and the skill doc) is credited alongside
  // any declared tags when it clears this floor. Model-relative like the gap
  // threshold above; NaN-guarded because a malformed env value would silently
  // turn slug crediting OFF (NaN comparisons are false) with no error.
  proofSlugSimThreshold: ((v) => (Number.isFinite(v) ? v : 0.5))(
    parseFloat(optional('PROOF_SLUG_SIM_THRESHOLD', '0.5')),
  ),

  // Railway Sandboxes — ephemeral compute for agent tool execution
  railwayApiToken: process.env.RAILWAY_API_TOKEN || '',
  railwayEnvironmentId: process.env.RAILWAY_ENVIRONMENT_ID || '',
  sandboxIdleTimeoutMinutes: parseInt(optional('SANDBOX_IDLE_TIMEOUT_MINUTES', '5'), 10),
  sandboxMaxConcurrent: parseInt(optional('SANDBOX_MAX_CONCURRENT', '3'), 10),
  // Cost per second in micro-units (USDC 6 decimals) for billing agents
  sandboxCostPerSecond: parseInt(optional('SANDBOX_COST_PER_SECOND', '1000'), 10),

  // Per-principal rate limits (plan 014) on the two routes that spend real
  // money per call — /sandbox/exec runs an arbitrary shell command billed to
  // the platform, /verification/verify spends a paid 0G Compute inference.
  // Tunable without a code change; sandbox is tighter since a job can run for
  // up to 600s (execSchema's ceiling) while verify is a single bounded call.
  sandboxRatePerMin: parseInt(optional('SANDBOX_RATE_PER_MIN', '10'), 10),
  verifyRatePerMin: parseInt(optional('VERIFY_RATE_PER_MIN', '20'), 10),
  // Rolling daily cost ceiling per principal for /sandbox/exec, in the same
  // micro-units as sandboxCostPerSecond. Enforced via Redis
  // (sandbox:spend:<address>:<YYYY-MM-DD>) so it survives restarts and is
  // shared across instances — unlike railwaySandbox.ts's in-memory
  // usageHistory array. This is a runaway brake, not a billing plan: the
  // default (10,000,000 micro-units = $10 at the default cost-per-second) is
  // generous relative to real per-agent usage.
  sandboxDailyCostCapMicro: parseInt(optional('SANDBOX_DAILY_COST_CAP_MICRO', '10000000'), 10),

  // The deploy fee paywall, on unless AGENT_FACTORY_PAYWALL=false. When on,
  // deploying an agent needs a paid fee: a USDC transfer on Arc named in the
  // request (services/deployFee.ts), or an AgentFactory credit
  // (agentFactoryListener.ts).
  agentFactoryPaywall: optional('AGENT_FACTORY_PAYWALL', 'true').toLowerCase() === 'true',
  // The deploy fee in USDC's smallest unit (6 decimals), when it is paid on
  // Arc as a transfer to the escrow's treasury (services/deployFee.ts). 1 USDC,
  // the same as AgentFactory's on Base.
  deployFeeUsdcRaw: BigInt(optional('DEPLOY_FEE_USDC_RAW', '1000000')),

  // Sponsored agent gas (docs/AGENT-GAS-FUNDING.md, services/gasSponsor*.ts):
  // BlindMarket's relayer sends a hosted agent's first submitEvidence (and a
  // releaseUnjudgedWork) through its EIP-7702 delegate and pays the gas. Off
  // unless GAS_SPONSOR_ENABLED=true. Raw strings: gasSponsorConfig.ts
  // validates them and keeps sponsorship off, with a warning, rather than
  // stopping boot.
  gasSponsor: {
    enabled: optional('GAS_SPONSOR_ENABLED', 'false').trim().toLowerCase() === 'true',
    privateKey: process.env.GAS_SPONSOR_PRIVATE_KEY || '',
    /** Highest raw gas estimate the relayer sends; the gas limit is the estimate × 1.15. */
    maxGas: optional('GAS_SPONSOR_MAX_GAS', '200000').trim(),
    /** maxFeePerGas ceiling, in gwei. */
    maxFeeGwei: optional('GAS_SPONSOR_MAX_FEE_GWEI', '100').trim(),
    /** Smallest task reward that qualifies, in USDC. */
    minTaskUsdc: optional('GAS_SPONSOR_MIN_TASK_USDC', '0.10').trim(),
    /** Sponsored tasks per agent, Privy user and poster wallet, in any 24 hours. */
    perAgentDaily: optional('GAS_SPONSOR_PER_AGENT_DAILY', '10').trim(),
    perUserDaily: optional('GAS_SPONSOR_PER_USER_DAILY', '20').trim(),
    perPosterDaily: optional('GAS_SPONSOR_PER_POSTER_DAILY', '10').trim(),
    /** Global spend ceilings, in USDC. */
    hourlyBudgetUsdc: optional('GAS_SPONSOR_HOURLY_BUDGET_USDC', '0.25').trim(),
    dailyBudgetUsdc: optional('GAS_SPONSOR_DAILY_BUDGET_USDC', '1').trim(),
    /** Expired reservations in 7 days that end sponsorship for an agent or user. */
    maxStrikes: optional('GAS_SPONSOR_MAX_STRIKES', '3').trim(),
    /** Failed sponsored sends in an hour that pause sponsorship. */
    maxFailuresPerHour: optional('GAS_SPONSOR_MAX_FAILURES_PER_HOUR', '5').trim(),
    /** Minutes a stored transaction may go unlanded before sponsorship pauses itself. */
    stuckMinutes: optional('GAS_SPONSOR_STUCK_MINUTES', '10').trim(),
  },

  // Circle CCTP V2 — lets a user/agent move native USDC between Base and
  // another EVM chain (burn-and-mint, not a wrapped-asset bridge). See
  // services/cctpChains.ts for how these compose into per-chain configs.
  // DEFAULT OFF: routes 400 CCTP_DISABLED and the attestation poller no-ops
  // until this is explicitly enabled per environment (plans/... CCTP plan).
  cctp: {
    enabled: optional('CCTP_ENABLED', 'false').toLowerCase() === 'true',
    /** Mainnet CCTP tier iff tasks settle on Arc mainnet (5042): Arc is one leg of every transfer. */
    mainnet: CCTP_MAINNET,
    // TokenMessengerV2 / MessageTransmitterV2 addresses are identical across
    // every EVM chain for a given network tier (Circle's deterministic
    // deployment) — one pair of addresses covers both the Base and Ethereum
    // legs. Verified against developers.circle.com Sept 2026; re-check if
    // Circle redeploys.
    tokenMessengerAddress: optional('CCTP_TOKEN_MESSENGER_ADDRESS', CCTP_MAINNET
      ? '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
      : '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'),
    messageTransmitterAddress: optional('CCTP_MESSAGE_TRANSMITTER_ADDRESS', CCTP_MAINNET
      ? '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'
      : '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'),
    irisApiBase: optional('CCTP_IRIS_API_BASE', CCTP_MAINNET
      ? 'https://iris-api.circle.com'
      : 'https://iris-api-sandbox.circle.com'),
    // Base leg. It is the settlement Base network, sharing its RPC and USDC,
    // when that network is on the CCTP tier. When it is not (Arc mainnet next
    // to a Base Sepolia escrow kept for its older tasks), the leg is Base on
    // the CCTP tier, read through its own RPC.
    baseRpcUrl: optional('CCTP_BASE_RPC_URL', BASE_MAINNET === CCTP_MAINNET
      ? BASE_RPC_URL
      : (CCTP_MAINNET ? NETWORKS.networks.base.mainnet.rpcUrl : NETWORKS.networks.base.testnet.rpcUrl)),
    baseUsdcAddress: optional('CCTP_BASE_USDC_ADDRESS', BASE_MAINNET === CCTP_MAINNET
      ? BASE_USDC_ADDRESS
      : (CCTP_MAINNET ? NETWORKS.networks.base.mainnet.usdc : NETWORKS.networks.base.testnet.usdc)),
    // Ethereum leg — Base already has baseRpcUrl/baseChainId/baseUsdcAddress
    // above; CCTP is the first feature needing a second EVM chain, so its
    // config lives here rather than growing the top-level config with an
    // ethereum* prefix used nowhere else.
    ethereumRpcUrl: optional('CCTP_ETHEREUM_RPC_URL', CCTP_MAINNET
      ? NETWORKS.cctp.ethereum.mainnet.rpcUrl
      : NETWORKS.cctp.ethereum.testnet.rpcUrl),
    ethereumChainId: parseInt(optional('CCTP_ETHEREUM_CHAIN_ID', CCTP_MAINNET ? String(NETWORKS.cctp.ethereum.mainnet.chainId) : String(NETWORKS.cctp.ethereum.testnet.chainId)), 10),
    ethereumUsdcAddress: optional('CCTP_ETHEREUM_USDC_ADDRESS', CCTP_MAINNET
      ? NETWORKS.cctp.ethereum.mainnet.usdc
      : NETWORKS.cctp.ethereum.testnet.usdc),
    // Arbitrum and Optimism (OP Mainnet) — both Fast-Transfer-eligible per
    // Circle's domain table (domains 3 and 2 respectively), so they slot
    // into the same single code path as Base/Ethereum with no new
    // infrastructure. Polygon PoS and Avalanche are deliberately NOT added:
    // Circle doesn't support Fast Transfer/Forwarding Service on either
    // (Standard Transfer only), which would mean every transfer on those
    // routes needs a human to run scripts/recover-stuck-cctp-transfer.ts by
    // hand — a materially different (and much heavier) feature than "add a
    // chain config entry." Revisit only alongside a real automated relayer.
    arbitrumRpcUrl: optional('CCTP_ARBITRUM_RPC_URL', CCTP_MAINNET
      ? NETWORKS.cctp.arbitrum.mainnet.rpcUrl
      : NETWORKS.cctp.arbitrum.testnet.rpcUrl),
    arbitrumChainId: parseInt(optional('CCTP_ARBITRUM_CHAIN_ID', CCTP_MAINNET ? String(NETWORKS.cctp.arbitrum.mainnet.chainId) : String(NETWORKS.cctp.arbitrum.testnet.chainId)), 10),
    arbitrumUsdcAddress: optional('CCTP_ARBITRUM_USDC_ADDRESS', CCTP_MAINNET
      ? NETWORKS.cctp.arbitrum.mainnet.usdc
      : NETWORKS.cctp.arbitrum.testnet.usdc),
    optimismRpcUrl: optional('CCTP_OPTIMISM_RPC_URL', CCTP_MAINNET
      ? NETWORKS.cctp.optimism.mainnet.rpcUrl
      : NETWORKS.cctp.optimism.testnet.rpcUrl),
    optimismChainId: parseInt(optional('CCTP_OPTIMISM_CHAIN_ID', CCTP_MAINNET ? String(NETWORKS.cctp.optimism.mainnet.chainId) : String(NETWORKS.cctp.optimism.testnet.chainId)), 10),
    optimismUsdcAddress: optional('CCTP_OPTIMISM_USDC_ADDRESS', CCTP_MAINNET
      ? NETWORKS.cctp.optimism.mainnet.usdc
      : NETWORKS.cctp.optimism.testnet.usdc),
    // Polygon PoS (domain 7) — CCTP works on it, but Circle offers no Fast
    // Transfer / Forwarding Service there, so a burn to/from it does not
    // auto-complete the destination mint (operator self-relays). Marked
    // supportsFastTransfer:false in cctpChains.ts, same as Arc. Avalanche is
    // deliberately NOT added: Privy has no USDC gas sponsorship there, so a
    // burn from it can't be gasless-in-USDC.
    // publicnode, like Ethereum's defaults: polygon-rpc.com answers "API key
    // disabled" and rpc-amoy.polygon.technology does not resolve (2026-09-25).
    polygonRpcUrl: optional('CCTP_POLYGON_RPC_URL', CCTP_MAINNET
      ? 'https://polygon-bor-rpc.publicnode.com'
      : 'https://polygon-amoy-bor-rpc.publicnode.com'),
    polygonChainId: parseInt(optional('CCTP_POLYGON_CHAIN_ID', CCTP_MAINNET ? '137' : '80002'), 10),
    polygonUsdcAddress: optional('CCTP_POLYGON_USDC_ADDRESS', CCTP_MAINNET
      ? '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
      : '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582'),
    // Arc — Circle's own L1 (docs.arc.io), and the settlement leg: the Arc
    // network tasks settle on, so these default to ARC_* and follow
    // ARC_CHAIN_ID (assertBootConfig refuses a CCTP_ARC_CHAIN_ID that
    // disagrees). CCTP domain 26 on both networks; on Arc mainnet the V2 pair
    // above has code and localDomain() = 26 (read 2026-09-25). Fast Transfer
    // is N/A on Arc (its finality is already instant); Forwarding Service is
    // supported, so transfers still auto-complete. USDC is Arc's native gas
    // token (18-dec native view, 6-dec ERC-20 view of ONE balance).
    arcRpcUrl: optional('CCTP_ARC_RPC_URL', ARC_RPC_URL),
    arcChainId: parseInt(optional('CCTP_ARC_CHAIN_ID', String(ARC_CHAIN_ID)), 10),
    arcUsdcAddress: optional('CCTP_ARC_USDC_ADDRESS', ARC_USDC_ADDRESS),
    // USDC (6-dec raw) a Phase B deposit must leave behind on Arc to pay the
    // approve + burn gas, since gas comes out of the same USDC being bridged.
    // 50000 = 0.05 USDC: ~13x the observed Arc testnet cost (approve <=55k
    // gas + depositForBurnWithHook ~126k gas at ~20.5 gwei ≈ 0.004 USDC);
    // covers a base fee up to ~166 gwei on a 300k-gas budget. Raise via env
    // if Arc fees move.
    arcGasReserveRaw: BigInt(optional('CCTP_ARC_GAS_RESERVE_RAW', '50000')),
  },

  // Key custody / late-joiner re-wrap (docs/TEE-REWRAP-SPEC.md). DEFAULT OFF.
  // When enabled, posters seal the brief AES key to a platform-held custody key
  // so an agent that registers AFTER a task was posted can be served a
  // re-wrapped slice on /accept, with no poster present. With backend=local the
  // operator CAN read every sealed brief key — keyCustodyService.ts logs a loud
  // warning at boot, and this posture must be disclosed (spec §9). tdx/zg-oracle
  // are not implemented yet. KEY_CUSTODY_PRIVATE_KEY is a crown-jewel secret.
  keyCustody: {
    enabled: optional('KEY_CUSTODY_ENABLED', 'false') === 'true',
    backend: optional('KEY_CUSTODY_BACKEND', 'local') as 'local' | 'tdx' | 'zg-oracle',
    privateKey: process.env.KEY_CUSTODY_PRIVATE_KEY || '',
  },
} as const;

// Mainnet chain id, from the tier table that owns it.
const MAINNET_CHAIN_ID = TIER_CHAIN_IDS['0g'].mainnet;

/**
 * Fail-fast boot assertions. Call once at startup (before the server binds) so a
 * misconfigured production deploy dies loudly with an actionable message instead
 * of failing deep at runtime (an agent that can't mint a token, a bridge that
 * silently can't settle, a prod backend pointed at testnet contracts).
 *
 * Deliberately conservative — this guards a LIVE product, so it only HARD-FAILS
 * on misconfigurations that are never legitimate in production, and otherwise
 * warns. The chain-id assert has an ALLOW_NONMAINNET_PROD escape hatch for the
 * rare intentional prod-on-testnet (staging) deploy.
 */
export function assertBootConfig(): void {
  const isProd = config.nodeEnv === 'production';
  const fatals: string[] = [];
  const warnings: string[] = [];

  fatals.push(
    ...deploymentSetProblems(config.deploymentSet, process.env, { og: config.ogChainId, base: config.baseChainId, arc: config.arcChainId }),
  );

  // Contract addresses come from the generated records selected by chain id,
  // so a mainnet/testnet address mixup through env is no longer possible:
  // there is no address env var to set wrongly on the default set.
  if (config.settlementTier) {
    // An explicit tier is a promise about every chain. A chain id that breaks
    // it would settle real money on the wrong network, so this is fatal even
    // outside production.
    for (const mismatch of tierMismatches(process.env, config.settlementTier)) {
      fatals.push(`${mismatch}. Remove the override, or set SETTLEMENT_TIER to the tier you meant.`);
    }
    if (isProd && config.settlementTier === 'testnet') {
      const unset = ([
        ['PUBLIC_API_URL', config.publicApiUrl],
        ['PUBLIC_APP_URL', config.publicAppUrl],
      ] as const).filter(([name]) => !process.env[name]);
      if (unset.length > 0) {
        const plural = unset.length > 1;
        warnings.push(
          `NODE_ENV=production with SETTLEMENT_TIER=testnet, but ${unset.map(([name]) => name).join(' and ')} ` +
            `${plural ? 'are' : 'is'} unset — this stack falls back to production's own ` +
            `${plural ? 'addresses' : 'address'} (${unset.map(([, url]) => url).join(', ')}) and advertises ` +
            `${plural ? 'them' : 'it'} to the agents that discover it.`,
        );
      }
    }
  } else {
    // No tier named, which production never is (NODE_ENV=production derives
    // one): a development stack may mix tiers on purpose, so this only warns.
    const ogTier = chainTier('0g', config.ogChainId);
    const baseTier = chainTier('base', config.baseChainId);
    if (ogTier && baseTier && ogTier !== baseTier) {
      warnings.push(
        `0G is on ${ogTier} (${config.ogChainId}) and Base is on ${baseTier} (${config.baseChainId}) — ` +
          `this stack is half mainnet, half testnet. Set SETTLEMENT_TIER once both are on the same tier.`,
      );
    }
  }

  if (config.cctp.enabled) {
    // Each leg's provider is built with its chain id, and a malformed one
    // throws there, at boot, as a bare RangeError.
    const legIds = {
      CCTP_ETHEREUM_CHAIN_ID: config.cctp.ethereumChainId,
      CCTP_ARBITRUM_CHAIN_ID: config.cctp.arbitrumChainId,
      CCTP_OPTIMISM_CHAIN_ID: config.cctp.optimismChainId,
      CCTP_POLYGON_CHAIN_ID: config.cctp.polygonChainId,
      CCTP_ARC_CHAIN_ID: config.cctp.arcChainId,
    };
    for (const [name, id] of Object.entries(legIds)) {
      if (!Number.isSafeInteger(id) || id <= 0) fatals.push(`${name}=${process.env[name] ?? ''} is not a chain id.`);
    }
    // CCTP mints into the user's Arc wallet, so its Arc leg must be the Arc
    // network tasks settle on, on the tier CCTP runs. Only an explicit
    // CCTP_ARC_CHAIN_ID, or an Arc network Circle has no CCTP on, can break it.
    const arcLeg = TIER_CHAIN_IDS.arc[config.cctp.mainnet ? 'mainnet' : 'testnet'];
    if (config.arcChainId !== arcLeg || config.cctp.arcChainId !== arcLeg) {
      fatals.push(
        `CCTP_ENABLED=true but CCTP's Arc leg is chain ${config.cctp.arcChainId} (CCTP_ARC_CHAIN_ID) and tasks settle on Arc chain ` +
          `${config.arcChainId} (ARC_CHAIN_ID); both must be Arc ${config.cctp.mainnet ? 'mainnet' : 'testnet'} (${arcLeg}), or USDC ` +
          `is minted on a network the escrow is not on. Remove CCTP_ARC_CHAIN_ID (it defaults to ARC_CHAIN_ID).`,
      );
    }
  }

  if (isProd) {
    // JWT_SECRET signs the 365d agent platform tokens (agentRunner). Empty in
    // prod means agents can't start and any token path is unsigned — never valid.
    if (!config.jwtSecret) {
      fatals.push('JWT_SECRET is empty in production — deployed agents cannot mint platform tokens and will fail to start.');
    }

    // A prod backend on the testnet chain id is the cross-chain poaching footgun
    // (it would act on mainnet task ids against testnet escrow). Refuse, unless
    // the operator explicitly opts into a non-mainnet prod deploy.
    const allowNonMainnet = process.env.ALLOW_NONMAINNET_PROD === 'true';
    if (config.ogChainId !== MAINNET_CHAIN_ID && !allowNonMainnet) {
      fatals.push(`OG_CHAIN_ID=${config.ogChainId} in production — expected mainnet ${MAINNET_CHAIN_ID}. Refusing to boot a production backend against a non-mainnet chain (set ALLOW_NONMAINNET_PROD=true to override for staging).`);
    }

    // Degraded-but-not-fatal: the bridge being optional is an existing design
    // choice. Persistence is NOT optional in production: the SQLite fallback
    // lives in the container and is wiped on every redeploy, so agents, API
    // keys, messages, reviews and the earnings ledger disappear. Require an
    // explicit opt-in to run production against SQLite.
    if (!config.databaseUrl && process.env.ALLOW_SQLITE_PROD !== 'true') {
      fatals.push('DATABASE_URL is empty in production — persistence is disabled and data will be lost on redeploy. Set DATABASE_URL to a Postgres (Neon) connection string, or set ALLOW_SQLITE_PROD=true to opt out of durable persistence.');
    } else if (!config.databaseUrl) {
      warnings.push('DATABASE_URL is empty in production — running against SQLite because ALLOW_SQLITE_PROD=true is set. Data will be lost on redeploy.');
    }
    if (!config.marketplaceSignerPrivateKey) {
      warnings.push('MARKETPLACE_SIGNER_PRIVATE_KEY is empty — the A2A settlement bridge is DISABLED; agent tasks will accept/submit off-chain but never settle on-chain.');
    }
    if (!config.databaseUrl && config.cctp.enabled) {
      warnings.push('CCTP_ENABLED=true but DATABASE_URL is empty — bridging is DISABLED (it needs the cctp_transfers table).');
    }
    // The public endpoint is the default so a stack boots without one, but
    // the indexers and the settlement bridge read Arc on every tick.
    if (config.arcEscrowAddress && config.arcChainId === TIER_CHAIN_IDS.arc.mainnet && config.arcRpcUrl === ARC_MAINNET_PUBLIC_RPC_URL) {
      warnings.push(
        `Arc mainnet is read through the public RPC ${ARC_MAINNET_PUBLIC_RPC_URL}, the default. ` +
          'Set ARC_RPC_URL to an endpoint you control or pay for.',
      );
    }
  }

  for (const w of warnings) console.warn(`[config] ⚠ ${w}`);

  if (fatals.length > 0) {
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error(`[config] ⛔ ${fatals.length} fatal boot-config problem(s) — refusing to start:`);
    for (const f of fatals) console.error(`    • ${f}`);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    throw new Error(`Invalid boot config: ${fatals.length} fatal problem(s) — see logs above.`);
  }
}