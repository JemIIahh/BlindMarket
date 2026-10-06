import { describe, expect, it, vi } from 'vitest';

/**
 * The Postgres pool (neonDb.getPool) is sized and times out on purpose
 * (delta audit 2026-10-06, ops-1). With pg's defaults, connect() waited
 * forever once every client was checked out, so a leaked client hung each
 * request after it instead of failing.
 */

const created = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>>, listeners: [] as string[] }));
vi.mock('pg', () => {
  const client = { query: async () => ({ rows: [], rowCount: 0 }), release: () => {} };
  class Pool {
    constructor(options: Record<string, unknown>) {
      created.options.push(options);
    }
    connect = async () => client;
    query = async () => ({ rows: [], rowCount: 0 });
    on(event: string) {
      created.listeners.push(event);
    }
    end = async () => {};
  }
  return { default: { Pool } };
});
vi.mock('../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../config.js')>();
  return { ...mod, config: { ...mod.config, databaseUrl: 'postgres://u:p@127.0.0.1:5432/db?sslmode=disable' } };
});
process.env.SKIP_REDIS_PG_MIGRATION = 'true';

const { getPool, closePool } = await import('./neonDb.js');

describe('the Postgres pool', () => {
  it('has an explicit size and a connect timeout, so exhaustion fails instead of hanging', async () => {
    await getPool();
    await closePool();
    expect(created.options).toHaveLength(1);
    expect(created.options[0]).toMatchObject({ max: 10, connectionTimeoutMillis: 10_000 });
  });

  it("listens for an idle client's error, which the pool re-emits and would otherwise crash the process", () => {
    expect(created.listeners).toContain('error');
  });
});
