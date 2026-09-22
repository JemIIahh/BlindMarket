import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

/**
 * The durable at-most-once gate for earnings credits: one row per task hash,
 * taken before a credit is written, released only when the credit fails.
 * Runs the SQLite path against a real in-memory table built from the
 * migration's own SQL, and the Postgres path against a fake pool.
 */

const { db, cfg, pool } = vi.hoisted(() => ({
  db: { current: null as unknown as Database.Database },
  cfg: { databaseUrl: '' },
  pool: { query: vi.fn() },
}));

vi.mock('../config.js', () => ({ config: cfg }));
vi.mock('./database.js', () => ({ getDb: () => db.current }));
vi.mock('./neonDb.js', () => ({ getPool: async () => pool }));

const { claimCredit, releaseCredit, isCredited } = await import('./creditLedger.js');
const { MIGRATIONS } = await import('./database.js').then(async () => {
  // The SQLite migration list is not exported; build the table from the
  // same SQL text so the test breaks if the two drift.
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('./database.ts', import.meta.url), 'utf-8'));
  const m = src.match(/CREATE TABLE IF NOT EXISTS credited_payouts \([\s\S]*?\);/);
  if (!m) throw new Error('credited_payouts migration not found in database.ts');
  return { MIGRATIONS: m[0] };
});

const HASH = '0x' + 'ab'.repeat(32);

beforeEach(() => {
  cfg.databaseUrl = '';
  db.current = new Database(':memory:');
  db.current.exec(MIGRATIONS);
  pool.query.mockReset();
});
afterEach(() => db.current.close());

describe('creditLedger (SQLite)', () => {
  it('claims a hash once; a second claim by any executor is refused', async () => {
    expect(await claimCredit(HASH, 'base', '0xAAAA')).toBe(true);
    expect(await claimCredit(HASH, 'base', '0xAAAA')).toBe(false);
    expect(await claimCredit(HASH.toUpperCase().replace('0X', '0x'), 'arc', '0xBBBB')).toBe(false);
    expect(await isCredited(HASH)).toBe(true);
  });

  it('release gives the claim back, so a retry can credit', async () => {
    expect(await claimCredit(HASH, 'base', '0xAAAA')).toBe(true);
    await releaseCredit(HASH);
    expect(await isCredited(HASH)).toBe(false);
    expect(await claimCredit(HASH, 'base', '0xAAAA')).toBe(true);
  });

  it('records the chain and executor, lowercased', async () => {
    await claimCredit(HASH, 'arc', '0xAbCd');
    const row = db.current.prepare('SELECT chain, executor FROM credited_payouts WHERE task_hash = ?').get(HASH) as any;
    expect(row).toEqual({ chain: 'arc', executor: '0xabcd' });
  });
});

describe('creditLedger (Postgres)', () => {
  beforeEach(() => {
    cfg.databaseUrl = 'postgres://x';
  });

  it('claims through INSERT … ON CONFLICT DO NOTHING and reads the row count', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ task_hash: HASH }] });
    expect(await claimCredit(HASH, 'base', '0xAAAA')).toBe(true);
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    expect(await claimCredit(HASH, 'base', '0xAAAA')).toBe(false);
    expect(pool.query.mock.calls[0][0]).toMatch(/ON CONFLICT \(task_hash\) DO NOTHING/);
    expect(pool.query.mock.calls[0][1]).toEqual([HASH, 'base', '0xaaaa']);
  });

  it('propagates a database failure (the caller treats it as a failed credit)', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection refused'));
    await expect(claimCredit(HASH, 'base', '0xAAAA')).rejects.toThrow('connection refused');
  });
});
