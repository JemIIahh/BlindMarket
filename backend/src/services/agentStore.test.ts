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
  pool: { query: vi.fn(), connect: vi.fn() },
}));

vi.mock('../config.js', () => ({ config: cfg }));
vi.mock('./database.js', () => ({ getDb: () => db.current }));
vi.mock('./neonDb.js', () => ({ getPool: async () => pool }));

const { registerAgent, creditPayout, creditPayoutOnce, adjustReputation, getAgent } = await import('./agentStore.js');

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
  // database.ts migrations 10, 14 and 15.
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
    ALTER TABLE agent_executors ADD COLUMN supported_chains TEXT;
    CREATE TABLE credited_payouts (
      task_hash TEXT PRIMARY KEY,
      chain TEXT NOT NULL,
      executor TEXT NOT NULL,
      credited_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
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

  it.each([
    [null, null],
    // Nothing declared is the legacy set, as the '[]' column default reads.
    [[], null],
    [['arc'], ['arc']],
    [['arc', 'base', 'arc'], ['arc', 'base', 'arc']],
  ])('stores declared chains %j and reads them back as %j', async (declared, expected) => {
    await registerAgent(bootRegistration({ supportedChains: declared }));
    expect((await getAgent(ADDR))?.supportedChains).toEqual(expected);
  });

  it('resets declared chains to null when older code re-registers without them', async () => {
    await registerAgent(bootRegistration({ supportedChains: ['arc', 'base', 'arc'] }));
    await registerAgent(bootRegistration());
    expect((await getAgent(ADDR))?.supportedChains).toBeNull();
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

/**
 * creditPayoutOnce claims the task's credited_payouts row and applies the
 * credit in one transaction, so a failure leaves neither and no path ever
 * deletes a claim an earlier credit wrote (security audit run 1, C34).
 */
describe('creditPayoutOnce', () => {
  const TASK = '0x' + 'ab'.repeat(32);
  const claims = () => db.current.prepare('SELECT task_hash, chain, executor FROM credited_payouts').all();

  it('credits a task once, and reports a repeat as a duplicate without touching the counters', async () => {
    await registerAgent(bootRegistration());
    expect(await creditPayoutOnce({ taskHash: TASK.toUpperCase().replace('0X', '0x'), chain: 'arc' }, ADDR, USDC, 4_500_000n)).toBe('credited');
    expect(await creditPayoutOnce({ taskHash: TASK, chain: 'arc' }, ADDR, USDC, 4_500_000n)).toBe('duplicate');
    expect(await getAgent(ADDR)).toMatchObject({ tasksCompleted: 1, reputation: 51, totalEarnedUsdcRaw: '4500000' });
    expect(claims()).toEqual([{ task_hash: TASK, chain: 'arc', executor: ADDR.toLowerCase() }]);
  });

  it('writes no claim for an executor that does not exist', async () => {
    expect(await creditPayoutOnce({ taskHash: TASK, chain: 'arc' }, ADDR, USDC, 1n)).toBe('unregistered');
    expect(claims()).toEqual([]);
  });

  it('rolls the claim back when the credit fails, so a retry can credit', async () => {
    await registerAgent(bootRegistration());
    db.current.exec(`CREATE TRIGGER fail_credit BEFORE UPDATE ON agent_executors
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;`);
    await expect(creditPayoutOnce({ taskHash: TASK, chain: 'arc' }, ADDR, USDC, 1n)).rejects.toThrow('disk I/O error');
    expect(claims()).toEqual([]);
    db.current.exec('DROP TRIGGER fail_credit');
    expect(await creditPayoutOnce({ taskHash: TASK, chain: 'arc' }, ADDR, USDC, 1n)).toBe('credited');
  });

  describe('on Postgres', () => {
    const client = { query: vi.fn(), release: vi.fn() };
    const sent = () => client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/).slice(0, 3).join(' '));

    beforeEach(() => {
      cfg.databaseUrl = 'postgres://test';
      client.query.mockReset().mockResolvedValue({ rowCount: 1, rows: [] });
      client.release.mockReset();
      pool.connect.mockReset().mockResolvedValue(client);
    });
    afterEach(() => { cfg.databaseUrl = ''; });

    it('claims and credits between BEGIN and COMMIT on one connection', async () => {
      expect(await creditPayoutOnce({ taskHash: TASK, chain: 'base' }, ADDR, USDC, 4_500_000n)).toBe('credited');
      expect(sent()).toEqual(['BEGIN', 'INSERT INTO credited_payouts', 'UPDATE agent_executors SET', 'COMMIT']);
      expect(client.query.mock.calls[1][1]).toEqual([TASK, 'base', ADDR.toLowerCase()]);
      expect(client.query.mock.calls[2][1]).toEqual([ADDR.toLowerCase(), '4500000']);
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('rolls back without crediting when the task is already claimed', async () => {
      client.query.mockImplementation(async (sql: string) => ({ rowCount: sql.includes('credited_payouts') ? 0 : 1, rows: [] }));
      expect(await creditPayoutOnce({ taskHash: TASK, chain: 'base' }, ADDR, USDC, 1n)).toBe('duplicate');
      expect(sent()).toEqual(['BEGIN', 'INSERT INTO credited_payouts', 'ROLLBACK']);
    });

    it('rolls the claim back when the executor is missing', async () => {
      client.query.mockImplementation(async (sql: string) => ({ rowCount: sql.includes('agent_executors') ? 0 : 1, rows: [] }));
      expect(await creditPayoutOnce({ taskHash: TASK, chain: 'base' }, ADDR, USDC, 1n)).toBe('unregistered');
      expect(sent()).toEqual(['BEGIN', 'INSERT INTO credited_payouts', 'UPDATE agent_executors SET', 'ROLLBACK']);
    });

    it('rolls back and rethrows when the credit fails, deleting nothing', async () => {
      client.query.mockImplementation(async (sql: string) => {
        if (sql.includes('agent_executors')) throw new Error('Connection terminated unexpectedly');
        return { rowCount: 1, rows: [] };
      });
      await expect(creditPayoutOnce({ taskHash: TASK, chain: 'base' }, ADDR, USDC, 1n)).rejects.toThrow('Connection terminated');
      expect(sent()).toEqual(['BEGIN', 'INSERT INTO credited_payouts', 'UPDATE agent_executors SET', 'ROLLBACK']);
      expect(client.query.mock.calls.some(([sql]) => /DELETE/i.test(String(sql)))).toBe(false);
      expect(client.release).toHaveBeenCalledTimes(1);
    });
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
    expect(onConflict).toMatch(/supported_chains = EXCLUDED\.supported_chains/);
  });

  it('passes declared chains as a Postgres array, and null when absent', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ n: 0 }] });
    await registerAgent(bootRegistration({ supportedChains: ['arc', 'arc'] }));
    const upsertCall = pool.query.mock.calls.find(([sql]) => String(sql).includes('ON CONFLICT'))!;
    expect(upsertCall[1]).toContainEqual(['arc', 'arc']);

    pool.query.mockClear();
    await registerAgent(bootRegistration());
    const legacyCall = pool.query.mock.calls.find(([sql]) => String(sql).includes('ON CONFLICT'))!;
    expect((legacyCall[1] as unknown[]).at(-1)).toBeNull();
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
