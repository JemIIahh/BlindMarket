import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Integration test for the load-bearing skills claim (design decision D2):
 * an installed skill's instructions + tools must actually reach the forked
 * worker's env — AGENT_INSTRUCTIONS (which worker.js interpolates verbatim
 * into its system prompt) and AGENT_TOOLS. The composer is unit-tested in
 * isolation; this proves startAgent WIRES it into the child process env, so
 * a "skilled" agent genuinely behaves differently.
 *
 * fork() is mocked so no real worker spawns — we assert on the env handed to it.
 */

const forkMock = vi.hoisted(() => vi.fn());

// Memory is not what this file is about (agentRunner.memoryGuard.test.ts is):
// nothing measured, and no worker pid written to /proc.
vi.mock('./memoryHeadroom.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memoryHeadroom.js')>()),
  readMemory: () => null,
  preferWorkerForOom: vi.fn(),
}));
vi.mock('child_process', () => ({
  fork: forkMock,
}));

// Neon-free: stub the agent store so startAgent loads our fixture.
const AGENT = vi.hoisted(() => ({
  id: 'agent-skills-1',
  ownerAddress: '0xowner',
  name: 'Skilled Agent',
  instructions: 'You are a helpful agent.',
  provider: 'openai',
  model: 'gpt-x',
  apiKey: 'sk-test',
  encryptedApiKey: '',
  capabilities: ['summarization'],
  tools: [{ type: 'http', name: 'base_tool', description: '', url: 'https://x', method: 'GET' }],
  status: 'stopped',
  deployedAt: '2026-01-01',
  walletAddress: '0xagentwallet',
  publicKey: '04ab',
  encryptedPrivateKey: '',
  rawPrivateKey: 'deadbeef',
  platformToken: 'jwt',
  skills: [{
    skillId: 1,
    slug: 'web-summarizer',
    version: '2.0.0',
    name: 'Web summarizer',
    instructions: 'SKILL-MARKER: always answer in exactly 3 bullet points.',
    tools: [{
      name: 'fetch_page',
      description: 'Fetch a page',
      input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      execution: { method: 'GET', url: 'https://r.jina.ai/{url}', param_mapping: { url: 'path' } },
      auth: { type: 'none', key_name: '', secret_ref: '' },
    }],
    secretRefs: [],
    capabilities: ['summarization'],
    source: 'skillmd',
    installedAt: '2026-01-02',
  }],
}));

vi.mock('./deployedAgentStore.js', () => ({
  loadAgent: vi.fn(async () => AGENT),
  loadAllAgents: vi.fn(async () => [AGENT]),
  saveAgent: vi.fn(async () => undefined),
  updateAgentFields: vi.fn(async () => true),
  setAgentStatus: vi.fn(async () => true),
}));

// Silence the rest of startAgent's side-effect deps.
vi.mock('./redis.js', () => ({
  appendLog: vi.fn(), getLogs: vi.fn(async () => []), subscribeAgentLogs: vi.fn(),
  touchHeartbeat: vi.fn(), isAlive: vi.fn(async () => false), getHeartbeat: vi.fn(async () => null),
  redis: { set: vi.fn(), get: vi.fn(), del: vi.fn() },
}));
vi.mock('./chain.js', () => ({ inft: null }));
vi.mock('./crypto.js', () => ({ eciesEncrypt: () => Buffer.from(''), generateKeyPair: () => ({ privateKey: 'x', publicKey: 'y' }) }));

describe('startAgent composes installed skills into the worker env', () => {
  beforeEach(() => {
    forkMock.mockReset();
    forkMock.mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      pid: 1234,
      kill: vi.fn(),
    });
  });

  it('injects [SKILL: …] instructions and merges skill tools into AGENT_TOOLS', async () => {
    const { startAgent } = await import('./agentRunner.js');
    await startAgent(AGENT.id, { skipResume: true });

    expect(forkMock).toHaveBeenCalledTimes(1);
    const env = forkMock.mock.calls[0][2].env as Record<string, string>;

    // Base prompt preserved, skill section appended, marker present.
    expect(env.AGENT_INSTRUCTIONS).toContain('You are a helpful agent.');
    expect(env.AGENT_INSTRUCTIONS).toContain('[SKILL: Web summarizer v2.0.0]');
    expect(env.AGENT_INSTRUCTIONS).toContain('SKILL-MARKER: always answer in exactly 3 bullet points.');

    // Skill tool merged alongside the base tool.
    const tools = JSON.parse(env.AGENT_TOOLS) as Array<{ name: string; type?: string }>;
    expect(tools.find((t) => t.name === 'base_tool')).toBeTruthy();
    const skillTool = tools.find((t) => t.name === 'fetch_page');
    expect(skillTool).toBeTruthy();
    expect(skillTool?.type).toBe('tool');
  });
});
