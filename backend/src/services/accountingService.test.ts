import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

/**
 * The accounting ledger stores whole-unit amounts; before the `unit` column
 * every summary added USDC rows to 0G rows. The headline totals are now in
 * the deployment's pricing unit (plus rows written before the column
 * existed), and every other unit is reported separately, never added.
 */

const { db, cfg, pool, pricing } = vi.hoisted(() => ({
  db: { current: null as unknown as Database.Database },
  cfg: { databaseUrl: '' },
  pool: { query: vi.fn() },
  pricing: { unit: { symbol: 'USDC', decimals: 6 } },
}));

vi.mock('../config.js', () => ({ config: cfg }));
vi.mock('./database.js', () => ({ getDb: () => db.current }));
vi.mock('./neonDb.js', () => ({ getPool: async () => pool }));
vi.mock('./settlementUnits.js', () => ({ pricingUnit: () => pricing.unit }));

const { recordTransaction, getSummary, getGlobalStats, exportCsv } = await import('./accountingService.js');

const A = '0x1111111111111111111111111111111111111111';

beforeEach(() => {
  cfg.databaseUrl = '';
  pricing.unit = { symbol: 'USDC', decimals: 6 };
  db.current = new Database(':memory:');
  db.current.exec(`
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL, role TEXT NOT NULL, task_id TEXT, type TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0, fee REAL NOT NULL DEFAULT 0, net REAL NOT NULL DEFAULT 0,
      unit TEXT, status TEXT NOT NULL DEFAULT 'confirmed', tx_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
});
afterEach(() => db.current.close());

const pay = (amount: number, fee: number, unit?: string, address = A) =>
  recordTransaction({ address, role: 'worker', taskId: 't', type: 'payment', amount, fee, net: amount - fee, unit });

describe('per-unit summaries', () => {
  it('never adds a 0G payout to a USDC one', async () => {
    await pay(5, 0.5, 'USDC');
    await pay(5, 0.5, '0G');
    const s = await getSummary([A]);
    expect(s.unit).toBe('USDC');
    expect(s).toMatchObject({ totalEarned: 5, totalFees: 0.5, netRevenue: 4.5, taskCount: 1, unitlessRows: 0 });
    expect(s.byUnit).toEqual({
      USDC: { totalEarned: 5, totalFees: 0.5, netRevenue: 4.5, taskCount: 1 },
      '0G': { totalEarned: 5, totalFees: 0.5, netRevenue: 4.5, taskCount: 1 },
    });
  });

  it('counts rows from before the unit column in the headline, and says how many', async () => {
    await pay(2, 0.2, 'USDC');
    await pay(3, 0.3, undefined);
    const s = await getSummary([A]);
    expect(s).toMatchObject({ totalEarned: 5, totalFees: 0.5, taskCount: 2, unitlessRows: 1 });
    expect(s.byUnit.USDC.totalEarned).toBe(5);
  });

  it('follows the pricing unit: on a 0G-priced stack USDC rows leave the headline', async () => {
    pricing.unit = { symbol: '0G', decimals: 18 };
    await pay(5, 0.5, 'USDC');
    await pay(1, 0.1, '0G');
    const s = await getSummary([A]);
    expect(s.unit).toBe('0G');
    expect(s).toMatchObject({ totalEarned: 1, taskCount: 1 });
    expect(s.byUnit.USDC.totalEarned).toBe(5);
  });

  it('ignores non-income rows and other addresses, and is empty for no addresses', async () => {
    await pay(5, 0.5, 'USDC');
    await recordTransaction({ address: A, role: 'agent', type: 'escrow_lock', amount: 9, unit: 'USDC' });
    await pay(7, 0.7, 'USDC', '0x2222222222222222222222222222222222222222');
    expect((await getSummary([A])).totalEarned).toBe(5);
    expect(await getSummary([])).toMatchObject({ totalEarned: 0, taskCount: 0, unit: 'USDC', byUnit: {} });
  });

  it('platform stats add fee rows to the fees, per unit', async () => {
    await pay(10, 1, 'USDC');
    await recordTransaction({ address: A, role: 'platform', type: 'fee', amount: 0, fee: 0.25, unit: 'USDC' });
    await recordTransaction({ address: A, role: 'platform', type: 'fee', amount: 0, fee: 0.1, unit: '0G' });
    const g = await getGlobalStats();
    expect(g).toMatchObject({ unit: 'USDC', totalEarned: 10, totalFees: 1.25, totalVolume: 11.25, taskCount: 1 });
    expect(g.byUnit['0G']).toMatchObject({ totalEarned: 0, totalFees: 0.1 });
  });

  it('stores and exports the unit', async () => {
    const row = await pay(5, 0.5, 'USDC');
    expect(row.unit).toBe('USDC');
    const csv = await exportCsv([A]);
    expect(csv.split('\n')[0]).toBe('Date,Task ID,Type,Role,Amount,Fee,Net,Status,Tx Hash,Unit');
    expect(csv.split('\n')[1].endsWith(',USDC')).toBe(true);
  });
});

describe('Postgres queries', () => {
  it('group by type and unit, and insert the unit', async () => {
    cfg.databaseUrl = 'postgres://x';
    pool.query.mockResolvedValueOnce({ rows: [{ type: 'payment', unit: '0G', total_amount: '5', total_fee: '0.5', cnt: 1 }] });
    const s = await getSummary([A]);
    expect(pool.query.mock.calls[0][0]).toMatch(/GROUP BY type, unit/);
    expect(s.totalEarned).toBe(0);
    expect(s.byUnit['0G'].totalEarned).toBe(5);
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, unit: 'USDC' }] });
    await pay(1, 0, 'USDC');
    expect(pool.query.mock.calls[1][0]).toMatch(/INSERT INTO transactions \(address, role, task_id, type, amount, fee, net, unit, status, tx_hash\)/);
    expect(pool.query.mock.calls[1][1][7]).toBe('USDC');
  });
});
