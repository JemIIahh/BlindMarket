import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * An AgentFactory credit is keyed by the wallet that paid the factory. A
 * signed-in user can have several linked wallets, and the deploy looked for a
 * credit under the primary one only. On 2026-09-23 a user paid the Arc
 * factory from a linked wallet, and the deploy page looped on
 * NO_DEPLOY_CREDIT while the 1 USDC sat unclaimed. The transfer path already
 * accepted any of the caller's wallets; the credit path now does too.
 */

const PRIMARY = '0x1111111111111111111111111111111111111111';
const LINKED = '0x3333333333333333333333333333333333333333';
// A real secp256k1 point (private key 0x11…11): the deploy encrypts the agent's key to it.
const OWNER_PUBLIC_KEY = '044f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa385b6b1b8ead809ca67454d9683fcf2ba03456d6fe2c4abe2b07f0fbdbb2f1c1';

const { deployAgent, claimDeployCredit, restoreDeployCredit } = vi.hoisted(() => ({
  deployAgent: vi.fn(async () => ({
    id: 'agent-linked', ownerAddress: '0x1111111111111111111111111111111111111111', name: 'A', instructions: 'x',
    provider: 'openai', model: 'm', apiKey: '', encryptedApiKey: '', capabilities: [], tools: [], status: 'stopped',
    deployedAt: '2026-01-01', walletAddress: '0x4444444444444444444444444444444444444444', publicKey: '04ab',
    encryptedPrivateKey: '', rawPrivateKey: 'SECRET',
  })),
  claimDeployCredit: vi.fn(),
  restoreDeployCredit: vi.fn(async () => {}),
}));

vi.mock('../middleware/auth.js', () => ({
  REVOKED_JWT_TTL_S: 1,
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: '0x1111111111111111111111111111111111111111', addresses: ['0x1111111111111111111111111111111111111111', '0x3333333333333333333333333333333333333333'] };
    next();
  },
}));
vi.mock('../services/agentRunner.js', () => ({
  startRefusal: vi.fn(() => null),
  deployAgent, startAgent: vi.fn(async () => {}),
  pauseAgent: vi.fn(), stopAgent: vi.fn(), resumeAgent: vi.fn(),
  getAgent: vi.fn(), listAgents: vi.fn(), getAgentLogs: vi.fn(),
  subscribeAgentLogs: vi.fn(async () => () => {}), updateAgent: vi.fn(),
  addAuthorizedOwner: vi.fn(), getAgentStats: vi.fn(),
}));
vi.mock('../services/chain.js', () => ({ provider: {}, baseProvider: {} }));
vi.mock('../services/redis.js', () => ({
  redis: { get: vi.fn(), set: vi.fn(), exists: vi.fn(), pipeline: vi.fn(), smembers: vi.fn(async () => []), sadd: vi.fn(), srem: vi.fn(), del: vi.fn() },
}));
vi.mock('../services/reputation.js', () => ({}));
vi.mock('../services/reputationDecay.js', () => ({}));
vi.mock('../services/agentStore.js', () => ({}));
vi.mock('../services/serviceStore.js', () => ({}));
vi.mock('../services/skillStore.js', () => ({ incrementInstallCount: vi.fn(async () => {}), getSkillBySlug: vi.fn(async () => null) }));
vi.mock('../services/agentEmbedding.js', () => ({}));
vi.mock('../services/agentFactoryListener.js', () => ({
  markDeployCreditUsed: vi.fn(async () => undefined), claimDeployCredit, restoreDeployCredit }));
vi.mock('../services/skillComposer.js', () => ({ buildInstalledSkill: vi.fn(), assertComposedSizeOk: vi.fn() }));
vi.mock('../services/deployFee.js', () => ({
  arcDeployFeeTerms: vi.fn(async () => null),
  verifyArcDeployFee: vi.fn(), claimArcDeployFee: vi.fn(), markArcDeployFeeUsed: vi.fn(), releaseArcDeployFee: vi.fn(),
}));

import { agentsRouter } from './agents.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';

const app = express();
app.use(express.json());
app.use('/api/v1/agents', agentsRouter);
app.use(globalErrorHandler);

const deploy = () => request(app).post('/api/v1/agents/deploy').send({
  name: 'A', instructions: 'do useful things for people', provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test',
  capabilities: [], ownerPublicKey: OWNER_PUBLIC_KEY,
});

const creditFrom = (user: string) => ({ user, nonce: '9', usdcAmount: '0', block: 1, txHash: '0xpaid', ts: 0 });

beforeEach(() => {
  claimDeployCredit.mockReset();
  restoreDeployCredit.mockClear();
  deployAgent.mockClear();
});

describe('POST /agents/deploy — a factory credit from any of the caller\'s wallets', () => {
  it('spends a credit paid from a linked wallet', async () => {
    claimDeployCredit.mockImplementation(async (user: string) => (user === LINKED ? creditFrom(LINKED) : null));
    const res = await deploy();
    expect(res.status).toBe(201);
    expect(claimDeployCredit.mock.calls.map((c) => c[0])).toEqual([PRIMARY, LINKED]);
    expect(deployAgent).toHaveBeenCalledTimes(1);
  });

  it('spends the primary wallet\'s credit first, and only one', async () => {
    claimDeployCredit.mockImplementation(async (user: string) => creditFrom(user));
    const res = await deploy();
    expect(res.status).toBe(201);
    expect(claimDeployCredit.mock.calls.map((c) => c[0])).toEqual([PRIMARY]);
  });

  it('gives a linked wallet\'s credit back to that wallet when the deploy fails', async () => {
    claimDeployCredit.mockImplementation(async (user: string) => (user === LINKED ? creditFrom(LINKED) : null));
    deployAgent.mockRejectedValueOnce(new Error('boom'));
    const res = await deploy();
    expect(res.status).toBe(500);
    expect(restoreDeployCredit).toHaveBeenCalledWith(expect.objectContaining({ user: LINKED }));
  });

  it('answers NO_DEPLOY_CREDIT when no wallet has one', async () => {
    claimDeployCredit.mockResolvedValue(null);
    const res = await deploy();
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('NO_DEPLOY_CREDIT');
  });
});
