import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /api/v1/agents/:id/readiness serves the worker's last report on whether
 * it is taking tasks. Owner-only: the reason can quote a model provider's
 * error, which can echo part of an API key.
 */

const OWNER = '0x2222222222222222222222222222222222222222';

const { getAgent, loadAgentReadiness } = vi.hoisted(() => ({
  getAgent: vi.fn(async () => ({
    id: 'agent-1', ownerAddress: '0x2222222222222222222222222222222222222222', authorizedOwners: [],
    walletAddress: '0x4444444444444444444444444444444444444444', status: 'running',
  })),
  loadAgentReadiness: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('../services/agentReadiness.js', () => ({ loadAgentReadiness }));
vi.mock('../services/agentRunner.js', () => ({
  deployAgent: vi.fn(), startAgent: vi.fn(),
  pauseAgent: vi.fn(), stopAgent: vi.fn(), resumeAgent: vi.fn(),
  getAgent, listAgents: vi.fn(), getAgentLogs: vi.fn(),
  subscribeAgentLogs: vi.fn(async () => () => {}), updateAgent: vi.fn(),
  addAuthorizedOwner: vi.fn(), getAgentStats: vi.fn(),
}));
vi.mock('../services/apiKeyStore.js', () => ({
  lookupApiKey: vi.fn(async (c: string) =>
    c === 'sk_owner' ? { ownerAddress: OWNER } : c === 'sk_other' ? { ownerAddress: '0x9999999999999999999999999999999999999999' } : null),
}));
vi.mock('../services/chain.js', () => ({ provider: {}, baseProvider: {} }));
vi.mock('../services/redis.js', () => ({
  redis: {
    get: vi.fn(), set: vi.fn(), exists: vi.fn(), pipeline: vi.fn(),
    smembers: vi.fn(async () => []), sadd: vi.fn(async () => 0),
    srem: vi.fn(async () => 0), del: vi.fn(async () => 0),
  },
}));
vi.mock('../services/reputation.js', () => ({}));
vi.mock('../services/reputationDecay.js', () => ({}));
vi.mock('../services/agentStore.js', () => ({}));
vi.mock('../services/serviceStore.js', () => ({}));
vi.mock('../services/skillStore.js', () => ({ incrementInstallCount: vi.fn(), getSkillBySlug: vi.fn(async () => null) }));
vi.mock('../services/agentEmbedding.js', () => ({ recomputeForWalletBestEffort: vi.fn() }));
vi.mock('../services/agentFactoryListener.js', () => ({
  markDeployCreditUsed: vi.fn(async () => undefined), claimDeployCredit: vi.fn(), restoreDeployCredit: vi.fn() }));
vi.mock('../services/skillComposer.js', () => ({ buildInstalledSkill: vi.fn(), assertComposedSizeOk: vi.fn() }));

const { agentsRouter } = await import('./agents.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use('/api/v1/agents', agentsRouter);
app.use(globalErrorHandler);

const report = {
  ready: false,
  reason: 'no 0G Compute account yet',
  fund: { chain: '0g', address: '0x4444444444444444444444444444444444444444', holdsWei: '1600000000000000000', needWei: '3100000000000000000', shortfallWei: '1500000000000000000' },
  reportedAt: '2026-09-25T12:00:00.000Z',
};

beforeEach(() => vi.clearAllMocks());

describe('GET /api/v1/agents/:id/readiness', () => {
  it("gives the owner the worker's last report", async () => {
    loadAgentReadiness.mockResolvedValueOnce(report);
    const res = await request(app).get('/api/v1/agents/agent-1/readiness').set('X-API-Key', 'sk_owner');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ readiness: report });
    expect(loadAgentReadiness).toHaveBeenCalledWith('agent-1');
  });

  it('answers null while the worker has not reported', async () => {
    const res = await request(app).get('/api/v1/agents/agent-1/readiness').set('X-API-Key', 'sk_owner');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ readiness: null });
  });

  it('shows nothing to anyone else', async () => {
    loadAgentReadiness.mockResolvedValue(report);
    const other = await request(app).get('/api/v1/agents/agent-1/readiness').set('X-API-Key', 'sk_other');
    expect(other.status).toBe(403);
    expect(JSON.stringify(other.body)).not.toContain('0G Compute');
    const anon = await request(app).get('/api/v1/agents/agent-1/readiness');
    expect(anon.status).toBe(401);
  });
});
