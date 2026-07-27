import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import { config, assertBootConfig } from './config.js';
import { globalErrorHandler } from './middleware/errorHandler.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { requestLogger } from './middleware/requestLogger.js';
import { initSocket } from './services/socket.js';
import { healthRouter } from './routes/health.js';
import { tasksRouter } from './routes/tasks.js';
import { submissionsRouter } from './routes/submissions.js';
import { reputationRouter } from './routes/reputation.js';
import { storageRouter } from './routes/storage.js';
import { verificationRouter } from './routes/verification.js';
import { a2aRouter } from './routes/a2a.js';
import { a2aProtocolRouter } from './routes/a2aProtocol.js';
import { forensicsRouter } from './routes/forensics.js';
import { custodyRouter } from './routes/custody.js';
import { stakingRouter } from './routes/staking.js';
import { accountingRouter } from './routes/accounting.js';
import { agentsRouter } from './routes/agents.js';
import { messagesRouter } from './routes/messages.js';
import { marketplaceRouter } from './routes/marketplace.js';
import { registrationRouter } from './routes/registration.js';
import { validatorsRouter } from './routes/validators.js';
import { statsRouter } from './routes/stats.js';
import { analyticsRouter } from './routes/analytics.js';
import { apiKeysRouter } from './routes/apiKeys.js';
import { adminRouter } from './routes/admin.js';
import { sandboxRouter } from './routes/sandbox.js';
import { toolsRouter } from './routes/tools.js';
import { mcpRouter } from './routes/mcp.js';
import { wellKnownRouter, openapiRouter } from './routes/discovery.js';
import { getDb } from './services/database.js';
import { startEscrowEventLoop } from './services/escrowEvents.js';
import { startExpirySweepLoop } from './services/a2aExpirySweep.js';
import { auditCustodySealedTasks } from './services/keyCustodyService.js';
import { isBridgeConfigured } from './services/a2aSettlement.js';
import { marketplaceSigner, escrow, provider } from './services/chain.js';
import { logChainConfig } from './services/chainService.js';
import { reconcileAgents, startZombieReaper } from './services/agentRunner.js';

// Fail fast on a misconfigured (esp. production) deploy before binding the port.
assertBootConfig();

logChainConfig();

const app = express();
app.set('trust proxy', 1);

// Security
app.use(helmet());
app.use(cors({
  origin: config.nodeEnv === 'development'
    ? [...new Set([...config.corsOrigin, 'http://localhost:5173', 'http://localhost:5174'])] as string[]
    : [...config.corsOrigin] as string[],
  credentials: true,
}));
app.use(createRateLimiter());

// Body parsing
app.use(express.json({ limit: '2mb' }));

// Request logging
app.use(requestLogger);

// Routes
app.use('/health', healthRouter);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/submissions', submissionsRouter);
app.use('/api/v1/reputation', reputationRouter);
app.use('/api/v1/storage', storageRouter);
app.use('/api/v1/verification', verificationRouter);
app.use('/api/v1/a2a', a2aRouter);
app.use('/api/v1/forensics', forensicsRouter);
app.use('/api/v1/custody', custodyRouter);
app.use('/api/v1/staking', stakingRouter);
app.use('/api/v1/accounting', accountingRouter);
app.use('/api/v1/agents', agentsRouter);
app.use('/api/v1/messages', messagesRouter);
app.use('/api/v1/marketplace', marketplaceRouter);
app.use('/api/v1/registration', registrationRouter);
app.use('/api/v1/validators', validatorsRouter);
app.use('/api/v1/stats', statsRouter);
app.use('/api/v1/analytics', analyticsRouter);
app.use('/api/v1/api-keys', apiKeysRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/sandbox', sandboxRouter);
app.use('/api/v1/tools', toolsRouter);
app.use('/a2a/v1', a2aProtocolRouter);
// Remote MCP endpoint (Streamable HTTP) — how external agent harnesses
// (Claude Code / Claude connectors / ChatGPT / Hermes / Cursor) reach the
// marketplace. See routes/mcp.ts and docs/AGENT-READY.md.
app.use('/mcp', mcpRouter);

// Agent cards (A2A discovery) + OpenAPI — see routes/discovery.ts.
app.use('/.well-known', wellKnownRouter);
app.use('/api/v1/openapi.json', openapiRouter);

// Error handling (must be last)
app.use(globalErrorHandler);

// Initialize SQLite database and run migrations
getDb();

const corsOptions = {
  origin: config.nodeEnv === 'development'
    ? [...new Set([...config.corsOrigin, 'http://localhost:5173', 'http://localhost:5174'])] as string[]
    : [...config.corsOrigin] as string[],
  credentials: true,
};

const httpServer = createServer(app);
initSocket(httpServer, corsOptions);

httpServer.listen(config.port, () => {
  console.log(`BlindMarket backend listening on port ${config.port} (${config.nodeEnv})`);
  // Start the BlindEscrow TaskCreated poller — populates the taskHash↔taskId
  // mapping that the A2A settlement bridge needs to call assignWorker /
  // completeVerification by on-chain id.
  startEscrowEventLoop();

  // Proactively close open tasks whose on-chain deadline has passed, instead
  // of leaving them listed until some agent burns an /accept on them.
  startExpirySweepLoop();

  // Tripwire for custody-key rotation/disable while custody-sealed tasks are
  // still open (their late-joiner self-heal silently breaks). Loud log only.
  void auditCustodySealedTasks();

  // Re-fork agents that were 'running' before this restart — the in-memory
  // process map doesn't survive a deploy/crash, so without this they show
  // 'running' in the UI but do no work and stop heartbeating. Off only if an
  // operator running an unusual (multi-instance) topology opts out, since each
  // instance would otherwise re-fork the same agents.
  if (process.env.AGENT_RECONCILE_ON_BOOT !== 'false') {
    void reconcileAgents();
  }
  // Background reaper: every 60s, kill forked agents whose Redis heartbeat
  // expired (stale >90s). Catches SIGKILL'd workers the auto-restart handler
  // never saw. Always runs, even when reconcile is off.
  startZombieReaper();
  // Visibility into whether the A2A settlement bridge will actually fire
  // when an agent accepts/submits. Off-by-default if MARKETPLACE_SIGNER_PRIVATE_KEY
  // is unset; when on, log the signer address so it's clear which key is signing.
  if (isBridgeConfigured() && marketplaceSigner) {
    void (async () => {
      const signerAddr = await marketplaceSigner.getAddress();
      console.log(`[a2aSettlement] bridge active — marketplace signer = ${signerAddr}`);
      // Verify the signer actually holds the on-chain verifier role. Without
      // this, marketplaceAssign/completeVerification revert with NotVerifier()
      // on every call and the fire-and-forget bridge swallows the error,
      // leaving tasks stuck at accepted forever. This was the 2-day-debug
      // root cause: the role was set to the founder wallet at deploy and
      // never rotated. Print the exact rotation command so the operator
      // has zero ambiguity about the fix.
      try {
        const onChainVerifier = (await escrow.verifier()) as string;
        if (onChainVerifier.toLowerCase() !== signerAddr.toLowerCase()) {
          console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.error('[a2aSettlement] ⛔ VERIFIER ROLE MISMATCH — bridge will silently fail every call');
          console.error(`    escrow.verifier()        = ${onChainVerifier}`);
          console.error(`    marketplaceSigner.addr   = ${signerAddr}`);
          console.error(`    escrow contract address  = ${config.blindEscrowAddress}`);
          console.error('    Fix from contracts/ with the current admin key:');
          console.error(`    MARKETPLACE_SIGNER_ADDRESS=${signerAddr} \\`);
          console.error(`      npx hardhat run scripts/rotate-verifier.ts --network 0g-${config.ogChainId === 16661 ? 'mainnet' : 'testnet'}`);
          console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        } else {
          console.log(`[a2aSettlement] ✓ verifier role confirmed (escrow.verifier() == signer)`);
        }
      } catch (e) {
        const err = e as Error & { errors?: Error[] };
        const msg = err.errors?.length
          ? err.errors.map((ee: Error) => ee.message || String(ee)).join('; ')
          : err.message || String(e);
        console.error(
          `[a2aSettlement] ⛔ could not read escrow.verifier() — escrow contract at ${config.blindEscrowAddress} may be wrong or unreachable: ${msg}`,
        );
      }
    })();
  } else {
    console.warn(
      '[a2aSettlement] bridge DISABLED — MARKETPLACE_SIGNER_PRIVATE_KEY not set. ' +
        'A2A tasks will accept/submit off-chain but will not settle on-chain.',
    );
  }
});

export default app;