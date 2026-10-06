import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The memory guard: a worker starts only while memory stays above the
 * reserve with one more worker (WORKER_MEMORY_MB) on top, counting workers
 * forked in the last 30 s at full size, since their memory may not show in
 * the readings yet. MAX_CONCURRENT_AGENTS stays a hard cap above it. Memory
 * readings are mocked (memoryHeadroom.test.ts covers reading them); the pool
 * is set high so memory is what binds.
 *
 * Run: npx vitest run src/services/agentRunner.memoryGuard.test.ts
 */

vi.hoisted(() => {
  process.env.MAX_CONCURRENT_AGENTS = '150';
  process.env.MAX_AGENTS_PER_OWNER = '150';
  delete process.env.AGENT_MEMORY_RESERVE_MB;
});

const memory = vi.hoisted(() => ({ reading: null as null | { availableMb: number; totalMb: number; source: 'cgroup' | 'os' } }));
const preferWorkerForOom = vi.hoisted(() => vi.fn());
vi.mock('./memoryHeadroom.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memoryHeadroom.js')>()),
  readMemory: () => memory.reading,
  preferWorkerForOom,
}));

const forkMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ fork: forkMock }));
const agents = vi.hoisted(() => new Map<string, any>());
vi.mock('./deployedAgentStore.js', () => ({
  loadAgent: vi.fn(async (id: string) => agents.get(id) ?? null),
  loadAllAgents: vi.fn(async () => [...agents.values()]),
  saveAgent: vi.fn(async (a: any) => { agents.set(a.id, a); }),
  updateAgentFields: vi.fn(async (id: string, fields: any, opts: any = {}) => {
    const a = agents.get(id);
    if (!a || (opts.ifStatus && a.status !== opts.ifStatus)) return false;
    agents.set(id, { ...a, ...fields });
    return true;
  }),
  setAgentStatus: vi.fn(async (id: string, status: string, opts: any = {}) => {
    const a = agents.get(id);
    if (!a || (opts.from && a.status !== opts.from)) return false;
    agents.set(id, { ...a, status });
    return true;
  }),
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

const { agentCapacity, startAgent, startRefusal, stopAgent, reconcileAgents, WORKER_MEMORY_MB } = await import('./agentRunner.js');

const OWNER = '0xaaaa00000000000000000000000000000000000a';
const LOW = 'The server is low on memory — stop an agent or try again later';
let pid = 100;

function agent(id: string, status = 'stopped') {
  agents.set(id, {
    id, ownerAddress: OWNER, name: id, instructions: 'x', provider: 'openai', model: 'm', apiKey: 'sk', encryptedApiKey: '',
    capabilities: [], tools: [], status, deployedAt: `2026-01-01T00:00:${String(agents.size).padStart(2, '0')}Z`,
    walletAddress: `0x${id}`, publicKey: '04ab', encryptedPrivateKey: '', rawPrivateKey: 'deadbeef', platformToken: 'jwt',
  });
  return id;
}
/** A box whose readings say `availableMb` is free, of 16 GB (reserve 2048 MB by default). */
const box = (availableMb: number, source: 'cgroup' | 'os' = 'os') => { memory.reading = { availableMb, totalMb: 16_384, source }; };

beforeEach(async () => {
  for (const id of agents.keys()) await stopAgent(id).catch(() => {});
  agents.clear();
  memory.reading = null;
  preferWorkerForOom.mockClear();
  forkMock.mockReset();
  forkMock.mockImplementation(() => ({ stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), pid: ++pid, kill: vi.fn() }));
  vi.useFakeTimers({ toFake: ['Date'] });
  // Past every earlier test's starts.
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 3) + pid * 60_000));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the memory guard', () => {
  it('reports what memory allows: free memory less the reserve, in steps of one worker', () => {
    box(2048 + 3 * WORKER_MEMORY_MB + 10);
    expect(agentCapacity(OWNER).memory).toEqual({ availableMb: 2508, reserveMb: 2048, workerMb: 150, slotsFree: 3, source: 'os' });
    expect(startRefusal(OWNER)).toBeNull();
  });

  it('refuses a start that would leave less than the reserve, with a plain message, though the pool has room', async () => {
    box(2048 + WORKER_MEMORY_MB - 1);
    const cap = agentCapacity(OWNER);
    expect(cap.poolFree).toBe(150);
    expect(cap.memory?.slotsFree).toBe(0);
    expect(startRefusal(OWNER)).toBe(LOW);
    await expect(startAgent(agent('a1'))).rejects.toThrow(LOW);
    expect(forkMock).not.toHaveBeenCalled();
  });

  it('counts a worker forked in the last 30 s at full size, since the readings may not show it yet', async () => {
    box(2048 + 2 * WORKER_MEMORY_MB);
    await startAgent(agent('a1'));
    // The readings have not moved; the new worker still counts.
    expect(agentCapacity(OWNER).memory?.slotsFree).toBe(1);
    await startAgent(agent('a2'));
    expect(agentCapacity(OWNER).memory?.slotsFree).toBe(0);
    await expect(startAgent(agent('a3'))).rejects.toThrow(LOW);
    // 30 s on, the readings are what count.
    vi.setSystemTime(Date.now() + 30_000);
    expect(agentCapacity(OWNER).memory?.slotsFree).toBe(2);
  });

  it('agrees with startRefusal at every reading: it refuses exactly when memory allows no worker', () => {
    for (let mb = 1900; mb <= 2700; mb += 7) {
      box(mb);
      expect(startRefusal(OWNER) === null).toBe((agentCapacity(OWNER).memory?.slotsFree ?? 1) > 0);
    }
  });

  it('follows AGENT_MEMORY_RESERVE_MB', () => {
    process.env.AGENT_MEMORY_RESERVE_MB = '500';
    try {
      box(500 + WORKER_MEMORY_MB);
      expect(agentCapacity(OWNER).memory).toMatchObject({ reserveMb: 500, slotsFree: 1 });
      expect(startRefusal(OWNER)).toBeNull();
    } finally {
      delete process.env.AGENT_MEMORY_RESERVE_MB;
    }
  });

  it('refuses nothing for memory where it is not measured', async () => {
    memory.reading = null;
    expect(agentCapacity(OWNER).memory).toBeNull();
    expect(startRefusal(OWNER)).toBeNull();
    await expect(startAgent(agent('a1'))).resolves.toBeUndefined();
  });

  it('keeps MAX_CONCURRENT_AGENTS as the hard cap with memory to spare', async () => {
    box(100_000);
    const { poolMax } = agentCapacity(OWNER);
    expect(poolMax).toBe(150);
    for (let i = 0; i < 150; i++) await startAgent(agent(`a${i}`));
    expect(startRefusal(OWNER)).toMatch(/Max concurrent agents \(150\) reached/);
  });

  it('marks each worker it forks as the OOM killer\'s first choice', async () => {
    box(10_000);
    await startAgent(agent('a1'));
    expect(preferWorkerForOom).toHaveBeenCalledWith(pid);
  });

  it('brings back only the agents memory allows after a restart, and says why for the rest', async () => {
    box(2048 + 2 * WORKER_MEMORY_MB + 50);
    for (let i = 0; i < 5; i++) agent(`r${i}`, 'running');
    await reconcileAgents();
    expect(forkMock).toHaveBeenCalledTimes(2);
    const statuses = [...agents.values()].map((a) => a.status).sort();
    expect(statuses).toEqual(['running', 'running', 'stopped', 'stopped', 'stopped']);
  });
});
