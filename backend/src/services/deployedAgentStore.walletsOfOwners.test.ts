import { describe, it, expect, vi } from 'vitest';

/**
 * walletsOfOwners: the hosted agents of a set of owners, read in one query, so
 * the cascade can drop every agent of a sub-task poster's owner without a
 * lookup per candidate. Runs on the real SQLite migrations in memory; the
 * Postgres query's shape and parameters are checked separately.
 */

const pg = vi.hoisted(() => ({ calls: [] as Array<{ sql: string; params: unknown[] }>, on: false }));
vi.mock('../config.js', () => ({ config: { get databaseUrl() { return pg.on ? 'postgres://test' : ''; } } }));
vi.mock('./neonDb.js', () => ({
  getPool: async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      pg.calls.push({ sql, params });
      return { rows: [{ wallet_address: '0xAAAA000000000000000000000000000000000001', smart_account_address: null }], rowCount: 1 };
    },
  }),
}));
vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = (await importOriginal<{ default: new (path: string) => object }>()).default;
  return { default: class extends Real { constructor() { super(':memory:'); } } };
});

import { saveAgent, walletsOfOwners } from './deployedAgentStore.js';
import type { DeployedAgent } from '../types.js';

const agent = (id: string, owner: string, extra: Partial<DeployedAgent> = {}): DeployedAgent => ({
  id, ownerAddress: owner, name: id, instructions: 'x', provider: 'openai', model: 'm', apiKey: '', encryptedApiKey: '',
  capabilities: [], tools: [], status: 'stopped', deployedAt: '2026-10-02T00:00:00.000Z',
  walletAddress: `0x${id.padStart(40, '0')}`, publicKey: '04ab', encryptedPrivateKey: '', ...extra,
});

describe('walletsOfOwners (SQLite)', () => {
  it("lists every agent an owner owns or is linked to, wallets and smart accounts, lowercased", async () => {
    await saveAgent(agent('a1', '0xOwnerA'));
    await saveAgent(agent('a2', '0xownera', { smartAccountAddress: '0xSMART00000000000000000000000000000000a2' }));
    await saveAgent(agent('b1', '0xownerb', { authorizedOwners: ['0xownera'] }));
    await saveAgent(agent('c1', '0xownerc'));

    const got = await walletsOfOwners(['0xOWNERA']);
    expect(got.sort()).toEqual([
      `0x${'a1'.padStart(40, '0')}`,
      `0x${'a2'.padStart(40, '0')}`,
      `0x${'b1'.padStart(40, '0')}`,
      '0xsmart00000000000000000000000000000000a2',
    ].sort());
    expect(await walletsOfOwners(['0xownerc'])).toEqual([`0x${'c1'.padStart(40, '0')}`]);
    expect(await walletsOfOwners([])).toEqual([]);
  });
});

describe('walletsOfOwners (Postgres)', () => {
  it('is one query on owner or linked owner, reading no key material', async () => {
    pg.on = true;
    let got: string[];
    try {
      got = await walletsOfOwners(['0xOwnerA', '0xownera', '0xOwnerB']);
    } finally {
      pg.on = false;
    }
    expect(pg.calls).toHaveLength(1);
    const { sql, params } = pg.calls[0];
    expect(params).toEqual([['0xownera', '0xownerb']]);
    expect(sql).toMatch(/LOWER\(owner_address\) = ANY\(\$1::text\[\]\)/);
    expect(sql).toMatch(/unnest\(authorized_owners\)/);
    expect(sql).not.toMatch(/private_key|api_key|platform_token/);
    expect(got).toEqual(['0xaaaa000000000000000000000000000000000001']);
  });
});
