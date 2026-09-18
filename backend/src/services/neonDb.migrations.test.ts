import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertPricingUnitUnchanged, getSchemaStatus, isRerunSafe, listMigrations, rerunUnsafeMigrationIds, runMigrations } from './neonDb.js';

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

  it('flags only the data migrations (#16, #31) among the current ones', () => {
    // A new migration that isn't safe to re-run fails this test on purpose:
    // write it with IF NOT EXISTS, or add its id here as a conscious decision.
    expect(rerunUnsafeMigrationIds()).toEqual([16, 31]);
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

  it('runs and is recorded where Base settles in USDC', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pool, queries } = fakePool([]);
    await runMigrations(pool);
    expect(queries.some((q) => convertsAmounts(q.sql))).toBe(true);
    expect(inserts(queries)).toContain(31);
  });

  it('is skipped and left unrecorded on a 0G-only deployment', async () => {
    cfg.baseEscrowAddress = '';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pool, queries } = fakePool([]);
    await runMigrations(pool);
    expect(queries.some((q) => convertsAmounts(q.sql))).toBe(false);
    expect(inserts(queries)).not.toContain(31);
  });

  // A stack can have a Base escrow (withdrawals, CCTP) while posting — and
  // pricing — on 0G. Its amounts are 18-decimal and dividing them by 10^12 is
  // irreversible. A skipped `when` is not recorded, so this migration would
  // otherwise fire on the first boot after such a stack added its Base escrow.
  it('is skipped on a stack with a Base escrow that posts on 0G', async () => {
    cfg.postingChain = '0g';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pool, queries } = fakePool([]);
    await runMigrations(pool);
    expect(queries.some((q) => convertsAmounts(q.sql))).toBe(false);
    expect(inserts(queries)).not.toContain(31);
  });

  it('applies on a stack that posts on Base', async () => {
    cfg.postingChain = 'base';
    const { pool, queries } = fakePool([]);
    await runMigrations(pool);
    expect(queries.some((q) => convertsAmounts(q.sql))).toBe(true);
  });

  it('is not reported missing where it does not apply', async () => {
    cfg.baseEscrowAddress = '';
    const recorded = listMigrations().filter((m) => m.id !== 31);
    const status = await getSchemaStatus({ query: async () => ({ rows: recorded }) } as never);
    expect(status.missing).toEqual([]);
    cfg.baseEscrowAddress = '0xescrow';
    const withBase = await getSchemaStatus({ query: async () => ({ rows: recorded }) } as never);
    expect(withBase.missing).toEqual([31]);
  });
});

describe('pricing unit guard (assertPricingUnitUnchanged)', () => {
  // Migration 31 converted every stored price to USDC base units and is
  // recorded only where it ran. Once recorded, pricing in 0G would read
  // those 6-decimal amounts as wei.
  it('refuses to run migrations when a USDC-priced database now prices in 0G', async () => {
    cfg.postingChain = '0g';
    const { pool } = fakePool(allRecorded());
    await expect(runMigrations(pool)).rejects.toThrow(/priced in USDC \(migration 31 is recorded\).*prices in 0G/);
  });

  it('runs when the pricing unit is still USDC, or 31 was never recorded', async () => {
    const { pool } = fakePool(allRecorded());
    await expect(runMigrations(pool)).resolves.toBeUndefined();
    cfg.postingChain = '0g';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { pool: fresh } = fakePool(allRecorded().filter((m) => m.id !== 31));
    await expect(runMigrations(fresh)).resolves.toBeUndefined();
  });

  it('runs with a warning when the operator says the rows were re-keyed', async () => {
    cfg.postingChain = '0g';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const applied = new Map(allRecorded().map((m) => [m.id, m.name]));
    expect(() => assertPricingUnitUnchanged(applied, { ALLOW_PRICING_UNIT_CHANGE: 'true' } as NodeJS.ProcessEnv)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ALLOW_PRICING_UNIT_CHANGE=true'));
    expect(() => assertPricingUnitUnchanged(applied, {} as NodeJS.ProcessEnv)).toThrow(/ALLOW_PRICING_UNIT_CHANGE=true/);
  });
});
