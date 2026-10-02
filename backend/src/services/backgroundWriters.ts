/**
 * The loops that write shared state on their own schedule (Redis indexes,
 * task states, Postgres, on-chain mints). They start once the first identity
 * check has answered, whatever it said: every tick checks
 * backgroundWritesAllowed() itself, so a process on another deployment's
 * Redis runs them as no-ops, and one whose check had no answer at boot picks
 * up as soon as a later check allows it. Agent reconcile runs at boot and
 * again each time writes turn back on. See deploymentIdentity.ts.
 */

import { checkDeploymentIdentity, onBackgroundWritesResumed, type IdentityStatus } from './deploymentIdentity.js';
import { settlementChainConfig } from './settlementChains.js';
import { startBaseEscrowEventLoop } from './baseEscrowEvents.js';
import { startArcEscrowEventLoop } from './arcEscrowEvents.js';
import { startAgentFactoryListener } from './agentFactoryListener.js';
import { startCctpAttestationPoller } from './cctpAttestationPoller.js';
import { startExpirySweepLoop } from './a2aExpirySweep.js';
import { reconcileAgents } from './agentRunner.js';
import { startGasSponsor } from './gasSponsorRelayer.js';

export interface BackgroundWriter {
  name: string;
  start: () => void;
}

/**
 * Which half of the backend this process runs. Mirrors config.parseRunMode
 * (kept local so this module never loads config — its required() env vars
 * would break unit tests): `all` runs everything, `api` serves HTTP and
 * skips the chain-event indexers, `indexer` runs only those indexers.
 * config.runMode validates the same values at boot and fails fast there.
 */
function runMode(env: NodeJS.ProcessEnv): 'all' | 'api' | 'indexer' {
  const raw = (env.RUN_MODE ?? 'all').trim().toLowerCase();
  if (raw === 'all' || raw === 'api' || raw === 'indexer') return raw;
  throw new Error(`RUN_MODE="${env.RUN_MODE}" is not a run mode. Use "all" (HTTP + indexers), "api" (HTTP, no chain indexers) or "indexer" (chain indexers, no HTTP).`);
}

/** Every background writer this backend starts at boot, in start order. */
export function backgroundWriters(env: NodeJS.ProcessEnv = process.env): BackgroundWriter[] {
  const mode = runMode(env);
  const writers: BackgroundWriter[] = [];
  // Settlement chain indexers — populates the taskHash↔taskId mapping that
  // the A2A settlement bridge needs to call assignWorker / completeVerification
  // by on-chain id. Only start a loop when this stack has an escrow for the
  // chain, otherwise it would poll address(0) forever. Skipped entirely in
  // `api` mode, where a dedicated indexer process owns these loops (sharing
  // one Redis checkpoint, two pollers would just double the RPC load).
  if (mode !== 'api') {
    if (settlementChainConfig('base').escrowAddress !== null) {
      writers.push({ name: 'Base indexer', start: startBaseEscrowEventLoop });
    } else {
      console.log('[chain] no Base escrow configured; Base event indexing off');
    }
    if (settlementChainConfig('arc').escrowAddress !== null) {
      writers.push({ name: 'Arc indexer', start: startArcEscrowEventLoop });
    } else {
      console.log('[chain] no Arc escrow configured; Arc event indexing off');
    }
    writers.push(
      // AgentFactory listener — creates agents from on-chain AgentDeployed
      // events. Backend never signs for agents (decentralized).
      { name: 'AgentFactory listener', start: startAgentFactoryListener },
    );
  }
  if (mode !== 'indexer') {
    writers.push(
      // CCTP attestation poller — advances in-flight burn->attest->mint
      // transfers (Base <-> another EVM chain). No-ops when CCTP_ENABLED is unset.
      { name: 'CCTP poller', start: startCctpAttestationPoller },
      // Proactively close open tasks whose on-chain deadline has passed,
      // instead of leaving them listed until some agent burns an /accept on them.
      { name: 'expiry sweep', start: startExpirySweepLoop },
      // Sponsored agent gas: the single writer, its recovery, and the
      // reservation sweep. A no-op unless GAS_SPONSOR_ENABLED (gasSponsorConfig.ts).
      // In the API process: /accept reserves and /sponsored-call relays there.
      { name: 'gas sponsor', start: startGasSponsor },
    );
  }
  // Re-fork agents that were 'running' before this restart — the in-memory
  // process map doesn't survive a deploy/crash, so without this they show
  // 'running' in the UI but do no work and stop heartbeating. Off only if an
  // operator running an unusual (multi-instance) topology opts out, since each
  // instance would otherwise re-fork the same agents. Gated inside, and run
  // again when writes resume (workers killed on a not-owner verdict).
  // Never in `indexer` mode: workers are forked by the API process alone.
  if (mode !== 'indexer' && env.AGENT_RECONCILE_ON_BOOT !== 'false') {
    writers.push({ name: 'agent reconcile', start: () => void reconcileAgents() });
    onBackgroundWritesResumed(() => void reconcileAgents());
  }
  return writers;
}

/** Wait for the first identity check, then start every writer; each tick decides for itself. */
export async function startBackgroundWriters(
  writers: readonly BackgroundWriter[] = backgroundWriters(),
  check: () => Promise<IdentityStatus> = () => checkDeploymentIdentity(),
): Promise<{ identity: IdentityStatus; started: string[] }> {
  const identity = await check();
  for (const writer of writers) writer.start();
  if (!identity.writersAllowed) {
    // Their own "polling every Ns" lines would read as if they were writing.
    console.warn(`[identity] background loops started IDLE: each tick skips until a check allows writes (${identity.reason})`);
  }
  return { identity, started: writers.map((w) => w.name) };
}
