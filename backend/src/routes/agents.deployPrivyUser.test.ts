import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * A deploy records the Privy user who made it (req.user.privyUserId, the
 * access token's `sub`) on the agent, for per-person limits later: one person
 * can link several wallets, so the owner address does not name them. Taken
 * from the verified token only, never from the request body.
 */

const PRIMARY = '0x1111111111111111111111111111111111111111';
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
  // A Privy session when the test names a user id, else an API-key principal.
  requireAuth: (req: any, _res: any, next: any) => {
    const privyUserId = req.headers['x-test-privy-user'];
    req.user = { address: '0x1111111111111111111111111111111111111111', ...(privyUserId ? { privyUserId } : {}) };
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

const deploy = (privyUser?: string, extra: Record<string, unknown> = {}) => {
  const r = request(app).post('/api/v1/agents/deploy');
  if (privyUser) r.set('x-test-privy-user', privyUser);
  return r.send({
    name: 'A', instructions: 'do useful things for people', provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test',
    capabilities: [], ownerPublicKey: OWNER_PUBLIC_KEY, ...extra,
  });
};

beforeEach(() => {
  claimDeployCredit.mockReset();
  claimDeployCredit.mockImplementation(async (user: string) => ({ user, nonce: '9', usdcAmount: '0', block: 1, txHash: '0xpaid', ts: 0 }));
  deployAgent.mockClear();
});

describe('POST /agents/deploy — the deploying Privy user', () => {
  it('is stored on the agent', async () => {
    const res = await deploy('did:privy:cm0abc123');
    expect(res.status).toBe(201);
    expect(deployAgent).toHaveBeenCalledWith(expect.objectContaining({ ownerAddress: PRIMARY, privyUserId: 'did:privy:cm0abc123' }));
  });

  it('is absent for a caller who did not sign in through Privy', async () => {
    const res = await deploy();
    expect(res.status).toBe(201);
    expect((deployAgent.mock.calls[0] as unknown[])[0]).toMatchObject({ privyUserId: undefined });
  });

  it('is never taken from the request body', async () => {
    await deploy(undefined, { privyUserId: 'did:privy:someone-else' });
    expect((deployAgent.mock.calls[0] as unknown[])[0]).toMatchObject({ privyUserId: undefined });
    deployAgent.mockClear();
    await deploy('did:privy:cm0abc123', { privyUserId: 'did:privy:someone-else' });
    expect((deployAgent.mock.calls[0] as unknown[])[0]).toMatchObject({ privyUserId: 'did:privy:cm0abc123' });
  });
});
