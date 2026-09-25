import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * My Agents lists agents with GET /agents?owner=. A user's agents can be
 * owned by any of their linked wallets: on 2026-09-23 a user deployed from
 * the web app, the backend recorded their external wallet as the owner (the
 * session's address on Arc), and the page, which asks by the embedded
 * wallet, showed "No agents deployed" for a running agent. `owner` now takes
 * several wallets, comma-separated; one wallet behaves as before.
 */

const EMBEDDED = '0x1111111111111111111111111111111111111111';
const EXTERNAL = '0xBb8021Dc9a063F4F2525f532fAA3FE1907599026';
const STRANGER = '0x9999999999999999999999999999999999999999';

const agents = vi.hoisted(() => [
  { id: 'a-ext', name: 'ext', ownerAddress: '0xBb8021Dc9a063F4F2525f532fAA3FE1907599026', walletAddress: '0x4444444444444444444444444444444444444444', status: 'running' },
  { id: 'a-emb', name: 'emb', ownerAddress: '0x1111111111111111111111111111111111111111', walletAddress: '0x5555555555555555555555555555555555555555', status: 'stopped' },
  { id: 'a-other', name: 'other', ownerAddress: '0x9999999999999999999999999999999999999999', walletAddress: '0x6666666666666666666666666666666666666666', status: 'running' },
]);

vi.mock('../services/agentRunner.js', () => ({
  deployAgent: vi.fn(), startAgent: vi.fn(), pauseAgent: vi.fn(), stopAgent: vi.fn(), resumeAgent: vi.fn(), getAgent: vi.fn(),
  listAgents: vi.fn(async (owner?: string) => (owner ? agents.filter((a) => a.ownerAddress.toLowerCase() === owner.toLowerCase()) : agents)),
  getAgentLogs: vi.fn(), subscribeAgentLogs: vi.fn(async () => () => {}), updateAgent: vi.fn(), addAuthorizedOwner: vi.fn(), getAgentStats: vi.fn(),
}));
vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn(async () => undefined) }));
vi.mock('../services/reputation.js', () => ({ getReputationWithScore: vi.fn(async () => null) }));
vi.mock('../services/reputationDecay.js', () => ({ getDecayedReputation: vi.fn(async () => ({ rawScore: 0 })) }));
vi.mock('../services/apiKeyStore.js', () => ({ lookupApiKey: vi.fn(async () => null) }));
vi.mock('../services/chain.js', () => ({ provider: {}, baseProvider: {} }));
vi.mock('../services/redis.js', () => ({ redis: { get: vi.fn(), set: vi.fn(), exists: vi.fn(), pipeline: vi.fn() } }));
vi.mock('../services/serviceStore.js', () => ({}));
vi.mock('../services/skillStore.js', () => ({ incrementInstallCount: vi.fn(), getSkillBySlug: vi.fn(async () => null) }));
vi.mock('../services/agentEmbedding.js', () => ({ recomputeForWalletBestEffort: vi.fn() }));
vi.mock('../services/agentFactoryListener.js', () => ({
  markDeployCreditUsed: vi.fn(async () => undefined), claimDeployCredit: vi.fn(), restoreDeployCredit: vi.fn() }));
vi.mock('../services/skillComposer.js', () => ({ buildInstalledSkill: vi.fn(), assertComposedSizeOk: vi.fn() }));

const { agentsRouter } = await import('./agents.js');
const app = express();
app.use('/api/v1/agents', agentsRouter);

const ids = (res: request.Response) => (res.body.data as Array<{ id: string }>).map((a) => a.id).sort();

describe('GET /agents?owner=', () => {
  it("lists the agents of every wallet named, whatever the letter case", async () => {
    const res = await request(app).get(`/api/v1/agents?owner=${EMBEDDED},${EXTERNAL.toLowerCase()}`);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(['a-emb', 'a-ext']);
    expect(res.body.total).toBe(2);
  });

  it('one wallet behaves as before', async () => {
    const res = await request(app).get(`/api/v1/agents?owner=${EXTERNAL}`);
    expect(ids(res)).toEqual(['a-ext']);
  });

  it('ignores entries that are not addresses, and never lists everyone for them', async () => {
    const res = await request(app).get(`/api/v1/agents?owner=${EMBEDDED},,not-an-address`);
    expect(ids(res)).toEqual(['a-emb']);
    const none = await request(app).get('/api/v1/agents?owner=,');
    expect(ids(none)).toEqual([]);
    expect(ids(await request(app).get(`/api/v1/agents?owner=${STRANGER},`))).toEqual(['a-other']);
  });
});
