import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * A deployed agent must actually run.
 *
 * deployAgent() persists status 'stopped' (agentRunner.ts:235) and nothing
 * moved it to 'running': the UI shows "deployment initiated" and returns,
 * reconcileAgents() on boot only re-forks agents already marked 'running', and
 * every other path into that status — the crash-loop cap, the zombie reaper, a
 * non-zero exit — is one-way. So every agent ever deployed was born switched
 * off, after its owner had paid the deploy fee. Production shows 0 of 20
 * running, and open tasks expired with nobody to take them.
 *
 * The start is best-effort: the fee is already spent, so a refusal
 * (MAX_CONCURRENT_AGENTS is the expected one) must not fail the deploy.
 */

const OWNER = '0x2222222222222222222222222222222222222222';
// A real secp256k1 point (private key 0x11…11): the deploy encrypts the agent's key to it.
const OWNER_PUBLIC_KEY = '044f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa385b6b1b8ead809ca67454d9683fcf2ba03456d6fe2c4abe2b07f0fbdbb2f1c1';
const AGENT_ID = 'agent-new';

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
vi.mock('../services/skillStore.js', () => ({ incrementInstallCount: vi.fn(async () => {}) }));
vi.mock('../services/agentEmbedding.js', () => ({}));
// The deploy paywall — a real credit comes from an on-chain AgentFactory
// payment. Grant one so the test exercises the start, not the USDC gate.
vi.mock('../services/agentFactoryListener.js', () => ({
  claimDeployCredit: vi.fn(async () => ({ user: '0x2222222222222222222222222222222222222222', nonce: 1 })),
  restoreDeployCredit: vi.fn(async () => {}),
}));
vi.mock('../services/skillComposer.js', () => ({
  buildInstalledSkill: vi.fn(), assertComposedSizeOk: vi.fn(),
}));

import { agentsRouter } from './agents.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';

const app = express();
app.use(express.json());
app.use('/api/v1/agents', agentsRouter);
app.use(globalErrorHandler);

const deployBody = {
  name: 'A', instructions: 'do useful things for people',
  provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test',
  ownerAddress: OWNER, capabilities: [],
  // uncompressed secp256k1 point — the deploy schema ECIES-wraps the agent key to it
  ownerPublicKey: OWNER_PUBLIC_KEY,
};

const deploy = () =>
  request(app).post('/api/v1/agents/deploy').set('X-API-Key', 'sk_owner').send(deployBody);

beforeEach(() => { startAgent.mockClear(); startAgent.mockResolvedValue(undefined as never); });

describe('POST /agents/deploy — a deployed agent actually runs', () => {
  it('starts the agent it just created', async () => {
    const res = await deploy();
    expect(res.status).toBe(201);
    expect(startAgent).toHaveBeenCalledWith(AGENT_ID);
    expect(res.body.data.started).toBe(true);
  });

  it('still succeeds when the start is refused — the fee is already spent', async () => {
    startAgent.mockImplementation(async () => {
      throw new Error('MAX_CONCURRENT_AGENTS reached');
    });
    const res = await deploy();
    expect(res.status).toBe(201);
    expect(res.body.data.started).toBe(false);
    expect(res.body.data.id).toBe(AGENT_ID);
  });

  it('never leaks the agent private key in the deploy response', async () => {
    const res = await deploy();
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
  });
});
