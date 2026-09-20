/**
 * agentStore — the SQL has to agree with the values bound to it.
 *
 * Regression (e99b754): adding supported_chains to registerAgent's Postgres
 * INSERT took the placeholders to $12 while the params array dropped to 9
 * values, so every registration failed at bind time with
 *   bind message supplies 9 parameters, but prepared statement "" requires 12
 * Nothing in CI runs against Postgres and TypeScript cannot see inside a SQL
 * string, so it shipped green. These tests need no database: the Postgres half
 * records every query the store issues and checks placeholders against params;
 * the SQLite half runs the real migrations against an in-memory database, so
 * it also sees what the migration list leaves the table looking like.
 *
 * supported_chains: null = registered by code that predates the field (the
 * legacy set, executorChains.LEGACY_SUPPORTED_CHAINS). agentStore.test.ts
 * covers the counters and the upsert's shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentExecutor } from '../types.js';

const h = vi.hoisted(() => ({
  databaseUrl: '' as string,
  calls: [] as Array<{ sql: string; params: unknown[] | undefined }>,
  rowsFor: (_sql: string): unknown[] => [],
}));

vi.mock('../config.js', () => ({
  config: {
    get databaseUrl() { return h.databaseUrl; },
  },
}));

vi.mock('./neonDb.js', () => ({
  getPool: async () => ({
    query: async (sql: string, params?: unknown[]) => {
      h.calls.push({ sql, params });
      return { rows: h.rowsFor(sql) };
    },
  }),
}));

// The real SQLite layer and its real migrations, but never the on-disk file.
vi.mock('better-sqlite3', async (importOriginal) => {
  const Real = (await importOriginal<{ default: new (path: string) => object }>()).default;
  return { default: class extends Real { constructor() { super(':memory:'); } } };
});

import * as agentStore from './agentStore.js';
import { getDb, sqliteMigrationSql } from './database.js';
import Database from 'better-sqlite3';

/** Distinct `$n` placeholders in a statement, ascending. */
function placeholders(sql: string): number[] {
  const seen = new Set<number>();
  for (const m of sql.matchAll(/\$(\d+)/g)) seen.add(Number(m[1]));
  return [...seen].sort((a, b) => a - b);
}

/** Every recorded query binds exactly the values its SQL asks for: $1..$n, n params. */
function expectEveryQueryBindsWhatItAsksFor(): void {
  expect(h.calls.length).toBeGreaterThan(0);
  for (const { sql, params } of h.calls) {
    const wanted = placeholders(sql);
    const n = params?.length ?? 0;
    expect(wanted, `placeholders vs ${n} params in:\n${sql}`).toEqual(
      Array.from({ length: n }, (_, i) => i + 1),
    );
  }
}

function agent(extra: Partial<AgentExecutor> = {}): AgentExecutor {
  return {
    address: '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa',
    displayName: 'Test agent',
    capabilities: ['code_review'] as AgentExecutor['capabilities'],
    publicKey: '0x04abcdef',
    reputation: 50,
    tasksCompleted: 0,
    registeredAt: new Date().toISOString(),
    ...extra,
  };
}

function insertCall() {
  const call = h.calls.find((c) => /INSERT INTO agent_executors/.test(c.sql));
  if (!call) throw new Error('registerAgent issued no INSERT');
  return call;
}

/** Split on commas that are not inside parentheses. */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** The value bound to a column of the INSERT whose VALUES entry is a plain `$n`. */
function boundTo(column: string): unknown {
  const { sql, params } = insertCall();
  const cols = splitTopLevel(sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')));
  const afterValues = sql.slice(sql.indexOf('VALUES') + 'VALUES'.length);
  const open = afterValues.indexOf('(');
  let depth = 0, end = -1;
  for (let i = open; i < afterValues.length; i++) {
    if (afterValues[i] === '(') depth++;
    if (afterValues[i] === ')' && --depth === 0) { end = i; break; }
  }
  const values = splitTopLevel(afterValues.slice(open + 1, end));
  expect(values.length, 'one VALUES entry per column').toBe(cols.length);
  const expr = values[cols.indexOf(column)];
  expect(expr, `VALUES entry for ${column}`).toMatch(/^\$\d+$/);
  return params![Number(expr.slice(1)) - 1];
}

describe('agentStore on Postgres — SQL and params agree', () => {
  beforeEach(() => {
    h.databaseUrl = 'postgres://unit-test';
    h.calls.length = 0;
    h.rowsFor = () => [];
  });

  it('registerAgent binds one value per placeholder (chains declared)', async () => {
    await agentStore.registerAgent(agent({ supportedChains: ['arc', 'base'] }));
    expectEveryQueryBindsWhatItAsksFor();
  });

  it('registerAgent binds one value per placeholder (no chains declared)', async () => {
    await agentStore.registerAgent(agent());
    await agentStore.registerAgent(agent({ supportedChains: null }));
    await agentStore.registerAgent(agent({ supportedChains: [] }));
    expectEveryQueryBindsWhatItAsksFor();
  });

  it('getAgent and listAgents bind one value per placeholder', async () => {
    await agentStore.getAgent('0xabc');
    await agentStore.listAgents();
    await agentStore.listAgents(['code_review']);
    expectEveryQueryBindsWhatItAsksFor();
  });

  it('binds declared chains as given, and null when none are declared', async () => {
    await agentStore.registerAgent(agent({ supportedChains: ['arc', 'base'] }));
    expect(boundTo('supported_chains')).toEqual(['arc', 'base']);
    h.calls.length = 0;
    await agentStore.registerAgent(agent());
    expect(boundTo('supported_chains')).toBeNull();
  });

  it('binds each counter to its own column on insert', async () => {
    await agentStore.registerAgent(agent({ reputation: 61, tasksCompleted: 3, totalEarnedRaw: '900000', totalEarnedUsdcRaw: '4500000' }));
    expect(boundTo('reputation')).toBe(61);
    expect(boundTo('tasks_completed')).toBe(3);
    expect(boundTo('total_earned_raw')).toBe('900000');
    expect(boundTo('total_earned_usdc_raw')).toBe('4500000');
  });

  it('reads supported_chains back, and a row with none as null (the legacy set)', async () => {
    h.rowsFor = () => [{ address: '0xabc', display_name: 'x', capabilities: [], public_key: 'k', supported_chains: ['arc', 'base'] }];
    expect((await agentStore.getAgent('0xabc'))?.supportedChains).toEqual(['arc', 'base']);
    for (const none of [undefined, null, []]) {
      h.rowsFor = () => [{ address: '0xabc', display_name: 'x', capabilities: [], public_key: 'k', supported_chains: none }];
      expect((await agentStore.getAgent('0xabc'))?.supportedChains, JSON.stringify(none)).toBeNull();
    }
  });
});

describe('agentStore on SQLite — real migrations, in memory', () => {
  beforeEach(() => {
    h.databaseUrl = '';
    getDb().prepare('DELETE FROM agent_executors').run();
  });

  it('registers and reads back declared chains', async () => {
    await agentStore.registerAgent(agent({ supportedChains: ['arc', 'base'] }));
    const got = await agentStore.getAgent(agent().address);
    expect(got?.supportedChains).toEqual(['arc', 'base']);
    expect(got?.reputation).toBe(50);
  });

  it('reads undeclared chains back as null (the legacy set)', async () => {
    await agentStore.registerAgent(agent());
    expect((await agentStore.getAgent(agent().address))?.supportedChains).toBeNull();
  });

  it("reads a row left at migration 14's '[]' default as null", async () => {
    await agentStore.registerAgent(agent({ supportedChains: ['base'] }));
    getDb().prepare("UPDATE agent_executors SET supported_chains = '[]'").run();
    expect((await agentStore.getAgent(agent().address))?.supportedChains).toBeNull();
  });

  it('re-registering without chains resets them to null and keeps the stored counters', async () => {
    await agentStore.registerAgent(agent({ supportedChains: ['arc', 'base'] }));
    expect(await agentStore.creditPayout(agent().address, { symbol: 'USDC', decimals: 6 }, 4_500_000n)).toBe(true);
    await agentStore.registerAgent(agent());
    const got = await agentStore.getAgent(agent().address);
    expect(got?.supportedChains).toBeNull();
    expect(got?.reputation).toBe(51);
    expect(got?.tasksCompleted).toBe(1);
    expect(got?.totalEarnedUsdcRaw).toBe('4500000');
  });
});

describe('SQLite migration 18 on rows written before it', () => {
  it('clears every 0G-only list and leaves the rest alone, malformed values included', () => {
    const db = new (Database as unknown as new () => InstanceType<typeof Database>)();
    db.exec('CREATE TABLE agent_executors (address TEXT PRIMARY KEY, supported_chains TEXT)');
    const rows: Array<[string, string | null, string | null]> = [
      ['stamped', '["0g"]', null],
      ['default', '[]', null],
      ['duplicate', '["0g","0g"]', null],
      ['both', '["0g","base"]', '["0g","base"]'],
      ['base', '["base"]', '["base"]'],
      ['legacy', null, null],
      ['malformed', 'not json', 'not json'],
      ['not-an-array', '"0g"', '"0g"'],
    ];
    const insert = db.prepare('INSERT INTO agent_executors VALUES (?, ?)');
    for (const [address, before] of rows) insert.run(address, before);

    db.exec(sqliteMigrationSql(18)!);

    const after = db.prepare('SELECT supported_chains AS c FROM agent_executors WHERE address = ?');
    for (const [address, , expected] of rows) {
      expect((after.get(address) as { c: string | null }).c, address).toBe(expected);
    }
  });
});
