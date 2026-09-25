import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Service prices and minimum rewards are USDC base units on Base. Until Sep
 * 2026 the web app sent them with 18 decimals, and the live frontend can still
 * do so until it redeploys, so these routes convert such amounts on the way in.
 */

const OWNER = '0x2222222222222222222222222222222222222222';
const AGENT_WALLET = '0x4444444444444444444444444444444444444444';

const { getAgent, updateAgent, createService, updateService } = vi.hoisted(() => ({
  getAgent: vi.fn(async () => ({
    id: 'agent-1', ownerAddress: '0x2222222222222222222222222222222222222222', authorizedOwners: [],
    walletAddress: '0x4444444444444444444444444444444444444444', status: 'stopped',
  })),
  updateAgent: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
  createService: vi.fn(async (s: Record<string, unknown>) => ({ id: 1, ...s })),
  updateService: vi.fn(async (id: number, _agent: string, patch: Record<string, unknown>) => ({ id, ...patch })),
}));

vi.mock('../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../config.js')>();
  return { ...mod, config: { ...mod.config, baseEscrowAddress: '0xescrow' } };
});
vi.mock('../services/agentRunner.js', () => ({
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
vi.mock('../services/serviceStore.js', () => ({ createService, updateService }));
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

const asOwner = (r: request.Test) => r.set('X-API-Key', 'sk_owner');
const service = (priceRaw: string) => ({ name: 'Summarise text', priceRaw, serviceType: 'api' });

beforeEach(() => {
  createService.mockClear();
  updateService.mockClear();
  updateAgent.mockClear();
});

describe('service prices', () => {
  it('converts an 18-decimal price to USDC base units', async () => {
    const res = await asOwner(request(app).post('/api/v1/agents/agent-1/services')).send(service('1000000000000000000'));
    expect(res.status).toBe(201);
    expect(createService).toHaveBeenCalledWith(expect.objectContaining({ priceRaw: '1000000', agentAddress: AGENT_WALLET }));
  });

  it('keeps a USDC price as sent', async () => {
    await asOwner(request(app).post('/api/v1/agents/agent-1/services')).send(service('2500000'));
    expect(createService).toHaveBeenCalledWith(expect.objectContaining({ priceRaw: '2500000' }));
  });

  it('converts on update too', async () => {
    const res = await asOwner(request(app).patch('/api/v1/agents/agent-1/services/7')).send({ priceRaw: '500000000000000' });
    expect(res.status).toBe(200);
    expect(updateService).toHaveBeenCalledWith(7, AGENT_WALLET, expect.objectContaining({ price_raw: '500' }));
  });

  it('still rejects a non-integer price', async () => {
    const res = await asOwner(request(app).post('/api/v1/agents/agent-1/services')).send(service('1.5'));
    expect(res.status).toBe(400);
    expect(createService).not.toHaveBeenCalled();
  });
});

describe('agent minimum reward', () => {
  it('converts an 18-decimal minimum reward', async () => {
    const res = await asOwner(request(app).patch('/api/v1/agents/agent-1')).send({ minReward: '500000000000000000' });
    expect(res.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({ minReward: '500000' }));
  });

  it('keeps a USDC minimum reward as sent', async () => {
    await asOwner(request(app).patch('/api/v1/agents/agent-1')).send({ minReward: '250000' });
    expect(updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({ minReward: '250000' }));
  });
});

describe('PATCH /agents/:id body validation (audit run 1, C22)', () => {
  it('refuses a non-array tools value, and never stores it', async () => {
    for (const tools of [{}, 'x', 5, [null], [{ name: 'no type' }], [{ type: 'evil', name: 'x' }]]) {
      const res = await asOwner(request(app).patch('/api/v1/agents/agent-1')).send({ tools });
      expect(res.status).toBe(400);
    }
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('keeps extra fields on a tool (MCP tools added after deploy carry them)', async () => {
    const tool = { type: 'tool', name: 'lookup', mcp_endpoint: 'https://mcp.example.com', source: 'mcp' };
    const res = await asOwner(request(app).patch('/api/v1/agents/agent-1')).send({ tools: [tool] });
    expect(res.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({ tools: [tool] }));
  });

  it('refuses an unknown provider, an empty model and a non-integer minReward', async () => {
    for (const body of [{ provider: 'nope' }, { model: '' }, { minReward: '1.5' }]) {
      expect((await asOwner(request(app).patch('/api/v1/agents/agent-1')).send(body)).status).toBe(400);
    }
    expect(updateAgent).not.toHaveBeenCalled();
  });
});

describe('POST /agents/:id/verifier (audit run 1, C04)', () => {
  it('lets the owner turn verifier duty on and off', async () => {
    const res = await asOwner(request(app).post('/api/v1/agents/agent-1/verifier')).send({ enabled: true });
    expect(res.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith('agent-1', { verifierEnabled: true });
  });

  it('refuses anything but a boolean', async () => {
    const res = await asOwner(request(app).post('/api/v1/agents/agent-1/verifier')).send({ enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(updateAgent).not.toHaveBeenCalled();
  });
});
