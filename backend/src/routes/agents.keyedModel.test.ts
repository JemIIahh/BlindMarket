import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * An owner can name a model the catalog doesn't list yet (one released
 * today). Deploy and PATCH check it against the provider's own models list
 * with the owner's key — free, no model call — and refuse it with a clear 400
 * when the key can't use it. The edit form lists models with the key on file.
 * fetch is stubbed: nothing here reaches a provider.
 */

const OWNER = '0x2222222222222222222222222222222222222222';
const STRANGER = '0x4444444444444444444444444444444444444444';
// A real secp256k1 point (private key 0x11…11): the deploy encrypts the agent's key to it.
const OWNER_PUBLIC_KEY = '044f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa385b6b1b8ead809ca67454d9683fcf2ba03456d6fe2c4abe2b07f0fbdbb2f1c1';

const { getAgent, updateAgent } = vi.hoisted(() => ({
  getAgent: vi.fn(),
  updateAgent: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
}));

vi.mock('../services/ogComputeCatalog.js', () => ({ readOgServices: vi.fn(async () => []) }));
vi.mock('../services/agentRunner.js', () => ({
  startRefusal: vi.fn(() => null),
  deployAgent: vi.fn(), startAgent: vi.fn(),
  pauseAgent: vi.fn(), stopAgent: vi.fn(), resumeAgent: vi.fn(),
  getAgent, listAgents: vi.fn(), getAgentLogs: vi.fn(),
  subscribeAgentLogs: vi.fn(async () => () => {}), updateAgent,
  addAuthorizedOwner: vi.fn(), getAgentStats: vi.fn(),
}));
vi.mock('../services/apiKeyStore.js', () => ({
  lookupApiKey: vi.fn(async (c: string) =>
    c === 'sk_owner' ? { ownerAddress: OWNER } : c === 'sk_stranger' ? { ownerAddress: STRANGER } : null),
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

// GET https://api.x.ai/v1/language-models, as docs.x.ai documents its shape.
const XAI_LIST = { models: [
  { id: 'grok-4.7', created: 1789000000, input_modalities: ['text'], output_modalities: ['text'], prompt_text_token_price: 20000, completion_text_token_price: 60000, aliases: [] },
  { id: 'grok-5', created: 1790000000, input_modalities: ['text'], output_modalities: ['text'], aliases: ['grok-5-latest'] },
] };

let fetchMock: ReturnType<typeof vi.fn>;
const respond = (body: unknown, status = 200) => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
};
const providerCalls = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), auth: (init as RequestInit).headers as Record<string, string> }));

const deployBody = (extra: Record<string, unknown> = {}) => ({
  name: 'A', instructions: 'do useful things for people',
  provider: 'xai', model: 'grok-5', apiKey: 'xai-owner-key', capabilities: [],
  ownerPublicKey: OWNER_PUBLIC_KEY, ...extra,
});
const validate = (extra = {}) =>
  request(app).post('/api/v1/agents/deploy/validate').set('X-API-Key', 'sk_owner').send(deployBody(extra));
const patch = (body: object) =>
  request(app).patch('/api/v1/agents/agent-1').set('X-API-Key', 'sk_owner').send(body);
const agentOn = (provider: string, model: string, apiKey = 'xai-key-on-file') => ({
  id: 'agent-1', ownerAddress: OWNER, authorizedOwners: [], provider, model, apiKey,
  walletAddress: '0xCD7e56fB4c1b3832e8462a33576B4dd034aEc25F', status: 'running',
});

beforeEach(() => {
  respond(XAI_LIST);
  updateAgent.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('deploying on a model the catalog lacks', () => {
  it('accepts one the provider lists for the key, asking with that key', async () => {
    const res = await validate();
    expect(res.status).toBe(200);
    expect(providerCalls()).toEqual([{ url: 'https://api.x.ai/v1/language-models', auth: { Authorization: 'Bearer xai-owner-key' } }]);
  });

  it('accepts an alias the provider gives, and trims the id', async () => {
    expect((await validate({ model: '  grok-5-latest ' })).status).toBe(200);
  });

  it('refuses one the provider does not list: 400 MODEL_NOT_AVAILABLE naming what it does list', async () => {
    const res = await validate({ model: 'grok-9' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MODEL_NOT_AVAILABLE');
    expect(res.body.error.message).toContain('grok-9');
    expect(res.body.error.models).toEqual(['grok-5', 'grok-4.7']);
  });

  it('refuses before the fee is taken: POST /deploy gives the same 400', async () => {
    const res = await request(app).post('/api/v1/agents/deploy').set('X-API-Key', 'sk_owner').send(deployBody({ model: 'grok-9' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MODEL_NOT_AVAILABLE');
  });

  it('a key the provider refuses → 400 PROVIDER_AUTH, the key not echoed', async () => {
    respond({ error: 'Incorrect API key provided: xai-o***' }, 401);
    const res = await validate({ apiKey: 'xai-SECRETKEY' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PROVIDER_AUTH');
    expect(JSON.stringify(res.body)).not.toContain('SECRETKEY');
  });

  it('a list that cannot be read → 502, never an unchecked deploy', async () => {
    respond({}, 503);
    const res = await validate();
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('no key → 400 API_KEY_REQUIRED, and nothing is sent', async () => {
    const res = await validate({ apiKey: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('API_KEY_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not ask the provider about a catalog model', async () => {
    expect((await validate({ model: 'grok-4.7' })).status).toBe(200);
    expect((await validate({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant' })).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an id longer than any model id', async () => {
    expect((await validate({ model: 'g'.repeat(129) })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /agents/:id to a model the catalog lacks', () => {
  it('checks it with the key on file when the provider stays', async () => {
    getAgent.mockResolvedValue(agentOn('xai', 'grok-4.7'));
    const res = await patch({ provider: 'xai', model: 'grok-5' });
    expect(res.status).toBe(200);
    expect(providerCalls()[0].auth).toEqual({ Authorization: 'Bearer xai-key-on-file' });
    expect(updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({ model: 'grok-5' }));
  });

  it('checks it with a new key when one is sent', async () => {
    getAgent.mockResolvedValue(agentOn('xai', 'grok-4.7'));
    expect((await patch({ model: 'grok-5', apiKey: 'xai-new-key' })).status).toBe(200);
    expect(providerCalls()[0].auth).toEqual({ Authorization: 'Bearer xai-new-key' });
  });

  it('refuses one the provider does not list, and saves nothing', async () => {
    getAgent.mockResolvedValue(agentOn('xai', 'grok-4.7'));
    const res = await patch({ model: 'grok-9' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MODEL_NOT_AVAILABLE');
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('never checks a model on another provider with the key on file', async () => {
    getAgent.mockResolvedValue(agentOn('openai', 'gpt-5.4-mini', 'sk-openai-on-file'));
    const res = await patch({ provider: 'xai', model: 'grok-5' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('API_KEY_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not block an edit that leaves the provider and model alone', async () => {
    getAgent.mockResolvedValue(agentOn('xai', 'grok-retired'));
    expect((await patch({ instructions: 'new', provider: 'xai', model: 'grok-retired' })).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /agents/:id/provider-models (edit form, key on file)', () => {
  const list = (key = 'sk_owner') => request(app).post('/api/v1/agents/agent-1/provider-models').set('X-API-Key', key).send({});

  it("lists the agent's provider's models with the key on file, newest first", async () => {
    getAgent.mockResolvedValue(agentOn('xai', 'grok-4.7'));
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      provider: 'xai',
      models: [{ id: 'grok-5' }, { id: 'grok-4.7', inputCostPer1M: 2, outputCostPer1M: 6 }],
    });
    expect(providerCalls()[0].auth).toEqual({ Authorization: 'Bearer xai-key-on-file' });
    expect(JSON.stringify(res.body)).not.toContain('xai-key-on-file');
  });

  it('is owner-only', async () => {
    getAgent.mockResolvedValue(agentOn('xai', 'grok-4.7'));
    const res = await list('sk_stranger');
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for a key when none is on file', async () => {
    getAgent.mockResolvedValue(agentOn('xai', 'grok-4.7', ''));
    const res = await list();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('API_KEY_REQUIRED');
  });

  it('a key on file the provider now refuses → 400 PROVIDER_AUTH', async () => {
    getAgent.mockResolvedValue(agentOn('xai', 'grok-4.7'));
    respond({ error: 'bad key' }, 403);
    const res = await list();
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PROVIDER_AUTH');
  });
});

describe('xai as a provider', () => {
  it('is offered by GET /agents/providers with its catalog prices', async () => {
    const res = await request(app).get('/api/v1/agents/providers');
    expect(res.body.data.models.xai[0]).toBe('grok-4.7');
    expect(res.body.data.pricing.xai[0]).toEqual({ id: 'grok-4.7', inputCostPer1M: 2, outputCostPer1M: 6 });
  });
});
