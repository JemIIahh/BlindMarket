import pg from 'pg';
import { waitlistConfig } from './config.js';

const { Pool } = pg;

/**
 * The waitlist's own database: one table, its own migration list. Nothing here
 * touches the marketplace schema (services/neonDb.ts), and it needs no
 * extensions, so any Postgres 12+ works.
 */
const migrations: Array<{ id: number; name: string; sql: string }> = [
  {
    // token_hash is SHA-256 of the signup's bearer token (the raw token is only
    // ever returned to the browser, once). tasks/points are the self-reported X
    // tasks; referral_count is credited server-side (store.ts).
    id: 1,
    name: 'waitlist_signups',
    sql: `
      CREATE TABLE IF NOT EXISTS waitlist_signups (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        x_handle TEXT,
        tasks TEXT[] NOT NULL DEFAULT '{}',
        points INTEGER NOT NULL DEFAULT 0,
        token_hash TEXT NOT NULL UNIQUE,
        referral_code TEXT NOT NULL,
        referred_by INTEGER REFERENCES waitlist_signups(id) ON DELETE SET NULL,
        referral_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS waitlist_signups_referral_code_key ON waitlist_signups (referral_code);
    `,
  },
];

let pool: pg.Pool | null = null;
// Cached so migrations run once per process; cleared on failure so a transient
// error at boot doesn't leave the schema missing for the life of the process.
let ready: Promise<void> | null = null;

// Arbitrary constant: serialises migrations when several replicas boot at once
// (concurrent CREATE TABLE IF NOT EXISTS can still collide in Postgres).
const MIGRATION_LOCK_ID = 7_302_024_001;

async function runMigrations(p: pg.Pool): Promise<void> {
  const client = await p.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS waitlist_schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    const { rows } = await client.query<{ id: number }>('SELECT id FROM waitlist_schema_migrations');
    const applied = new Set(rows.map((r) => r.id));
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        // ON CONFLICT: two replicas booting at once both run the idempotent SQL; one records it.
        await client.query('INSERT INTO waitlist_schema_migrations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [m.id, m.name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      console.log(`[waitlist-db] applied migration ${m.id}: ${m.name}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

/**
 * Connection settings with libpq's meaning of `sslmode`, applied explicitly.
 * node-postgres lets an `sslmode` in the URL override the `ssl` option — and
 * today it reads `require` as "verify the certificate", which fails on hosts
 * with private CAs — so the mode is taken out of the URL and decided here:
 *   disable                → no TLS (local, or a host's private network)
 *   verify-ca, verify-full → TLS, certificate verified
 *   anything else / unset  → TLS without CA verification (libpq `require`)
 */
export function connectionOptions(databaseUrl: string): Pick<pg.PoolConfig, 'connectionString' | 'ssl'> {
  const url = new URL(databaseUrl);
  const mode = (url.searchParams.get('sslmode') ?? '').toLowerCase();
  url.searchParams.delete('sslmode');
  const ssl = mode === 'disable'
    ? false
    : { rejectUnauthorized: mode === 'verify-full' || mode === 'verify-ca' };
  return { connectionString: url.toString(), ssl };
}

export async function getWaitlistPool(): Promise<pg.Pool> {
  if (!waitlistConfig.databaseUrl) throw new Error('WAITLIST_DATABASE_URL is not set');
  if (!pool) {
    pool = new Pool({ ...connectionOptions(waitlistConfig.databaseUrl), max: 10 });
    // A pooled connection the server drops while idle (restart, failover, idle
    // timeout) is reported here. Without a listener Node treats it as an
    // uncaught error and the whole service exits; with one, the pool just
    // discards that connection and opens a fresh one on the next query.
    pool.on('error', (err) => {
      console.error('[waitlist-db] idle database connection lost:', err.message);
    });
  }
  ready ??= runMigrations(pool).catch((err) => {
    ready = null;
    throw err;
  });
  await ready;
  return pool;
}

export async function closeWaitlistPool(): Promise<void> {
  if (!pool) return;
  await pool.end().catch(() => {});
  pool = null;
  ready = null;
}
