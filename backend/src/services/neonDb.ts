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

// No-op pool returned when DATABASE_URL is empty — lets PG-only services
// return empty results instead of throwing on every request.
const EMPTY_ROWS: never[] = [];
const EMPTY_RESULT: pg.QueryResult = { rows: EMPTY_ROWS, rowCount: 0, command: '', oid: 0, fields: [] };
const noopPool = new Proxy({} as pg.Pool, {
  get(_target, prop) {
    if (prop === 'query') {
      return async () => EMPTY_RESULT;
    }
    if (prop === 'connect') {
      return async () => ({
        query: async () => EMPTY_RESULT,
        release: () => {},
      });
    }
    if (prop === 'end') {
      return async () => {};
    }
    return undefined;
  },
});

export async function getPool(): Promise<pg.Pool> {
  if (!config.databaseUrl) {
    // Return a no-op pool so PG-only services degrade gracefully in dev
    // instead of throwing on every request.
    return noopPool;
  }

  if (!pool) {
    // Neon requires SSL, but node-postgres can't verify Neon's cert chain
    // without an explicitly configured CA — forcing sslmode=verify-full made
    // every query fail. Connect over TLS without CA verification (the semantics
    // of sslmode=require), which is the standard Neon + node-postgres setup.
    //
    // A local Postgres (dev/CI) usually has no SSL — honor an explicit
    // `sslmode=disable` in the connection string so `DATABASE_URL=…?sslmode=disable`
    // connects plaintext. Neon URLs never carry that, so prod is unaffected.
    const sslDisabled = /[?&]sslmode=disable\b/.test(config.databaseUrl);
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: sslDisabled ? false : { rejectUnauthorized: false },
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

  // One-shot data migration: copy agents from Redis to PG. Started here but
  // deliberately NOT awaited.
  //
  // It used to be awaited, which put a Redis round trip per agent key on the
  // critical path of the FIRST database-backed request of every process — and
  // getPool() gates all of them. Against a remote Redis that is ~800ms per
  // key (measured: type + get on Redis Cloud us-east-1), so ~97 agent keys
  // stalled every request behind ~80s of network plus the inserts. The
  // symptom was a backend that answered /health instantly and hung on
  // everything else, which reads as a dead database rather than a slow copy.
  //
  // Awaiting it was never required for correctness: the schema migration above
  // is what queries depend on, this only back-fills rows, its failure is
  // already swallowed as non-fatal, and every INSERT is ON CONFLICT DO
  // NOTHING. Set SKIP_REDIS_PG_MIGRATION=true to not run it at all.
  if (!dataMigrationPromise && process.env.SKIP_REDIS_PG_MIGRATION !== 'true') {
    dataMigrationPromise = migrateRedisToPg(pool).catch((err) => {
      console.warn('[neonDb] Redis → PG data migration failed (non-fatal):', (err as Error).message);
    });
  }

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
  {
    id: 13,
    name: 'agent_skills',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_skills (
        id SERIAL PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL CHECK (char_length(name) BETWEEN 3 AND 80),
        description TEXT NOT NULL DEFAULT '',
        version TEXT NOT NULL DEFAULT '1.0.0',
        author_address TEXT NOT NULL,
        instructions TEXT NOT NULL,
        tools JSONB NOT NULL DEFAULT '[]',
        secret_refs JSONB NOT NULL DEFAULT '[]',
        capabilities TEXT[] NOT NULL DEFAULT '{}',
        source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local','skillmd','mcp','openapi')),
        is_public BOOLEAN NOT NULL DEFAULT false,
        install_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_skills_author ON agent_skills(author_address);
      CREATE INDEX IF NOT EXISTS idx_skills_public ON agent_skills(is_public) WHERE is_public = true;
      CREATE INDEX IF NOT EXISTS idx_skills_caps ON agent_skills USING GIN (capabilities);
    `,
  },
  {
    id: 14,
    name: 'deployed_agents_skills',
    sql: `
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT '[]';
    `,
  },
  {
    id: 15,
    name: 'skill_stats',
    sql: `
      CREATE TABLE IF NOT EXISTS skill_stats (
        agent_address TEXT NOT NULL,
        capability TEXT NOT NULL,
        tasks_completed INTEGER NOT NULL DEFAULT 0,
        tasks_failed INTEGER NOT NULL DEFAULT 0,
        last_task_at TIMESTAMPTZ,
        PRIMARY KEY (agent_address, capability)
      );
    `,
  },
  {
    id: 16,
    name: 'repair_retired_agent_models',
    sql: `
      -- claude-3-haiku-20240307 was retired by Anthropic on 2026-04-19; every
      -- call 404s. claude-haiku-4-5 is the documented drop-in replacement.
      UPDATE deployed_agents
        SET model = 'claude-haiku-4-5', updated_at = NOW()
        WHERE provider = 'anthropic' AND model = 'claude-3-haiku-20240307';
      -- 'claude-sonnet-4-7' never existed (hand-typed at deploy; model was only
      -- validated as a non-empty string). Map to the current Sonnet.
      UPDATE deployed_agents
        SET model = 'claude-sonnet-5', updated_at = NOW()
        WHERE provider = 'anthropic' AND model = 'claude-sonnet-4-7';
    `,
  },
  {
    // Semantic matching (Phase 0): pgvector for embedding-based routing.
    // vector(1024) matches EMBEDDING_DIM default (Voyage voyage-3-large native).
    // Populated by services/agentEmbedding.ts (agents) and, in Phase 1, at
    // /tasks/index (task_embeddings). Non-breaking: columns are nullable and
    // nothing reads them yet.
    id: 17,
    name: 'pgvector_embeddings',
    sql: `
      CREATE EXTENSION IF NOT EXISTS vector;

      ALTER TABLE agent_executors ADD COLUMN IF NOT EXISTS embedding vector(1024);
      ALTER TABLE agent_executors ADD COLUMN IF NOT EXISTS embedding_model TEXT;
      ALTER TABLE agent_executors ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMPTZ;

      CREATE TABLE IF NOT EXISTS task_embeddings (
        task_hash TEXT PRIMARY KEY,
        embedding vector(1024) NOT NULL,
        model TEXT NOT NULL,
        source_text_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_executors_embedding
        ON agent_executors USING hnsw (embedding vector_cosine_ops);
      CREATE INDEX IF NOT EXISTS idx_task_embeddings_vec
        ON task_embeddings USING hnsw (embedding vector_cosine_ops);
    `,
  },
  {
    // Semantic matching (Phase 1): SHADOW log — for every indexed task with
    // routing text, record how semantic KNN would have ranked agents vs the
    // capability-tag ranking, then fill in who actually accepted and whether
    // it settled. This is pure measurement (nothing reads it for routing);
    // the tuning loop compares the two rankings against real outcomes until
    // semantic is provably better ("flip-ready").
    id: 18,
    name: 'match_shadow_log',
    sql: `
      CREATE TABLE IF NOT EXISTS match_shadow_log (
        task_hash TEXT PRIMARY KEY,
        routing_text TEXT NOT NULL,
        embedding_model TEXT NOT NULL,
        semantic_topk JSONB NOT NULL DEFAULT '[]',
        tag_topk JSONB NOT NULL DEFAULT '[]',
        required_capabilities TEXT[] NOT NULL DEFAULT '{}',
        accepted_by TEXT,
        settled BOOLEAN,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_shadow_created ON match_shadow_log(created_at);
    `,
  },
  {
    // Semantic matching (Phase 2 foundation): also record how the RERANKED
    // ranking would order agents, so the prod tuning loop can compare
    // embeddings-only vs embeddings+rerank against real acceptance — the
    // production analog of the offline eval bench. Nullable/back-compat.
    id: 19,
    name: 'shadow_rerank_column',
    sql: `
      ALTER TABLE match_shadow_log ADD COLUMN IF NOT EXISTS semantic_rerank_topk JSONB NOT NULL DEFAULT '[]';
    `,
  },
  {
    // Semantic matching (Phase 2 FLIP): record which ranking actually drove
    // the cascade ('semantic' | 'tag'; NULL = broadcast, flag-off, or
    // pre-flip row — written only while SEMANTIC_ROUTING_ENABLED). Once
    // routing follows the semantic order, accepted_by agreeing with
    // semantic_topk is self-fulfilling — this column lets the shadow metrics
    // be segmented by router, and measures how often the flip engages vs
    // falls back to tags.
    id: 20,
    name: 'shadow_routed_by_column',
    sql: `
      ALTER TABLE match_shadow_log ADD COLUMN IF NOT EXISTS routed_by TEXT;
    `,
  },
  {
    // Off-chain accounting ledger (escrow_lock, payment, fee, refund, stake,
    // slash, stake_return). Previously SQLite-only; in production SQLite is
    // ephemeral, so this PG table is the durable source of truth for volume
    // and earnings queries.
    id: 21,
    name: 'transactions',
    sql: `
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        address TEXT NOT NULL,
        role TEXT NOT NULL,
        task_id TEXT,
        type TEXT NOT NULL,
        amount DOUBLE PRECISION NOT NULL DEFAULT 0,
        fee DOUBLE PRECISION NOT NULL DEFAULT 0,
        net DOUBLE PRECISION NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'confirmed',
        tx_hash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_address ON transactions(address);
      CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
      CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);
    `,
  },
  {
    // Chain-of-custody evidence vault. Previously SQLite-only.
    id: 22,
    name: 'custody_entries',
    sql: `
      CREATE TABLE IF NOT EXISTS custody_entries (
        id SERIAL PRIMARY KEY,
        task_id TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        submitter TEXT NOT NULL,
        data_snapshot TEXT,
        integrity_hash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_custody_task ON custody_entries(task_id);
    `,
  },
  {
    id: 23,
    name: 'custody_audit_log',
    sql: `
      CREATE TABLE IF NOT EXISTS custody_audit_log (
        id SERIAL PRIMARY KEY,
        task_id TEXT NOT NULL,
        entry_id INTEGER REFERENCES custody_entries(id),
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        detail TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_task ON custody_audit_log(task_id);
    `,
  },
  {
    // Worker stake locks. Previously SQLite-only.
    id: 24,
    name: 'stakes',
    sql: `
      CREATE TABLE IF NOT EXISTS stakes (
        id SERIAL PRIMARY KEY,
        worker TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE,
        task_reward DOUBLE PRECISION NOT NULL,
        stake_amount DOUBLE PRECISION NOT NULL,
        status TEXT NOT NULL DEFAULT 'locked',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_stakes_worker ON stakes(worker);
      CREATE INDEX IF NOT EXISTS idx_stakes_task ON stakes(task_id);
    `,
  },
  {
    // Task applications. Previously SQLite-only.
    id: 25,
    name: 'applications',
    sql: `
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        applicant TEXT NOT NULL,
        message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(task_id, applicant)
      );
      CREATE INDEX IF NOT EXISTS idx_applications_task ON applications(task_id);
      CREATE INDEX IF NOT EXISTS idx_applications_applicant ON applications(applicant);
    `,
  },
  {
    // Usage analytics events. Previously SQLite-only.
    id: 26,
    name: 'analytics_events',
    sql: `
      CREATE TABLE IF NOT EXISTS analytics_events (
        id SERIAL PRIMARY KEY,
        event TEXT NOT NULL,
        anon_id TEXT,
        session_id TEXT,
        address TEXT,
        path TEXT,
        referrer TEXT,
        props TEXT,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics_events(event);
      CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_analytics_anon ON analytics_events(anon_id);
      CREATE INDEX IF NOT EXISTS idx_analytics_session ON analytics_events(session_id);
    `,
  },
  {
    id: 27,
    name: 'smart_account_address',
    sql: `ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS smart_account_address TEXT;`,
  },
  {
    id: 28,
    name: 'agent_usage',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_usage (
        id SERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        task_hash TEXT,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_agent_usage_agent ON agent_usage(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_usage_created ON agent_usage(created_at);
    `,
  },
  {
    // M2 (audit): agentRunner builds plaintext + ECIES toolSecrets, but no
    // column ever stored them — the worker always saw {} after a (re)start.
    id: 29,
    name: 'deployed_agents_tool_secrets',
    sql: `
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS tool_secrets JSONB NOT NULL DEFAULT '{}';
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS encrypted_tool_secrets JSONB NOT NULL DEFAULT '{}';
    `,
  },
  {
    // Circle CCTP V2 transfers (Base <-> another EVM chain). One row per
    // burn->attest->mint pipeline, crash-resumable via the background poller
    // in services/cctpAttestationPoller.ts. `idempotency_key` is UNIQUE so a
    // retried request resumes the existing row instead of double-burning.
    id: 30,
    name: 'cctp_transfers',
    sql: `
      CREATE TABLE IF NOT EXISTS cctp_transfers (
        id SERIAL PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
        agent_id TEXT,
        owner_address TEXT NOT NULL,
        source_chain TEXT NOT NULL,
        source_domain INTEGER NOT NULL,
        dest_chain TEXT NOT NULL,
        dest_domain INTEGER NOT NULL,
        usdc_amount_raw TEXT NOT NULL,
        mint_recipient TEXT NOT NULL,
        max_fee_raw TEXT NOT NULL,
        min_finality_threshold INTEGER NOT NULL,
        relay_method TEXT NOT NULL CHECK (relay_method IN ('forwarding_service','self_relay')),
        stage TEXT NOT NULL DEFAULT 'created' CHECK (stage IN (
          'created','approved','burn_submitted','burn_confirmed',
          'attestation_pending','attestation_ready',
          'mint_submitted','mint_confirmed','failed'
        )),
        approve_tx_hash TEXT,
        burn_tx_hash TEXT,
        burn_block_number BIGINT,
        cctp_message_hex TEXT,
        cctp_attestation_hex TEXT,
        mint_tx_hash TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_cctp_transfers_stage ON cctp_transfers(stage)
        WHERE stage NOT IN ('mint_confirmed','failed');
      CREATE INDEX IF NOT EXISTS idx_cctp_transfers_agent ON cctp_transfers(agent_id);
      CREATE INDEX IF NOT EXISTS idx_cctp_transfers_owner ON cctp_transfers(owner_address);
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
    // Same socket hygiene as services/redis.ts: this client walks ~100 keys
    // sequentially against a remote Redis, and one idle-dropped socket with
    // no command timeout would park the whole back-fill for minutes.
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      connectTimeout: 10_000,
      commandTimeout: 15_000,
      keepAlive: 10_000,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(200 * times, 2_000),
    });

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
        toolSecrets, encryptedToolSecrets,
      } = data;
      if (!id) continue;

      await p.query(
        `INSERT INTO deployed_agents
           (id, owner_address, authorized_owners, name, instructions,
            provider, model, api_key, encrypted_api_key, capabilities,
            tools, status, deployed_at, last_active_at, storage_ref,
            platform_token, wallet_address, public_key, encrypted_private_key,
            raw_private_key, inft_token_id, min_reward,
            tool_secrets, encrypted_tool_secrets, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [id, ownerAddress, authorizedOwners ?? [], name, instructions,
         provider, model, apiKey ?? '', encryptedApiKey, capabilities ?? [],
         JSON.stringify(tools ?? []), status, deployedAt,
         lastActiveAt ?? null, storageRef ?? null, platformToken ?? null,
         walletAddress, publicKey, encryptedPrivateKey, rawPrivateKey ?? null,
         inftTokenId ?? null, minReward ?? null,
         JSON.stringify(toolSecrets ?? {}), JSON.stringify(encryptedToolSecrets ?? {})],
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
