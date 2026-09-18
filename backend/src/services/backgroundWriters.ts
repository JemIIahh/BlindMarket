/**
 * The loops that write shared state on their own schedule (Redis indexes,
 * task states, Postgres, on-chain mints), started once this process knows
 * the Redis is its deployment's. Each writer also checks
 * backgroundWritesAllowed() when it runs, so a verdict reached after boot
 * still stops it; see deploymentIdentity.ts. HTTP routes are not affected.
 */

import { checkDeploymentIdentity, type IdentityStatus } from './deploymentIdentity.js';
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
  // instance would otherwise re-fork the same agents.
  if (env.AGENT_RECONCILE_ON_BOOT !== 'false') {
    writers.push({ name: 'agent reconcile', start: () => void reconcileAgents() });
  }
  return writers;
}

/** Check who owns this Redis, then start `writers` only if this process may write. */
export async function startBackgroundWriters(
  writers: readonly BackgroundWriter[] = backgroundWriters(),
  check: () => Promise<IdentityStatus> = () => checkDeploymentIdentity(),
): Promise<{ identity: IdentityStatus; started: string[] }> {
  const identity = await check();
  if (!identity.writersAllowed) return { identity, started: [] };
  for (const writer of writers) writer.start();
  return { identity, started: writers.map((w) => w.name) };
}
