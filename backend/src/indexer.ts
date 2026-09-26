/**
 * Standalone chain-event indexer: runs the settlement-chain listeners (Base,
 * Arc, AgentFactory) against the shared Redis without binding HTTP.
 *
 * Split topology for VPC/docker-compose deploys: one `api` container serves
 * requests (RUN_MODE=api skips these loops) and one `indexer` container runs
 * this entry (RUN_MODE=indexer). Both share DEPLOYMENT_ID, so the identity
 * check allows both to write; the loops are idempotent and checkpointed, so
 * at-least-once delivery across restarts is safe.
 *
 * Run:  RUN_MODE=indexer npx tsx src/indexer.ts   (dev)
 *       node dist/indexer.js                      (docker, after `npm run build`)
 */

import { config, assertBootConfig } from './config.js';
import { initSentry } from './middleware/errorHandler.js';
import { logChainConfig } from './services/chainService.js';
import { startBackgroundWriters } from './services/backgroundWriters.js';
import { checkDeploymentIdentity } from './services/deploymentIdentity.js';
import { assertRpcChainIds, bootRpcEndpoints } from './services/rpcChainIds.js';
import { stopBaseEscrowEventLoop } from './services/baseEscrowEvents.js';
import { stopArcEscrowEventLoop } from './services/arcEscrowEvents.js';
import { stopAgentFactoryListener } from './services/agentFactoryListener.js';

if (config.runMode !== 'indexer') {
  console.error(
    `[indexer] refusing to start with RUN_MODE=${config.runMode}: this entry runs the chain indexers only; ` +
      `set RUN_MODE=indexer (the API serves HTTP with RUN_MODE=api).`,
  );
  process.exit(1);
}

// First, so a failed boot check below is reported too. No-op without SENTRY_DSN.
initSentry(config.sentryDsn, config.sentryEnvironment);

// Same fail-fast gates as the API: a misconfigured deploy dies loudly here,
// and a wrong-chain RPC is caught before any checkpoint moves.
assertBootConfig();
logChainConfig();

// Every provider takes its chain id on trust (staticNetwork), so ask each RPC
// which chain it serves before indexing (services/rpcChainIds.ts).
await assertRpcChainIds(bootRpcEndpoints());

const identityCheck = checkDeploymentIdentity();
const { identity, started } = await startBackgroundWriters(undefined, () => identityCheck);
console.log(`[indexer] running (${started.join(', ')}) — identity: ${identity.role}, writes ${identity.writersAllowed ? 'allowed' : 'IDLE until allowed'}`);

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`[indexer] ${signal} — stopping loops`);
    stopBaseEscrowEventLoop();
    stopArcEscrowEventLoop();
    stopAgentFactoryListener();
    // Intervals cleared; pending RPC calls settle, then the loop drains.
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
