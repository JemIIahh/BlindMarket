import 'dotenv/config';
import { CONTRACT_ADDRESSES } from './contractAddresses.js';
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

const IS_PROD = process.env.NODE_ENV === 'production';

/**
 * The network tier every chain follows, or null when each keeps its own
 * default (see services/settlementTier.ts). Read here, at import, so a typo
 * fails before anything is configured from it.
 */
const SETTLEMENT_TIER = readSettlementTier(process.env);

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

/** Where a production backend says it lives, when PUBLIC_*_URL is unset. */
export const PRODUCTION_PUBLIC_URLS = {
  PUBLIC_API_URL: 'https://api.blindmarket.xyz',
  PUBLIC_APP_URL: 'https://blindmarket.xyz',
} as const;

/**
 * Env vars a non-default deployment set must set explicitly. optional() treats
 * an unset or empty value as missing and falls back to the generated
 * (production) addresses, production's RPC, or production's public URLs, so a
 * staging stack that forgot one would talk to production's contracts, or
 * send the agents that discover it to production's API. A zero address
 * counts as set ("not deployed on this stack"). VALIDATOR_POOL_ADDRESS has no
 * fallback but is listed so staging can't silently omit its pool.
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
  'ARC_AGENT_FACTORY_ADDRESS',
  'USDC_PAYMASTER_ADDRESS',
  'BLIND_ACCOUNT_FACTORY_ADDRESS',
  'ENTRY_POINT_ADDRESS',
  'PUBLIC_API_URL',
  'PUBLIC_APP_URL',
] as const;

/**
 * The 0G and Base chains each non-default set runs on. contracts/scripts/
 * _deployments.ts SET_CHAINS also lists Arc testnet (5042002) for staging;
 * the backend does not settle on Arc yet, so it is not checked here.
 */
const DEPLOYMENT_SET_CHAINS: Record<'staging', { og: number; base: number }> = {
  staging: { og: 16602, base: 84532 },
};

/** Why a backend in `set` must not boot; empty for the default set. */
export function deploymentSetProblems(
  set: '' | 'staging',
  env: Record<string, string | undefined>,
  chainIds: { og: number; base: number },
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
  return problems;
}

// Base network this deployment settles on, and whether that network is Base
// MAINNET. Every Base default (RPC, USDC, contract table) and the CCTP tier
// key off this — NOT off NODE_ENV. The deployed app runs NODE_ENV=production
// on Base Sepolia: NODE_ENV-keyed defaults gave it Base MAINNET's USDC address
// (no contract on Sepolia → balances read 0, burns revert) and would have put
// CCTP on mainnet contracts/chains/Iris.
const BASE_CHAIN_ID = parseInt(optional('BASE_CHAIN_ID', tierChainId('base', IS_PROD ? 8453 : 84532)), 10);
const BASE_MAINNET = BASE_CHAIN_ID === TIER_CHAIN_IDS.base.mainnet;

const OG_CHAIN_ID = parseInt(optional('OG_CHAIN_ID', tierChainId('0g', IS_PROD ? 16661 : 16602)), 10);
const OG_MAINNET = OG_CHAIN_ID === TIER_CHAIN_IDS['0g'].mainnet;

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
// Arc settlement is testnet-only here, matching the frontend's own Arc
// default (frontend/src/config/constants.ts): there is no Arc-mainnet record
// yet, so the testnet record is the generated fallback.
const ARC_ADDR = (CONTRACT_ADDRESSES as any).arcTestnet as {
  readonly blindEscrow?: string;
  readonly agentFactory?: string;
  readonly USDC: string;
} | undefined;

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

  // 0G Chain (agent infra — TaskRegistry, Reputation, INFT)
  ogRpcUrl: optional('OG_RPC_URL', OG_MAINNET ? 'https://evmrpc.0g.ai' : 'https://evmrpc-testnet.0g.ai'),
  ogChainId: OG_CHAIN_ID,

  // Base Chain (settlement — BlindEscrow, USDC payouts)
  baseRpcUrl: optional('BASE_RPC_URL', BASE_MAINNET ? 'https://mainnet.base.org' : 'https://sepolia.base.org'),
  baseChainId: BASE_CHAIN_ID,
  /**
   * The tier SETTLEMENT_TIER names, or null when each chain follows its own
   * default. Null does NOT mean the chains disagree: /health/bridge derives
   * the tier the stack is actually on from the chain ids.
   */
  settlementTier: SETTLEMENT_TIER,

  // Contracts — 0G (agent infra)
  blindEscrowAddress: optional('BLIND_ESCROW_ADDRESS', ADDR.blindEscrow),
  taskRegistryAddress: optional('TASK_REGISTRY_ADDRESS', ADDR.taskRegistry),
  blindReputationAddress: optional('BLIND_REPUTATION_ADDRESS', ADDR.blindReputation),
  inftAddress: optional('INFT_ADDRESS', ADDR.inft),

  // Contracts — Base (settlement)
  // Zero here means Base isn't deployed on this network yet. Left as-is it is a
  // truthy string, which switches POST /tasks onto the Base escrow and points
  // createTask at address(0) — so collapse it to ''.
  baseEscrowAddress: unsetIfZero(optional('BASE_ESCROW_ADDRESS', BASE_ADDR?.blindEscrow ?? '')),
  baseUsdcAddress: optional('BASE_USDC_ADDRESS', BASE_MAINNET ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : '0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
  // The generated module carries a zero-address placeholder for networks the
  // factory hasn't been deployed to yet. Treat that as "not configured" so the
  // listener stays disabled instead of polling address(0) forever.
  agentFactoryAddress: unsetIfZero(optional('AGENT_FACTORY_ADDRESS', BASE_ADDR?.agentFactory || '')),

  // Arc Chain (settlement — USDC payouts, gas in USDC)
  // No generated defaults yet; Arc settlement is deployed per environment.
  arcRpcUrl: optional('ARC_RPC_URL', 'https://rpc.testnet.arc.io'),
  arcChainId: parseInt(optional('ARC_CHAIN_ID', '5042002'), 10),
  arcEscrowAddress: unsetIfZero(optional('ARC_ESCROW_ADDRESS', '')),
  arcUsdcAddress: optional('ARC_USDC_ADDRESS', '0x3600000000000000000000000000000000000000'),
  arcMarketplaceSignerPrivateKey: process.env.ARC_MARKETPLACE_SIGNER_PRIVATE_KEY || '',
  arcEscrowDeploymentBlock: parseInt(optional('ARC_ESCROW_DEPLOYMENT_BLOCK', '0'), 10),
  // AgentFactory on Arc — the factory DeployAgentForm pays and the listener
  // indexes for deploy credits. Falls back to the generated arcTestnet record;
  // env wins. (The Base `agentFactoryAddress` above is legacy: the wallet is
  // Arc-only and nothing polls the Base factory anymore.)
  arcAgentFactoryAddress: unsetIfZero(optional('ARC_AGENT_FACTORY_ADDRESS', ARC_ADDR?.agentFactory || '')),

  // ERC-4337 AA infrastructure (Base) — agents pay gas in USDC instead of ETH.
  usdcPaymasterAddress: unsetIfZero(optional('USDC_PAYMASTER_ADDRESS', (BASE_ADDR as any)?.USDCPaymaster ?? '')),
  blindAccountFactoryAddress: unsetIfZero(optional('BLIND_ACCOUNT_FACTORY_ADDRESS', (BASE_ADDR as any)?.BlindAccountFactory ?? '')),
  entryPointAddress: unsetIfZero(optional('ENTRY_POINT_ADDRESS', (BASE_ADDR as any)?.EntryPoint ?? '')),
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
  deploymentSet: parseDeploymentSet(process.env.DEPLOYMENT_SET),
  deploymentId: parseDeploymentId(process.env.DEPLOYMENT_ID),
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

  // Circle CCTP V2 — lets a user/agent move native USDC between Base and
  // another EVM chain (burn-and-mint, not a wrapped-asset bridge). See
  // services/cctpChains.ts for how these compose into per-chain configs.
  // DEFAULT OFF: routes 400 CCTP_DISABLED and the attestation poller no-ops
  // until this is explicitly enabled per environment (plans/... CCTP plan).
  cctp: {
    enabled: optional('CCTP_ENABLED', 'false').toLowerCase() === 'true',
    /** Mainnet CCTP tier iff this deployment settles on Base mainnet (8453). */
    mainnet: BASE_MAINNET,
    // TokenMessengerV2 / MessageTransmitterV2 addresses are identical across
    // every EVM chain for a given network tier (Circle's deterministic
    // deployment) — one pair of addresses covers both the Base and Ethereum
    // legs. Verified against developers.circle.com Sept 2026; re-check if
    // Circle redeploys.
    tokenMessengerAddress: optional('CCTP_TOKEN_MESSENGER_ADDRESS', BASE_MAINNET
      ? '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'
      : '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA'),
    messageTransmitterAddress: optional('CCTP_MESSAGE_TRANSMITTER_ADDRESS', BASE_MAINNET
      ? '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64'
      : '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'),
    irisApiBase: optional('CCTP_IRIS_API_BASE', BASE_MAINNET
      ? 'https://iris-api.circle.com'
      : 'https://iris-api-sandbox.circle.com'),
    // Ethereum leg — Base already has baseRpcUrl/baseChainId/baseUsdcAddress
    // above; CCTP is the first feature needing a second EVM chain, so its
    // config lives here rather than growing the top-level config with an
    // ethereum* prefix used nowhere else.
    ethereumRpcUrl: optional('CCTP_ETHEREUM_RPC_URL', BASE_MAINNET
      ? 'https://ethereum-rpc.publicnode.com'
      : 'https://ethereum-sepolia-rpc.publicnode.com'),
    ethereumChainId: parseInt(optional('CCTP_ETHEREUM_CHAIN_ID', BASE_MAINNET ? '1' : '11155111'), 10),
    ethereumUsdcAddress: optional('CCTP_ETHEREUM_USDC_ADDRESS', BASE_MAINNET
      ? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
      : '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'),
    // Arbitrum and Optimism (OP Mainnet) — both Fast-Transfer-eligible per
    // Circle's domain table (domains 3 and 2 respectively), so they slot
    // into the same single code path as Base/Ethereum with no new
    // infrastructure. Polygon PoS and Avalanche are deliberately NOT added:
    // Circle doesn't support Fast Transfer/Forwarding Service on either
    // (Standard Transfer only), which would mean every transfer on those
    // routes needs a human to run scripts/recover-stuck-cctp-transfer.ts by
    // hand — a materially different (and much heavier) feature than "add a
    // chain config entry." Revisit only alongside a real automated relayer.
    arbitrumRpcUrl: optional('CCTP_ARBITRUM_RPC_URL', BASE_MAINNET
      ? 'https://arb1.arbitrum.io/rpc'
      : 'https://sepolia-rollup.arbitrum.io/rpc'),
    arbitrumChainId: parseInt(optional('CCTP_ARBITRUM_CHAIN_ID', BASE_MAINNET ? '42161' : '421614'), 10),
    arbitrumUsdcAddress: optional('CCTP_ARBITRUM_USDC_ADDRESS', BASE_MAINNET
      ? '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
      : '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d'),
    optimismRpcUrl: optional('CCTP_OPTIMISM_RPC_URL', BASE_MAINNET
      ? 'https://mainnet.optimism.io'
      : 'https://sepolia.optimism.io'),
    optimismChainId: parseInt(optional('CCTP_OPTIMISM_CHAIN_ID', BASE_MAINNET ? '10' : '11155420'), 10),
    optimismUsdcAddress: optional('CCTP_OPTIMISM_USDC_ADDRESS', BASE_MAINNET
      ? '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'
      : '0x5fd84259d66Cd46123540766Be93DFE6D43130D7'),
    // Polygon PoS (domain 7) — CCTP works on it, but Circle offers no Fast
    // Transfer / Forwarding Service there, so a burn to/from it does not
    // auto-complete the destination mint (operator self-relays). Marked
    // supportsFastTransfer:false in cctpChains.ts, same as Arc. Avalanche is
    // deliberately NOT added: Privy has no USDC gas sponsorship there, so a
    // burn from it can't be gasless-in-USDC.
    polygonRpcUrl: optional('CCTP_POLYGON_RPC_URL', BASE_MAINNET
      ? 'https://polygon-rpc.com'
      : 'https://rpc-amoy.polygon.technology'),
    polygonChainId: parseInt(optional('CCTP_POLYGON_CHAIN_ID', BASE_MAINNET ? '137' : '80002'), 10),
    polygonUsdcAddress: optional('CCTP_POLYGON_USDC_ADDRESS', BASE_MAINNET
      ? '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
      : '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582'),
    // Arc — Circle's own L1 (docs.arc.io). These defaults are Arc TESTNET
    // (5042002) and do not follow the Base tier, so no mainnet chain entry
    // exists here. Arc Mainnet itself is live (its RPC answered chain id 5042
    // on 2026-09-17); adding it as a CCTP chain needs its contract addresses
    // checked first. CCTP domain 26. Fast Transfer is N/A on Arc (its finality
    // is already instant); Forwarding Service is supported, so transfers still
    // auto-complete. USDC is Arc's native gas token (18-dec native view, 6-dec
    // ERC-20 view of ONE balance).
    arcRpcUrl: optional('CCTP_ARC_RPC_URL', 'https://rpc.testnet.arc.io'),
    arcChainId: parseInt(optional('CCTP_ARC_CHAIN_ID', '5042002'), 10),
    arcUsdcAddress: optional('CCTP_ARC_USDC_ADDRESS', '0x3600000000000000000000000000000000000000'),
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
    ...deploymentSetProblems(config.deploymentSet, process.env, { og: config.ogChainId, base: config.baseChainId }),
  );

  // NODE_ENV=production defaults BASE_CHAIN_ID to Base mainnet. A production
  // env that sets BASE_ESCROW_ADDRESS to the Base Sepolia escrow but forgets
  // BASE_CHAIN_ID would boot as "Base mainnet" with mainnet USDC and the
  // Sepolia escrow address, and every tier check would read it as mainnet.
  const sepoliaEscrow = (CONTRACT_ADDRESSES.baseTestnet as { blindEscrow?: string }).blindEscrow;
  if (BASE_MAINNET && sepoliaEscrow && (config.baseEscrowAddress || '').toLowerCase() === sepoliaEscrow.toLowerCase()) {
    fatals.push(
      `BASE_CHAIN_ID=${config.baseChainId} (Base mainnet) but BASE_ESCROW_ADDRESS=${config.baseEscrowAddress} is the Base Sepolia ` +
        `escrow from contracts/deployments/base-sepolia.json. Set BASE_CHAIN_ID=84532 (production posts on Base Sepolia today), ` +
        `or a Base mainnet escrow address.`,
    );
  }

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
    // No tier named: report it when the chains disagree. Production is mixed
    // today (0G mainnet + Base Sepolia), so this cannot be fatal yet.
    const ogTier = chainTier('0g', config.ogChainId);
    const baseTier = chainTier('base', config.baseChainId);
    if (ogTier && baseTier && ogTier !== baseTier) {
      warnings.push(
        `0G is on ${ogTier} (${config.ogChainId}) and Base is on ${baseTier} (${config.baseChainId}) — ` +
          `this stack is half mainnet, half testnet. Set SETTLEMENT_TIER once both are on the same tier.`,
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