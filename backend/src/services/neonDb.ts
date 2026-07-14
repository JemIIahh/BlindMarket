import pg from 'pg';
import { config } from '../config.js';
import { Redis } from 'ioredis';

const { Pool } = pg;

let pool: pg.Pool | null = null;
// Cached so migrations run exactly once per process. Cleared on failure so a
// transient error doesn't leave the schema permanently uninitialised.
let migrationPromise: Promise<void> | null = null;
// Data migration from Redis → PG also runs once.
let dataMigrationPromise: Promise<void> | null = null;

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

  // One-shot data migration: copy agents from Redis to PG.
  if (!dataMigrationPromise) {
    dataMigrationPromise = migrateRedisToPg(pool).catch((err) => {
      console.warn('[neonDb] Redis → PG data migration failed (non-fatal):', (err as Error).message);
    });
  }
  await dataMigrationPromise;

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
  {
    id: 7,
    name: 'agent_executors',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_executors (
        address TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        capabilities TEXT[] NOT NULL DEFAULT '{}',
        public_key TEXT NOT NULL,
        agent_card_url TEXT,
        mcp_endpoint_url TEXT,
        min_reward TEXT,
        preferred_capabilities TEXT[],
        reputation INTEGER NOT NULL DEFAULT 50,
        tasks_completed INTEGER NOT NULL DEFAULT 0,
        total_earned_raw TEXT NOT NULL DEFAULT '0',
        registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_executor_caps ON agent_executors USING GIN (capabilities);
    `,
  },
  {
    id: 8,
    name: 'deployed_agents',
    sql: `
      CREATE TABLE IF NOT EXISTS deployed_agents (
        id TEXT PRIMARY KEY,
        owner_address TEXT NOT NULL,
        authorized_owners TEXT[] NOT NULL DEFAULT '{}',
        name TEXT NOT NULL,
        instructions TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key TEXT NOT NULL,
        encrypted_api_key TEXT NOT NULL,
        capabilities TEXT[] NOT NULL DEFAULT '{}',
        tools JSONB NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'stopped',
        deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_active_at TIMESTAMPTZ,
        storage_ref TEXT,
        platform_token TEXT,
        wallet_address TEXT NOT NULL,
        public_key TEXT NOT NULL,
        encrypted_private_key TEXT NOT NULL,
        raw_private_key TEXT,
        inft_token_id INTEGER,
        min_reward TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_deployed_owner ON deployed_agents(owner_address);
    `,
  },
  {
    id: 9,
    name: 'api_keys',
    sql: `
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        owner_address TEXT NOT NULL,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        capabilities TEXT[] NOT NULL DEFAULT '{}',
        agent_address TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_api_keys_owner ON api_keys(owner_address);
      CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    `,
  },
  {
    id: 10,
    name: 'drop_task_templates_category',
    sql: `
      ALTER TABLE task_templates DROP COLUMN IF EXISTS category;
    `,
  },
  {
    id: 11,
    name: 'deployed_agents_chain_type',
    sql: `
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS chain_type TEXT;
    `,
  },
  {
    id: 12,
    name: 'agent_services',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_services (
        id SERIAL PRIMARY KEY,
        agent_address TEXT NOT NULL,
        owner_address TEXT NOT NULL,
        name TEXT NOT NULL CHECK (char_length(name) BETWEEN 5 AND 60),
        description TEXT NOT NULL DEFAULT '',
        price_raw TEXT NOT NULL,
        service_type TEXT NOT NULL DEFAULT 'api' CHECK (service_type IN ('api','a2a')),
        active BOOLEAN NOT NULL DEFAULT true,
        sold_count INTEGER NOT NULL DEFAULT 0,
        avg_rating DOUBLE PRECISION NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_services_agent ON agent_services(agent_address);
      CREATE INDEX IF NOT EXISTS idx_services_owner ON agent_services(owner_address);
      CREATE INDEX IF NOT EXISTS idx_services_active ON agent_services(active) WHERE active = true;
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

// ── Redis → PG data migration ──────────────────────────────────────────────────
//
// Pre-migration-7 agents and executors exist only in Redis, not PG. Copy them
// once so users see their deployed agents after page reload.
async function migrateRedisToPg(p: pg.Pool): Promise<void> {
  let redis: Redis | null = null;
  try {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

    const keys = await redis.keys('agent:*');
    const agentKeys = keys.filter(k => !k.includes(':logs') && !k.includes(':heartbeat'));

    for (const key of agentKeys) {
      const keyType = await redis.type(key);
      if (keyType !== 'string') continue;
      const raw = await redis.get(key);
      if (!raw) continue;
      const data = JSON.parse(raw);
      const {
        id, ownerAddress, name, instructions, provider, model,
        apiKey, encryptedApiKey, capabilities, tools, status,
        deployedAt, lastActiveAt, storageRef, platformToken,
        walletAddress, publicKey, encryptedPrivateKey, rawPrivateKey,
        inftTokenId, minReward, authorizedOwners,
      } = data;
      if (!id) continue;

      await p.query(
        `INSERT INTO deployed_agents
           (id, owner_address, authorized_owners, name, instructions,
            provider, model, api_key, encrypted_api_key, capabilities,
            tools, status, deployed_at, last_active_at, storage_ref,
            platform_token, wallet_address, public_key, encrypted_private_key,
            raw_private_key, inft_token_id, min_reward, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17, $18, $19, $20, $21, $22, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [id, ownerAddress, authorizedOwners ?? [], name, instructions,
         provider, model, apiKey ?? '', encryptedApiKey, capabilities ?? [],
         JSON.stringify(tools ?? []), status, deployedAt,
         lastActiveAt ?? null, storageRef ?? null, platformToken ?? null,
         walletAddress, publicKey, encryptedPrivateKey, rawPrivateKey ?? null,
         inftTokenId ?? null, minReward ?? null],
      );
    }

    // agent:executor:all may be a string (JSON map) or a SET (old format).
    // Check the type so we don't throw WRONGTYPE on redis.get().
    const keyType = await redis.type('agent:executor:all');
    if (keyType === 'string') {
      const execRaw = await redis.get('agent:executor:all');
      if (execRaw) {
        const executors = JSON.parse(execRaw);
        if (Object.keys(executors).length > 0) {
          for (const [addr, d] of Object.entries(executors)) {
            const data = d as Record<string, unknown>;
            if (!addr || !data.displayName) continue;
            await p.query(
              `INSERT INTO agent_executors
                 (address, display_name, capabilities, public_key, reputation,
                  tasks_completed, total_earned_raw, min_reward,
                  preferred_capabilities, agent_card_url, mcp_endpoint_url,
                  registered_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
               -- Backfill only: NEVER overwrite a row that registerAgent /
               -- recordWorkerPayout has since advanced in PG, or a redeploy that
               -- re-runs this one-time migration reverts live earnings/reputation.
               ON CONFLICT (address) DO NOTHING`,
              [addr, data.displayName, data.capabilities ?? [],
               data.publicKey ?? '', data.reputation ?? 50,
               data.tasksCompleted ?? 0, data.totalEarnedRaw ?? '0',
               data.minReward ?? null, data.preferredCapabilities ?? [],
               data.agentCardUrl ?? null, data.mcpEndpointUrl ?? null,
               data.registeredAt ?? new Date().toISOString()],
            );
          }
        }
      }
    } else if (keyType === 'set') {
      const members = await redis.smembers('agent:executor:all');
      for (const addr of members) {
        const raw = await redis.get(`agent:executor:${addr}`);
        if (!raw) continue;
        const data = JSON.parse(raw) as Record<string, unknown>;
        if (!addr || !data.displayName) continue;
        await p.query(
          `INSERT INTO agent_executors
             (address, display_name, capabilities, public_key, reputation,
              tasks_completed, total_earned_raw, min_reward,
              preferred_capabilities, agent_card_url, mcp_endpoint_url,
              registered_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
           -- Backfill only: NEVER overwrite a row that registerAgent /
           -- recordWorkerPayout has since advanced in PG (see the string-format
           -- branch above) — DO NOTHING keeps a redeploy from reverting earnings.
           ON CONFLICT (address) DO NOTHING`,
          [addr, data.displayName, data.capabilities ?? [],
           data.publicKey ?? '', data.reputation ?? 50,
           data.tasksCompleted ?? 0, data.totalEarnedRaw ?? '0',
           data.minReward ?? null, data.preferredCapabilities ?? [],
           data.agentCardUrl ?? null, data.mcpEndpointUrl ?? null,
           data.registeredAt ?? new Date().toISOString()],
        );
      }
    }
  } finally {
    if (redis) await redis.quit().catch(() => {});
  }
}
