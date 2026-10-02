import { Router } from 'express';
import { gasSponsorReport } from '../services/gasSponsorRelayer.js';
import { formatEther, ZeroAddress } from 'ethers';
import type { ApiResponse } from '../types.js';
import { baseEscrow, baseMarketplaceSigner, baseProvider } from '../services/chain.js';
import { isBridgeReady } from '../services/a2aSettlement.js';
import { chainNetwork, contractsEnvPrefix } from '../services/chainNetwork.js';
import {
  postingChain,
  settlementChainConfigs,
  type SettlementChainConfig,
  type SettlementChainKey,
} from '../services/settlementChains.js';
import { chainRuntime } from '../services/chainRuntime.js';
import { batchCreateSupport } from '../services/batchSupport.js';
import type { SettlementTier } from '../services/settlementTier.js';
import { relayChainName } from '../services/relayChains.js';
import { deploymentIdentityStatus } from '../services/deploymentIdentity.js';
import { escrowFingerprintError } from '../services/escrowFingerprint.js';
import { parkedDisputeCount } from '../services/disputeKeys.js';
import { config } from '../config.js';
import { redis, redisSub } from '../services/redis.js';
import { getPool, getSchemaStatus, latestMigrationId } from '../services/neonDb.js';
import { safeErrorMessage } from '../middleware/errorHandler.js';

export const healthRouter = Router();



healthRouter.get('/', (_req, res) => {
  const body: ApiResponse<{ status: string; timestamp: string }> = {
    success: true,
    data: { status: 'ok', timestamp: new Date().toISOString() },
  };
  res.json(body);
});

/** An escrow address as clients should see it: null when unset or the zero
 *  address (BLIND_ESCROW_ADDRESS is not zero-filtered in config), so the MCP
 *  never treats address(0) as a known escrow and sends value there. */
function escrowOrNull(address: string): string | null {
  return address && address.toLowerCase() !== ZeroAddress ? address : null;
}

/**
 * An error as an unauthenticated route may repeat it. ethers puts the whole
 * request into a failed call's message (`info={ "requestUrl": … }`), and the
 * RPC URL can carry a provider key. Keep the short message and the code.
 */

function rotateCommand(signerAddr: string, network: string, escrowAddress: string | null): string {
  return `cd contracts && ${contractsEnvPrefix(escrowAddress)}MARKETPLACE_SIGNER_ADDRESS=${signerAddr} npx hardhat run scripts/rotate-verifier.ts --network ${network}`;
}

/** The Base half: verifier role, USDC and ETH balances of its signer. */
async function baseBridge(): Promise<Record<string, unknown>> {
  const baseSignerAddr = await baseMarketplaceSigner!.getAddress();
  let baseVerifier: string | null = null;
  let baseEscrowError: string | null = null;
  try {
    baseVerifier = (await baseEscrow!.verifier()) as string;
  } catch (e) {
    baseEscrowError = safeErrorMessage(e);
  }
  const baseVerifierMatches =
    baseVerifier !== null &&
    baseVerifier.toLowerCase() === baseSignerAddr.toLowerCase();
  let baseSignerBalanceUsdc: string | null = null;
  let baseSignerBalanceError: string | null = null;
  try {
    // USDC balance (6 decimals)
    const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];
    const usdc = new (await import('ethers')).ethers.Contract(config.baseUsdcAddress!, USDC_ABI, baseProvider);
    baseSignerBalanceUsdc = (await usdc.balanceOf(baseSignerAddr)).toString();
  } catch (e) {
    baseSignerBalanceError = safeErrorMessage(e);
  }
  let baseSignerEthBalance: string | null = null;
  let baseSignerEthLow: boolean | null = null;
  try {
    const ethBal = await baseProvider.getBalance(baseSignerAddr);
    baseSignerEthBalance = formatEther(ethBal);
    baseSignerEthLow = Number(baseSignerEthBalance) < 0.001;
  } catch {
    // non-critical
  }
  return {
    configured: true,
    signerAddress: baseSignerAddr,
    escrowAddress: config.baseEscrowAddress,
    chainId: config.baseChainId,
    onChainVerifier: baseVerifier,
    verifierMatches: baseVerifierMatches,
    escrowReadError: baseEscrowError,
    signerUsdcBalance: baseSignerBalanceUsdc,
    signerEthBalance: baseSignerEthBalance,
    signerEthLow: baseSignerEthLow,
    signerBalanceError: baseSignerBalanceError,
    rotateCommand: baseVerifierMatches
      ? null
      : rotateCommand(baseSignerAddr, chainNetwork('base').hardhatNetwork, escrowOrNull(config.baseEscrowAddress)),
  };
}

/** Why a chain can't settle, or null when it can or isn't part of this deployment. */
function notReadyReason(
  ready: boolean,
  escrowAddress: string | null,
  escrowEnv: string,
  signerSet: boolean,
  signerEnv: string,
): string | null {
  if (ready) return null;
  if (!escrowAddress) return signerSet ? `${escrowEnv} not set` : null;
  return `${signerEnv} not set`;
}

/** `indexerError` when the chain's index keys belong to a different escrow. */
function indexerError(chain: SettlementChainKey): { indexerError?: string } {
  const error = escrowFingerprintError(chain);
  return error ? { indexerError: error } : {};
}

/** `parkedDisputes` when a chain has dispute rulings the listener parked. */
async function parkedDisputes(chain: SettlementChainKey): Promise<{ parkedDisputes?: number }> {
  try {
    const count = await withTimeout(parkedDisputeCount(chain), 1_000);
    return count > 0 ? { parkedDisputes: count } : {};
  } catch {
    return {};
  }
}

/**
 * The tier this stack is actually on, and where that came from. With no
 * SETTLEMENT_TIER the tier is read back from the chains that settle here, so
 * a half-mainnet stack (production today: 0G mainnet + Base Sepolia) reports
 * 'mixed' rather than claiming either tier.
 */
function tierReport(
  entries: readonly SettlementChainConfig[],
  configuredTier: SettlementTier | null,
): { settlementTier: SettlementTier | 'mixed' | null; tierSource: 'SETTLEMENT_TIER' | 'chains' } {
  if (configuredTier) return { settlementTier: configuredTier, tierSource: 'SETTLEMENT_TIER' };
  // Chains with an escrow, or every known chain when this stack settles
  // nowhere — a chain it has no escrow on says nothing about its tier.
  const settling = entries.filter((entry) => entry.escrowAddress !== null);
  const tiers = new Set((settling.length > 0 ? settling : entries).map((entry) => entry.tier));
  if (tiers.size === 0) return { settlementTier: null, tierSource: 'chains' };
  return { settlementTier: tiers.size === 1 ? [...tiers][0] : 'mixed', tierSource: 'chains' };
}

/**
 * The facts about a chain that come from config alone: what /health/settlement
 * serves, and the part of /health/bridge's per-chain report that needs no
 * RPC or Redis. Fields are picked one by one: the registry entry also holds
 * the RPC URL, which can carry a provider key.
 */
function chainFacts(entry: SettlementChainConfig, posting: SettlementChainKey | null): Record<string, unknown> {
  const { key, chainId, tier, escrowAddress, token, gas } = entry;
  return {
    chain: key,
    chainId,
    tier,
    escrowAddress,
    token: { kind: token.kind, address: token.address, symbol: token.unit.symbol, decimals: token.unit.decimals },
    relayChain: relayChainName(entry),
    gasSymbol: gas.symbol,
    // POST /tasks builds new tasks here: the posting chain, with an escrow
    // and a settlement token. It does not need the marketplace signer, which
    // /health/bridge's `configured` reports.
    postable: key === posting && escrowAddress !== null && token.address !== null,
  };
}

/**
 * Whether this chain's marketplace signer holds the escrow's verifier role and
 * can pay gas for marketplaceAssign. Every chain gets it, not only Base: Arc's
 * escrow was deployed with its own verifier, and a signer that is not it makes
 * every accept on Arc revert with NotVerifier while `configured` reads true.
 */
async function verifierReport(entry: SettlementChainConfig): Promise<Record<string, unknown>> {
  const { escrow, marketplaceSigner, provider } = chainRuntime(entry.key);
  const signerAddress = await marketplaceSigner!.getAddress();
  // In parallel: a slow RPC should cost this endpoint one timeout, not two.
  const [verifierRead, balanceRead] = await Promise.allSettled([
    withTimeout(escrow!.verifier() as Promise<string>, 5_000),
    withTimeout(provider.getBalance(signerAddress), 5_000),
  ]);
  const onChainVerifier = verifierRead.status === 'fulfilled' ? verifierRead.value : null;
  const escrowReadError = verifierRead.status === 'rejected' ? safeErrorMessage(verifierRead.reason) : null;
  const matches = onChainVerifier !== null && onChainVerifier.toLowerCase() === signerAddress.toLowerCase();
  // The balance read is non-critical: null when it fails.
  const balance = balanceRead.status === 'fulfilled' ? balanceRead.value : null;
  const signerGasBalance = balance === null ? null : formatEther(balance);
  const signerGasLow = balance === null ? null : balance < entry.gas.withdrawMinWei;
  return {
    signerAddress,
    onChainVerifier,
    // null when the escrow could not be read: unknown, not a mismatch.
    verifierMatches: onChainVerifier === null ? null : matches,
    escrowReadError,
    signerGasBalance,
    signerGasLow,
    rotateCommand: onChainVerifier === null || matches
      ? null
      : rotateCommand(signerAddress, chainNetwork(entry.key).hardhatNetwork, entry.escrowAddress),
  };
}

/** A chain as /health/bridge reports it: its facts plus readiness. Key order is pinned by health.bridge.test.ts. */
async function chainReport(
  entry: SettlementChainConfig,
  configured: boolean,
  reason: string | null,
  posting: SettlementChainKey | null,
): Promise<Record<string, unknown>> {
  const { chain, ...facts } = chainFacts(entry, posting);
  return {
    chain,
    configured,
    ...facts,
    ...(configured ? { verifier: await verifierReport(entry) } : {}),
    ...(reason ? { reason } : {}),
    ...indexerError(entry.key),
    ...(await parkedDisputes(entry.key)),
  };
}

/** The posting chain, or the reason it can't be named (vercel.ts mounts this router without the boot checks). */
function postingChainOrError(): { posting: SettlementChainKey | null; postingChainError: string | null } {
  try {
    return { posting: postingChain(), postingChainError: null };
  } catch (e) {
    return { posting: null, postingChainError: (e as Error).message };
  }
}

// GET /api/v1/health/settlement — the settlement chains as data, for clients
// that build and price transactions: which chain new tasks post on, and for
// every chain its id, tier, escrow, settlement token (address, symbol,
// decimals), the `chain` name the relay takes, the gas coin, and
// `batchCreate`: whether its escrow has createTasks and how many tasks one
// takes (docs/BULK-POSTING.md). Config, plus that one read: MAX_BATCH() on
// each escrow, cached (services/batchSupport.ts), so the route answers from
// memory except on the first request after boot, which waits at most 2 s. No
// Redis. Readiness (signers, verifier roles, indexers) is /health/bridge's
// job. The web app reads this at boot instead of deciding the payment token
// by "is a Base escrow configured?", which is the rule POST /tasks stopped
// following in R12.
healthRouter.get('/settlement', async (_req, res) => {
  const entries = settlementChainConfigs();
  const { posting, postingChainError } = postingChainOrError();
  // batchCreateSupport never throws: an unreadable escrow is unsupported.
  const chains = await Promise.all(
    entries.map(async (entry) => ({ ...chainFacts(entry, posting), batchCreate: await batchCreateSupport(entry.key) })),
  );
  const body: ApiResponse = {
    success: true,
    data: {
      postingChain: posting,
      chains,
      ...tierReport(entries, config.settlementTier),
      ...(postingChainError ? { postingChainError } : {}),
    },
  };
  res.json(body);
});

// GET /api/v1/health/bridge — surfaces the A2A settlement bridge config
// without needing backend log access. Each settlement chain is reported on its
// own: a task lives on exactly one chain, so one chain being ready is enough to
// settle that chain's tasks. The 0G fields stay at the top level and Base under
// `base` (null unless Base can settle), which the MCP server reads, so their
// shape must not change. `chains` lists every chain the registry knows, with
// its tier, settlement token, the `chain` name the relay takes for it, and
// whether POST /tasks posts on it; `postingChain` names that chain. `reason`
// names what's missing for any chain that has only half its config, so it can
// appear next to `configured: true` when another chain is ready. A `false` for
// `verifierMatches` is the root cause of every "task accepted but never
// completes" report; the response includes the exact rotate-verifier command
// to run from contracts/.
healthRouter.get('/bridge', async (_req, res, next) => {
  try {
    const entries = settlementChainConfigs();
    // index.ts refuses to boot on an unknown POSTING_CHAIN, but vercel.ts
    // mounts this router without that check — and an endpoint whose job is
    // to report misconfiguration should report this one, not 500 on it.
    const { posting, postingChainError } = postingChainOrError();
    const readiness = entries.map((entry) => {
      const { escrow: chainEscrow, marketplaceSigner: signer } = chainRuntime(entry.key);
      // isBridgeReady already implies the escrow and signer; checked again
      // because the 0G and Base blocks below dereference them.
      const configured = isBridgeReady(entry.key) && !!chainEscrow && !!signer;
      const reason = notReadyReason(configured, entry.escrowAddress, entry.escrowEnv, !!signer, entry.signerEnv);
      return { entry, configured, reason };
    });
    const isReady = (key: SettlementChainKey) => readiness.some((r) => r.entry.key === key && r.configured);

    const [base, chains, gasSponsor] = await Promise.all([
      isReady('base') ? baseBridge() : null,
      Promise.all(readiness.map(({ entry, configured, reason }) => chainReport(entry, configured, reason, posting))),
      gasSponsorReport(),
    ]);

    const reasons = readiness.flatMap(({ entry, reason }) => (reason ? [`${entry.label}: ${reason}`] : []));
    const configured = readiness.some((r) => r.configured);
    if (!configured && reasons.length === 0) {
      reasons.push('no settlement chain has both an escrow and a marketplace signer');
    }

    const body: ApiResponse = {
      success: true,
      data: {
        configured,
        ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
        // 0G agent infra is still configured here for diagnostics; settlement
        // chains are listed under `chains`.
        escrowAddress: escrowOrNull(config.blindEscrowAddress),
        chainId: config.ogChainId,
        base,
        chains,
        postingChain: posting,
        ...tierReport(entries, config.settlementTier),
        ...(postingChainError ? { postingChainError } : {}),
        // Which deployment owns this Redis, as found at boot, and whether
        // this process's background writers run; null where the boot check
        // never ran (vercel.ts).
        deploymentIdentity: deploymentIdentityStatus(),
        // Sponsored agent gas: whether it runs, the sponsor's balance, calls
        // today and the budget left (docs/AGENT-GAS-FUNDING.md).
        gasSponsor,
      },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /health/redis — the shared ioredis clients as they are, not as they
 * should be: connection status, how many commands are waiting for a reply,
 * and which command is at the head of that queue. ioredis answers strictly
 * in order, so one command Redis never replies to holds every later one —
 * and that shows up here as a growing queue with a fixed head, which no
 * amount of connection tuning fixes. Command names only; no arguments, so
 * nothing sensitive is exposed.
 */
const DB_CHECK_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/**
 * GET /health/db — is Postgres configured, reachable, and fully migrated?
 * Answers the question that otherwise needs dashboard access: production ran
 * without DATABASE_URL (Sep 2026) and the only outside signal was
 * /api/v1/stats reading zero agents. Deliberately NOT part of plain /health:
 * that route stays dependency-free so a database blip can't make the host's
 * health check restart the whole API. No connection details are returned.
 */
healthRouter.get('/db', async (_req, res) => {
  if (!config.databaseUrl) {
    res.json({
      success: true,
      data: {
        configured: false,
        reachable: null,
        latencyMs: null,
        schema: { latestExpected: latestMigrationId() },
        warning: 'DATABASE_URL is not set — Postgres-only features (API keys, bridging, messages, reviews, templates) do nothing, and agents + the ledger fall back to a SQLite file that is lost on every redeploy or restart.',
      },
    });
    return;
  }
  const started = Date.now();
  try {
    const pool = await withTimeout(getPool(), DB_CHECK_TIMEOUT_MS);
    await withTimeout(pool.query('SELECT 1'), DB_CHECK_TIMEOUT_MS);
    const latencyMs = Date.now() - started;
    const schema = await withTimeout(getSchemaStatus(pool), DB_CHECK_TIMEOUT_MS).catch(() => null);
    res.json({
      success: true,
      data: {
        configured: true,
        reachable: true,
        latencyMs,
        schema: schema && { ...schema, upToDate: schema.missing.length === 0 && schema.nameMismatch.length === 0 },
      },
    });
  } catch (e) {
    res.json({
      success: true,
      data: {
        configured: true,
        reachable: false,
        latencyMs: null,
        schema: null,
        error: (e as Error).message === 'timeout' ? 'timeout' : 'connection_failed',
      },
    });
  }
});

healthRouter.get('/redis', (_req, res) => {
  const describe = (c: typeof redis) => {
    const q = (c as unknown as { commandQueue?: { length: number; peekFront?: () => { command?: { name?: string } } } }).commandQueue;
    const off = (c as unknown as { offlineQueue?: { length: number } }).offlineQueue;
    const head = q?.peekFront?.()?.command?.name ?? null;
    return { status: c.status, awaitingReply: q?.length ?? null, headCommand: head, offlineQueue: off?.length ?? null };
  };
  res.json({ success: true, data: { client: describe(redis), sub: describe(redisSub) } });
});

/**
 * GET /health/db — production health check for durable persistence.
 * Returns whether DATABASE_URL is set, whether Postgres is reachable, and
 * whether the schema is current enough to trust (deployed_agents exists).
 */
healthRouter.get('/db', async (_req, res) => {
  if (!config.databaseUrl) {
    res.json({
      success: true,
      data: { configured: false, reachable: false, upToDate: false, nameMismatch: null },
    });
    return;
  }

  try {
    const pool = await getPool();
    await pool.query('SELECT 1');

    let upToDate = false;
    let nameMismatch: string | null = null;
    try {
      const { rows } = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='deployed_agents'",
      );
      upToDate = rows.length > 0;
    } catch (e) {
      nameMismatch = (e as Error).message;
    }

    res.json({
      success: true,
      data: { configured: true, reachable: true, upToDate, nameMismatch },
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      error: { code: 'DB_UNREACHABLE', message: (err as Error).message },
      data: { configured: true, reachable: false, upToDate: false, nameMismatch: null },
    });
  }
});

// Kept importable from here for existing callers; it lives in errorHandler.
export { safeErrorMessage };
