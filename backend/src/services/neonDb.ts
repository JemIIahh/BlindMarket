import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
// Cached so migrations run exactly once per process. Cleared on failure so a
// transient error doesn't leave the schema permanently uninitialised.
let migrationPromise: Promise<void> | null = null;

export async function getPool(): Promise<pg.Pool> {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set — Neon PostgreSQL connection unavailable');
  }

  if (!pool) {
    // Neon requires SSL, but node-postgres can't verify Neon's cert chain
    // without an explicitly configured CA — forcing sslmode=verify-full made
    // every query fail. Connect over TLS without CA verification (the semantics
    // of sslmode=require), which is the standard Neon + node-postgres setup.
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: { rejectUnauthorized: false },
    });
  }

  // Ensure the schema exists before the first query. Previously migrations were
  // fire-and-forget (not awaited), so a query could hit a not-yet-created table
  // — and if that one-shot run failed, the schema stayed missing for the life
  // of the process. Await it, and clear the cache on failure so it retries.
  if (!migrationPromise) {
    migrationPromise = runMigrations(pool).catch((err) => {
      migrationPromise = null;
      throw err;
    });
  }
  await migrationPromise;

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
    migrationPromise = null;
  }
}

// ── Migrations ─────────────────────────────────────────────────────────────────

const migrations: Array<{ id: number; name: string; sql: string }> = [
  {
    id: 1,
    name: 'reputation_tables',
    sql: `
      CREATE TABLE IF NOT EXISTS reputation_history (
        address TEXT PRIMARY KEY,
        raw_score DOUBLE PRECISION NOT NULL DEFAULT 0,
        tasks_completed INTEGER NOT NULL DEFAULT 0,
        disputes INTEGER NOT NULL DEFAULT 0,
        last_task_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS reputation_events (
        id SERIAL PRIMARY KEY,
        address TEXT NOT NULL,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        score_delta DOUBLE PRECISION NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_rep_events_addr ON reputation_events(address);
    `,
  },
  {
    id: 2,
    name: 'agent_messages',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_messages (
        id SERIAL PRIMARY KEY,
        task_id TEXT,
        from_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        subject TEXT,
        body TEXT NOT NULL,
        read_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_msg_to ON agent_messages(to_address);
      CREATE INDEX IF NOT EXISTS idx_msg_from ON agent_messages(from_address);
      CREATE INDEX IF NOT EXISTS idx_msg_task ON agent_messages(task_id);
      CREATE INDEX IF NOT EXISTS idx_msg_created ON agent_messages(created_at);
    `,
  },
  {
    id: 3,
    name: 'agent_reviews',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_reviews (
        id SERIAL PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent_address TEXT NOT NULL,
        reviewer_address TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
        review TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(task_id, reviewer_address)
      );

      CREATE INDEX IF NOT EXISTS idx_reviews_agent ON agent_reviews(agent_address);
      CREATE INDEX IF NOT EXISTS idx_reviews_task ON agent_reviews(task_id);
    `,
  },
  {
    id: 4,
    name: 'task_templates',
    sql: `
      CREATE TABLE IF NOT EXISTS task_templates (
        id SERIAL PRIMARY KEY,
        creator_address TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        required_capabilities TEXT[] NOT NULL DEFAULT '{}',
        verification_criteria JSONB,
        suggested_reward TEXT,
        is_public BOOLEAN NOT NULL DEFAULT true,
        use_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_templates_creator ON task_templates(creator_address);
      CREATE INDEX IF NOT EXISTS idx_templates_public ON task_templates(is_public) WHERE is_public = true;
    `,
  },
  {
    id: 5,
    name: 'agent_webhooks',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_webhooks (
        id SERIAL PRIMARY KEY,
        agent_address TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        events TEXT[] NOT NULL DEFAULT '{task_assigned}',
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_webhooks_agent ON agent_webhooks(agent_address);
    `,
  },
  {
    id: 6,
    name: 'agent_badges',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_badges (
        id SERIAL PRIMARY KEY,
        agent_address TEXT NOT NULL,
        capability TEXT NOT NULL,
        badge_type TEXT NOT NULL DEFAULT 'verified',
        granted_by TEXT,
        granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        UNIQUE(agent_address, capability)
      );

      CREATE INDEX IF NOT EXISTS idx_badges_agent ON agent_badges(agent_address);
    `,
  },
];

async function runMigrations(p: pg.Pool): Promise<void> {
  const client = await p.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const { rows: applied } = await client.query<{ id: number }>(
      'SELECT id FROM schema_migrations',
    );
    const appliedIds = new Set(applied.map((r: { id: number }) => r.id));

    for (const m of migrations) {
      if (appliedIds.has(m.id)) continue;
      await client.query(m.sql);
      await client.query(
        'INSERT INTO schema_migrations (id, name) VALUES ($1, $2)',
        [m.id, m.name],
      );
      console.log(`[neonDb] Applied migration ${m.id}: ${m.name}`);
    }
  } finally {
    client.release();
  }
}
