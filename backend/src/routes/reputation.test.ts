import { describe, it, expect, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { reputationRouter } from './reputation.js';

// ── Mock on-chain reputation ─────────────────────────────────────────────────

const mockGetReputationWithScore = vi.fn();
const mockGetDecayedReputation = vi.fn();
const mockGetLeaderboard = vi.fn();
const mockGetReputationHistory = vi.fn();

vi.mock('../services/reputation.js', () => ({
  getReputationWithScore: (...args: any[]) => mockGetReputationWithScore(...args),
}));

vi.mock('../services/reputationDecay.js', () => ({
  getDecayedReputation: (...args: any[]) => mockGetDecayedReputation(...args),
  getLeaderboard: (...args: any[]) => mockGetLeaderboard(...args),
  getReputationHistory: (...args: any[]) => mockGetReputationHistory(...args),
}));

// Minimal AppError-shaped handler so route-issued AppErrors are caught
function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err?.name === 'AppError') {
    res.status(err.status || 400).json({ success: false, error: { code: err.code, message: err.message } });
  } else {
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err?.message } });
  }
}

const app = express();
app.use(express.json());
app.use('/api/v1/reputation', reputationRouter);
app.use(errorHandler);

const ADDR = '0x1234567890abcdef1234567890abcdef12345678';

describe('GET /api/v1/reputation/:address', () => {
  it('returns merged reputation with off-chain only data', async () => {
    mockGetReputationWithScore.mockRejectedValueOnce(new Error('no on-chain'));
    mockGetDecayedReputation.mockResolvedValueOnce({
      address: ADDR,
      rawScore: 50,
      decayedScore: 45.5,
      decayFactor: 0.91,
      daysSinceLastTask: 0.5,
      tasksCompleted: 5,
      disputes: 0,
    });

    const res = await request(app).get(`/api/v1/reputation/${ADDR}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      address: ADDR.toLowerCase(),
      tasksCompleted: 5,
      disputes: 0,
      onChainScore: 0,
      rawScore: 50,
      decayedScore: 45.5,
      decayFactor: 0.91,
      offChainTasksCompleted: 5,
      offChainDisputes: 0,
    });
  });

  it('returns merged reputation with on-chain + off-chain data', async () => {
    mockGetReputationWithScore.mockResolvedValueOnce({
      address: ADDR,
      tasksCompleted: 10,
      avgScore: 4.2,
      disputes: 1,
      disputeRatio: 10,
      score: 76,
    });
    mockGetDecayedReputation.mockResolvedValueOnce({
      address: ADDR,
      rawScore: 100,
      decayedScore: 92.3,
      decayFactor: 0.923,
      daysSinceLastTask: 1.2,
      tasksCompleted: 8,
      disputes: 1,
    });

    const res = await request(app).get(`/api/v1/reputation/${ADDR}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      address: ADDR.toLowerCase(),
      tasksCompleted: 10,
      avgScore: 4.2,
      disputes: 1,
      onChainScore: 76,
      rawScore: 100,
      decayedScore: 92.3,
      decayFactor: 0.923,
      offChainTasksCompleted: 8,
      offChainDisputes: 1,
    });
  });

  it('returns empty reputation for unknown address', async () => {
    mockGetReputationWithScore.mockRejectedValueOnce(new Error('no on-chain'));
    mockGetDecayedReputation.mockResolvedValueOnce({
      address: ADDR,
      rawScore: 0,
      decayedScore: 0,
      decayFactor: 1,
      daysSinceLastTask: null,
      tasksCompleted: 0,
      disputes: 0,
    });

    const res = await request(app).get(`/api/v1/reputation/${ADDR}`);

    expect(res.status).toBe(200);
    expect(res.body.data.rawScore).toBe(0);
    expect(res.body.data.decayedScore).toBe(0);
    expect(res.body.data.tasksCompleted).toBe(0);
  });

  it('rejects invalid address', async () => {
    const res = await request(app).get('/api/v1/reputation/not-an-address');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_ADDRESS');
  });
});

describe('GET /api/v1/reputation/leaderboard', () => {
  it('returns leaderboard sorted by decayed score', async () => {
    mockGetLeaderboard.mockResolvedValueOnce([
      { address: '0xa', rawScore: 100, decayedScore: 95.0, decayFactor: 0.95, daysSinceLastTask: 0.5, tasksCompleted: 10, disputes: 0 },
      { address: '0xb', rawScore: 80, decayedScore: 70.4, decayFactor: 0.88, daysSinceLastTask: 2.1, tasksCompleted: 8, disputes: 1 },
    ]);

    const res = await request(app).get('/api/v1/reputation/leaderboard?limit=10');

    expect(res.status).toBe(200);
    expect(res.body.data.leaderboard).toHaveLength(2);
    expect(res.body.data.leaderboard[0].address).toBe('0xa');
    expect(res.body.data.leaderboard[1].address).toBe('0xb');
  });
});

describe('GET /api/v1/reputation/:address/history', () => {
  it('returns event timeline', async () => {
    mockGetReputationHistory.mockResolvedValueOnce([
      { id: 1, address: ADDR, task_id: '0xtask1', event_type: 'task_completed', score_delta: 10, created_at: new Date().toISOString() },
    ]);

    const res = await request(app).get(`/api/v1/reputation/${ADDR}/history`);

    expect(res.status).toBe(200);
    expect(res.body.data.history).toHaveLength(1);
    expect(res.body.data.history[0].event_type).toBe('task_completed');
  });
});
