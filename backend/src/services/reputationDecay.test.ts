import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ethers } from 'ethers';

/**
 * reputationDecay keys every row by the lowercase address (security audit
 * run 1, C31). Settlement hands it the EIP-55 principal of hosted workers
 * (their platform JWT) and of chain reads, while scoreAgent reads the
 * lowercase agent_executors key; keyed on the caller's casing, a hosted
 * agent's disputes and decayed score never reached the ranker.
 *
 * reputationDecay's own SQL runs on an in-memory SQLite copy of the tables
 * (TEXT PRIMARY KEY compares exactly, as a default-collation Postgres TEXT
 * key does), with $N rebound to positional parameters.
 */

const h = vi.hoisted(() => ({ db: null as unknown as import('better-sqlite3').Database }));

vi.mock('./neonDb.js', () => ({
  getPool: async () => ({
    query: async (sql: string, params: unknown[] = []) => {
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
vi.mock('./agentStore.js', () => ({ listAgents: vi.fn() }));
vi.mock('./badgeStore.js', () => ({ getAgentBadges: vi.fn(async () => []) }));
vi.mock('./reviewStore.js', () => ({ getAgentReviews: vi.fn(async () => ({ stats: { avgRating: 0, totalReviews: 0 } })) }));
vi.mock('./a2aStore.js', () => ({ getExecutorTasks: vi.fn(async () => []) }));

const reputationDecay = await import('./reputationDecay.js');
const { scoreAgent } = await import('./agentScorer.js');

// A hosted worker's platform-JWT address is new Wallet(key).address: EIP-55.
const LOWER = '0xa7394cf8ddfbd00fb1d68bcce7a7eddde704706b';
const CHECKSUMMED = ethers.getAddress(LOWER);

beforeEach(() => {
  h.db = new Database(':memory:');
  // Postgres migration 1's columns (database.ts migration 2 is the SQLite twin).
  h.db.exec(`
    CREATE TABLE reputation_history (
      address TEXT PRIMARY KEY,
      raw_score REAL NOT NULL DEFAULT 0,
      tasks_completed INTEGER NOT NULL DEFAULT 0,
      disputes INTEGER NOT NULL DEFAULT 0,
      last_task_at TEXT
    );
    CREATE TABLE reputation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      score_delta REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
});

describe('reputationDecay keys addresses lowercase', () => {
  it('keeps one row per executor whatever casing settlement passes, readable by either', async () => {
    expect(CHECKSUMMED).not.toBe(LOWER);
    await reputationDecay.recordTaskCompletion(CHECKSUMMED, '0xt1', 10);
    await reputationDecay.recordDispute(CHECKSUMMED, '0xt2');
    await reputationDecay.recordDispute(LOWER, '0xt3');
    await reputationDecay.recordTaskCompletion(LOWER, '0xt4', 10);

    expect(h.db.prepare('SELECT address, raw_score, tasks_completed, disputes FROM reputation_history').all()).toEqual([
      { address: LOWER, raw_score: 20, tasks_completed: 2, disputes: 2 },
    ]);
    for (const addr of [LOWER, CHECKSUMMED]) {
      expect(await reputationDecay.getDecayedReputation(addr)).toMatchObject({ address: LOWER, rawScore: 20, tasksCompleted: 2, disputes: 2 });
      expect((await reputationDecay.getReputationHistory(addr)).map((e) => e.task_id).sort()).toEqual(['0xt1', '0xt2', '0xt3', '0xt4']);
    }
  });

  it("feeds a hosted agent's settlement record to the ranker, which reads the lowercase agent key", async () => {
    // 1 pass and 3 failed rounds, all recorded under the EIP-55 principal.
    await reputationDecay.recordTaskCompletion(CHECKSUMMED, '0xt1', 10);
    for (const t of ['0xt2', '0xt3', '0xt4']) await reputationDecay.recordDispute(CHECKSUMMED, t);

    const scored = await scoreAgent(
      { address: LOWER, displayName: 'hosted', capabilities: ['code_review'] as never, reputation: 21, tasksCompleted: 1, registeredAt: '' },
      ['code_review'] as never,
    );
    expect(scored.breakdown.reputationScore).toBeCloseTo(0.2, 2);
    // disputes / (tasks + disputes + 1) × 2 = 3/5 × 2
    expect(scored.breakdown.disputePenalty).toBeCloseTo(1.2, 5);
  });
});
