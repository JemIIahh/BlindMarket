import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Route-level regression tests for the two agent-log surfaces (Plan 008:
 * "Gate the agent-log surfaces on ownership and stop logging brief plaintext").
 *
 * Before this plan, NEITHER route had any auth middleware: any caller who
 * knew an agent id — and ids come back from the unauthenticated GET /agents
 * list — could read (or, on the SSE route, live-stream) that agent's worker
 * stdout, which includes excerpts of the DECRYPTED task brief. Case 1 is the
 * regression: it fails on `main` today (200, not 401) because /:id/logs/json
 * had no requireAuth at all.
 *
 * The REAL agentsRouter, requireAuth, and isAgentOwner run unmocked so this
 * exercises the actual gate, not a stand-in for it — same structural pattern
 * as a2a.accept.test.ts and mcp.test.ts. Auth is driven via the DB-backed
 * X-API-Key path (lookupApiKey mocked) rather than a real Privy JWT, so no
 * JWKS network call happens; an unauthenticated request (no headers at all)
 * still hits requireAuth's real synchronous 401 throw. Only infra-touching
 * modules this router also imports (chain/redis/reputation/skill services —
 * unused by the routes under test) are stubbed so the module can load.
 */

const OWNER = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const AGENT_ID = 'agent-1';

function agentRecord(overrides: Partial<any> = {}) {
  return {
    id: AGENT_ID,
    ownerAddress: OWNER,
    authorizedOwners: [],
    name: 'Test Agent',
    instructions: 'do things',
    provider: 'openai',
    model: 'gpt-x',
    apiKey: '',
    encryptedApiKey: '',
    capabilities: ['web_research'],
    tools: [],
    status: 'stopped',
    deployedAt: '2026-01-01',
    walletAddress: '0x4444444444444444444444444444444444444444',
    publicKey: '04abcd',
    encryptedPrivateKey: '',
    ...overrides,
  };
}

vi.mock('../services/agentRunner.js', () => ({
  deployAgent: vi.fn(),
  startAgent: vi.fn(),
  pauseAgent: vi.fn(),
  stopAgent: vi.fn(),
  resumeAgent: vi.fn(),
  getAgent: vi.fn(),
  listAgents: vi.fn(),
  getAgentLogs: vi.fn(),
  subscribeAgentLogs: vi.fn(async () => () => {}),
  updateAgent: vi.fn(),
  addAuthorizedOwner: vi.fn(),
  getAgentStats: vi.fn(),
}));

// Real requireAuth logic runs; only the DB lookup is stubbed. Key -> wallet:
vi.mock('../services/apiKeyStore.js', () => ({
  lookupApiKey: vi.fn(async (candidate: string) => {
    if (candidate === 'sk_owner') return { ownerAddress: OWNER };
    if (candidate === 'sk_other') return { ownerAddress: OTHER };
    return null;
  }),
}));

// Infra-touching modules agents.ts also imports, unused by the routes under
// test — stubbed purely so importing the router doesn't drag in real
// network/DB/chain access.
vi.mock('../services/chain.js', () => ({ provider: {} }));
vi.mock('../services/redis.js', () => ({
  redis: { get: vi.fn(), set: vi.fn(), exists: vi.fn(), pipeline: vi.fn() },
}));
vi.mock('../services/reputation.js', () => ({}));
vi.mock('../services/reputationDecay.js', () => ({}));
vi.mock('../services/agentStore.js', () => ({}));
vi.mock('../services/serviceStore.js', () => ({}));
vi.mock('../services/skillStore.js', () => ({}));
vi.mock('../services/agentEmbedding.js', () => ({}));
vi.mock('../services/skillComposer.js', () => ({
  buildInstalledSkill: vi.fn(),
  assertComposedSizeOk: vi.fn(),
}));

import { agentsRouter } from './agents.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as agentRunner from '../services/agentRunner.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/agents', agentsRouter);
  a.use(globalErrorHandler);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/agents/:id/logs/json — ownership gate', () => {
  it('1) unauthenticated request is rejected 401 (regression: no auth middleware before Plan 008)', async () => {
    vi.mocked(agentRunner.getAgent).mockResolvedValue(agentRecord() as any);

    const res = await request(app()).get(`/api/v1/agents/${AGENT_ID}/logs/json`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(agentRunner.getAgentLogs).not.toHaveBeenCalled();
  });

  it('2) an authenticated non-owner is rejected (authorizeOwner\'s real status code)', async () => {
    vi.mocked(agentRunner.getAgent).mockResolvedValue(agentRecord() as any);

    const res = await request(app())
      .get(`/api/v1/agents/${AGENT_ID}/logs/json`)
      .set('X-API-Key', 'sk_other');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(agentRunner.getAgentLogs).not.toHaveBeenCalled();
  });

  it('3) the owner gets the buffered log lines', async () => {
    vi.mocked(agentRunner.getAgent).mockResolvedValue(agentRecord() as any);
    vi.mocked(agentRunner.getAgentLogs).mockResolvedValue(['line 1', 'line 2']);

    const res = await request(app())
      .get(`/api/v1/agents/${AGENT_ID}/logs/json`)
      .set('X-API-Key', 'sk_owner');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: ['line 1', 'line 2'] });
  });
});

describe('GET /api/v1/agents/:id/logs — SSE stream ownership gate', () => {
  it('4) an unauthenticated caller is rejected BEFORE any SSE header is written', async () => {
    const res = await request(app()).get(`/api/v1/agents/${AGENT_ID}/logs`);

    expect(res.status).toBe(401);
    expect(res.headers['content-type']).not.toMatch(/text\/event-stream/);
    expect(agentRunner.subscribeAgentLogs).not.toHaveBeenCalled();
  });
});
