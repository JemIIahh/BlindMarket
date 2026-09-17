import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentExecutor } from '../types.js';

/**
 * Every worker calls POST /a2a/register when it boots, and that route builds
 * the record without totalEarnedRaw. registerAgent's upsert used to write the
 * counters on conflict too, so each restart reset an agent's earnings to 0
 * while its task count stayed ("3 tasks · 0"). Runs against a real in-memory
 * SQLite table with the production schema.
 */

const { db } = vi.hoisted(() => ({ db: { current: null as unknown as Database.Database } }));

vi.mock('../config.js', () => ({ config: { databaseUrl: '' } }));
vi.mock('./database.js', () => ({ getDb: () => db.current }));
vi.mock('./neonDb.js', () => ({ getPool: vi.fn() }));

const { registerAgent, updateAgentStats, getAgent } = await import('./agentStore.js');

const ADDR = '0xAbCd000000000000000000000000000000000001';

// The fields POST /a2a/register sends on every boot: no totalEarnedRaw.
function bootRegistration(overrides: Partial<AgentExecutor> = {}): AgentExecutor {
  return {
    address: ADDR,
    displayName: 'worker',
    capabilities: ['data_processing'],
    publicKey: '04aa',
    reputation: 50,
    tasksCompleted: 0,
    registeredAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  db.current = new Database(':memory:');
  db.current.exec(`
    CREATE TABLE agent_executors (
      address TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      capabilities TEXT DEFAULT '[]',
      public_key TEXT NOT NULL DEFAULT '',
      agent_card_url TEXT,
      mcp_endpoint_url TEXT,
      min_reward TEXT,
      preferred_capabilities TEXT,
      reputation INTEGER NOT NULL DEFAULT 50,
      tasks_completed INTEGER NOT NULL DEFAULT 0,
      total_earned_raw TEXT NOT NULL DEFAULT '0',
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
});

describe('registerAgent', () => {
  it('keeps earnings, task count and reputation when a worker re-registers', async () => {
    await registerAgent(bootRegistration());
    expect(await updateAgentStats(ADDR, { reputation: 53, tasksCompleted: 3, totalEarnedRaw: '2700000' })).toBe(true);

    // The route passes the stored task count and reputation but never earnings.
    await registerAgent(bootRegistration({ reputation: 53, tasksCompleted: 3 }));

    expect(await getAgent(ADDR)).toMatchObject({ reputation: 53, tasksCompleted: 3, totalEarnedRaw: '2700000' });
  });

  it('keeps the counters even when the caller sends stale ones', async () => {
    await registerAgent(bootRegistration());
    await updateAgentStats(ADDR, { reputation: 60, tasksCompleted: 7, totalEarnedRaw: '9' });
    await registerAgent(bootRegistration({ reputation: 50, tasksCompleted: 0, totalEarnedRaw: '0' }));
    expect(await getAgent(ADDR)).toMatchObject({ reputation: 60, tasksCompleted: 7, totalEarnedRaw: '9' });
  });

  it('still updates the profile on re-register', async () => {
    await registerAgent(bootRegistration());
    await registerAgent(bootRegistration({ displayName: 'renamed', publicKey: '04bb', minReward: '5' }));
    expect(await getAgent(ADDR)).toMatchObject({ displayName: 'renamed', publicKey: '04bb', minReward: '5' });
  });

  it('writes the given counters on first insert', async () => {
    await registerAgent(bootRegistration({ reputation: 50, tasksCompleted: 0 }));
    expect(await getAgent(ADDR)).toMatchObject({ address: ADDR.toLowerCase(), reputation: 50, tasksCompleted: 0, totalEarnedRaw: '0' });
  });
});

describe('updateAgentStats', () => {
  it('writes only the counters', async () => {
    await registerAgent(bootRegistration({ displayName: 'keep-me' }));
    await updateAgentStats(ADDR.toLowerCase(), { reputation: 51, tasksCompleted: 1, totalEarnedRaw: '900000' });
    expect(await getAgent(ADDR)).toMatchObject({ displayName: 'keep-me', reputation: 51, tasksCompleted: 1, totalEarnedRaw: '900000' });
  });

  it('reports false for an executor that does not exist, and creates nothing', async () => {
    expect(await updateAgentStats(ADDR, { reputation: 51, tasksCompleted: 1, totalEarnedRaw: '1' })).toBe(false);
    expect(await getAgent(ADDR)).toBeUndefined();
  });
});
