import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /agents/capacity tells an owner how many more agents can start now,
 * from the same numbers POST /deploy refuses with (startRefusal), so a client
 * deploying several never deploys past the limit. The real agentRunner runs
 * here with fork mocked: 3 slots on the process, 2 per owner.
 *
 * Run: npx vitest run src/routes/agents.capacity.test.ts
 */

vi.hoisted(() => {
  process.env.MAX_CONCURRENT_AGENTS = '3';
  process.env.MAX_AGENTS_PER_OWNER = '2';
  process.env.AGENT_API_KEY = 'legacy-shared-agent-key';
});

const OWNER_A = '0xaaaa00000000000000000000000000000000000a';
const OWNER_B = '0xbbbb00000000000000000000000000000000000b';
// A real secp256k1 point (private key 0x11…11): the deploy encrypts the agent's key to it.
const OWNER_PUBLIC_KEY = '044f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa385b6b1b8ead809ca67454d9683fcf2ba03456d6fe2c4abe2b07f0fbdbb2f1c1';

// Memory readings, mocked: null (not measured) unless a test sets them.
const memory = vi.hoisted(() => ({ reading: null as null | { availableMb: number; totalMb: number; source: 'cgroup' | 'os' } }));
vi.mock('../services/memoryHeadroom.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/memoryHeadroom.js')>()),
  readMemory: () => memory.reading,
  preferWorkerForOom: vi.fn(),
}));

const forkMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ fork: forkMock }));

const agents = vi.hoisted(() => new Map<string, any>());
vi.mock('../services/deployedAgentStore.js', () => ({
  loadAgent: vi.fn(async (id: string) => agents.get(id) ?? null),
  loadAllAgents: vi.fn(async () => [...agents.values()]),
  saveAgent: vi.fn(async (a: any) => { agents.set(a.id, a); }),
}));
vi.mock('../services/redis.js', () => ({
  appendLog: vi.fn(), getLogs: vi.fn(async () => []), subscribeAgentLogs: vi.fn(),
  touchHeartbeat: vi.fn(), isAlive: vi.fn(async () => false), getHeartbeat: vi.fn(async () => null),
  redis: {
    get: vi.fn(), set: vi.fn(), del: vi.fn(async () => 0), exists: vi.fn(), pipeline: vi.fn(),
    smembers: vi.fn(async () => []), sadd: vi.fn(async () => 0), srem: vi.fn(async () => 0),
  },
}));
vi.mock('../services/notificationStore.js', () => ({ notify: vi.fn(async () => null) }));
vi.mock('../services/chain.js', () => ({ inft: null, provider: {}, baseProvider: {} }));
vi.mock('../services/deploymentIdentity.js', () => ({
  backgroundWritesAllowed: () => true,
  deploymentIdentityStatus: () => null,
  onBackgroundWritesStopped: () => {},
}));
vi.mock('../services/apiKeyStore.js', () => ({
  lookupApiKey: vi.fn(async (c: string) => (c === 'sk_a' ? { ownerAddress: OWNER_A } : c === 'sk_b' ? { ownerAddress: OWNER_B } : null)),
}));
vi.mock('../services/reputation.js', () => ({}));
vi.mock('../services/reputationDecay.js', () => ({}));
vi.mock('../services/agentStore.js', () => ({}));
vi.mock('../services/serviceStore.js', () => ({}));
vi.mock('../services/skillStore.js', () => ({ incrementInstallCount: vi.fn(async () => {}) }));
vi.mock('../services/agentEmbedding.js', () => ({}));
vi.mock('../services/agentFactoryListener.js', () => ({
  claimDeployCredit: vi.fn(), markDeployCreditUsed: vi.fn(), restoreDeployCredit: vi.fn(),
}));
// A keyed model the catalog lists needs no provider call.
vi.mock('../services/providerModels.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/providerModels.js')>()),
  needsModelCheck: () => false,
}));

const { agentsRouter } = await import('./agents.js');
const { startAgent, stopAgent, startRefusal } = await import('../services/agentRunner.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use('/api/v1/agents', agentsRouter);
app.use(globalErrorHandler);

const capacity = (key?: string) => {
  const r = request(app).get('/api/v1/agents/capacity');
  return key ? r.set('X-API-Key', key) : r;
};

function agent(id: string, owner: string) {
  agents.set(id, {
    id, ownerAddress: owner, name: id, instructions: 'x', provider: 'openai', model: 'm', apiKey: 'sk', encryptedApiKey: '',
    capabilities: [], tools: [], status: 'stopped', deployedAt: '2026-01-01T00:00:00Z',
    walletAddress: `0x${id}`, publicKey: '04ab', encryptedPrivateKey: '', rawPrivateKey: 'deadbeef', platformToken: 'jwt',
  });
  return id;
}

beforeEach(async () => {
  for (const id of agents.keys()) await stopAgent(id).catch(() => {});
  agents.clear();
  memory.reading = null;
  forkMock.mockReset();
  forkMock.mockImplementation(() => ({ stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), pid: 1, kill: vi.fn() }));
});

describe('GET /api/v1/agents/capacity', () => {
  it('needs an owner: no credentials and the legacy shared key are refused', async () => {
    expect((await capacity()).status).toBe(401);
    expect((await capacity('sk_nobody')).status).toBe(401);
    const legacy = await capacity('legacy-shared-agent-key');
    expect(legacy.status).toBe(401);
    expect(legacy.body.error.code).toBe('UNAUTHORIZED');
  });

  it('reports the free slots on the process and the caller\'s own share', async () => {
    const empty = await capacity('sk_a');
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({ poolMax: 3, poolFree: 3, ownerMax: 2, ownerFree: 2, memory: null, canStart: true, scope: 'process' });

    await startAgent(agent('a1', OWNER_A));
    expect((await capacity('sk_a')).body.data).toMatchObject({ poolFree: 2, ownerFree: 1, canStart: true });
    // Another owner sees the shared pool shrink, and keeps a full share of their own.
    expect((await capacity('sk_b')).body.data).toMatchObject({ poolFree: 2, ownerFree: 2, canStart: true });
  });

  it('counts only the caller\'s own workers against their share, whatever the case of their address', async () => {
    await startAgent(agent('a1', OWNER_A.toUpperCase().replace('0X', '0x')));
    await startAgent(agent('a2', OWNER_A));
    expect((await capacity('sk_a')).body.data).toMatchObject({ ownerFree: 0, canStart: false });
    expect((await capacity('sk_b')).body.data).toMatchObject({ poolFree: 1, ownerFree: 2, canStart: true });
  });

  it('says no when the pool is full, though the caller has a share left', async () => {
    await startAgent(agent('a1', OWNER_A));
    await startAgent(agent('b1', OWNER_B));
    await startAgent(agent('b2', OWNER_B));
    expect((await capacity('sk_a')).body.data).toMatchObject({ poolFree: 0, ownerFree: 1, canStart: false });
  });

  it('frees a slot when a worker stops', async () => {
    await startAgent(agent('a1', OWNER_A));
    await startAgent(agent('a2', OWNER_A));
    await stopAgent('a1');
    expect((await capacity('sk_a')).body.data).toMatchObject({ poolFree: 2, ownerFree: 1, canStart: true });
  });

  it('returns counts only: nothing about which agents run or who owns them', async () => {
    await startAgent(agent('b1', OWNER_B));
    const res = await capacity('sk_a');
    expect(Object.keys(res.body.data).sort()).toEqual(['canStart', 'memory', 'ownerFree', 'ownerMax', 'poolFree', 'poolMax', 'scope']);
    expect(JSON.stringify(res.body)).not.toContain(OWNER_B.slice(2, 10));
    expect(JSON.stringify(res.body)).not.toContain('b1');
  });

  it('reports how many more workers memory allows, and says no when it allows none', async () => {
    // Past the 30 s in which the workers earlier tests started still count at full size.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    try {
      memory.reading = { availableMb: 2048 + 2 * 150 + 20, totalMb: 16_384, source: 'cgroup' };
      expect((await capacity('sk_a')).body.data).toMatchObject({
        poolFree: 3, ownerFree: 2, canStart: true,
        memory: { availableMb: 2368, reserveMb: 2048, workerMb: 150, slotsFree: 2, source: 'cgroup' },
      });
      memory.reading = { availableMb: 2100, totalMb: 16_384, source: 'os' };
      expect((await capacity('sk_a')).body.data).toMatchObject({ poolFree: 3, ownerFree: 2, canStart: false, memory: { slotsFree: 0 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a deploy while memory is short, before any fee, saying the server is low on memory', async () => {
    const { claimDeployCredit } = await import('../services/agentFactoryListener.js');
    memory.reading = { availableMb: 2100, totalMb: 16_384, source: 'os' };
    const res = await request(app).post('/api/v1/agents/deploy').set('X-API-Key', 'sk_a').send({
      name: 'x', instructions: 'do useful things', provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test',
      ownerPublicKey: OWNER_PUBLIC_KEY,
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({ code: 'AGENT_CAPACITY' });
    expect(res.body.error.message).toMatch(/^The server is low on memory — stop an agent or try again later\. Your payment has not been used\.$/);
    expect(claimDeployCredit).not.toHaveBeenCalled();
  });

  it('agrees with what POST /deploy refuses: canStart false ⇔ startRefusal, and the deploy answers AGENT_CAPACITY', async () => {
    const deploy = () => request(app).post('/api/v1/agents/deploy').set('X-API-Key', 'sk_a').send({
      name: 'x', instructions: 'do useful things', provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test',
      ownerPublicKey: OWNER_PUBLIC_KEY,
    });
    for (const [ids, owner] of [[['a1', 'a2'], OWNER_A], [['b1'], OWNER_B]] as const) {
      for (const id of ids) await startAgent(agent(id, owner));
      const { canStart } = (await capacity('sk_a')).body.data;
      expect(canStart).toBe(startRefusal(OWNER_A) === null);
    }
    expect((await capacity('sk_a')).body.data.canStart).toBe(false);
    const refused = await deploy();
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('AGENT_CAPACITY');
  });
});
