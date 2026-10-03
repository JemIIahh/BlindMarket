import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * How many workers one owner may run at once: 10 unless MAX_AGENTS_PER_OWNER
 * says otherwise, and a malformed value falls back to 10 instead of lifting
 * the limit. The module reads the env when it loads, so each case loads it
 * fresh, with a pool of 12 so the owner limit is what binds.
 */

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
vi.mock('./redis.js', () => ({
  appendLog: vi.fn(), getLogs: vi.fn(async () => []), subscribeAgentLogs: vi.fn(),
  touchHeartbeat: vi.fn(), isAlive: vi.fn(async () => false), getHeartbeat: vi.fn(async () => null),
  redis: { set: vi.fn(), get: vi.fn(), del: vi.fn() },
}));
vi.mock('./notificationStore.js', () => ({ notify: vi.fn(async () => null) }));
vi.mock('./chain.js', () => ({ inft: null }));
vi.mock('./deploymentIdentity.js', () => ({
  backgroundWritesAllowed: () => true,
  deploymentIdentityStatus: () => null,
  onBackgroundWritesStopped: () => {},
}));
vi.mock('./crypto.js', () => ({ eciesEncrypt: () => Buffer.from(''), generateKeyPair: () => ({ privateKey: 'x', publicKey: 'y' }) }));

const OWNER_A = '0xaaaa00000000000000000000000000000000000a';
const OWNER_B = '0xbbbb00000000000000000000000000000000000b';

function agent(id: string, owner: string) {
  agents.set(id, {
    id, ownerAddress: owner, name: id, instructions: 'x', provider: 'openai', model: 'm', apiKey: 'sk', encryptedApiKey: '',
    capabilities: [], tools: [], status: 'stopped', deployedAt: '2026-01-01T00:00:00Z',
    walletAddress: `0x${id}`, publicKey: '04ab', encryptedPrivateKey: '', rawPrivateKey: 'deadbeef', platformToken: 'jwt',
  });
  return id;
}

async function load(perOwner: string | undefined) {
  vi.resetModules();
  agents.clear();
  forkMock.mockReset();
  forkMock.mockImplementation(() => ({ stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), pid: 1, kill: vi.fn() }));
  process.env.MAX_CONCURRENT_AGENTS = '12';
  if (perOwner === undefined) delete process.env.MAX_AGENTS_PER_OWNER;
  else process.env.MAX_AGENTS_PER_OWNER = perOwner;
  return import('./agentRunner.js');
}

afterEach(() => {
  delete process.env.MAX_CONCURRENT_AGENTS;
  delete process.env.MAX_AGENTS_PER_OWNER;
});

describe('per-owner worker limit', () => {
  it.each([[undefined], ['abc'], ['0'], ['-3'], ['2.5']])('is 10 when MAX_AGENTS_PER_OWNER is %j', async (value) => {
    const { startAgent, startRefusal } = await load(value);
    for (let i = 0; i < 10; i++) await startAgent(agent(`a${i}`, OWNER_A));
    await expect(startAgent(agent('a10', OWNER_A))).rejects.toThrow(/You already run 10 agents/);
    // Another owner can still start in the two free slots.
    expect(startRefusal(OWNER_B)).toBeNull();
  });

  it('follows MAX_AGENTS_PER_OWNER when it is set', async () => {
    const { startAgent } = await load('3');
    for (let i = 0; i < 3; i++) await startAgent(agent(`a${i}`, OWNER_A));
    await expect(startAgent(agent('a3', OWNER_A))).rejects.toThrow(/You already run 3 agents/);
  });
});
