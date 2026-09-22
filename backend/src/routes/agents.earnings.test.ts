import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * An agent's earnings come back per currency. They used to be one total that
 * mixed 18-decimal 0G with 6-decimal USDC and was formatted with whichever
 * decimals the deployment settles in, so on a Base deployment every 0G
 * payout showed up 10^12 times too large.
 */

const { cfg, executor } = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  executor: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock('../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../config.js')>();
  Object.assign(cfg, mod.config);
  return { ...mod, config: cfg };
});
vi.mock('../services/agentRunner.js', () => ({
  deployAgent: vi.fn(), startAgent: vi.fn(), pauseAgent: vi.fn(), stopAgent: vi.fn(), resumeAgent: vi.fn(),
  getAgent: vi.fn(async () => ({ id: 'agent-1', name: 'a', walletAddress: '0x4444444444444444444444444444444444444444', status: 'stopped' })),
  listAgents: vi.fn(async () => []), getAgentLogs: vi.fn(), subscribeAgentLogs: vi.fn(async () => () => {}),
  updateAgent: vi.fn(), addAuthorizedOwner: vi.fn(), getAgentStats: vi.fn(),
}));
vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn(async () => executor.current) }));
vi.mock('../services/reputation.js', () => ({ getReputationWithScore: vi.fn(async () => null) }));
vi.mock('../services/reputationDecay.js', () => ({ getDecayedReputation: vi.fn(async () => ({ rawScore: 0 })) }));
vi.mock('../services/apiKeyStore.js', () => ({ lookupApiKey: vi.fn(async () => null) }));
vi.mock('../services/chain.js', () => ({ provider: {}, baseProvider: {} }));
vi.mock('../services/redis.js', () => ({ redis: { get: vi.fn(), set: vi.fn(), exists: vi.fn(), pipeline: vi.fn() } }));
vi.mock('../services/serviceStore.js', () => ({}));
vi.mock('../services/skillStore.js', () => ({ incrementInstallCount: vi.fn(), getSkillBySlug: vi.fn(async () => null) }));
vi.mock('../services/agentEmbedding.js', () => ({ recomputeForWalletBestEffort: vi.fn() }));
vi.mock('../services/agentFactoryListener.js', () => ({ claimDeployCredit: vi.fn(), restoreDeployCredit: vi.fn() }));
vi.mock('../services/skillComposer.js', () => ({ buildInstalledSkill: vi.fn(), assertComposedSizeOk: vi.fn() }));

const { agentsRouter, formatUnitsDecimal } = await import('./agents.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use('/api/v1/agents', agentsRouter);
app.use(globalErrorHandler);

beforeEach(() => {
  cfg.baseEscrowAddress = '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf';
  executor.current = { tasksCompleted: 4, totalEarnedRaw: '3000000000000000000', totalEarnedUsdcRaw: '5400000' };
});

describe('GET /agents/:id earnings', () => {
  it('returns each currency separately, and totalEarned in the currency services are priced in', async () => {
    const res = await request(app).get('/api/v1/agents/agent-1');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      tasksCompleted: 4,
      totalEarnedUsdc: '5.400000',
      totalEarnedNative: '3.000000',
      totalEarned: '5.400000',
    });
  });

  it('reports zeros for an agent that has never registered as an executor', async () => {
    executor.current = undefined;
    const res = await request(app).get('/api/v1/agents/agent-1');
    expect(res.body.data).toMatchObject({ tasksCompleted: 0, totalEarned: '0.000000', totalEarnedUsdc: '0.000000', totalEarnedNative: '0.000000' });
  });
});

describe('formatUnitsDecimal', () => {
  it.each([
    ['0', 6, '0.000000'],
    ['1', 6, '0.000001'],
    ['1234567', 6, '1.234567'],
    ['1500000000000000000', 18, '1.500000'],
    ['123', 18, '0.000000'],
    ['', 6, '0.000000'],
  ])('formats %s with %i decimals as %s', (raw, decimals, expected) => {
    expect(formatUnitsDecimal(raw, decimals)).toBe(expected);
  });
});
