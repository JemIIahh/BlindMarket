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
// Open unless a test closes it: a process on another deployment's Redis.
const gate = vi.hoisted(() => ({ allowed: true, onStopped: [] as Array<() => void> }));
vi.mock('./deploymentIdentity.js', () => ({
  backgroundWritesAllowed: () => gate.allowed,
  deploymentIdentityStatus: () => (gate.allowed ? null : { reason: 'this Redis belongs to deployment "production"' }),
  onBackgroundWritesStopped: (listener: () => void) => { gate.onStopped.push(listener); },
}));
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
  'HEARTBEAT_INTERVAL_MS', 'POLL_INTERVAL_MS', 'WS_RECONCILE_MS', 'GAS_RECHECK_MS',
  'LLM_TIMEOUT_MS', 'RELEASE_COOLDOWN_MS', 'SENTRY_DSN', 'SENTRY_ENVIRONMENT', 'DELEGATE_REWARD_OG', 'DELEGATE_REWARD_USDC',
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
    process.env.LLM_TIMEOUT_MS = '45000';
    process.env.RELEASE_COOLDOWN_MS = '60000';
    process.env.SENTRY_DSN = 'https://key@sentry.test/1';
    process.env.SENTRY_ENVIRONMENT = 'staging';
    // A var deliberately left unset to prove absence isn't stringified.
    delete process.env.HEARTBEAT_INTERVAL_MS;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    // `processes` is a module singleton capped at MAX_CONCURRENT_AGENTS: free
    // this test's slot so later starts in the file are not refused.
    const { stopAgent } = await import('./agentRunner.js');
    await stopAgent(agentHolder.current.id);
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

    // Seeded above, so the loop below cannot pass vacuously for these.
    expect(env.LLM_TIMEOUT_MS).toBe('45000');
    expect(env.RELEASE_COOLDOWN_MS).toBe('60000');
    expect(env.SENTRY_DSN).toBe('https://key@sentry.test/1');
    expect(env.SENTRY_ENVIRONMENT).toBe('staging');

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

  it("tells the worker whether its owner opted in to verifier duty, off by default (audit run 1, C04)", async () => {
    const { startAgent } = await import('./agentRunner.js');
    const off = makeAgent('agent-env-verifier-off');
    agentHolder.current = off;
    await startAgent(off.id, { skipResume: true });
    expect((forkMock.mock.calls.at(-1)![2].env as Record<string, string>).AGENT_VERIFIER_ENABLED).toBe('false');
    const { stopAgent } = await import('./agentRunner.js');
    await stopAgent(off.id);

    const on = { ...makeAgent('agent-env-verifier-on'), verifierEnabled: true };
    agentHolder.current = on;
    await startAgent(on.id, { skipResume: true });
    expect((forkMock.mock.calls.at(-1)![2].env as Record<string, string>).AGENT_VERIFIER_ENABLED).toBe('true');
  });

  it('tells the worker whether its owner turned delegation on, off for a freshly deployed agent', async () => {
    const { startAgent, stopAgent } = await import('./agentRunner.js');
    const off = makeAgent('agent-env-delegation-off');
    agentHolder.current = off;
    await startAgent(off.id, { skipResume: true });
    expect((forkMock.mock.calls.at(-1)![2].env as Record<string, string>).AGENT_DELEGATION_ENABLED).toBe('false');
    await stopAgent(off.id);

    const on = { ...makeAgent('agent-env-delegation-on'), delegationEnabled: true };
    agentHolder.current = on;
    await startAgent(on.id, { skipResume: true });
    expect((forkMock.mock.calls.at(-1)![2].env as Record<string, string>).AGENT_DELEGATION_ENABLED).toBe('true');
  });

  it('hands the worker every configured settlement chain as data', async () => {
    const agent = makeAgent('agent-env-chains');
    agentHolder.current = agent;
    const { startAgent } = await import('./agentRunner.js');
    await startAgent(agent.id, { skipResume: true });

    const env = forkMock.mock.calls[0][2].env as Record<string, string>;
    const table = JSON.parse(env.SETTLEMENT_CHAINS_JSON) as Array<Record<string, unknown>>;

    // Base and Arc testnet both have generated escrow records, so both are
    // present; Arc is the posting chain.
    expect(table.map((c) => c.key)).toEqual(['base', 'arc']);
    expect(table.find((c) => c.key === 'base')).toMatchObject({
      token: { kind: 'erc20', symbol: 'USDC', decimals: 6 },
      gasSymbol: 'ETH',
      aa: true,
      posting: false,
    });
    expect(table.find((c) => c.key === 'arc')).toMatchObject({
      token: { kind: 'erc20', symbol: 'USDC', decimals: 6 },
      posting: true,
      // The worker's gas gate on Arc (settlementChains.ts workerTxGasLimit).
      preflightGasLimit: '200000',
    });
    expect(table.find((c) => c.key === 'base')).toMatchObject({ preflightGasLimit: '300000' });
    // Exactly one chain is the posting chain.
    expect(table.filter((c) => c.posting)).toHaveLength(1);
    // Each entry carries what a signer needs, and nothing secret.
    for (const entry of table) {
      expect(entry.rpcUrl).toBeTruthy();
      expect(entry.escrow).toBeTruthy();
      expect(JSON.stringify(entry)).not.toMatch(/PRIVATE_KEY|secret/i);
    }
    // The legacy vars stay for one more release, and still agree.
    expect(env.OG_CHAIN_ID).toBeTruthy();
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

describe('the passthrough list covers every process.env read in worker.js', () => {
  it('has no unexplained gap', async () => {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const src = readFileSync(fileURLToPath(new URL('../../agents/worker.js', import.meta.url)), 'utf8');
    const read = new Set([...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]));
    const { WORKER_ENV_PASSTHROUGH } = await import('./agentRunner.js');

    agentHolder.current = makeAgent('agent-env-coverage');
    forkMock.mockReset();
    forkMock.mockReturnValue({ stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), pid: 1, kill: vi.fn() });
    const { startAgent } = await import('./agentRunner.js');
    await startAgent('agent-env-coverage');
    const explicit = new Set(Object.keys(forkMock.mock.calls[0][2].env));

    // Sui settlement is not a deployable path (deployAgent mints EVM wallets
    // only), so its config is deliberately not forwarded.
    const knownUnforwarded = new Set([
      'SUI_NETWORK_ID', 'SUI_RPC_URL', 'SUI_PACKAGE_ID', 'SUI_BLIND_ESCROW_OBJECT_ID',
      'SUI_BLIND_REPUTATION_OBJECT_ID', 'SUI_ADMIN_CAP_ID',
    ]);
    const missing = [...read].filter((k) =>
      !(WORKER_ENV_PASSTHROUGH as readonly string[]).includes(k) && !explicit.has(k) && !knownUnforwarded.has(k));
    expect(missing).toEqual([]);
  });
});

describe('crash memory survives the restart', () => {
  const TASK = '0x' + 'c'.repeat(64);

  it('recordCrash charges the in-flight task and counts the streak', async () => {
    const { recordCrash, recordTaskCompleted, HEALTHY_UPTIME_MS } = await import('./agentRunner.js');
    let mem = recordCrash(undefined, { inFlightTask: TASK, uptimeMs: 130_000 });
    expect(mem).toEqual({ consecutive: 1, byTask: { [TASK]: 1 } });
    mem = recordCrash(mem, { inFlightTask: TASK, uptimeMs: 130_000 });
    expect(mem).toEqual({ consecutive: 2, byTask: { [TASK]: 2 } });
    // No task in flight: the streak still grows, nothing is charged.
    mem = recordCrash(mem, { inFlightTask: null, uptimeMs: 5_000 });
    expect(mem).toEqual({ consecutive: 3, byTask: { [TASK]: 2 } });
    // A healthy stretch starts a new streak but keeps the per-task charge.
    mem = recordCrash(mem, { inFlightTask: null, uptimeMs: HEALTHY_UPTIME_MS });
    expect(mem).toEqual({ consecutive: 1, byTask: { [TASK]: 2 } });
    // Completing the task clears both.
    expect(recordTaskCompleted(mem, TASK)).toEqual({ consecutive: 0, byTask: {} });
    expect(recordTaskCompleted(undefined, TASK)).toBeUndefined();
  });

  it('recordCrash keeps only the most recent tasks', async () => {
    const { recordCrash } = await import('./agentRunner.js');
    let mem;
    for (let i = 0; i < 30; i++) mem = recordCrash(mem, { inFlightTask: `0x${i}`, uptimeMs: 1 });
    expect(Object.keys(mem!.byTask)).toHaveLength(20);
    expect(mem!.byTask['0x29']).toBe(1);
    expect(mem!.byTask['0x0']).toBeUndefined();
  });

  it('a crash with a task in flight reaches the restarted worker via env', async () => {
    vi.useFakeTimers();
    try {
      const handlers: Record<string, (...a: any[]) => unknown> = {};
      const child = {
        stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, pid: 4321, kill: vi.fn(),
        on: vi.fn((ev: string, cb: (...a: any[]) => unknown) => { handlers[ev] = cb; }),
      };
      forkMock.mockReset();
      forkMock.mockReturnValue(child);
      const agent = makeAgent('agent-crash-memory');
      agentHolder.current = agent;
      const { startAgent, stopAgent } = await import('./agentRunner.js');
      // `processes` is a module singleton: free the slots earlier tests took,
      // or MAX_CONCURRENT_AGENTS refuses this start.
      for (const id of ['agent-env-secrets', 'agent-env-passthrough', 'agent-env-explicit', 'agent-env-absent', 'agent-env-coverage']) {
        await stopAgent(id);
      }
      forkMock.mockClear();

      await startAgent(agent.id);
      const first = forkMock.mock.calls[0][2].env as Record<string, string>;
      expect(first.AGENT_CRASH_COUNT).toBe('0');
      expect(first.AGENT_CRASHED_TASKS).toBe('{}');

      // A run that merely returned must not clear anything; junk is ignored.
      await handlers.message({ type: 'task-started', taskHash: TASK });
      await handlers.message({ type: 'task-finished', taskHash: TASK, completed: false });
      await handlers.message({ type: 'task-started', taskHash: { evil: true } });
      await handlers.message({ type: 'task-started', taskHash: TASK });

      // Second fork gets its own child object so the stale-exit guard holds.
      forkMock.mockReturnValue({ ...child, on: vi.fn((ev: string, cb: (...a: any[]) => unknown) => { handlers[`2:${ev}`] = cb; }) });
      await handlers.exit(1, null);
      await vi.advanceTimersByTimeAsync(3_100);

      expect(forkMock).toHaveBeenCalledTimes(2);
      const second = forkMock.mock.calls[1][2].env as Record<string, string>;
      expect(second.AGENT_SKIP_RESUME).toBe('1');
      expect(second.AGENT_CRASH_COUNT).toBe('1');
      expect(JSON.parse(second.AGENT_CRASHED_TASKS)).toEqual({ [TASK]: 1 });

      // Completing the task clears its charge for the next start.
      await handlers['2:message']({ type: 'task-started', taskHash: TASK });
      await handlers['2:message']({ type: 'task-finished', taskHash: TASK, completed: true });
      forkMock.mockReturnValue({ ...child, on: vi.fn() });
      await handlers['2:exit'](1, null);
      await vi.advanceTimersByTimeAsync(3_100);
      const third = forkMock.mock.calls[2][2].env as Record<string, string>;
      expect(third.AGENT_CRASH_COUNT).toBe('1');
      expect(JSON.parse(third.AGENT_CRASHED_TASKS)).toEqual({});

      // An operator stop is a clean slate.
      await stopAgent(agent.id);
      forkMock.mockReturnValue({ ...child, on: vi.fn() });
      await startAgent(agent.id);
      const fourth = forkMock.mock.calls[3][2].env as Record<string, string>;
      expect(fourth.AGENT_CRASH_COUNT).toBe('0');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("on another deployment's Redis (deploymentIdentity)", () => {
  it('starts no agent and reconciles nothing: workers are what poach a shared queue', async () => {
    const { startAgent, reconcileAgents } = await import('./agentRunner.js');
    const store = await import('./deployedAgentStore.js');
    agentHolder.current = makeAgent('agent-other-redis');
    forkMock.mockClear();
    vi.mocked(store.loadAllAgents).mockClear();
    gate.allowed = false;
    try {
      await expect(startAgent('agent-other-redis')).rejects.toThrow(/another deployment's Redis .*belongs to deployment "production"/);
      await reconcileAgents();
      expect(forkMock).not.toHaveBeenCalled();
      expect(store.loadAllAgents).not.toHaveBeenCalled();
    } finally {
      gate.allowed = true;
    }
  });
});

describe('when writes turn off after boot (deploymentIdentity)', () => {
  it('kills every running worker, leaving its saved status for reconcile', async () => {
    const { startAgent, stopLocalWorkers } = await import('./agentRunner.js');
    const store = await import('./deployedAgentStore.js');
    const kill = vi.fn();
    const handlers: Record<string, (...a: unknown[]) => unknown> = {};
    forkMock.mockReset();
    forkMock.mockReturnValue({
      stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, pid: 99, kill,
      on: vi.fn((ev: string, cb: (...a: unknown[]) => unknown) => { handlers[ev] = cb; }),
    });
    stopLocalWorkers(); // slots earlier tests left
    agentHolder.current = { ...makeAgent('agent-killed-on-stop'), status: 'running' };
    await startAgent('agent-killed-on-stop', { skipResume: true });
    vi.mocked(store.saveAgent).mockClear();

    expect(gate.onStopped.length).toBeGreaterThan(0);
    for (const listener of gate.onStopped) listener();
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    // The worker's exit arrives after the kill: it must not mark the agent stopped.
    await handlers.exit(null, 'SIGTERM');

    expect(stopLocalWorkers()).toBe(0);
    expect(store.saveAgent).not.toHaveBeenCalled();
  });

  it('a crash restart due after writes turned off does not restart, and keeps the saved status', async () => {
    const { startAgent, stopLocalWorkers } = await import('./agentRunner.js');
    const store = await import('./deployedAgentStore.js');
    const handlers: Record<string, (...a: unknown[]) => unknown> = {};
    forkMock.mockReset();
    forkMock.mockReturnValue({
      stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, pid: 97, kill: vi.fn(),
      on: vi.fn((ev: string, cb: (...a: unknown[]) => unknown) => { handlers[ev] = cb; }),
    });
    stopLocalWorkers();
    agentHolder.current = { ...makeAgent('agent-crash-then-stop'), status: 'running' };
    await startAgent('agent-crash-then-stop', { skipResume: true });
    vi.useFakeTimers();
    try {
      await handlers.exit(1, null); // a crash: an auto-restart is scheduled
      gate.allowed = false; // then this process learns it is on another deployment's Redis
      forkMock.mockClear();
      vi.mocked(store.saveAgent).mockClear();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(forkMock).not.toHaveBeenCalled();
      expect(store.saveAgent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      gate.allowed = true;
    }
  });

  it('the heartbeat watchdog writes no log lines to another deployment\'s Redis', async () => {
    const { startZombieReaper } = await import('./agentRunner.js');
    const store = await import('./deployedAgentStore.js');
    const redisMod = await import('./redis.js');
    vi.useFakeTimers();
    gate.allowed = false;
    try {
      agentHolder.current = { ...makeAgent('agent-watchdog'), status: 'running' };
      vi.mocked(store.loadAllAgents).mockClear();
      vi.mocked(redisMod.appendLog).mockClear();
      startZombieReaper();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(store.loadAllAgents).not.toHaveBeenCalled();
      expect(redisMod.appendLog).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      gate.allowed = true;
    }
  });

  it('kills a worker whose start was forking when writes turned off', async () => {
    const { startAgent, stopLocalWorkers } = await import('./agentRunner.js');
    const store = await import('./deployedAgentStore.js');
    const kill = vi.fn();
    const handlers: Record<string, (...a: unknown[]) => unknown> = {};
    forkMock.mockReset();
    forkMock.mockImplementation(() => {
      gate.allowed = false; // the check turned writes off while this start was forking
      return {
        stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, pid: 98, kill,
        on: vi.fn((ev: string, cb: (...a: unknown[]) => unknown) => { handlers[ev] = cb; }),
      };
    });
    stopLocalWorkers();
    agentHolder.current = { ...makeAgent('agent-forking-at-stop'), status: 'running' };
    vi.mocked(store.saveAgent).mockClear();
    try {
      await expect(startAgent('agent-forking-at-stop', { skipResume: true })).rejects.toThrow(/another deployment's Redis/);
      expect(kill).toHaveBeenCalledWith('SIGTERM');
      await handlers.exit(null, 'SIGTERM');
      expect(stopLocalWorkers()).toBe(0);
      expect(store.saveAgent).not.toHaveBeenCalled();
    } finally {
      gate.allowed = true;
    }
  });
});
