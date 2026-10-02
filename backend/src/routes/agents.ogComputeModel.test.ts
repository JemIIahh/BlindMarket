import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * A 0g-compute agent pays a 0G Compute provider from its own account, so it
 * can only run a model some provider on-chain serves. The deploy form used to
 * offer the 0G Compute Router's catalog (deepseek-v4-flash by default), which
 * the agent's account can't pay for: those agents never answered a model call
 * and never took a task (Oct 2026). Deploy and PATCH now refuse such a model,
 * and the edit form lists the ones that work.
 */

const OWNER = '0x2222222222222222222222222222222222222222';
// A real secp256k1 point (private key 0x11…11): the deploy encrypts the agent's key to it.
const OWNER_PUBLIC_KEY = '044f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa385b6b1b8ead809ca67454d9683fcf2ba03456d6fe2c4abe2b07f0fbdbb2f1c1';

const { getAgent, updateAgent, readOgServices } = vi.hoisted(() => ({
  getAgent: vi.fn(),
  updateAgent: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
  readOgServices: vi.fn(),
}));

vi.mock('../services/ogComputeCatalog.js', () => ({ readOgServices }));
vi.mock('../services/agentRunner.js', () => ({
  startRefusal: vi.fn(() => null),
  deployAgent: vi.fn(), startAgent: vi.fn(),
  pauseAgent: vi.fn(), stopAgent: vi.fn(), resumeAgent: vi.fn(),
  getAgent, listAgents: vi.fn(), getAgentLogs: vi.fn(),
  subscribeAgentLogs: vi.fn(async () => () => {}), updateAgent,
  addAuthorizedOwner: vi.fn(), getAgentStats: vi.fn(),
}));
vi.mock('../services/apiKeyStore.js', () => ({
  lookupApiKey: vi.fn(async (c: string) => (c === 'sk_owner' ? { ownerAddress: OWNER } : null)),
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

const chat = (provider: string, model: string) => ({
  provider, model, serviceType: 'chatbot', url: 'https://p.example',
  inputPrice: 1n, outputPrice: 1n, teeSignerAcknowledged: true, formats: ['openai'],
});
const ON_CHAIN = [
  chat('0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C', 'glm-5'),
  chat('0x1B3AAef3ae5050EEE04ea38cD4B087472BD85EB0', 'qwen3.7-plus'),
];

const deployBody = (extra: Record<string, unknown> = {}) => ({
  name: 'A', instructions: 'do useful things for people',
  provider: '0g-compute', model: 'glm-5', apiKey: '', capabilities: [],
  ownerPublicKey: OWNER_PUBLIC_KEY, ...extra,
});
const validate = (extra = {}) =>
  request(app).post('/api/v1/agents/deploy/validate').set('X-API-Key', 'sk_owner').send(deployBody(extra));
const patch = (body: object) =>
  request(app).patch('/api/v1/agents/agent-1').set('X-API-Key', 'sk_owner').send(body);
const agentOn = (provider: string, model: string) => ({
  id: 'agent-1', ownerAddress: OWNER, authorizedOwners: [], provider, model,
  walletAddress: '0xCD7e56fB4c1b3832e8462a33576B4dd034aEc25F', status: 'running',
});

beforeEach(() => {
  readOgServices.mockReset();
  readOgServices.mockResolvedValue(ON_CHAIN);
  updateAgent.mockClear();
});

describe('deploying a 0g-compute agent', () => {
  it('refuses a model no 0G Compute provider serves, naming the ones that do', async () => {
    const res = await validate({ model: 'deepseek-v4-flash' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MODEL_NOT_ON_0G_COMPUTE');
    expect(res.body.error.models).toEqual(['glm-5', 'qwen3.7-plus']);
    expect(res.body.error.message).toContain('deepseek-v4-flash');
  });

  it('accepts a model a provider serves', async () => {
    const res = await validate({ model: 'glm-5' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ valid: true });
  });

  it('refuses before the fee is taken: POST /deploy gives the same 400', async () => {
    const res = await request(app).post('/api/v1/agents/deploy').set('X-API-Key', 'sk_owner').send(deployBody({ model: 'kimi-k3' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MODEL_NOT_ON_0G_COMPUTE');
  });

  it("leaves other providers' models alone", async () => {
    // A catalog model: one the catalog lacks is checked against the provider's own list (agents.keyedModel.test.ts).
    const res = await validate({ provider: 'openai', model: 'gpt-5.4-mini', apiKey: 'sk-test' });
    expect(res.status).toBe(200);
    expect(readOgServices).not.toHaveBeenCalled();
  });
});

describe('PATCH /agents/:id on a 0g-compute agent', () => {
  it('switches a stuck agent to a model a provider serves', async () => {
    getAgent.mockResolvedValue(agentOn('0g-compute', 'deepseek-v4-flash'));
    const res = await patch({ model: 'glm-5' });
    expect(res.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({ model: 'glm-5' }));
  });

  it('refuses a model no provider serves', async () => {
    getAgent.mockResolvedValue(agentOn('0g-compute', 'glm-5'));
    const res = await patch({ model: 'deepseek-v4-flash' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MODEL_NOT_ON_0G_COMPUTE');
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('checks the model it already has when the provider moves to 0g-compute', async () => {
    getAgent.mockResolvedValue(agentOn('openai', 'gpt-5.4-mini'));
    const res = await patch({ provider: '0g-compute' });
    expect(res.status).toBe(400);
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('does not block an edit that leaves the provider and model alone', async () => {
    getAgent.mockResolvedValue(agentOn('0g-compute', 'deepseek-v4-flash'));
    expect((await patch({ instructions: 'new instructions' })).status).toBe(200);
    // The edit form sends both on every save.
    expect((await patch({ instructions: 'newer', provider: '0g-compute', model: 'deepseek-v4-flash' })).status).toBe(200);
    expect(readOgServices).not.toHaveBeenCalled();
  });
});

describe('GET /agents/providers', () => {
  it("lists 0g-compute's on-chain models, not the catalog's", async () => {
    readOgServices.mockResolvedValue([chat('0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D', 'glm-5.3')]);
    const res = await request(app).get('/api/v1/agents/providers');
    expect(res.status).toBe(200);
    expect(res.body.data.models['0g-compute']).toEqual(['glm-5.3']);
    expect(res.body.data.models.openai.length).toBeGreaterThan(0);
  });

  it('falls back to the catalog when 0G Compute cannot be read', async () => {
    readOgServices.mockRejectedValue(new Error('rpc down'));
    const res = await request(app).get('/api/v1/agents/providers');
    expect(res.status).toBe(200);
    expect(res.body.data.models['0g-compute'][0]).toBe('glm-5');
  });
});
