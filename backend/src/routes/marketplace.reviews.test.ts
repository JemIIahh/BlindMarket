import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';

/**
 * One review per completed task per poster, however the task hash is spelled
 * (security audit run 1, C12). The gate reads the task through a2aStore,
 * whose keys lowercase the id, while agent_reviews was keyed on the raw
 * string, so every re-cased spelling of one hash stored another review and
 * moved the agent's public rating.
 *
 * Runs the REAL route, a2aStore and reviewStore. Redis is an in-memory map
 * and Postgres is an in-memory SQLite table with migration 3's agent_reviews
 * columns and UNIQUE(task_id, reviewer_address), which compares exactly as a
 * default-collation Postgres TEXT column does. reviewStore's own SQL runs on
 * it with $N rebound to positional parameters.
 */

const h = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  db: null as unknown as import('better-sqlite3').Database,
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] };
    next();
  },
  optionalAuth: (req: any, _res: any, next: any) => {
    if (req.headers['x-test-address']) req.user = { address: req.headers['x-test-address'] };
    next();
  },
  requireFounder: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../services/redis.js', () => ({
  redis: { get: vi.fn(async (k: string) => h.kv.get(k) ?? null) },
}));
vi.mock('../services/notificationStore.js', () => ({ notify: vi.fn(async () => null) }));
vi.mock('../services/templateStore.js', () => ({}));
vi.mock('../services/webhookStore.js', () => ({}));
vi.mock('../services/badgeStore.js', () => ({}));
vi.mock('../services/serviceStore.js', () => ({}));
vi.mock('../services/skillStatsStore.js', () => ({}));
vi.mock('../services/neonDb.js', () => ({
  getPool: async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      // $N may repeat (the upsert reuses $4/$5): bind by occurrence.
      const bound: unknown[] = [];
      const text = sql.replace(/\$(\d+)/g, (_m, n: string) => {
        bound.push(params[Number(n) - 1]);
        return '?';
      });
      const stmt = h.db.prepare(text);
      return { rows: stmt.reader ? stmt.all(...bound) : (stmt.run(...bound), []) };
    },
  }),
}));

const { marketplaceRouter } = await import('./marketplace.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');
const { notify } = await import('../services/notificationStore.js');
const reviewStore = await import('../services/reviewStore.js');

const POSTER = '0xa000000000000000000000000000000000000001';
const OTHER = '0xc000000000000000000000000000000000000003';
const AGENT = '0xe5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5';
const TASK = '0x11ae8a3b796fa81b0741c73ab4a1135229556803565d59d4c2b249e82c7e9677';
// A task indexed before a2aStore lowercased its keys, stored under this exact
// spelling only (a2aStore's legacy fallback).
const LEGACY = '0x22Bf8A3b796fa81b0741c73ab4a1135229556803565d59d4c2b249e82c7e9677';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/marketplace', marketplaceRouter);
  a.use(globalErrorHandler);
  return a;
}

function review(taskId: string, rating = 1, caller = POSTER) {
  return request(app())
    .post('/api/v1/marketplace/reviews')
    .set('x-test-address', caller)
    .send({ taskId, agentAddress: AGENT, rating });
}

function seedTask(key: string, poster: string) {
  h.kv.set(`a2a:meta:${key}`, JSON.stringify({ taskId: key, posterAddress: poster }));
  h.kv.set(`a2a:state:${key}`, JSON.stringify({ taskId: key, status: 'verified', executorAddress: AGENT }));
}

const stats = async () => (await request(app()).get(`/api/v1/marketplace/reviews/${AGENT}`)).body.data.stats;

beforeEach(() => {
  vi.clearAllMocks();
  h.kv.clear();
  h.db = new Database(':memory:');
  h.db.exec(`
    CREATE TABLE agent_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      agent_address TEXT NOT NULL,
      reviewer_address TEXT NOT NULL,
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      review TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(task_id, reviewer_address)
    );
  `);
  seedTask(TASK, POSTER);
});

describe('POST /marketplace/reviews: one review per task per poster', () => {
  it('refuses the same hash re-cased or 0X-prefixed with 409, leaving one review', async () => {
    expect((await review(TASK)).status).toBe(200);
    for (const spelling of [
      TASK.toUpperCase().replace('0X', '0x'),
      `0X${TASK.slice(2)}`,
      TASK.toUpperCase(),
      '0x11Ae8A3b796Fa81B0741c73Ab4A1135229556803565d59D4c2B249e82C7e9677',
    ]) {
      const res = await review(spelling);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_REVIEWED');
    }
    expect(await stats()).toMatchObject({ totalReviews: 1, avgRating: 1 });
    expect(h.db.prepare('SELECT task_id FROM agent_reviews').all()).toEqual([{ task_id: TASK }]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('keys a first review sent in upper case on the lowercase id', async () => {
    expect((await review(TASK.toUpperCase().replace('0X', '0x'), 4)).status).toBe(200);
    expect((await review(TASK)).status).toBe(409);
    expect(h.db.prepare('SELECT task_id FROM agent_reviews').all()).toEqual([{ task_id: TASK }]);
    const mine = await request(app())
      .get(`/api/v1/marketplace/reviews/task/${TASK.toUpperCase().replace('0X', '0x')}`)
      .set('x-test-address', POSTER);
    expect(mine.body.data.review).toMatchObject({ task_id: TASK, rating: 4 });
  });

  it('refuses a task id that is not a bytes32 hash with 400', async () => {
    for (const bad of [`${TASK} `, TASK.slice(0, 65), 'task-1', `${TASK}00`]) {
      const res = await review(bad);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await stats()).toMatchObject({ totalReviews: 0 });
  });

  it('still reviews a task stored under a legacy mixed-case key, exactly once', async () => {
    seedTask(LEGACY, POSTER);
    expect((await review(LEGACY, 5)).status).toBe(200);
    expect((await review(LEGACY, 5)).status).toBe(409);
    expect((await review(LEGACY.toLowerCase(), 5)).status).not.toBe(200);
    expect(h.db.prepare('SELECT task_id FROM agent_reviews').all()).toEqual([{ task_id: LEGACY.toLowerCase() }]);
  });

  it("counts each poster's review of each task once in the agent's stats", async () => {
    seedTask('0x' + '33'.repeat(32), OTHER);
    expect((await review('0x' + '33'.repeat(32), 5, OTHER)).status).toBe(200);
    expect((await review(TASK, 1)).status).toBe(200);
    await review(TASK.toUpperCase().replace('0X', '0x'), 1);
    await review(`0X${TASK.slice(2)}`, 1);
    expect(await stats()).toMatchObject({ totalReviews: 2, avgRating: 3 });
  });
});

describe('reviewStore keys task ids lowercase (defence in depth)', () => {
  it('finds and updates one row whatever the spelling it is called with', async () => {
    const first = await reviewStore.submitReview({ taskId: TASK.toUpperCase().replace('0X', '0x'), agentAddress: AGENT, reviewerAddress: POSTER, rating: 2 });
    const again = await reviewStore.submitReview({ taskId: TASK, agentAddress: AGENT, reviewerAddress: POSTER, rating: 3 });
    expect(again.id).toBe(first.id);
    expect(await reviewStore.getReviewForTask(`0X${TASK.slice(2)}`, POSTER)).toMatchObject({ id: first.id, task_id: TASK, rating: 3 });
  });
});
