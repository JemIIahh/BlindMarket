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
vi.mock('child_process', () => ({ fork: forkMock }));

const agents = vi.hoisted(() => new Map<string, any>());
vi.mock('./deployedAgentStore.js', () => ({
  loadAgent: vi.fn(async (id: string) => agents.get(id) ?? null),
  loadAllAgents: vi.fn(async () => [...agents.values()]),
  saveAgent: vi.fn(async (a: any) => { agents.set(a.id, a); }),
}));
vi.mock('./redis.js', () => ({
  appendLog: vi.fn(), getLogs: vi.fn(async () => []), subscribeAgentLogs: vi.fn(),
  touchHeartbeat: vi.fn(), isAlive: vi.fn(async () => false), getHeartbeat: vi.fn(async () => null),
  redis: { set: vi.fn(), get: vi.fn(), del: vi.fn() },
}));
vi.mock('./chain.js', () => ({ inft: null }));
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
});
