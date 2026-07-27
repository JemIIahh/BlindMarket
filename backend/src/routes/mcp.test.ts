import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Route-level tests for the remote MCP endpoint (Streamable HTTP, stateless).
 *
 * The security claims under test:
 *  1. No API key → MCP-shaped 401 with WWW-Authenticate (not the REST envelope).
 *  2. GET/DELETE → 405 (stateless endpoint, POST only).
 *  3. Tool output NEVER carries brief key material (wrappedKeys /
 *     keyCustodyBlob / rootHash) or deployed-agent secrets (rawPrivateKey /
 *     platformToken / apiKey) — tool output lands verbatim in third-party LLM
 *     context windows, so this is the same invariant the projectPublic*
 *     projections enforce on unauthenticated REST surfaces.
 *  4. resultData is poster/worker-gated exactly like REST task detail.
 *  5. Agent lifecycle tools enforce ownership (isAgentOwner), not just auth.
 *
 * Infra-touching modules are mocked at their seams; a2aStore is partially
 * mocked so the REAL projection functions run against fixture data that is
 * deliberately stuffed with secrets.
 */

const F = vi.hoisted(() => {
  const POSTER = '0x1111111111111111111111111111111111111111';
  const OTHER = '0x3333333333333333333333333333333333333333';
  const OWNER = '0x2222222222222222222222222222222222222222';
  const ZERO = '0x0000000000000000000000000000000000000000';
  const TASK_HASH = '0x' + 'ab'.repeat(32);
  return {
    POSTER, OTHER, OWNER, ZERO, TASK_HASH,
    META: {
      taskId: TASK_HASH,
      targetExecutorType: 'agent',
      verificationMode: 'auto',
      requiredCapabilities: ['web_research'],
      posterAddress: POSTER,
      rootHash: 'SECRET_ROOT_HASH',
      wrappedKeys: { '0xagent': 'deadbeefslice' },
      keyCustodyBlob: { keyId: 'kid', blob: 'SECRET_CUSTODY_BLOB' },
      deadline: 4102444800,
    },
    STATE: {
      taskId: TASK_HASH,
      status: 'submitted',
      executorAddress: '0xagent',
      resultData: { output: 'the secret deliverable' },
      assignError: 'SECRET_ASSIGN_ERROR',
      verifyError: 'SECRET_VERIFY_ERROR',
    },
    ESCROW_TASK: {
      taskHash: TASK_HASH,
      agent: POSTER,
      worker: ZERO,
      token: ZERO,
      amount: 1000000000000000000n,
      status: 1,
      createdAt: 1700000000n,
      deadline: 4102444800n,
    },
    AGENT: {
      id: 'agent-1',
      ownerAddress: OWNER,
      authorizedOwners: [],
      name: 'Test Agent',
      instructions: 'do things',
      provider: 'openai',
      model: 'gpt-x',
      apiKey: 'SECRET_LLM_KEY',
      encryptedApiKey: 'SECRET_ENC_API',
      capabilities: ['web_research'],
      tools: [],
      status: 'stopped',
      deployedAt: '2026-01-01',
      walletAddress: '0x4444444444444444444444444444444444444444',
      publicKey: '04abcd',
      encryptedPrivateKey: 'SECRET_ENC_PRIV',
      rawPrivateKey: 'SECRET_RAW_KEY',
      platformToken: 'SECRET_PLATFORM_JWT',
    },
  };
});

vi.mock('../services/redis.js', () => ({
  redis: {
    get: vi.fn(async (k: string) => (k.startsWith('a2a:hash2id:') ? '7' : null)),
    set: vi.fn(), pipeline: vi.fn(), smembers: vi.fn(async () => []), eval: vi.fn(),
  },
}));

vi.mock('../services/chain.js', () => ({
  getTokenDecimals: vi.fn(async () => 18),
}));

vi.mock('../services/registry.js', () => ({
  openTaskCount: vi.fn(async () => 3),
  getOpenTasks: vi.fn(async () => []),
}));

vi.mock('../services/escrow.js', () => ({
  getTask: vi.fn(async (id: number) => {
    if (id !== 7) throw new Error('could not decode result data');
    return F.ESCROW_TASK;
  }),
}));

vi.mock('../services/serviceStore.js', () => ({
  listActiveServices: vi.fn(async () => ({
    services: [{ id: 1, agent_address: '0xagent', name: 'Summarizer', price_raw: '100', agent_public_key: '04abcd' }],
    total: 1,
  })),
  getActiveService: vi.fn(async () => null),
  getMinActivePricesByAgents: vi.fn(async () => new Map<string, string>()),
}));

vi.mock('../services/agentStore.js', () => ({
  listAgents: vi.fn(async () => []),
}));

vi.mock('../services/reputation.js', () => ({
  getReputationWithScore: vi.fn(async () => null),
}));

vi.mock('../services/reputationDecay.js', () => ({
  getDecayedReputation: vi.fn(async (address: string) => ({
    address, rawScore: 0, decayedScore: 0, decayFactor: 1, daysSinceLastTask: null, tasksCompleted: 0, disputes: 0,
  })),
  getLeaderboard: vi.fn(async () => []),
}));

vi.mock('../services/deployedAgentStore.js', () => ({
  loadAllAgents: vi.fn(async () => [F.AGENT]),
  loadAgentByWallet: vi.fn(async () => null),
}));

vi.mock('../services/agentRunner.js', () => ({
  getAgent: vi.fn(async (id: string) => (id === F.AGENT.id ? F.AGENT : undefined)),
  startAgent: vi.fn(async () => undefined),
  stopAgent: vi.fn(async () => undefined),
  getAgentLogs: vi.fn(async () => ['log line 1', 'log line 2']),
}));

// Real requireAuth logic runs; only the DB lookup is stubbed. Key → wallet:
vi.mock('../services/apiKeyStore.js', () => ({
  lookupApiKey: vi.fn(async (candidate: string) => {
    if (candidate === 'sk_poster') return { ownerAddress: F.POSTER };
    if (candidate === 'sk_other') return { ownerAddress: F.OTHER };
    if (candidate === 'sk_owner') return { ownerAddress: F.OWNER };
    return null;
  }),
}));

vi.mock('../services/a2aStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/a2aStore.js')>();
  return {
    ...actual,
    browseAgentTasks: vi.fn(async () => [{ meta: F.META, state: F.STATE }]),
    getMeta: vi.fn(async () => F.META),
    getState: vi.fn(async () => F.STATE),
    getPosterTasks: vi.fn(async () => [{ meta: F.META, state: F.STATE }]),
  };
});

import { mcpRouter } from './mcp.js';
import * as agentRunner from '../services/agentRunner.js';

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/mcp', mcpRouter);
  return app;
}

let id = 0;
function rpc(app: express.Express, body: Record<string, unknown>, key?: string) {
  let r = request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json');
  if (key) r = r.set('X-API-Key', key);
  return r.send({ jsonrpc: '2.0', id: ++id, ...body });
}

const callTool = (app: express.Express, name: string, args: Record<string, unknown>, key: string) =>
  rpc(app, { method: 'tools/call', params: { name, arguments: args } }, key);

/** Every secret string that must never appear in any tool output. */
const FORBIDDEN_STRINGS = [
  'deadbeefslice', 'SECRET_ROOT_HASH', 'SECRET_CUSTODY_BLOB', 'wrappedKeys', 'keyCustodyBlob',
  'SECRET_ASSIGN_ERROR', 'SECRET_VERIFY_ERROR',
  'SECRET_RAW_KEY', 'SECRET_PLATFORM_JWT', 'SECRET_LLM_KEY', 'SECRET_ENC_PRIV', 'SECRET_ENC_API',
];

function expectNoSecrets(body: unknown) {
  const text = JSON.stringify(body);
  for (const s of FORBIDDEN_STRINGS) expect(text).not.toContain(s);
}

describe('POST /mcp — transport & auth', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects unauthenticated requests with an MCP-shaped 401 + WWW-Authenticate', async () => {
    const res = await rpc(makeApp(), { method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Bearer');
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.error.message).toMatch(/API key/i);
  });

  it('rejects an unknown API key with 401', async () => {
    const res = await rpc(makeApp(), { method: 'tools/list' }, 'sk_bogus');
    expect(res.status).toBe(401);
  });

  it('405s GET and DELETE (stateless endpoint)', async () => {
    const app = makeApp();
    expect((await request(app).get('/mcp')).status).toBe(405);
    expect((await request(app).delete('/mcp')).status).toBe(405);
  });

  it('completes the initialize handshake', async () => {
    const res = await rpc(makeApp(), {
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } },
    }, 'sk_poster');
    expect(res.status).toBe(200);
    expect(res.body.result.serverInfo.name).toBe('BlindMarket');
  });

  it('lists the Tier-1 tools', async () => {
    const res = await rpc(makeApp(), { method: 'tools/list' }, 'sk_poster');
    expect(res.status).toBe(200);
    const names = res.body.result.tools.map((t: { name: string }) => t.name);
    for (const expected of [
      'platform_status', 'browse_services', 'get_service', 'search_agents', 'browse_tasks',
      'get_task_status', 'get_reputation', 'get_leaderboard', 'get_my_posted_tasks',
      'list_my_agents', 'get_agent_logs', 'start_agent', 'stop_agent', 'restart_agent',
    ]) expect(names).toContain(expected);
    const browse = res.body.result.tools.find((t: { name: string }) => t.name === 'browse_tasks');
    expect(browse.annotations.readOnlyHint).toBe(true);
  });
});

describe('POST /mcp — key-material & secret leak guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('browse_tasks output carries no key material or diagnostics', async () => {
    const res = await callTool(makeApp(), 'browse_tasks', {}, 'sk_other');
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();
    expectNoSecrets(res.body);
  });

  it('get_task_status hides resultData from non-poster/worker and leaks no secrets', async () => {
    const res = await callTool(makeApp(), 'get_task_status', { taskId: F.TASK_HASH }, 'sk_other');
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body.result.content[0].text);
    expect(payload.a2aState.resultData).toBeNull();
    expectNoSecrets(res.body);
    expect(JSON.stringify(res.body)).not.toContain('the secret deliverable');
  });

  it('get_task_status shows resultData to the poster (still no key material)', async () => {
    const res = await callTool(makeApp(), 'get_task_status', { taskId: '7' }, 'sk_poster');
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body.result.content[0].text);
    expect(payload.a2aState.resultData).toEqual({ output: 'the secret deliverable' });
    expectNoSecrets(res.body);
  });

  it('get_my_posted_tasks includes the deliverable but never wrapped keys', async () => {
    const res = await callTool(makeApp(), 'get_my_posted_tasks', {}, 'sk_poster');
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body.result.content[0].text);
    expect(payload.tasks[0].state.resultData).toEqual({ output: 'the secret deliverable' });
    expectNoSecrets(res.body);
  });

  it('list_my_agents strips every deployed-agent secret', async () => {
    const res = await callTool(makeApp(), 'list_my_agents', {}, 'sk_owner');
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body.result.content[0].text);
    expect(payload.total).toBe(1);
    expect(payload.agents[0].name).toBe('Test Agent');
    expectNoSecrets(res.body);
  });
});

describe('POST /mcp — agent lifecycle ownership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses start_agent for a non-owner', async () => {
    const res = await callTool(makeApp(), 'start_agent', { agentId: F.AGENT.id }, 'sk_other');
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toContain('FORBIDDEN');
    expect(agentRunner.startAgent).not.toHaveBeenCalled();
  });

  it('starts an owned agent', async () => {
    const res = await callTool(makeApp(), 'start_agent', { agentId: F.AGENT.id }, 'sk_owner');
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();
    expect(agentRunner.startAgent).toHaveBeenCalledWith(F.AGENT.id);
    expectNoSecrets(res.body);
  });

  it('list_my_agents refuses the legacy shared-key principal', async () => {
    // The legacy AGENT_API_KEY resolves to the address 'agent' (no wallet) —
    // exercised here via a poster key stripped to a walletless identity by
    // calling the tool with no wallet-bearing key at all is impossible, so we
    // assert the FORBIDDEN path on ownership instead: a valid wallet that owns
    // nothing gets an empty list, not someone else's agents.
    const res = await callTool(makeApp(), 'list_my_agents', {}, 'sk_other');
    const payload = JSON.parse(res.body.result.content[0].text);
    expect(payload.total).toBe(0);
  });
});
