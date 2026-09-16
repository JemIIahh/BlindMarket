import { describe, it, expect, vi, afterEach } from 'vitest';
import { isRerunSafe, listMigrations, rerunUnsafeMigrationIds, runMigrations } from './neonDb.js';

/**
 * The migration runner used to skip by id only. When two branches both used
 * id 27, a database that had run the branch's #27 ('cctp_transfers') never
 * applied master's #27 ('smart_account_address') — silently — and saving an
 * agent later failed with "column does not exist". It now compares names:
 * a re-run-safe mismatch is re-applied, anything else is flagged, and startup
 * is never blocked.
 */

afterEach(() => vi.restoreAllMocks());

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

  it('flags only the data fix (#16) among the current migrations', () => {
    // A new migration that isn't safe to re-run fails this test on purpose:
    // write it with IF NOT EXISTS, or add its id here as a conscious decision.
    expect(rerunUnsafeMigrationIds()).toEqual([16]);
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
