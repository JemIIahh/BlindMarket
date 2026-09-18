/**
 * agentStore — the SQL has to agree with the values bound to it.
 *
 * Regression: adding supported_chains to registerAgent's Postgres INSERT took
 * the placeholders to $12 while the params array dropped to 9 values, so every
 * registration (and every payout credit, which also writes through
 * registerAgent) failed at bind time with
 *   bind message supplies 9 parameters, but prepared statement "" requires 12
 * Nothing in CI runs against Postgres and TypeScript cannot see inside a SQL
 * string, so it shipped green. These tests need no database: the Postgres half
 * records every query the store issues and checks placeholders against params;
 * the SQLite half runs the real migrations against an in-memory database.
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
import { getDb } from './database.js';

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
    await agentStore.registerAgent(agent({ supportedChains: ['0g', 'base'] }));
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

  it('never lets supported_chains resolve to NULL (the column is NOT NULL)', async () => {
    await agentStore.registerAgent(agent());
    const { sql, params } = insertCall();
    // Undeclared chains go in as NULL, so the SQL must coalesce that parameter
    // down to a non-null fallback that is itself bound and non-empty.
    const m = sql.match(/COALESCE\(\s*\$(\d+)::TEXT\[\][\s\S]*?\$(\d+)::TEXT\[\]\s*\)/);
    expect(m, 'supported_chains must be COALESCEd to a bound default').not.toBeNull();
    const fallback = params![Number(m![2]) - 1];
    expect(fallback).toEqual([...agentStore.DEFAULT_SUPPORTED_CHAINS]);
    expect(agentStore.DEFAULT_SUPPORTED_CHAINS.length).toBeGreaterThan(0);
  });

  it('binds declared chains as given', async () => {
    await agentStore.registerAgent(agent({ supportedChains: ['0g', 'base'] }));
    const { sql, params } = insertCall();
    const m = sql.match(/COALESCE\(\s*\$(\d+)::TEXT\[\]/)!;
    expect(params![Number(m[1]) - 1]).toEqual(['0g', 'base']);
  });

  it('writes the counters the caller carries, so a credit is not lost', async () => {
    await agentStore.registerAgent(agent({ reputation: 61, tasksCompleted: 3, totalEarnedRaw: '900000' }));
    expect(boundTo('reputation')).toBe(61);
    expect(boundTo('tasks_completed')).toBe(3);
    expect(boundTo('total_earned_raw')).toBe('900000');
  });

  it('reads supported_chains back, defaulting a row that has none', async () => {
    h.rowsFor = () => [{ address: '0xabc', display_name: 'x', capabilities: [], public_key: 'k', supported_chains: ['0g', 'base'] }];
    expect((await agentStore.getAgent('0xabc'))?.supportedChains).toEqual(['0g', 'base']);
    h.rowsFor = () => [{ address: '0xabc', display_name: 'x', capabilities: [], public_key: 'k' }];
    expect((await agentStore.getAgent('0xabc'))?.supportedChains).toEqual(['0g']);
  });
});

describe('agentStore on SQLite — real migrations, in memory', () => {
  beforeEach(() => {
    h.databaseUrl = '';
    getDb().prepare('DELETE FROM agent_executors').run();
  });

  it('registers and reads back declared chains', async () => {
    await agentStore.registerAgent(agent({ supportedChains: ['0g', 'base'] }));
    const got = await agentStore.getAgent(agent().address);
    expect(got?.supportedChains).toEqual(['0g', 'base']);
    expect(got?.reputation).toBe(50);
  });

  it('defaults undeclared chains to 0g', async () => {
    await agentStore.registerAgent(agent());
    expect((await agentStore.getAgent(agent().address))?.supportedChains).toEqual(['0g']);
  });

  it('re-registering without chains keeps the declared ones and the carried counters', async () => {
    await agentStore.registerAgent(agent({ supportedChains: ['0g', 'base'] }));
    await agentStore.registerAgent(agent({ reputation: 61, tasksCompleted: 3, totalEarnedRaw: '900000' }));
    const got = await agentStore.getAgent(agent().address);
    expect(got?.supportedChains).toEqual(['0g', 'base']);
    expect(got?.reputation).toBe(61);
    expect(got?.tasksCompleted).toBe(3);
    expect(got?.totalEarnedRaw).toBe('900000');
  });
});
