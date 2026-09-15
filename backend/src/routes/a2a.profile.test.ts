import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /api/v1/a2a/profile — two contracts on one route:
 * - default: an unregistered wallet gets 404 NOT_REGISTERED (the published
 *   SDK's getProfile calls this and may rely on it);
 * - `?optional=1`: the web app gets 200 { agent: null } instead, so a
 *   poster's browser console isn't full of red 404s.
 */

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || '0xposter' };
    next();
  },
}));

vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn() }));
vi.mock('../services/reputation.js', () => ({
  getReputationWithScore: vi.fn(async (address: string) => ({ address, tasksCompleted: 3, avgScore: 90, disputes: 0, disputeRatio: 0, score: 90 })),
}));
vi.mock('../services/reputationDecay.js', () => ({
  getDecayedReputation: vi.fn(async (address: string) => ({ address, rawScore: 90, decayedScore: 88, decayFactor: 0.98, daysSinceLastTask: 2, tasksCompleted: 3, disputes: 0 })),
}));

// Import-side-effect-heavy modules — same stubs as the other a2a route tests.
vi.mock('../services/a2aStore.js', () => ({}));
vi.mock('../services/keyCustodyService.js', () => ({ getKeyCustodyService: vi.fn(() => null), isKeyCustodyEnabled: vi.fn(() => false) }));
vi.mock('../services/a2aSettlement.js', () => ({ settleAssignment: vi.fn(), settleVerification: vi.fn() }));
vi.mock('../services/redis.js', () => ({ redis: { set: vi.fn(), get: vi.fn(), exists: vi.fn(), pipeline: vi.fn() } }));
vi.mock('../services/chain.js', () => ({ provider: {}, escrow: { interface: {}, getAddress: vi.fn() } }));
vi.mock('../services/escrow.js', () => ({ getTask: vi.fn(), feeBps: vi.fn(), getTaskVerifier: vi.fn() }));
vi.mock('../services/escrowEvents.js', () => ({ getTaskIdByHash: vi.fn(), getCachedTaskIdByHash: vi.fn(() => Promise.resolve(null)) }));
vi.mock('../services/autoVerify.js', () => ({ autoVerify: vi.fn() }));
vi.mock('../services/accountingService.js', () => ({}));
vi.mock('../services/bidsStore.js', () => ({}));
vi.mock('../services/taskChain.js', () => ({ resolveTaskByHash: vi.fn(), resolveTaskChainById: vi.fn() }));

import { a2aRouter } from './a2a.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as agentStore from '../services/agentStore.js';

const app = express();
app.use(express.json());
app.use('/api/v1/a2a', a2aRouter);
app.use(globalErrorHandler);

beforeEach(() => {
  vi.mocked(agentStore.getAgent).mockReset();
});

describe('GET /api/v1/a2a/profile', () => {
  it('keeps the 404 NOT_REGISTERED contract for an unregistered wallet by default (SDK)', async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(null as any);
    const res = await request(app).get('/api/v1/a2a/profile');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_REGISTERED');
  });

  it('answers 200 { agent: null } for an unregistered wallet with ?optional=1 (web app)', async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(null as any);
    const res = await request(app).get('/api/v1/a2a/profile?optional=1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { agent: null } });
  });

  it('returns the full profile for a registered wallet either way', async () => {
    const agent = { address: '0xexec', capabilities: ['web_research'] };
    vi.mocked(agentStore.getAgent).mockResolvedValue(agent as any);
    for (const path of ['/api/v1/a2a/profile', '/api/v1/a2a/profile?optional=1']) {
      const res = await request(app).get(path).set('x-test-address', '0xexec');
      expect(res.status).toBe(200);
      expect(res.body.data.agent).toEqual(agent);
      expect(res.body.data.reputation.score).toBe(90);
      expect(res.body.data.decayedReputation.decayedScore).toBe(88);
    }
  });
});
