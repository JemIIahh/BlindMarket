import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * POST /agents/provider-models relays the user's pasted key to the provider's
 * own /models endpoint so the deploy form lists what that key can actually
 * use. It must be authenticated (not an anonymous key-validity oracle), refuse
 * a keyed provider without a key, and translate provider-side failures into
 * codes the form can explain — without echoing the key.
 */

const OWNER = '0x2222222222222222222222222222222222222222';

vi.mock('../services/agentRunner.js', () => ({
  deployAgent: vi.fn(), startAgent: vi.fn(), pauseAgent: vi.fn(), stopAgent: vi.fn(), resumeAgent: vi.fn(),
  getAgent: vi.fn(), listAgents: vi.fn(), getAgentLogs: vi.fn(),
  subscribeAgentLogs: vi.fn(async () => () => {}), updateAgent: vi.fn(),
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
vi.mock('../services/skillStore.js', () => ({ incrementInstallCount: vi.fn(async () => {}) }));
vi.mock('../services/agentEmbedding.js', () => ({}));
vi.mock('../services/agentFactoryListener.js', () => ({ claimDeployCredit: vi.fn() }));
vi.mock('../services/skillComposer.js', () => ({ buildInstalledSkill: vi.fn(), assertComposedSizeOk: vi.fn() }));
// Keep the real error class (the route branches on instanceof); stub the fetch.
vi.mock('../services/providerModels.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/providerModels.js')>();
  return { ...actual, discoverModels: vi.fn() };
});
// A configured legacy agent key so the 'agent' principal can be exercised.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, config: { ...actual.config, agentApiKey: 'legacy-agent-key' } };
});

import { agentsRouter } from './agents.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import { discoverModels, ProviderModelsError } from '../services/providerModels.js';

const app = express();
app.use(express.json());
app.use('/api/v1/agents', agentsRouter);
app.use(globalErrorHandler);

const call = (body: object, auth = true) => {
  const r = request(app).post('/api/v1/agents/provider-models');
  return (auth ? r.set('X-API-Key', 'sk_owner') : r).send(body);
};

beforeEach(() => { vi.mocked(discoverModels).mockClear(); });

describe('POST /agents/provider-models', () => {
  it('requires authentication', async () => {
    const res = await call({ provider: 'anthropic', apiKey: 'sk-ant-abc' }, false);
    expect(res.status).toBe(401);
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it('refuses a keyed provider without a key', async () => {
    const res = await call({ provider: 'openai' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('API_KEY_REQUIRED');
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it('lets 0g-compute through keyless', async () => {
    vi.mocked(discoverModels).mockResolvedValueOnce([{ id: 'deepseek-v4-flash', inputCostPer1M: 0.138, outputCostPer1M: 0.275 }]);
    const res = await call({ provider: '0g-compute' });
    expect(res.status).toBe(200);
    expect(discoverModels).toHaveBeenCalledWith('0g-compute', '');
    expect(res.body.data.models[0].id).toBe('deepseek-v4-flash');
  });

  it('returns the live list for the key', async () => {
    const models = [{ id: 'claude-opus-5', inputCostPer1M: 5, outputCostPer1M: 25 }, { id: 'claude-new' }];
    vi.mocked(discoverModels).mockResolvedValueOnce(models);
    const res = await call({ provider: 'anthropic', apiKey: 'sk-ant-real-key' });
    expect(res.status).toBe(200);
    expect(discoverModels).toHaveBeenCalledWith('anthropic', 'sk-ant-real-key');
    expect(res.body.data).toEqual({ provider: 'anthropic', models });
  });

  it('provider auth failure → 400 PROVIDER_AUTH, key not echoed', async () => {
    vi.mocked(discoverModels).mockRejectedValueOnce(new ProviderModelsError('PROVIDER_AUTH', 'anthropic rejected the API key'));
    const res = await call({ provider: 'anthropic', apiKey: 'sk-ant-SECRETKEY' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PROVIDER_AUTH');
    expect(JSON.stringify(res.body)).not.toContain('SECRETKEY');
  });

  it('unreachable provider → 502', async () => {
    vi.mocked(discoverModels).mockRejectedValueOnce(new ProviderModelsError('PROVIDER_UNAVAILABLE', 'openai models endpoint returned 503'));
    const res = await call({ provider: 'openai', apiKey: 'sk-abc' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('rejects the shared legacy agent principal', async () => {
    const res = await request(app).post('/api/v1/agents/provider-models')
      .set('X-API-Key', 'legacy-agent-key').send({ provider: '0g-compute' });
    expect(res.status).toBe(401);
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it('rejects a key with control characters before relaying it', async () => {
    const res = await call({ provider: 'openai', apiKey: 'sk-abc\ndef' });
    expect(res.status).toBe(400);
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it('rejects an unknown provider', async () => {
    const res = await call({ provider: 'mistral', apiKey: 'x' });
    expect(res.status).toBe(400);
    expect(discoverModels).not.toHaveBeenCalled();
  });
});
