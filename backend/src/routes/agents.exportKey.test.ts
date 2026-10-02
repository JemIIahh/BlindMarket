import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Exporting an agent's key ends sponsored gas for its wallet for good
 * (docs/AGENT-GAS-FUNDING.md, "Who is eligible"): POST /agents/:id/export-key
 * logs the export before it returns the key, and refuses when it can't log on
 * Postgres. GET /agents/:id/gas-sponsorship tells the owner where the agent
 * stands. Same harness as agents.readiness.test.ts.
 */

const OWNER = '0x2222222222222222222222222222222222222222';

const { getAgent, loadAgentReadiness } = vi.hoisted(() => ({
  getAgent: vi.fn(async () => ({
    id: 'agent-1', ownerAddress: '0x2222222222222222222222222222222222222222', authorizedOwners: [],
    walletAddress: '0x4444444444444444444444444444444444444444', status: 'running', encryptedPrivateKey: 'enc:key',
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

const sponsor = vi.hoisted(() => ({ record: vi.fn(async () => {}), status: vi.fn(async () => ({ state: 'sponsored' })) }));
vi.mock('../services/gasSponsorStore.js', () => ({ recordKeyExport: sponsor.record }));
vi.mock('../services/gasSponsorEligibility.js', () => ({ sponsorshipStatus: sponsor.status }));
const backfill = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../services/privyBackfill.js', () => ({ backfillOwnerPrivyId: backfill }));
const cfg = vi.hoisted(() => ({ databaseUrl: 'postgres://x' }));
vi.mock('../config.js', async (orig) => {
  const mod = await orig<typeof import('../config.js')>();
  return { ...mod, config: new Proxy(mod.config, { get: (t, k) => (k === 'databaseUrl' ? cfg.databaseUrl : (t as any)[k]) }) };
});

const { agentsRouter } = await import('./agents.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use('/api/v1/agents', agentsRouter);
app.use(globalErrorHandler);

beforeEach(() => {
  vi.clearAllMocks();
  cfg.databaseUrl = 'postgres://x';
  sponsor.record.mockResolvedValue(undefined);
});

const exportKey = (key = 'sk_owner') => request(app).post('/api/v1/agents/agent-1/export-key').set('X-API-Key', key);

describe('POST /agents/:id/export-key', () => {
  it('logs the export, then returns the encrypted key', async () => {
    const res = await exportKey();
    expect(res.status).toBe(200);
    expect(sponsor.record).toHaveBeenCalledWith('agent-1', '0x4444444444444444444444444444444444444444', OWNER);
    expect(res.body.data.encryptedPrivateKey).toBe('enc:key');
  });

  it('refuses when the export cannot be logged', async () => {
    sponsor.record.mockRejectedValue(new Error('db down'));
    const res = await exportKey();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('EXPORT_NOT_LOGGED');
    expect(JSON.stringify(res.body)).not.toContain('enc:key');
  });

  it("logs nothing for someone else's agent", async () => {
    expect((await exportKey('sk_other')).status).toBe(403);
    expect(sponsor.record).not.toHaveBeenCalled();
  });

  it('has nothing to log without Postgres', async () => {
    cfg.databaseUrl = '';
    expect((await exportKey()).status).toBe(200);
    expect(sponsor.record).not.toHaveBeenCalled();
  });
});

describe('owner routes', () => {
  it('offer the signed-in user to the Privy backfill before the agent loads', async () => {
    await exportKey();
    expect(backfill).toHaveBeenCalledWith(expect.objectContaining({ address: OWNER }));
    expect(backfill.mock.invocationCallOrder[0]).toBeLessThan(getAgent.mock.invocationCallOrder[0]);
  });
});

describe('GET /agents/:id/gas-sponsorship', () => {
  it('tells the owner, and only the owner, where the agent stands', async () => {
    sponsor.status.mockResolvedValue({ state: 'not_eligible', reason: 'key_exported' });
    const res = await request(app).get('/api/v1/agents/agent-1/gas-sponsorship').set('X-API-Key', 'sk_owner');
    expect(res.body.data).toEqual({ state: 'not_eligible', reason: 'key_exported' });
    expect((await request(app).get('/api/v1/agents/agent-1/gas-sponsorship').set('X-API-Key', 'sk_other')).status).toBe(403);
  });
});
