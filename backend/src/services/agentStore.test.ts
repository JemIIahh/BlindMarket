import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentExecutor } from '../types.js';

/**
 * Every worker calls POST /a2a/register when it boots, and that route builds
 * the record without earnings. registerAgent's upsert used to write the
 * counters on conflict too, so each restart reset an agent's earnings to 0
 * while its task count stayed ("3 tasks · 0"). Counters now change only
 * through creditPayout / adjustReputation, which also keep native 0G and
 * USDC earnings in separate totals. Runs against a real in-memory SQLite
 * table with the production schema.
 */

const { db, cfg, pool } = vi.hoisted(() => ({
  db: { current: null as unknown as Database.Database },
  cfg: { databaseUrl: '' },
  pool: { query: vi.fn() },
}));

vi.mock('../config.js', () => ({ config: cfg }));
vi.mock('./database.js', () => ({ getDb: () => db.current }));
vi.mock('./neonDb.js', () => ({ getPool: async () => pool }));

const { registerAgent, creditPayout, adjustReputation, getAgent } = await import('./agentStore.js');

const ADDR = '0xAbCd000000000000000000000000000000000001';
const ONE_0G = 10n ** 18n;
const USDC = { symbol: 'USDC', decimals: 6 } as const;
const NATIVE_0G = { symbol: '0G', decimals: 18 } as const;

// The fields POST /a2a/register sends on every boot: no earnings.
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
  // database.ts migrations 10 and 14.
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
    ALTER TABLE agent_executors ADD COLUMN total_earned_usdc_raw TEXT NOT NULL DEFAULT '0';
  `);
});

describe('registerAgent', () => {
  it('keeps earnings, task count and reputation when a worker re-registers', async () => {
    await registerAgent(bootRegistration());
    await creditPayout(ADDR, NATIVE_0G, 2n * ONE_0G);
    await creditPayout(ADDR, USDC, 900_000n);

    await registerAgent(bootRegistration());

    expect(await getAgent(ADDR)).toMatchObject({
      reputation: 52, tasksCompleted: 2, totalEarnedRaw: (2n * ONE_0G).toString(), totalEarnedUsdcRaw: '900000',
    });
  });

  it('still updates the profile on re-register', async () => {
    await registerAgent(bootRegistration());
    await registerAgent(bootRegistration({ displayName: 'renamed', publicKey: '04bb', minReward: '5' }));
    expect(await getAgent(ADDR)).toMatchObject({ displayName: 'renamed', publicKey: '04bb', minReward: '5' });
  });

  it('starts a new executor at 50 reputation with nothing earned', async () => {
    await registerAgent(bootRegistration());
    expect(await getAgent(ADDR)).toMatchObject({
      address: ADDR.toLowerCase(), reputation: 50, tasksCompleted: 0, totalEarnedRaw: '0', totalEarnedUsdcRaw: '0',
    });
  });
});

describe('creditPayout', () => {
  it('adds each currency to its own total and never mixes them', async () => {
    await registerAgent(bootRegistration({ displayName: 'keep-me' }));
    expect(await creditPayout(ADDR.toLowerCase(), USDC, 4_500_000n)).toBe(true);
    expect(await creditPayout(ADDR, USDC, 900_000n)).toBe(true);
    expect(await creditPayout(ADDR, NATIVE_0G, 3n * ONE_0G)).toBe(true);
    expect(await getAgent(ADDR)).toMatchObject({
      displayName: 'keep-me',
      tasksCompleted: 3,
      reputation: 53,
      totalEarnedUsdcRaw: '5400000',
      totalEarnedRaw: (3n * ONE_0G).toString(),
    });
  });

  it('keeps 18-decimal totals exact beyond 64-bit integers', async () => {
    await registerAgent(bootRegistration());
    await creditPayout(ADDR, NATIVE_0G, 9n * ONE_0G);
    await creditPayout(ADDR, NATIVE_0G, 9n * ONE_0G);
    expect((await getAgent(ADDR))?.totalEarnedRaw).toBe((18n * ONE_0G).toString());
  });

  it('caps reputation at 100', async () => {
    await registerAgent(bootRegistration({ reputation: 100 }));
    await creditPayout(ADDR, USDC, 1n);
    expect((await getAgent(ADDR))?.reputation).toBe(100);
  });

  it('reports false for an executor that does not exist, and creates nothing', async () => {
    expect(await creditPayout(ADDR, USDC, 1n)).toBe(false);
    expect(await getAgent(ADDR)).toBeUndefined();
  });

  it('refuses a unit whose scale does not match its total (native 18-decimal USDC)', async () => {
    await registerAgent(bootRegistration());
    await expect(creditPayout(ADDR, { symbol: 'USDC', decimals: 18 }, 1n)).rejects.toThrow(/USDC with 18 decimals/);
    expect(await getAgent(ADDR)).toMatchObject({ tasksCompleted: 0, totalEarnedUsdcRaw: '0' });
  });
});

describe('Postgres statements', () => {
  beforeEach(() => {
    cfg.databaseUrl = 'postgres://test';
    pool.query.mockReset();
    pool.query.mockResolvedValue({ rowCount: 1, rows: [] });
  });
  afterEach(() => { cfg.databaseUrl = ''; });

  it('credits in one statement, adding to the USDC column in SQL', async () => {
    expect(await creditPayout(ADDR, USDC, 4_500_000n)).toBe(true);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/tasks_completed = tasks_completed \+ 1/);
    expect(sql).toMatch(/reputation = LEAST\(100, reputation \+ 1\)/);
    expect(sql).toMatch(/total_earned_usdc_raw = \(COALESCE\(NULLIF\(total_earned_usdc_raw, ''\), '0'\)::numeric \+ \$2::numeric\)::text/);
    expect(sql).not.toMatch(/total_earned_raw\b/);
    expect(params).toEqual([ADDR.toLowerCase(), '4500000']);
  });

  it('sends 0G payouts to the native column', async () => {
    await creditPayout(ADDR, NATIVE_0G, ONE_0G);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/total_earned_raw = \(COALESCE\(NULLIF\(total_earned_raw, ''\)/);
    expect(params).toEqual([ADDR.toLowerCase(), ONE_0G.toString()]);
  });

  it('reports false when no row matched', async () => {
    pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
    expect(await creditPayout(ADDR, USDC, 1n)).toBe(false);
    expect(await adjustReputation(ADDR, -10)).toBe(false);
  });

  it('clamps reputation in SQL', async () => {
    await adjustReputation(ADDR, -10);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/reputation = LEAST\(100, GREATEST\(0, reputation \+ \$2\)\)/);
    expect(params).toEqual([ADDR.toLowerCase(), -10]);
  });

  it('leaves the counters out of the re-registration update', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ c: ADDR.toLowerCase() }] });
    await registerAgent(bootRegistration());
    const upsert = pool.query.mock.calls.map(([sql]) => sql as string).find((sql) => sql.includes('ON CONFLICT'))!;
    const onConflict = upsert.slice(upsert.indexOf('ON CONFLICT'));
    expect(onConflict).not.toMatch(/reputation|tasks_completed|total_earned/);
  });
});

describe('adjustReputation', () => {
  it('moves only reputation, within 0 to 100', async () => {
    await registerAgent(bootRegistration({ reputation: 5 }));
    await creditPayout(ADDR, USDC, 7n);
    expect(await adjustReputation(ADDR, -10)).toBe(true);
    expect(await getAgent(ADDR)).toMatchObject({ reputation: 0, tasksCompleted: 1, totalEarnedUsdcRaw: '7' });
  });

  it('reports false for an executor that does not exist', async () => {
    expect(await adjustReputation(ADDR, -10)).toBe(false);
  });
});
