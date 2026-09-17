import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression test for the worker env-allowlist fix (plan 010).
 *
 * Agent workers are forked with an explicit env allowlist (WORKER_ENV_PASSTHROUGH
 * in agentRunner.ts) instead of `...process.env`, because the worker runs
 * user-supplied `js` tool code through `vm.runInNewContext` — which Node
 * explicitly documents as not a security boundary. Before this fix, every
 * worker inherited the backend's entire environment, including the
 * marketplace settlement signer keys, JWT_SECRET, and the database URL.
 *
 * fork() is mocked so no real worker spawns — we assert on the env object
 * handed to it, modeled on agentRunner.skills.test.ts.
 */

const forkMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  fork: forkMock,
}));

// startAgent() no-ops if the module's internal `processes` map already has
// the id (it's a module-singleton across dynamic imports within this file),
// so each test needs its own fresh agent id — a shared mutable "current
// agent" record keeps the mock simple while still letting each test control
// what loadAgent() returns.
const makeAgent = (id: string) => ({
  id,
  ownerAddress: '0xowner',
  name: 'Env Test Agent',
  instructions: 'You are a helpful agent.',
  provider: 'openai',
  model: 'gpt-x',
  apiKey: 'sk-test',
  encryptedApiKey: '',
  capabilities: ['summarization'],
  tools: [],
  status: 'stopped',
  deployedAt: '2026-01-01',
  walletAddress: '0xagentwallet',
  publicKey: '04ab',
  encryptedPrivateKey: '',
  rawPrivateKey: 'deadbeef',
  platformToken: 'jwt',
});

const agentHolder = vi.hoisted(() => ({ current: null as any }));

vi.mock('./deployedAgentStore.js', () => ({
  loadAgent: vi.fn(async () => agentHolder.current),
  loadAllAgents: vi.fn(async () => (agentHolder.current ? [agentHolder.current] : [])),
  saveAgent: vi.fn(async () => undefined),
}));

vi.mock('./redis.js', () => ({
  appendLog: vi.fn(), getLogs: vi.fn(async () => []), subscribeAgentLogs: vi.fn(),
  touchHeartbeat: vi.fn(), isAlive: vi.fn(async () => false), getHeartbeat: vi.fn(async () => null),
  redis: { set: vi.fn(), get: vi.fn(), del: vi.fn() },
}));
vi.mock('./chain.js', () => ({ inft: null }));
vi.mock('./crypto.js', () => ({ eciesEncrypt: () => Buffer.from(''), generateKeyPair: () => ({ privateKey: 'x', publicKey: 'y' }) }));

// The WORKER_ENV_PASSTHROUGH list, mirrored here so this test asserts on the
// documented contract rather than importing the module's internals.
// Note: BACKEND_URL, OG_RPC_URL and OG_CHAIN_ID appear in the passthrough
// list AND are re-set explicitly below the spread in agentRunner.ts (derived
// from config, not raw process.env) — the explicit assignment always wins, so
// they're excluded from the raw-value equality check below and asserted
// separately.
const PASSTHROUGH_KEYS = [
  'NODE_ENV',
  'HEARTBEAT_INTERVAL_MS', 'POLL_INTERVAL_MS', 'DELEGATE_REWARD_OG',
  'DELEGATE_GAS_RESERVE_OG', 'PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'NODE_OPTIONS',
];

const SECRET_KEYS = [
  'MARKETPLACE_SIGNER_PRIVATE_KEY',
  'BASE_MARKETPLACE_SIGNER_PRIVATE_KEY',
  'JWT_SECRET',
  'DATABASE_URL',
  'OG_STORAGE_PRIVATE_KEY',
  'OG_COMPUTE_PRIVATE_KEY',
  'KEY_CUSTODY_PRIVATE_KEY',
  'PRIVY_APP_SECRET',
  'EMBEDDING_API_KEY',
  'RAILWAY_API_TOKEN',
  'REDIS_URL',
];

describe('startAgent forks workers with an allowlisted env, not the full process.env', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    forkMock.mockReset();
    forkMock.mockReturnValue({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      pid: 1234,
      kill: vi.fn(),
    });

    // Seed secrets that must NOT leak, plus a passthrough var.
    for (const k of SECRET_KEYS) process.env[k] = `secret-value-for-${k}`;
    process.env.NODE_ENV = 'test';
    // A var deliberately left unset to prove absence isn't stringified.
    delete process.env.HEARTBEAT_INTERVAL_MS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('never hands the forked worker any of the backend secrets', async () => {
    const agent = makeAgent('agent-env-secrets');
    agentHolder.current = agent;
    const { startAgent } = await import('./agentRunner.js');
    await startAgent(agent.id, { skipResume: true });

    expect(forkMock).toHaveBeenCalledTimes(1);
    const env = forkMock.mock.calls[0][2].env as Record<string, string>;

    for (const k of SECRET_KEYS) {
      expect(env[k]).toBeUndefined();
    }
  });

  it('passes through every allowlisted var that is set in process.env', async () => {
    const agent = makeAgent('agent-env-passthrough');
    agentHolder.current = agent;
    const { startAgent } = await import('./agentRunner.js');
    await startAgent(agent.id, { skipResume: true });

    const env = forkMock.mock.calls[0][2].env as Record<string, string>;

    for (const k of PASSTHROUGH_KEYS) {
      if (process.env[k] !== undefined) {
        expect(env[k]).toBe(process.env[k]);
      }
    }
    // Sanity: this was actually seeded and checked above.
    expect(env.NODE_ENV).toBe('test');
    // BACKEND_URL/OG_RPC_URL/OG_CHAIN_ID are in the passthrough list too, but
    // the explicit assignment below the spread always wins — still present,
    // just not equal to a raw process.env value we set.
    expect(env.BACKEND_URL).toBeTruthy();
  });

  it('still sets the explicit AGENT_* assignments', async () => {
    const agent = makeAgent('agent-env-explicit');
    agentHolder.current = agent;
    const { startAgent } = await import('./agentRunner.js');
    await startAgent(agent.id, { skipResume: true });

    const env = forkMock.mock.calls[0][2].env as Record<string, string>;

    expect(env.AGENT_ID).toBe(agent.id);
    expect(env.AGENT_PRIVATE_KEY).toBe(agent.rawPrivateKey);
    expect(env.AGENT_PLATFORM_TOKEN).toBe(agent.platformToken);
  });

  it('hands the worker every configured settlement chain as data', async () => {
    const agent = makeAgent('agent-env-chains');
    agentHolder.current = agent;
    const { startAgent } = await import('./agentRunner.js');
    await startAgent(agent.id, { skipResume: true });

    const env = forkMock.mock.calls[0][2].env as Record<string, string>;
    const table = JSON.parse(env.SETTLEMENT_CHAINS_JSON) as Array<Record<string, unknown>>;

    // The test env has both escrows, and posts on Base by the default rule.
    expect(table.map((c) => c.key)).toEqual(['0g', 'base']);
    expect(table.find((c) => c.key === '0g')).toMatchObject({
      chainId: expect.any(Number),
      token: { kind: 'native', address: '0x0000000000000000000000000000000000000000', symbol: '0G', decimals: 18 },
      gasSymbol: '0G',
      nativeIsSettlementToken: false,
      aa: false,
      posting: false,
    });
    expect(table.find((c) => c.key === 'base')).toMatchObject({
      token: { kind: 'erc20', symbol: 'USDC', decimals: 6 },
      gasSymbol: 'ETH',
      aa: true,
      posting: true,
    });
    // Exactly one chain is the posting chain.
    expect(table.filter((c) => c.posting)).toHaveLength(1);
    // Each entry carries what a signer needs, and nothing secret.
    for (const entry of table) {
      expect(entry.rpcUrl).toBeTruthy();
      expect(entry.escrow).toBeTruthy();
      expect(JSON.stringify(entry)).not.toMatch(/PRIVATE_KEY|secret/i);
    }
    // The legacy vars stay for one more release, and still agree.
    expect(env.OG_CHAIN_ID).toBe(String(table.find((c) => c.key === '0g')!.chainId));
    expect(env.AGENT_BASE_ESCROW_ADDRESS).toBe(table.find((c) => c.key === 'base')!.escrow);
  });

  it('leaves an unset passthrough var absent rather than the string "undefined"', async () => {
    const agent = makeAgent('agent-env-absent');
    agentHolder.current = agent;
    const { startAgent } = await import('./agentRunner.js');
    await startAgent(agent.id, { skipResume: true });

    const env = forkMock.mock.calls[0][2].env as Record<string, string>;

    expect('HEARTBEAT_INTERVAL_MS' in env).toBe(false);
    expect(env.HEARTBEAT_INTERVAL_MS).toBeUndefined();
  });
});
