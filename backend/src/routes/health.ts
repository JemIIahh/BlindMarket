import { Router } from 'express';
import { formatEther } from 'ethers';
import type { ApiResponse } from '../types.js';
import { escrow, marketplaceSigner, provider, baseEscrow, baseMarketplaceSigner, baseProvider } from '../services/chain.js';
import { isBridgeConfigured } from '../services/a2aSettlement.js';
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

// GET /api/v1/health/bridge — surfaces the A2A settlement bridge config
// without needing backend log access. Returns whether the marketplace signer
// is set and whether it actually holds the on-chain verifier role. A `false`
// for `verifierMatches` is the root cause of every "task accepted but never
// completes" report; the response includes the exact rotate-verifier command
// to run from contracts/.
healthRouter.get('/bridge', async (_req, res, next) => {
  try {
    const configured = isBridgeConfigured();
    if (!configured || !marketplaceSigner) {
      const body: ApiResponse = {
        success: true,
        data: {
          configured: false,
          reason: 'MARKETPLACE_SIGNER_PRIVATE_KEY not set in backend env',
        },
      };
      res.json(body);
      return;
    }
    const signerAddr = await marketplaceSigner.getAddress();
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

    const network = config.ogChainId === 16661 ? 'mainnet' : 'testnet';

    // Base bridge status (USDC settlement)
    let baseBridge: Record<string, unknown> | null = null;
    if (config.baseEscrowAddress && baseEscrow && baseMarketplaceSigner && baseProvider) {
      const baseSignerAddr = await baseMarketplaceSigner.getAddress();
      let baseVerifier: string | null = null;
      let baseEscrowError: string | null = null;
      try {
        baseVerifier = (await baseEscrow.verifier()) as string;
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
      baseBridge = {
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
          : `cd contracts && MARKETPLACE_SIGNER_ADDRESS=${baseSignerAddr} npx hardhat run scripts/rotate-verifier.ts --network base${network === 'mainnet' ? '' : '-sepolia'}`,
      };
    }

    const body: ApiResponse = {
      success: true,
      data: {
        configured: true,
        signerAddress: signerAddr,
        escrowAddress: config.blindEscrowAddress,
        chainId: config.ogChainId,
        onChainVerifier,
        verifierMatches,
        escrowReadError,
        signerBalanceOg,
        signerGasLow,
        signerBalanceError,
        rotateCommand: verifierMatches
          ? null
          : `cd contracts && MARKETPLACE_SIGNER_ADDRESS=${signerAddr} npx hardhat run scripts/rotate-verifier.ts --network 0g-${network}`,
        base: baseBridge,
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
