import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * A deploy credit is a paid 1 USDC (AgentFactory). It must only be spent on a
 * deploy that actually happens. Found 2026-09-16 on the local stack: the route
 * claimed the credit BEFORE validating skills, so a request with an unknown
 * skill slug returned 404 and still consumed the payment; a deployAgent
 * failure lost it too.
 */

const OWNER = '0x2222222222222222222222222222222222222222';

// vi.mock factories are hoisted above module-level consts, so the shared spies
// have to be created inside vi.hoisted() to exist by the time they run.
const { startAgent, deployAgent } = vi.hoisted(() => ({
  startAgent: vi.fn(async () => {}),
  deployAgent: vi.fn(async () => ({
    id: 'agent-new', ownerAddress: '0x2222222222222222222222222222222222222222',
    name: 'A', instructions: 'do things',
    provider: 'openai', model: 'gpt-x', apiKey: '', encryptedApiKey: '',
    capabilities: [], tools: [], status: 'stopped', deployedAt: '2026-01-01',
    walletAddress: '0x4444444444444444444444444444444444444444',
    publicKey: '04abcd', encryptedPrivateKey: '', rawPrivateKey: 'SECRET',
  })),
}));

vi.mock('../services/agentRunner.js', () => ({
  deployAgent, startAgent,
  pauseAgent: vi.fn(), stopAgent: vi.fn(), resumeAgent: vi.fn(),
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
vi.mock('../services/skillStore.js', () => ({ incrementInstallCount: vi.fn(async () => {}), getSkillBySlug: vi.fn(async () => null) }));
vi.mock('../services/agentEmbedding.js', () => ({}));
// The deploy paywall — a real credit comes from an on-chain AgentFactory
// payment. Grant one so the test exercises the start, not the USDC gate.
vi.mock('../services/agentFactoryListener.js', () => ({
  claimDeployCredit: vi.fn(async () => ({ user: '0x2222222222222222222222222222222222222222', nonce: '7', usdcAmount: '1000000', block: 1, txHash: '0xpaid', ts: 0 })),
  restoreDeployCredit: vi.fn(async () => {}),
}));
vi.mock('../services/skillComposer.js', () => ({
  buildInstalledSkill: vi.fn(), assertComposedSizeOk: vi.fn(),
}));

import { agentsRouter } from './agents.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import { claimDeployCredit, restoreDeployCredit } from '../services/agentFactoryListener.js';

const app = express();
app.use(express.json());
app.use('/api/v1/agents', agentsRouter);
app.use(globalErrorHandler);

const body = (extra: Record<string, unknown> = {}) => ({
  name: 'A', instructions: 'do useful things for people',
  provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test', capabilities: [],
  ownerPublicKey: '04' + 'ab'.repeat(64), ...extra,
});
const deploy = (extra = {}) =>
  request(app).post('/api/v1/agents/deploy').set('X-API-Key', 'sk_owner').send(body(extra));

beforeEach(() => {
  vi.mocked(claimDeployCredit).mockClear();
  vi.mocked(restoreDeployCredit).mockClear();
  deployAgent.mockClear();
});

describe('POST /agents/deploy — the paid credit is only spent on a real deploy', () => {
  it('an unknown skill is rejected WITHOUT claiming the credit', async () => {
    const res = await deploy({ skillSlugs: ['no-such-skill'] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SKILL_NOT_FOUND');
    expect(claimDeployCredit).not.toHaveBeenCalled();
    expect(deployAgent).not.toHaveBeenCalled();
  });

  it('a failing deploy gives the claimed credit back', async () => {
    deployAgent.mockRejectedValueOnce(new Error('ECIES wrap failed'));
    const res = await deploy();
    expect(res.status).toBe(500);
    expect(claimDeployCredit).toHaveBeenCalledTimes(1);
    expect(restoreDeployCredit).toHaveBeenCalledWith(expect.objectContaining({ nonce: '7', txHash: '0xpaid' }));
  });

  it('a successful deploy spends the credit and does not restore it', async () => {
    const res = await deploy();
    expect(res.status).toBe(201);
    expect(claimDeployCredit).toHaveBeenCalledTimes(1);
    expect(restoreDeployCredit).not.toHaveBeenCalled();
  });
});
