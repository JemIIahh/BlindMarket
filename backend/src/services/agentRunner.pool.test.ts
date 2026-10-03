import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hosted-worker pool gives each owner a bounded share (security audit run
 * 1, C10). Same fork/store mocks as agentRunner.env.test.ts; the caps are set
 * before the module loads: 4 slots, 2 per owner.
 */

vi.hoisted(() => {
  process.env.MAX_CONCURRENT_AGENTS = '4';
  process.env.MAX_AGENTS_PER_OWNER = '2';
});

const forkMock = vi.hoisted(() => vi.fn());
// Memory is not what this file is about (agentRunner.memoryGuard.test.ts is):
// nothing measured, and no worker pid written to /proc.
vi.mock('./memoryHeadroom.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memoryHeadroom.js')>()),
  readMemory: () => null,
  preferWorkerForOom: vi.fn(),
}));
vi.mock('child_process', () => ({ fork: forkMock }));

const agents = vi.hoisted(() => new Map<string, any>());
vi.mock('./deployedAgentStore.js', () => ({
  loadAgent: vi.fn(async (id: string) => agents.get(id) ?? null),
  loadAllAgents: vi.fn(async () => [...agents.values()]),
  saveAgent: vi.fn(async (a: any) => { agents.set(a.id, a); }),
}));
const notify = vi.hoisted(() => vi.fn(async () => null));
vi.mock('./notificationStore.js', () => ({ notify }));
const appendLog = vi.hoisted(() => vi.fn());
vi.mock('./redis.js', () => ({
  appendLog, getLogs: vi.fn(async () => []), subscribeAgentLogs: vi.fn(),
  touchHeartbeat: vi.fn(), isAlive: vi.fn(async () => false), getHeartbeat: vi.fn(async () => null),
  redis: { set: vi.fn(), get: vi.fn(), del: vi.fn() },
}));
vi.mock('./chain.js', () => ({ inft: null }));
const saveAgentReadiness = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./agentReadiness.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentReadiness.js')>()),
  saveAgentReadiness,
}));
vi.mock('./deploymentIdentity.js', () => ({
  backgroundWritesAllowed: () => true,
  deploymentIdentityStatus: () => null,
  onBackgroundWritesStopped: () => {},
}));
vi.mock('./crypto.js', () => ({ eciesEncrypt: () => Buffer.from(''), generateKeyPair: () => ({ privateKey: 'x', publicKey: 'y' }) }));

import { reconcileAgents, startAgent, startRefusal, stopAgent } from './agentRunner.js';

const OWNER_A = '0xaaaa00000000000000000000000000000000000a';
const OWNER_B = '0xbbbb00000000000000000000000000000000000b';

function agent(id: string, owner: string) {
  const a = {
    id, ownerAddress: owner, name: id, instructions: 'x', provider: 'openai', model: 'm', apiKey: 'sk', encryptedApiKey: '',
    capabilities: [], tools: [], status: 'stopped', deployedAt: `2026-01-01T00:00:0${agents.size}Z`,
    walletAddress: `0x${id}`, publicKey: '04ab', encryptedPrivateKey: '', rawPrivateKey: 'deadbeef', platformToken: 'jwt',
  };
  agents.set(id, a);
  return a;
}

beforeEach(async () => {
  for (const id of agents.keys()) await stopAgent(id).catch(() => {});
  agents.clear();
  appendLog.mockClear();
  notify.mockClear();
  forkMock.mockReset();
  forkMock.mockImplementation(() => ({ stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), pid: 1, kill: vi.fn() }));
});

describe('hosted-worker pool: per-owner share (audit run 1, C10)', () => {
  it("refuses an owner's third agent while another owner can still start", async () => {
    await startAgent(agent('a1', OWNER_A).id);
    await startAgent(agent('a2', OWNER_A).id);
    await expect(startAgent(agent('a3', OWNER_A).id)).rejects.toThrow(/the most one owner can run/);
    await startAgent(agent('b1', OWNER_B).id);
    expect(forkMock).toHaveBeenCalledTimes(3);
  });

  it('frees the owner a slot when one of its agents stops', async () => {
    await startAgent(agent('a1', OWNER_A).id);
    await startAgent(agent('a2', OWNER_A).id);
    expect(startRefusal(OWNER_A)).toMatch(/the most one owner can run/);
    await stopAgent('a1');
    expect(startRefusal(OWNER_A)).toBeNull();
  });

  it('reports a full pool to anyone', async () => {
    await startAgent(agent('a1', OWNER_A).id);
    await startAgent(agent('a2', OWNER_A).id);
    await startAgent(agent('b1', OWNER_B).id);
    await startAgent(agent('b2', OWNER_B).id);
    expect(startRefusal('0xcccc00000000000000000000000000000000000c')).toMatch(/Max concurrent agents \(4\)/);
  });

  it("reconcile refills free slots round-robin, each owner's oldest first, within the share", async () => {
    for (const [id, owner] of [['a1', OWNER_A], ['a2', OWNER_A], ['a3', OWNER_A], ['b1', OWNER_B]] as const) {
      agent(id, owner).status = 'running';
    }
    await reconcileAgents();
    const forkedNames = forkMock.mock.calls.map((c) => (c[2].env as Record<string, string>).AGENT_ID).sort();
    expect(forkedNames).toEqual(['a1', 'a2', 'b1']);
  });

  // An agent reconcile leaves out used to stay 'running' with no worker: live
  // in My Agents, doing nothing, never coming back on its own.
  it('marks an agent it leaves out stopped, says why in its log and tells the owner', async () => {
    for (const [id, owner] of [['a1', OWNER_A], ['a2', OWNER_A], ['a3', OWNER_A], ['b1', OWNER_B]] as const) {
      agent(id, owner).status = 'running';
    }
    await reconcileAgents();
    expect(agents.get('a3').status).toBe('stopped');
    expect(['a1', 'a2', 'b1'].map((id) => agents.get(id).status)).toEqual(['running', 'running', 'running']);
    expect(appendLog).toHaveBeenCalledWith('a3', expect.stringMatching(/not restarted after the server restarted: its owner already runs 2 agents.*Start it again/));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(OWNER_A, expect.objectContaining({ type: 'agent_stopped', title: 'a3 is stopped' }));
  });

  it('names a full pool as the reason when the owner is under its share', async () => {
    for (const [id, owner] of [['a1', OWNER_A], ['a2', OWNER_A], ['b1', OWNER_B], ['b2', OWNER_B], ['c1', '0xcccc00000000000000000000000000000000000c']] as const) {
      agent(id, owner).status = 'running';
    }
    await reconcileAgents();
    // Round-robin, oldest first: a1, b1, c1, a2 take the 4 slots; b2 is left out.
    expect(agents.get('b2').status).toBe('stopped');
    expect(agents.get('c1').status).toBe('running');
    expect(appendLog).toHaveBeenCalledWith('b2', expect.stringMatching(/every worker slot on the server is taken \(4\)/));
  });

  it('marks an agent whose restart fails stopped instead of leaving it running', async () => {
    agent('a1', OWNER_A).status = 'running';
    forkMock.mockImplementationOnce(() => { throw new Error('spawn EACCES'); });
    await reconcileAgents();
    expect(agents.get('a1').status).toBe('stopped');
    expect(appendLog).toHaveBeenCalledWith('a1', expect.stringMatching(/it failed to start \(spawn EACCES\)/));
    expect(notify).toHaveBeenCalledWith(OWNER_A, expect.objectContaining({ type: 'agent_stopped' }));
  });
});

// The worker's heartbeat says whether it is taking tasks; the owner's agent
// page reads it back (GET /agents/:id/readiness).
describe('worker readiness reports', () => {
  it("stores the readiness a heartbeat carries, from the agent's live worker", async () => {
    await startAgent(agent('a1', OWNER_A).id);
    const child = forkMock.mock.results[0].value;
    const onMessage = child.on.mock.calls.find(([event]: [string]) => event === 'message')[1];
    const fund = { chain: '0g', address: '0x3a38cd7A3321A6716815f7B555F4dA6baDCCBC82', holdsWei: '1600000000000000000', needWei: '3100000000000000000', shortfallWei: '1500000000000000000' };
    await onMessage({ type: 'heartbeat', timestamp: 1, readiness: { ready: false, reason: 'no 0G Compute account yet', fund } });
    expect(saveAgentReadiness).toHaveBeenCalledWith('a1', expect.objectContaining({ ready: false, reason: 'no 0G Compute account yet', fund }));

    saveAgentReadiness.mockClear();
    await onMessage({ type: 'heartbeat', timestamp: 2 }); // an older worker: no report
    expect(saveAgentReadiness).not.toHaveBeenCalled();
  });
});
