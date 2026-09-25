import { describe, it, expect, vi, afterEach } from 'vitest';
import { isRerunSafe, listMigrations, migrationSql, rerunUnsafeMigrationIds, runMigrations } from './neonDb.js';

// Migration 31 (USDC units) only applies where the deployment PRICES in USDC,
// which is the settlement token of the chain it posts tasks on.
const cfg = vi.hoisted(() => ({ baseEscrowAddress: '0xescrow', postingChain: '' }));
vi.mock('../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../config.js')>();
  return {
    ...mod,
    config: new Proxy(mod.config, {
      get: (target, key) =>
        key in cfg ? cfg[key as keyof typeof cfg] : Reflect.get(target, key),
    }),
  };
});

/**
 * The migration runner used to skip by id only. When two branches both used
 * id 27, a database that had run the branch's #27 ('cctp_transfers') never
 * applied master's #27 ('smart_account_address') — silently — and saving an
 * agent later failed with "column does not exist". It now compares names:
 * a re-run-safe mismatch is re-applied, anything else is flagged, and startup
 * is never blocked.
 */

afterEach(() => {
  vi.restoreAllMocks();
  cfg.baseEscrowAddress = '0xescrow';
  cfg.postingChain = '';
});

describe('isRerunSafe', () => {
  it.each([
    ['CREATE TABLE IF NOT EXISTS t (id INT);', true],
    ['CREATE UNIQUE INDEX IF NOT EXISTS i ON t(id);', true],
    ['CREATE EXTENSION IF NOT EXISTS vector;', true],
    ['ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS smart_account_address TEXT;', true],
    ['ALTER TABLE t DROP COLUMN IF EXISTS c;', true],
    ['-- comment\n CREATE TABLE IF NOT EXISTS a (x INT);\n CREATE INDEX IF NOT EXISTS b ON a(x);', true],
    ['CREATE TABLE t (id INT);', false],
    ["UPDATE deployed_agents SET model = 'x' WHERE model = 'y';", false],
    ['CREATE TABLE IF NOT EXISTS a (x INT); INSERT INTO a VALUES (1);', false],
    ['ALTER TABLE t ALTER COLUMN c SET NOT NULL;', false],
    ['-- only a comment', false],
    ['', false],
  ])('%s → %s', (sql, expected) => {
    expect(isRerunSafe(sql)).toBe(expected);
  });

  it('flags only the data migrations (#16, #31, #36) among the current ones', () => {
    // A new migration that isn't safe to re-run fails this test on purpose:
    // write it with IF NOT EXISTS, or add its id here as a conscious decision.
    // #36 clears supported_chains = {0g}: re-run later, it would erase what
    // agents declared since.
    expect(rerunUnsafeMigrationIds()).toEqual([16, 31, 36]);
  });
});

describe('migrations production has recorded', () => {
  const squash = (sql: string | undefined) => sql?.replace(/\s+/g, ' ').trim();

  it('keeps #32 exactly as master shipped it (production applied it)', () => {
    expect(listMigrations().find((m) => m.id === 32)).toEqual({ id: 32, name: 'agent_executors_supported_chains' });
    expect(squash(migrationSql(32))).toBe(
      "ALTER TABLE agent_executors ADD COLUMN IF NOT EXISTS supported_chains TEXT[] NOT NULL DEFAULT '{0g}';",
    );
  });

  it('numbers this branch after it, ending with the nullable follow-up', () => {
    expect(listMigrations().filter((m) => m.id >= 32 && m.id <= 36)).toEqual([
      { id: 32, name: 'agent_executors_supported_chains' },
      { id: 33, name: 'agent_executors_usdc_earnings' },
      { id: 34, name: 'credited_payouts' },
      { id: 35, name: 'transactions_unit' },
      { id: 36, name: 'agent_executors_supported_chains_nullable' },
    ]);
  });

  it('#39 adds the verifier opt-in, off by default and safe to re-run (audit run 1, C04)', () => {
    expect(listMigrations().find((m) => m.id === 39)).toEqual({ id: 39, name: 'deployed_agents_verifier_enabled' });
    expect(squash(migrationSql(39))).toBe(
      'ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS verifier_enabled BOOLEAN NOT NULL DEFAULT false;',
    );
  });

  it('#36 drops the constraint and default, and clears every 0G-only list', () => {
    const sql = squash(migrationSql(36))!;
    expect(sql).toContain('ALTER COLUMN supported_chains DROP NOT NULL');
    expect(sql).toContain('ALTER COLUMN supported_chains DROP DEFAULT');
    expect(sql).toMatch(/SET supported_chains = NULL WHERE supported_chains <@ ARRAY\['0g'\]/);
  });
});

function fakePool(recorded: Array<{ id: number; name: string }>) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (/SELECT id, name FROM schema_migrations/.test(sql)) return { rows: recorded };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client) } as never, queries, client };
}

const allRecorded = () => listMigrations().map((m) => ({ ...m }));
const inserts = (qs: Array<{ sql: string; params?: unknown[] }>) =>
  qs.filter((q) => q.sql.startsWith('INSERT INTO schema_migrations')).map((q) => q.params?.[0]);

describe('runMigrations', () => {
  it('re-applies a re-run-safe migration whose id is recorded under another name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recorded = allRecorded().map((m) => (m.id === 27 ? { id: 27, name: 'cctp_transfers' } : m));
    const { pool, queries, client } = fakePool(recorded);

    await runMigrations(pool);

    const ran = queries.filter((q) => /smart_account_address/.test(q.sql));
    expect(ran).toHaveLength(1);
    expect(inserts(queries)).toEqual([]); // the history row is left for a person to reconcile
    expect(warn.mock.calls.flat().join('\n')).toMatch(/migration 27 is recorded as 'cctp_transfers'/);
    expect(client.release).toHaveBeenCalled();
  });

  it('does NOT re-run a data migration under a mismatched id — flags it instead', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recorded = allRecorded().map((m) => (m.id === 16 ? { id: 16, name: 'something_else' } : m));
    const { pool, queries } = fakePool(recorded);

    await expect(runMigrations(pool)).resolves.toBeUndefined(); // never blocks startup
    expect(queries.some((q) => /claude-haiku-4-5/.test(q.sql))).toBe(false);
    expect(error.mock.calls.flat().join('\n')).toMatch(/migration 16 .* NOT safe to re-run/);
  });

  it('does nothing when every recorded name matches', async () => {
    const { pool, queries } = fakePool(allRecorded());
    await runMigrations(pool);
    // Only the bookkeeping table check and the SELECT ran.
    expect(queries).toHaveLength(2);
  });

  it('applies and records every migration on an empty database', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pool, queries } = fakePool([]);
    await runMigrations(pool);
    expect(inserts(queries)).toEqual(listMigrations().map((m) => m.id));
  });
});
describe('conditional migration 31 (USDC units)', () => {
  const convertsAmounts = (sql: string) => /UPDATE agent_services/.test(sql);

  it('runs and is recorded where settlement prices in USDC', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pool, queries } = fakePool([]);
    await runMigrations(pool);
    expect(queries.some((q) => convertsAmounts(q.sql))).toBe(true);
    expect(inserts(queries)).toContain(31);
  });
});
