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
// A real secp256k1 point (private key 0x11…11): the deploy encrypts the agent's key to it.
const OWNER_PUBLIC_KEY = '044f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa385b6b1b8ead809ca67454d9683fcf2ba03456d6fe2c4abe2b07f0fbdbb2f1c1';

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
  startRefusal: vi.fn(() => null),
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
  markDeployCreditUsed: vi.fn(async () => undefined),
  claimDeployCredit: vi.fn(async () => ({ user: '0x2222222222222222222222222222222222222222', nonce: '7', usdcAmount: '1000000', block: 1, txHash: '0xpaid', ts: 0 })),
  restoreDeployCredit: vi.fn(async () => {}),
}));
vi.mock('../services/skillComposer.js', () => ({
  buildInstalledSkill: vi.fn(), assertComposedSizeOk: vi.fn(),
}));
// The Arc fee path — deployFee.test.ts covers the receipt checks themselves.
const ARC_TERMS = {
  method: 'transfer', chain: 'arc', chainId: 5042002, token: '0x3600000000000000000000000000000000000000',
  recipient: '0x2f8b1177c83623a560B26B38dE984e154b123D75', amountRaw: '1000000', decimals: 6,
};
vi.mock('../services/deployFee.js', () => ({
  arcDeployFeeTerms: vi.fn(async () => ARC_TERMS),
  verifyArcDeployFee: vi.fn(async () => ({ payer: '0x2222222222222222222222222222222222222222', amountRaw: 1_000_000n })),
  claimArcDeployFee: vi.fn(async () => ({ claimed: true })),
  markArcDeployFeeUsed: vi.fn(async () => {}),
  releaseArcDeployFee: vi.fn(async () => {}),
}));

import { agentsRouter } from './agents.js';
import { globalErrorHandler, AppError } from '../middleware/errorHandler.js';
import { claimDeployCredit, restoreDeployCredit } from '../services/agentFactoryListener.js';
import { arcDeployFeeTerms, verifyArcDeployFee, claimArcDeployFee, markArcDeployFeeUsed, releaseArcDeployFee } from '../services/deployFee.js';
import { config } from '../config.js';
import { startRefusal } from '../services/agentRunner.js';

const app = express();
app.use(express.json());
app.use('/api/v1/agents', agentsRouter);
app.use(globalErrorHandler);

const body = (extra: Record<string, unknown> = {}) => ({
  name: 'A', instructions: 'do useful things for people',
  provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test', capabilities: [],
  ownerPublicKey: OWNER_PUBLIC_KEY, ...extra,
});
const deploy = (extra = {}) =>
  request(app).post('/api/v1/agents/deploy').set('X-API-Key', 'sk_owner').send(body(extra));

beforeEach(() => {
  vi.mocked(claimDeployCredit).mockClear();
  vi.mocked(restoreDeployCredit).mockClear();
  vi.mocked(verifyArcDeployFee).mockClear();
  vi.mocked(claimArcDeployFee).mockClear();
  vi.mocked(markArcDeployFeeUsed).mockClear();
  vi.mocked(releaseArcDeployFee).mockClear();
  deployAgent.mockClear();
});

const FEE_TX = '0x' + 'cd'.repeat(32);

describe('POST /agents/deploy — the deploy fee paid on Arc', () => {
  it("checks the transfer against the caller's wallets, claims it and deploys", async () => {
    const res = await deploy({ feeTxHash: FEE_TX });
    expect(res.status).toBe(201);
    expect(verifyArcDeployFee).toHaveBeenCalledWith(FEE_TX, [OWNER]);
    expect(claimArcDeployFee).toHaveBeenCalledWith(FEE_TX, OWNER);
    expect(claimDeployCredit).not.toHaveBeenCalled();
    expect(deployAgent).toHaveBeenCalledTimes(1);
    expect(deployAgent.mock.calls[0]).not.toHaveProperty('0.feeTxHash');
    expect(markArcDeployFeeUsed).toHaveBeenCalledWith(FEE_TX, 'agent-new');
    expect(releaseArcDeployFee).not.toHaveBeenCalled();
  });

  it('refuses a transaction that already paid for a deploy, naming the agent', async () => {
    vi.mocked(claimArcDeployFee).mockResolvedValueOnce({ claimed: false, pending: false, agentId: 'agent-old' });
    const res = await deploy({ feeTxHash: FEE_TX });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'DEPLOY_FEE_ALREADY_USED', agentId: 'agent-old' });
    expect(deployAgent).not.toHaveBeenCalled();
  });

  it('tells a deploy still running with the same transaction apart from a spent one', async () => {
    vi.mocked(claimArcDeployFee).mockResolvedValueOnce({ claimed: false, pending: true });
    const res = await deploy({ feeTxHash: FEE_TX });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DEPLOY_FEE_IN_USE');
    expect(deployAgent).not.toHaveBeenCalled();
  });

  it('passes on why a transaction is not a fee, and claims nothing', async () => {
    vi.mocked(verifyArcDeployFee).mockRejectedValueOnce(new AppError(402, 'DEPLOY_FEE_NOT_PAID', 'paid from another wallet', 'PAYER_NOT_LINKED'));
    const res = await deploy({ feeTxHash: FEE_TX });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: 'DEPLOY_FEE_NOT_PAID', reason: 'PAYER_NOT_LINKED' });
    expect(claimArcDeployFee).not.toHaveBeenCalled();
    expect(deployAgent).not.toHaveBeenCalled();
  });

  it('an unknown skill is rejected before the fee is looked at', async () => {
    const res = await deploy({ feeTxHash: FEE_TX, skillSlugs: ['no-such-skill'] });
    expect(res.status).toBe(404);
    expect(verifyArcDeployFee).not.toHaveBeenCalled();
    expect(claimArcDeployFee).not.toHaveBeenCalled();
  });

  it('a failing deploy frees the transfer for the retry', async () => {
    deployAgent.mockRejectedValueOnce(new Error('ECIES wrap failed'));
    const res = await deploy({ feeTxHash: FEE_TX });
    expect(res.status).toBe(500);
    expect(releaseArcDeployFee).toHaveBeenCalledWith(FEE_TX);
    expect(markArcDeployFeeUsed).not.toHaveBeenCalled();
    expect(restoreDeployCredit).not.toHaveBeenCalled();
  });

  it('rejects a feeTxHash that is not a transaction hash', async () => {
    const res = await deploy({ feeTxHash: '0x1234' });
    expect(res.status).toBe(400);
    expect(verifyArcDeployFee).not.toHaveBeenCalled();
  });
});

describe('POST /agents/deploy/validate — the checks before a fee is paid', () => {
  const validate = (extra: Record<string, unknown> = {}) =>
    request(app).post('/api/v1/agents/deploy/validate').set('X-API-Key', 'sk_owner').send(body(extra));

  it('passes a request the deploy would accept, and takes no fee and saves nothing', async () => {
    const res = await validate();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ valid: true });
    expect(verifyArcDeployFee).not.toHaveBeenCalled();
    expect(claimDeployCredit).not.toHaveBeenCalled();
    expect(deployAgent).not.toHaveBeenCalled();
  });

  it('refuses what the deploy would refuse, with the same answer', async () => {
    for (const extra of [{ name: '' }, { skillSlugs: ['no-such-skill'] }, { ownerPublicKey: '04' + 'ab'.repeat(64) }]) {
      const [checked, deployed] = await Promise.all([validate(extra), deploy(extra)]);
      expect(checked.status).toBe(deployed.status);
      expect(checked.body).toEqual(deployed.body);
    }
    expect(deployAgent).not.toHaveBeenCalled();
  });

  it('needs auth', async () => {
    const res = await request(app).post('/api/v1/agents/deploy/validate').send(body());
    expect(res.status).toBe(401);
  });
});

describe('POST /agents/deploy — the owner key must be one the agent key can be encrypted to', () => {
  it('refuses hex that is not a public key before the fee is looked at', async () => {
    const res = await deploy({ feeTxHash: FEE_TX, ownerPublicKey: '04' + 'ab'.repeat(64) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_OWNER_PUBLIC_KEY');
    expect(verifyArcDeployFee).not.toHaveBeenCalled();
    expect(claimArcDeployFee).not.toHaveBeenCalled();
    expect(deployAgent).not.toHaveBeenCalled();
  });

  it('accepts a compressed secp256k1 key too, as it did before', async () => {
    const compressed = '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa';
    const res = await deploy({ feeTxHash: FEE_TX, ownerPublicKey: compressed });
    expect(res.status).toBe(201);
  });
});

describe('GET /agents/deploy-fee', () => {
  it('gives the Arc terms when this stack has an Arc escrow', async () => {
    const res = await request(app).get('/api/v1/agents/deploy-fee');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ required: true, ...ARC_TERMS, factory: config.arcAgentFactoryAddress || null });
  });

  it('points at AgentFactory when there is no Arc escrow to pay by transfer', async () => {
    vi.mocked(arcDeployFeeTerms).mockResolvedValueOnce(null);
    const res = await request(app).get('/api/v1/agents/deploy-fee');
    expect(res.body.data).toEqual({ required: true, method: 'factory', chain: 'arc', chainId: config.arcChainId, factory: config.arcAgentFactoryAddress || null });
  });

  it('says no fee is due when the paywall is off', async () => {
    const cfg = config as { agentFactoryPaywall: boolean };
    const before = cfg.agentFactoryPaywall;
    cfg.agentFactoryPaywall = false;
    try {
      const res = await request(app).get('/api/v1/agents/deploy-fee');
      expect(res.body.data).toEqual({ required: false });
    } finally {
      cfg.agentFactoryPaywall = before;
    }
  });
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

describe('POST /agents/deploy — no free worker slot (audit run 1, C10)', () => {
  it('refuses with 503 AGENT_CAPACITY before taking any fee', async () => {
    vi.mocked(startRefusal).mockReturnValueOnce('You already run 2 agents, the most one owner can run here at once — stop one first');
    const res = await deploy({ feeTxHash: FEE_TX });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AGENT_CAPACITY');
    expect(res.body.error.message).toContain('Your payment has not been used');
    expect(claimArcDeployFee).not.toHaveBeenCalled();
    expect(claimDeployCredit).not.toHaveBeenCalled();
  });
});
