// Must precede every router: forwards async handler errors to next(err)
// instead of crashing the process (see middleware/asyncErrors.ts).
import './middleware/asyncErrors.js';
import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import { config, assertBootConfig } from './config.js';
import { embeddingsConfigured } from './services/embeddingService.js';
import { globalErrorHandler, initSentry } from './middleware/errorHandler.js';
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
import { accountingRouter } from './routes/accounting.js';
import { agentsRouter } from './routes/agents.js';
import { agentsCctpRouter } from './routes/agentsCctp.js';
import { cctpRouter } from './routes/cctp.js';
import { rpcRouter } from './routes/rpc.js';
import { messagesRouter } from './routes/messages.js';
import { marketplaceRouter } from './routes/marketplace.js';
import { notificationsRouter } from './routes/notifications.js';
import { registrationRouter } from './routes/registration.js';
import { validatorsRouter } from './routes/validators.js';
import { statsRouter } from './routes/stats.js';
import { analyticsRouter } from './routes/analytics.js';
import { apiKeysRouter } from './routes/apiKeys.js';
import { adminRouter } from './routes/admin.js';
import { sandboxRouter } from './routes/sandbox.js';
import { toolsRouter } from './routes/tools.js';
import { skillsRouter } from './routes/skills.js';
import { txRouter } from './routes/tx.js';
import { mcpRouter } from './routes/mcp.js';
import { wellKnownRouter, openapiRouter } from './routes/discovery.js';
import { getDb } from './services/database.js';
import { auditCustodySealedTasks } from './services/keyCustodyService.js';
import { isBridgeReady } from './services/a2aSettlement.js';
import { contractsEnvPrefix } from './services/chainNetwork.js';
import {
  assertPostingChain,
  assertRegistryInvariants,
  postingChain,
  settlementChainConfig,
  settlementChainConfigs,
} from './services/settlementChains.js';
import { chainRuntime } from './services/chainRuntime.js';
import { clientPricingWarnings } from './services/settlementUnits.js';
import { logChainConfig } from './services/chainService.js';
import { startZombieReaper } from './services/agentRunner.js';
import { startBackgroundWriters } from './services/backgroundWriters.js';
import { checkDeploymentIdentity } from './services/deploymentIdentity.js';

// First, so a failed boot check below is reported too. No-op without SENTRY_DSN.
initSentry(config.sentryDsn, config.sentryEnvironment);

// Fail fast on a misconfigured (esp. production) deploy before binding the port.
assertBootConfig();
for (const warning of assertRegistryInvariants(settlementChainConfigs())) {
  console.warn(`[boot] settlement chain registry: ${warning}`);
}
for (const warning of assertPostingChain({ tier: config.settlementTier })) {
  console.warn(`[boot] posting chain: ${warning}`);
}
for (const warning of clientPricingWarnings()) {
  console.warn(`[boot] pricing: ${warning}`);
}

logChainConfig();
console.log(`[chain] New tasks post on ${settlementChainConfig(postingChain()).label}`);

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
// Also under /api/v1: the web app reads /api/v1/health/settlement (and
// every other client path is /api/v1/*). Mounted only at /health, that
// request 404'd, the app fell back to its build-time table, and posted
// in Base USDC to a backend that escrows on Arc (TOKEN_NOT_SETTLEMENT).
app.use('/api/v1/health', healthRouter);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/submissions', submissionsRouter);
app.use('/api/v1/reputation', reputationRouter);
app.use('/api/v1/storage', storageRouter);
app.use('/api/v1/verification', verificationRouter);
app.use('/api/v1/a2a', a2aRouter);
app.use('/api/v1/forensics', forensicsRouter);
app.use('/api/v1/custody', custodyRouter);
// /api/v1/staking is unmounted: no client uses it, and it bound a stake to the
// caller instead of the task's executor, taking the reward from the request body
// (security audit run 1, C33). routes/staking.ts stays for a redesign.
app.use('/api/v1/accounting', accountingRouter);
app.use('/api/v1/agents', agentsRouter);
app.use('/api/v1/agents', agentsCctpRouter);
app.use('/api/v1/cctp', cctpRouter);
app.use('/api/v1/rpc', rpcRouter);
app.use('/api/v1/messages', messagesRouter);
app.use('/api/v1/marketplace', marketplaceRouter);
app.use('/api/v1/notifications', notificationsRouter);
app.use('/api/v1/registration', registrationRouter);
app.use('/api/v1/validators', validatorsRouter);
app.use('/api/v1/stats', statsRouter);
app.use('/api/v1/analytics', analyticsRouter);
app.use('/api/v1/api-keys', apiKeysRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/sandbox', sandboxRouter);
app.use('/api/v1/tools', toolsRouter);
  app.use('/api/v1/skills', skillsRouter);
  app.use('/api/v1/tx', txRouter);
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

// Initialize database: SQLite when no DATABASE_URL (dev), PostgreSQL otherwise (prod)
if (!config.databaseUrl) {
  getDb();
} else {
  console.log('[db] DATABASE_URL set — using PostgreSQL');
}

const corsOptions = {
  origin: config.nodeEnv === 'development'
    ? [...new Set([...config.corsOrigin, 'http://localhost:5173', 'http://localhost:5174'])] as string[]
    : [...config.corsOrigin] as string[],
  credentials: true,
};

const httpServer = createServer(app);
initSocket(httpServer, corsOptions);

// Who owns this Redis, asked before the first request can force an indexer
// pass; the background writers start once it answers (deploymentIdentity.ts).
const identityCheck = checkDeploymentIdentity();

httpServer.listen(config.port, () => {
  console.log(`BlindMarket backend listening on port ${config.port} (${config.nodeEnv})`);

  // Semantic routing (Phase 2 flip) posture. Loud misconfig warning: flipping
  // routing on while embeddings are mock/keyless would order cascade offers by
  // deterministic hash vectors, not meaning (mechanically safe — tag/broadcast
  // fallbacks still apply — but a nonsense canary).
  if (config.semanticRoutingEnabled) {
    if (!embeddingsConfigured()) {
      console.warn('[semantic] SEMANTIC_ROUTING_ENABLED=true but embeddings are mock/keyless — offers would be ranked by hash vectors, NOT meaning. Set EMBEDDING_PROVIDER + EMBEDDING_API_KEY or turn the flag off.');
    } else {
      console.log(`[semantic] routing FLIPPED ON — cascade offers ranked by meaning (rerank=${config.rerankEnabled ? 'on' : 'off'}); capability tags are fallback-only`);
    }
  }
  // Indexers, sweeps, the CCTP poller and agent reconcile write shared state,
  // so they start only once this process knows the Redis is its deployment's.
  void startBackgroundWriters(undefined, () => identityCheck);

  // Tripwire for custody-key rotation/disable while custody-sealed tasks are
  // still open (their late-joiner self-heal silently breaks). Loud log only.
  void auditCustodySealedTasks();
  // Background reaper: every 60s, kill forked agents whose Redis heartbeat
  // expired (stale >90s). Catches SIGKILL'd workers the auto-restart handler
  // never saw. Always runs, even when reconcile is off.
  startZombieReaper();
  // Visibility into whether the A2A settlement bridge will actually fire
  // when an agent accepts/submits, per settlement chain: a chain with no
  // marketplace signer is off; when on, log the signer address so it's clear
  // which key is signing. Every chain the registry knows is checked, so a
  // signer set without its escrow is reported too.
  const bridgeChains = settlementChainConfigs().map(({ key, label, escrowEnv, signerEnv, hardhatNetwork }) => {
    const { escrow: chainEscrow, marketplaceSigner: signer } = chainRuntime(key);
    return {
      chain: key,
      escrow: chainEscrow,
      signer,
      // The address the escrow contract was built with, zero address
      // included (0G builds one whatever its setting), as these messages
      // have always printed it. Empty when there is no contract.
      escrowAddress: chainEscrow ? String(chainEscrow.target) : '',
      label,
      escrowEnv,
      signerEnv,
      network: hardhatNetwork,
    };
  });
  for (const bridge of bridgeChains) {
    const { label, signer, escrow: chainEscrow } = bridge;
    if (!isBridgeReady(bridge.chain) || !signer || !chainEscrow) {
      // Same rule as /health/bridge: silent only when neither is set, i.e.
      // this chain is not part of the deployment.
      const unset = bridge.escrowAddress ? bridge.signerEnv : signer ? bridge.escrowEnv : null;
      if (unset) {
        console.warn(
          `[a2aSettlement] ${label} bridge DISABLED — ${unset} not set. ` +
            `${label} tasks will accept/submit off-chain but will not settle on-chain.`,
        );
      }
      continue;
    }
    void (async () => {
      const signerAddr = await signer.getAddress();
      console.log(`[a2aSettlement] ${label} bridge active — marketplace signer = ${signerAddr}`);
      // Verify the signer actually holds the on-chain verifier role. Without
      // this, marketplaceAssign/completeVerification revert with NotVerifier()
      // on every call and the fire-and-forget bridge swallows the error,
      // leaving tasks stuck at accepted forever. This was the 2-day-debug
      // root cause: the role was set to the founder wallet at deploy and
      // never rotated. Print the exact rotation command so the operator
      // has zero ambiguity about the fix.
      try {
        const onChainVerifier = (await chainEscrow.verifier()) as string;
        if (onChainVerifier.toLowerCase() !== signerAddr.toLowerCase()) {
          console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
          console.error(`[a2aSettlement] ⛔ ${label} VERIFIER ROLE MISMATCH — bridge will silently fail every call`);
          console.error(`    escrow.verifier()        = ${onChainVerifier}`);
          console.error(`    ${label} signer address = ${signerAddr}`);
          console.error(`    escrow contract address  = ${bridge.escrowAddress}`);
          console.error('    Fix from contracts/ with the current admin key. rotate-verifier.ts acts on');
          console.error('    the escrow its deployment record names and refuses unless that is EXPECTED_ESCROW:');
          console.error(`    ${contractsEnvPrefix(bridge.escrowAddress)}MARKETPLACE_SIGNER_ADDRESS=${signerAddr} \\`);
          console.error(`      npx hardhat run scripts/rotate-verifier.ts --network ${bridge.network}`);
          console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        } else {
          console.log(`[a2aSettlement] ✓ ${label} verifier role confirmed (escrow.verifier() == signer)`);
        }
      } catch (e) {
        const err = e as Error & { errors?: Error[] };
        const msg = err.errors?.length
          ? err.errors.map((ee: Error) => ee.message || String(ee)).join('; ')
          : err.message || String(e);
        console.error(
          `[a2aSettlement] ⛔ could not read ${label} escrow.verifier() — escrow contract at ${bridge.escrowAddress} may be wrong or unreachable: ${msg}`,
        );
      }
    })();
  }
});

export default app;