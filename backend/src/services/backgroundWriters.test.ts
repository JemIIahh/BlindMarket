/**
 * The background writers start only once this process knows the Redis is its
 * deployment's, and each also checks again when it runs (deploymentIdentity.ts).
 *
 * Run: npx vitest run src/services/backgroundWriters.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { started, gate, identity } = vi.hoisted(() => ({
  started: [] as string[],
  gate: { allowed: true },
  identity: { status: null as null | { role: string; writersAllowed: boolean } },
}));

vi.mock('./deploymentIdentity.js', () => ({
  checkDeploymentIdentity: async () => identity.status,
  backgroundWritesAllowed: () => gate.allowed,
}));
vi.mock('./settlementChains.js', () => ({ settlementChainConfig: () => ({ escrowAddress: '0x' + '11'.repeat(20) }) }));
vi.mock('./escrowEvents.js', () => ({ startEscrowEventLoop: () => started.push('startEscrowEventLoop') }));
vi.mock('./baseEscrowEvents.js', () => ({ startBaseEscrowEventLoop: () => started.push('startBaseEscrowEventLoop') }));
vi.mock('./agentFactoryListener.js', () => ({ startAgentFactoryListener: () => started.push('startAgentFactoryListener') }));
vi.mock('./cctpAttestationPoller.js', () => ({ startCctpAttestationPoller: () => started.push('startCctpAttestationPoller') }));
vi.mock('./a2aExpirySweep.js', () => ({ startExpirySweepLoop: () => started.push('startExpirySweepLoop') }));
vi.mock('./agentRunner.js', () => ({ reconcileAgents: async () => { started.push('reconcileAgents'); } }));

import { backgroundWriters, startBackgroundWriters } from './backgroundWriters.js';

const EVERY_WRITER = [
  'startEscrowEventLoop', 'startBaseEscrowEventLoop', 'startAgentFactoryListener',
  'startCctpAttestationPoller', 'startExpirySweepLoop', 'reconcileAgents',
];

beforeEach(() => {
  started.length = 0;
});

describe('startBackgroundWriters', () => {
  it('starts every writer for the owner', async () => {
    identity.status = { role: 'owner', writersAllowed: true };
    const { started: names } = await startBackgroundWriters(backgroundWriters({}));
    expect(started).toEqual(EVERY_WRITER);
    expect(names).toEqual(['0G indexer', 'Base indexer', 'AgentFactory listener', 'CCTP poller', 'expiry sweep', 'agent reconcile']);
  });

  it('starts none of them on another deployment\'s Redis — reconcile and the sweep included', async () => {
    identity.status = { role: 'not-owner', writersAllowed: false };
    const { started: names } = await startBackgroundWriters(backgroundWriters({}));
    expect(started).toEqual([]);
    expect(names).toEqual([]);
  });

  it('starts them all when the check could not reach Redis', async () => {
    identity.status = { role: 'unknown', writersAllowed: true };
    await startBackgroundWriters(backgroundWriters({}));
    expect(started).toEqual(EVERY_WRITER);
  });

  it('leaves reconcile out when AGENT_RECONCILE_ON_BOOT=false, as before', async () => {
    identity.status = { role: 'owner', writersAllowed: true };
    await startBackgroundWriters(backgroundWriters({ AGENT_RECONCILE_ON_BOOT: 'false' }));
    expect(started).not.toContain('reconcileAgents');
  });
});
