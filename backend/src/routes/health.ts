import { Router } from 'express';
import { formatEther, ZeroAddress } from 'ethers';
import type { ApiResponse } from '../types.js';
import { escrow, marketplaceSigner, provider, baseEscrow, baseMarketplaceSigner, baseProvider } from '../services/chain.js';
import { isBridgeReady } from '../services/a2aSettlement.js';
import { chainNetwork, contractsEnvPrefix } from '../services/chainNetwork.js';
import {
  postingChain,
  settlementChainConfigs,
  type SettlementChainConfig,
  type SettlementChainKey,
} from '../services/settlementChains.js';
import { chainRuntime } from '../services/chainRuntime.js';
import type { SettlementTier } from '../services/settlementTier.js';
import { relayChainName } from '../services/relayChains.js';
import { escrowFingerprintError } from '../services/escrowFingerprint.js';
import { parkedDisputeCount } from '../services/disputeKeys.js';
import { config } from '../config.js';
import { redis, redisSub } from '../services/redis.js';
import { getPool, getSchemaStatus, latestMigrationId } from '../services/neonDb.js';

export const healthRouter = Router();

// Below this native-0G balance the marketplace signer is at risk of failing to
// broadcast marketplaceAssign / completeVerification (out of gas), which surfaces
// as BRIDGE_FAILED even though the verifier role is correct.
const SIGNER_GAS_LOW_OG = 0.02;

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

function rotateCommand(signerAddr: string, network: string, escrowAddress: string | null): string {
  return `cd contracts && ${contractsEnvPrefix(escrowAddress)}MARKETPLACE_SIGNER_ADDRESS=${signerAddr} npx hardhat run scripts/rotate-verifier.ts --network ${network}`;
}

/** The 0G half of the bridge: verifier role and native-0G gas of its signer. */
async function zeroGBridge(): Promise<Record<string, unknown>> {
  const signerAddr = await marketplaceSigner!.getAddress();
  let onChainVerifier: string | null = null;
  let escrowReadError: string | null = null;
  try {
    onChainVerifier = (await escrow.verifier()) as string;
  } catch (e) {
    escrowReadError = (e as Error).message;
  }
  const verifierMatches =
    onChainVerifier !== null &&
    onChainVerifier.toLowerCase() === signerAddr.toLowerCase();

  let signerBalanceOg: string | null = null;
  let signerGasLow: boolean | null = null;
  let signerBalanceError: string | null = null;
  try {
    const balanceWei = await provider.getBalance(signerAddr);
    const og = Number(formatEther(balanceWei));
    signerBalanceOg = formatEther(balanceWei);
    signerGasLow = og < SIGNER_GAS_LOW_OG;
  } catch (e) {
    signerBalanceError = (e as Error).message;
  }

  return {
    signerAddress: signerAddr,
    escrowAddress: escrowOrNull(config.blindEscrowAddress),
    chainId: config.ogChainId,
    onChainVerifier,
    verifierMatches,
    escrowReadError,
    signerBalanceOg,
    signerGasLow,
    signerBalanceError,
    rotateCommand: verifierMatches
      ? null
      : rotateCommand(signerAddr, chainNetwork('0g').hardhatNetwork, escrowOrNull(config.blindEscrowAddress)),
  };
}

/** The Base half: verifier role, USDC and ETH balances of its signer. */
async function baseBridge(): Promise<Record<string, unknown>> {
  const baseSignerAddr = await baseMarketplaceSigner!.getAddress();
  let baseVerifier: string | null = null;
  let baseEscrowError: string | null = null;
  try {
    baseVerifier = (await baseEscrow!.verifier()) as string;
  } catch (e) {
    baseEscrowError = (e as Error).message;
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
    baseSignerBalanceError = (e as Error).message;
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
 * A chain as /health/bridge reports it. Fields are picked one by one: the
 * registry entry also holds the RPC URL, which can carry a provider key.
 */
async function chainReport(
  entry: SettlementChainConfig,
  configured: boolean,
  reason: string | null,
  posting: SettlementChainKey | null,
): Promise<Record<string, unknown>> {
  const { key, chainId, tier, escrowAddress, token, gas } = entry;
  return {
    chain: key,
    configured,
    chainId,
    tier,
    escrowAddress,
    token: { kind: token.kind, address: token.address, symbol: token.unit.symbol, decimals: token.unit.decimals },
    relayChain: relayChainName(entry),
    gasSymbol: gas.symbol,
    // POST /tasks builds new tasks here: the posting chain, with an escrow
    // and a settlement token. It does not need the marketplace signer, which
    // `configured` reports.
    postable: key === posting && escrowAddress !== null && token.address !== null,
    ...(reason ? { reason } : {}),
    ...indexerError(key),
    ...(await parkedDisputes(key)),
  };
}

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
    let posting: SettlementChainKey | null = null;
    let postingChainError: string | null = null;
    try {
      posting = postingChain();
    } catch (e) {
      postingChainError = (e as Error).message;
    }
    const readiness = entries.map((entry) => {
      const { escrow: chainEscrow, marketplaceSigner: signer } = chainRuntime(entry.key);
      // isBridgeReady already implies the escrow and signer; checked again
      // because the 0G and Base blocks below dereference them.
      const configured = isBridgeReady(entry.key) && !!chainEscrow && !!signer;
      const reason = notReadyReason(configured, entry.escrowAddress, entry.escrowEnv, !!signer, entry.signerEnv);
      return { entry, configured, reason };
    });
    const isReady = (key: SettlementChainKey) => readiness.some((r) => r.entry.key === key && r.configured);

    const [og, base, chains] = await Promise.all([
      isReady('0g') ? zeroGBridge() : null,
      isReady('base') ? baseBridge() : null,
      Promise.all(readiness.map(({ entry, configured, reason }) => chainReport(entry, configured, reason, posting))),
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
        // Reported even when 0G can't settle, so a client can still check
        // that a 0G transaction targets this escrow.
        escrowAddress: escrowOrNull(config.blindEscrowAddress),
        chainId: config.ogChainId,
        ...(og ?? {}),
        base,
        chains,
        postingChain: posting,
        ...tierReport(entries, config.settlementTier),
        ...(postingChainError ? { postingChainError } : {}),
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
