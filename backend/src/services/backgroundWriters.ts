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
import { startEscrowEventLoop } from './escrowEvents.js';
import { startBaseEscrowEventLoop } from './baseEscrowEvents.js';
import { startAgentFactoryListener } from './agentFactoryListener.js';
import { startCctpAttestationPoller } from './cctpAttestationPoller.js';
import { startExpirySweepLoop } from './a2aExpirySweep.js';
import { reconcileAgents } from './agentRunner.js';

export interface BackgroundWriter {
  name: string;
  start: () => void;
}

/** Every background writer this backend starts at boot, in start order. */
export function backgroundWriters(env: NodeJS.ProcessEnv = process.env): BackgroundWriter[] {
  const writers: BackgroundWriter[] = [];
  // The BlindEscrow TaskCreated poller — populates the taskHash↔taskId
  // mapping that the A2A settlement bridge needs to call assignWorker /
  // completeVerification by on-chain id. Only where this stack has a 0G
  // escrow: the loop would otherwise poll address(0) forever.
  if (settlementChainConfig('0g').escrowAddress !== null) {
    writers.push({ name: '0G indexer', start: startEscrowEventLoop });
  } else {
    console.log('[chain] no 0G escrow configured; 0G event indexing off');
  }
  writers.push(
    // Base escrow event loop — populates base: prefixed taskHash↔taskId
    // mapping needed for USDC settlement on Base chain.
    { name: 'Base indexer', start: startBaseEscrowEventLoop },
    // AgentFactory listener — creates agents from on-chain AgentDeployed
    // events. Backend never signs for agents (decentralized).
    { name: 'AgentFactory listener', start: startAgentFactoryListener },
    // CCTP attestation poller — advances in-flight burn->attest->mint
    // transfers (Base <-> another EVM chain). No-ops when CCTP_ENABLED is unset.
    { name: 'CCTP poller', start: startCctpAttestationPoller },
    // Proactively close open tasks whose on-chain deadline has passed,
    // instead of leaving them listed until some agent burns an /accept on them.
    { name: 'expiry sweep', start: startExpirySweepLoop },
  );
  // Re-fork agents that were 'running' before this restart — the in-memory
  // process map doesn't survive a deploy/crash, so without this they show
  // 'running' in the UI but do no work and stop heartbeating. Off only if an
  // operator running an unusual (multi-instance) topology opts out, since each
  // instance would otherwise re-fork the same agents. Gated inside, and run
  // again when writes resume (workers killed on a not-owner verdict).
  if (env.AGENT_RECONCILE_ON_BOOT !== 'false') {
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
