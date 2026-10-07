/**
 * The background writers start only once this process knows the Redis is its
 * deployment's, and each also checks again when it runs (deploymentIdentity.ts).
 *
 * Run: npx vitest run src/services/backgroundWriters.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { started, gate, identity, resumed } = vi.hoisted(() => ({
  started: [] as string[],
  gate: { allowed: true },
  identity: { status: null as null | { role: string; writersAllowed: boolean } },
  resumed: [] as Array<() => void>,
}));

vi.mock('./deploymentIdentity.js', () => ({
  checkDeploymentIdentity: async () => identity.status,
  backgroundWritesAllowed: () => gate.allowed,
  onBackgroundWritesResumed: (listener: () => void) => { resumed.push(listener); },
}));
vi.mock('./settlementChains.js', () => ({ settlementChainConfig: () => ({ escrowAddress: '0x' + '11'.repeat(20) }) }));
vi.mock('./arcEscrowEvents.js', () => ({ startArcEscrowEventLoop: () => started.push('startArcEscrowEventLoop') }));
vi.mock('./baseEscrowEvents.js', () => ({ startBaseEscrowEventLoop: () => started.push('startBaseEscrowEventLoop') }));
vi.mock('./agentFactoryListener.js', () => ({ startAgentFactoryListener: () => started.push('startAgentFactoryListener') }));
vi.mock('./cctpAttestationPoller.js', () => ({ startCctpAttestationPoller: () => started.push('startCctpAttestationPoller') }));
vi.mock('./a2aExpirySweep.js', () => ({ startExpirySweepLoop: () => started.push('startExpirySweepLoop') }));
vi.mock('./agentRunner.js', () => ({ reconcileAgents: async () => { started.push('reconcileAgents'); } }));
vi.mock('./gasSponsorRelayer.js', () => ({ startGasSponsor: () => started.push('startGasSponsor') }));
vi.mock('./openSubmissionSweep.js', () => ({ startOpenSubmissionSweepLoop: () => started.push('startOpenSubmissionSweepLoop') }));

import { backgroundWriters, startBackgroundWriters } from './backgroundWriters.js';

const EVERY_WRITER = [
  'startBaseEscrowEventLoop', 'startArcEscrowEventLoop', 'startAgentFactoryListener',
  'startCctpAttestationPoller', 'startExpirySweepLoop', 'startGasSponsor', 'reconcileAgents',
];

beforeEach(() => {
  started.length = 0;
  resumed.length = 0;
});

describe('startBackgroundWriters', () => {
  it('starts every writer for the owner', async () => {
    identity.status = { role: 'owner', writersAllowed: true };
    const { started: names } = await startBackgroundWriters(backgroundWriters({}));
    expect(started).toEqual(EVERY_WRITER);
    expect(names).toEqual(['Base indexer', 'Arc indexer', 'AgentFactory listener', 'CCTP poller', 'expiry sweep', 'gas sponsor', 'agent reconcile']);
  });

  it('adds the open-submission sweep only with OPEN_SUBMISSION_ENABLED, in the API process', () => {
    const names = (env: NodeJS.ProcessEnv) => backgroundWriters(env).map((w) => w.name);
    expect(names({})).not.toContain('open-submission sweep');
    expect(names({ OPEN_SUBMISSION_ENABLED: 'true' })).toContain('open-submission sweep');
    expect(names({ OPEN_SUBMISSION_ENABLED: 'true', RUN_MODE: 'indexer' })).not.toContain('open-submission sweep');
  });

  it('starts them after the first check whatever it said: each tick is gated, so a later "allowed" takes effect', async () => {
    for (const status of [{ role: 'not-owner', writersAllowed: false }, { role: 'unknown', writersAllowed: false }, { role: 'unknown', writersAllowed: true }]) {
      started.length = 0;
      identity.status = status;
      await startBackgroundWriters(backgroundWriters({}));
      expect(started).toEqual(EVERY_WRITER);
    }
  });

  it('says the loops started idle, so their "polling" lines do not read as writing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    identity.status = { role: 'not-owner', writersAllowed: false };
    await startBackgroundWriters(backgroundWriters({}));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/started IDLE/));
    warn.mockClear();
    identity.status = { role: 'owner', writersAllowed: true };
    await startBackgroundWriters(backgroundWriters({}));
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/started IDLE/));
    warn.mockRestore();
  });

  it('waits for the first check before starting anything', async () => {
    let answer: (s: { role: string; writersAllowed: boolean }) => void = () => {};
    const pending = startBackgroundWriters(backgroundWriters({}), () => new Promise((r) => { answer = r; }) as never);
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual([]);
    answer({ role: 'owner', writersAllowed: true });
    await pending;
    expect(started).toEqual(EVERY_WRITER);
  });

  it('reconciles agents again each time writes resume', async () => {
    identity.status = { role: 'unknown', writersAllowed: false };
    await startBackgroundWriters(backgroundWriters({}));
    started.length = 0;
    expect(resumed).toHaveLength(1);
    resumed[0]();
    expect(started).toEqual(['reconcileAgents']);
  });

  it('leaves reconcile out when AGENT_RECONCILE_ON_BOOT=false, as before', async () => {
    identity.status = { role: 'owner', writersAllowed: true };
    await startBackgroundWriters(backgroundWriters({ AGENT_RECONCILE_ON_BOOT: 'false' }));
    expect(started).not.toContain('reconcileAgents');
  });

  it('splits writers by RUN_MODE: api runs non-indexers + reconcile, indexer runs only chain indexers, all runs everything', async () => {
    identity.status = { role: 'owner', writersAllowed: true };
    const cases = [
      {
        env: { RUN_MODE: 'api' },
        expected: ['startCctpAttestationPoller', 'startExpirySweepLoop', 'startGasSponsor', 'reconcileAgents'],
      },
      {
        env: { RUN_MODE: 'indexer' },
        expected: ['startBaseEscrowEventLoop', 'startArcEscrowEventLoop', 'startAgentFactoryListener'],
      },
      {
        env: { RUN_MODE: 'all' },
        expected: EVERY_WRITER,
      },
    ];
    for (const { env, expected } of cases) {
      started.length = 0;
      await startBackgroundWriters(backgroundWriters(env));
      expect(started).toEqual(expected);
    }
  });

  it('refuses an unknown RUN_MODE', () => {
    expect(() => backgroundWriters({ RUN_MODE: 'invalid' })).toThrow(/RUN_MODE=.*invalid/);
  });
});
