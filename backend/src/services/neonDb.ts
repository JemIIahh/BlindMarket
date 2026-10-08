import pg from 'pg';
import { config } from '../config.js';
import { pricingUnit } from './settlementUnits.js';
import { USDC_UNIT } from './settlementChains.js';
import { Redis } from 'ioredis';

const { Pool } = pg;

let pool: pg.Pool | null = null;
const POOL_MAX = 10;
const POOL_CONNECT_TIMEOUT_MS = 10_000;
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
      // pg's default size, made explicit. Without a connect timeout, connect()
      // waited forever once every client was checked out, so one leaked client
      // per dropped connection hung every request after the tenth instead of
      // failing it (delta audit 2026-10-06, ops-1).
      max: POOL_MAX,
      connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
    });
    // An idle client whose connection drops (a Postgres restart, an idle
    // timeout on the server) is removed by the pool, which then emits 'error'.
    // With no listener that is an uncaught exception and the process exits.
    pool.on('error', (err) => console.error('[neonDb] idle Postgres client dropped:', err.message));
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

// Write every schema migration so it is safe to run twice (CREATE TABLE /
// INDEX / EXTENSION IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, DROP … IF EXISTS).
// If two branches ever reuse an id, runMigrations re-applies this build's
// migration only when isRerunSafe() says so; anything else (data fixes like
// #16) is flagged for a person instead of being run blind.
// `when` limits a migration to deployments it applies to. When it returns
// false the migration is skipped and left unrecorded, so it runs later if the
// deployment changes to match.
const migrations: Array<{ id: number; name: string; sql: string; when?: () => boolean }> = [
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
  {
    id: 31,
    name: 'settlement_amounts_to_usdc_units',
    // Only where this deployment PRICES in USDC: amounts on a stack that
    // prices in 0G really are 18-decimal and must stay as they are. Keyed on
    // the pricing unit, not on "a Base escrow exists", because a stack can
    // have a Base escrow (withdrawals, CCTP) while posting — and pricing — on
    // 0G. A skipped `when` is not recorded, so this would otherwise fire the
    // first boot after such a stack added a Base escrow and divide every 0G
    // price by 10^12, irreversibly.
    when: () => pricingUnit().decimals === USDC_UNIT.decimals,
    sql: `
      -- Service prices and agent minimum rewards were written with 18
      -- decimals (the web app used parseEther, SDK samples used 1 0G = 10^18)
      -- while Base settles in USDC with 6. Convert them so the amount the UI
      -- showed is the amount charged: divide by 10^12, rounding up so no paid
      -- listing becomes free. Values under 10^12 (1,000,000 USDC) are already
      -- USDC base units and stay as they are. services/settlementUnits.ts
      -- applies the same rule to amounts old clients still send.
      UPDATE agent_services
         SET price_raw = CEIL(price_raw::numeric / 1000000000000)::text
       WHERE price_raw ~ '^[0-9]+$' AND price_raw::numeric >= 1000000000000;
      UPDATE deployed_agents
         SET min_reward = CEIL(min_reward::numeric / 1000000000000)::text
       WHERE min_reward ~ '^[0-9]+$' AND min_reward::numeric >= 1000000000000;
      UPDATE agent_executors
         SET min_reward = CEIL(min_reward::numeric / 1000000000000)::text
       WHERE min_reward ~ '^[0-9]+$' AND min_reward::numeric >= 1000000000000;
    `,
  },
  {
    // SDK 0.6.0: workers tell the backend which chains they have an RPC for
    // so they only get offered tasks they can actually settle.
    // Recorded on production as-is: never edit this entry. Its NOT NULL
    // DEFAULT '{0g}' is undone by migration 36.
    id: 32,
    name: 'agent_executors_supported_chains',
    sql: `
      ALTER TABLE agent_executors ADD COLUMN IF NOT EXISTS supported_chains TEXT[] NOT NULL DEFAULT '{0g}';
    `,
  },
  {
    id: 33,
    name: 'agent_executors_usdc_earnings',
    // total_earned_raw holds native 0G (18 decimals); USDC payouts (6
    // decimals, Base now and Arc later) get their own total so the two are
    // never added together.
    sql: `ALTER TABLE agent_executors ADD COLUMN IF NOT EXISTS total_earned_usdc_raw TEXT NOT NULL DEFAULT '0';`,
  },
  {
    id: 34,
    name: 'credited_payouts',
    // Durable at-most-once gate for earnings credits (services/creditLedger.ts).
    // The Redis marker alone is lost on a snapshot restore while the credits
    // in agent_executors stay, so the next ruling scan credited them again.
    sql: `
      CREATE TABLE IF NOT EXISTS credited_payouts (
        task_hash TEXT PRIMARY KEY,
        chain TEXT NOT NULL,
        executor TEXT NOT NULL,
        credited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    id: 35,
    name: 'transactions_unit',
    // The currency a ledger row's amount/fee/net are in ('USDC', '0G'). Rows
    // from before this column are NULL: they are in whatever this deployment
    // paid in at the time. Summaries never add different units together.
    sql: `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS unit TEXT;`,
  },
  {
    id: 36,
    name: 'agent_executors_supported_chains_nullable',
    // supported_chains is what the executor's code declared at registration;
    // NULL = registered by code that predates the field, which handles
    // exactly 0G and Base (executorChains.LEGACY_SUPPORTED_CHAINS). Migration
    // 32 made the column NOT NULL DEFAULT '{0g}', stamping every existing
    // executor 0G-only. Routing reads the column, so the stamp would stop
    // those agents being offered Base tasks, and SDK 0.6 treats a stored
    // subset as the operator's choice and never re-declares it. A stamp
    // can't be told from a declared ['0g'], so every {0g} row goes back to
    // NULL; worker.js and the SDK declare their real chains at their next
    // registration. `<@` also catches '{}' and '{0g,0g}' (master's route did
    // not dedupe).
    sql: `
      ALTER TABLE agent_executors ALTER COLUMN supported_chains DROP NOT NULL;
      ALTER TABLE agent_executors ALTER COLUMN supported_chains DROP DEFAULT;
      UPDATE agent_executors SET supported_chains = NULL
       WHERE supported_chains <@ ARRAY['0g']::TEXT[];
    `,
  },
  {
    id: 37,
    name: 'agent_reviews_canonical_task_id',
    // One review per task per poster, however the task hash is spelled.
    // POST /marketplace/reviews stored the id as sent while its gate read the
    // task case-insensitively, so each re-cased spelling of one hash added a
    // review (security audit run 1, C12). Keeps the earliest row of each
    // (task, reviewer), lowercases task_id (reviewStore now writes it
    // lowercase), and enforces it in the database. A data fix: not re-run.
    sql: `
      DELETE FROM agent_reviews a USING agent_reviews b
       WHERE LOWER(a.task_id) = LOWER(b.task_id)
         AND a.reviewer_address = b.reviewer_address
         AND a.id > b.id;
      UPDATE agent_reviews SET task_id = LOWER(task_id) WHERE task_id <> LOWER(task_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_reviews_task_reviewer_lower
        ON agent_reviews (LOWER(task_id), reviewer_address);
    `,
  },
  {
    id: 38,
    name: 'lowercase_reputation_addresses',
    // reputationDecay keyed rows by the caller's casing: settlement wrote the
    // EIP-55 principal of hosted workers and chain reads, while the ranker read
    // the lowercase address and saw none of it (security audit run 1, C31).
    // It now lowercases every address; this merges the rows already split by
    // case under the lowercase key (sums the counters, keeps the latest
    // last_task_at), deletes the mixed-case rows and lowercases the event log.
    // A re-run finds nothing to merge, but it is a data fix: applied once.
    sql: `
      INSERT INTO reputation_history (address, raw_score, tasks_completed, disputes, last_task_at)
      SELECT LOWER(address), SUM(raw_score), SUM(tasks_completed), SUM(disputes), MAX(last_task_at)
        FROM reputation_history
       GROUP BY LOWER(address)
      ON CONFLICT (address) DO UPDATE SET
        raw_score = EXCLUDED.raw_score,
        tasks_completed = EXCLUDED.tasks_completed,
        disputes = EXCLUDED.disputes,
        last_task_at = EXCLUDED.last_task_at;
      DELETE FROM reputation_history WHERE address <> LOWER(address);
      UPDATE reputation_events SET address = LOWER(address) WHERE address <> LOWER(address);
    `,
  },
  {
    id: 39,
    name: 'deployed_agents_verifier_enabled',
    // Owner opt-in for verifier duty (security audit run 1, C04). Off for
    // every agent, existing ones included: until now any poster could make a
    // hosted agent judge and settle tasks on its owner's model and gas.
    // 37 and 38 are taken by the trust-signals migrations.
    sql: `ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS verifier_enabled BOOLEAN NOT NULL DEFAULT false;`,
  },
  {
    id: 40,
    name: 'spent_deploy_payments',
    // Durable record of which deploy-fee payments paid for an agent
    // (services/spentDeployPayments.ts; security audit run 1, C29). 37-39 are
    // taken by other fix batches.
    sql: `
      CREATE TABLE IF NOT EXISTS spent_deploy_payments (
        payment_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        agent_id TEXT,
        claimed_at BIGINT NOT NULL
      );`,
  },
  {
    id: 41,
    name: 'deployed_agents_delegation_enabled',
    // Owner opt-in for delegate_to_agent, off for every agent, existing ones
    // included (services/delegationGuard.ts).
    sql: `ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS delegation_enabled BOOLEAN NOT NULL DEFAULT false;`,
  },
  {
    id: 42,
    name: 'deployed_agents_privy_user_id',
    // The Privy user who deployed the agent, for per-person limits. NULL for
    // agents deployed before it, or through an API key or agent token.
    sql: `ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS privy_user_id TEXT;`,
  },
  {
    id: 43,
    name: 'gas_sponsorship',
    // Sponsored agent gas (docs/AGENT-GAS-FUNDING.md; services/gasSponsorStore.ts).
    // Postgres only: there is no SQLite mirror, and sponsorship refuses to run
    // without Postgres. One reservation per (chain, escrow task, kind); every
    // sponsored transaction is written here, signed, before it is broadcast.
    sql: `
      CREATE TABLE IF NOT EXISTS gas_sponsor_reservations (
        id BIGSERIAL PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        task_id BIGINT NOT NULL,
        kind TEXT NOT NULL,
        task_hash TEXT NOT NULL,
        agent_wallet TEXT NOT NULL,
        owner_did TEXT NOT NULL,
        poster TEXT NOT NULL,
        status TEXT NOT NULL,
        budget_wei NUMERIC(78, 0) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        settled_at TIMESTAMPTZ,
        tx_hash TEXT,
        gas_used BIGINT,
        cost_wei NUMERIC(78, 0),
        UNIQUE (chain_id, task_id, kind)
      );
      CREATE INDEX IF NOT EXISTS idx_gas_sponsor_res_created ON gas_sponsor_reservations (chain_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_gas_sponsor_res_agent ON gas_sponsor_reservations (chain_id, agent_wallet, status);
      CREATE INDEX IF NOT EXISTS idx_gas_sponsor_res_owner ON gas_sponsor_reservations (chain_id, owner_did, created_at);
      CREATE INDEX IF NOT EXISTS idx_gas_sponsor_res_poster ON gas_sponsor_reservations (chain_id, poster, created_at);
      CREATE TABLE IF NOT EXISTS gas_sponsor_txs (
        id BIGSERIAL PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        reservation_id BIGINT NOT NULL REFERENCES gas_sponsor_reservations (id),
        sponsor TEXT NOT NULL,
        nonce BIGINT NOT NULL,
        raw_tx TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        with_authorization BOOLEAN NOT NULL DEFAULT false,
        status TEXT NOT NULL,
        gas_used BIGINT,
        cost_wei NUMERIC(78, 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tx_hash)
      );
      -- One transaction per sponsor nonce; one the node rejected outright never
      -- entered a pool, so its nonce is free again.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_gas_sponsor_txs_nonce ON gas_sponsor_txs (chain_id, sponsor, nonce) WHERE status <> 'rejected';
      CREATE INDEX IF NOT EXISTS idx_gas_sponsor_txs_res ON gas_sponsor_txs (reservation_id);
      CREATE INDEX IF NOT EXISTS idx_gas_sponsor_txs_status ON gas_sponsor_txs (chain_id, status, created_at);
      CREATE TABLE IF NOT EXISTS gas_sponsor_strikes (
        id BIGSERIAL PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        agent_wallet TEXT NOT NULL,
        owner_did TEXT NOT NULL,
        reservation_id BIGINT NOT NULL UNIQUE REFERENCES gas_sponsor_reservations (id),
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_gas_sponsor_strikes_agent ON gas_sponsor_strikes (chain_id, agent_wallet, created_at);
      CREATE INDEX IF NOT EXISTS idx_gas_sponsor_strikes_owner ON gas_sponsor_strikes (chain_id, owner_did, created_at);
      CREATE TABLE IF NOT EXISTS agent_key_exports (
        id BIGSERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_agent_key_exports_wallet ON agent_key_exports (wallet);
      CREATE TABLE IF NOT EXISTS gas_sponsor_controls (
        chain_id INTEGER PRIMARY KEY,
        paused BOOLEAN NOT NULL DEFAULT false,
        killed BOOLEAN NOT NULL DEFAULT false,
        reason TEXT,
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );`,
  },
  {
    id: 44,
    name: 'gas_sponsor_reservations_returned_at',
    // When the agent handed back a task the escrow already assigns it (POST
    // /release refused ON_CHAIN_LOCKED). The reservation stays held, so a
    // resume is still sponsored, and at its hour it is released without a
    // strike (gasSponsorRelayer.sweepReservations). Postgres only, like 43.
    sql: `ALTER TABLE gas_sponsor_reservations ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;`,
  },
  {
    id: 45,
    name: 'deployed_agents_open_submission_enabled',
    // Owner opt-in for competing in open-submission tasks: each attempt
    // spends the agent's model budget and gas, with no pay unless it wins.
    // Off for every agent, existing ones included (docs/OPEN-SUBMISSION-TASKS.md).
    sql: `ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS open_submission_enabled BOOLEAN NOT NULL DEFAULT false;`,
  },
];

/**
 * Compare the migrations this build expects with what the database recorded.
 * `runMigrations` skips by id only, so an id applied under a DIFFERENT name
 * (two branches both used id 27) is never re-applied — that is how a local DB
 * silently missed `deployed_agents.smart_account_address`. Surfaced by
 * GET /health/db; returns ids only, nothing sensitive.
 */
export async function getSchemaStatus(p: pg.Pool): Promise<{
  latestExpected: number;
  latestApplied: number | null;
  missing: number[];
  nameMismatch: number[];
}> {
  const { rows } = await p.query<{ id: number; name: string }>('SELECT id, name FROM schema_migrations');
  const applied = new Map(rows.map((r) => [Number(r.id), r.name]));
  return {
    latestExpected: latestMigrationId(),
    latestApplied: rows.length ? Math.max(...rows.map((r) => Number(r.id))) : null,
    missing: migrations.filter((m) => !applied.has(m.id) && appliesHere(m)).map((m) => m.id),
    nameMismatch: migrations.filter((m) => applied.has(m.id) && applied.get(m.id) !== m.name).map((m) => m.id),
  };
}

const RERUN_SAFE_STATEMENT = [
  /^CREATE TABLE IF NOT EXISTS\b/i,
  /^CREATE (UNIQUE )?INDEX IF NOT EXISTS\b/i,
  /^CREATE EXTENSION IF NOT EXISTS\b/i,
  /^ALTER TABLE (IF EXISTS )?\S+ (ADD COLUMN IF NOT EXISTS|DROP COLUMN IF EXISTS|DROP CONSTRAINT IF EXISTS)\b/i,
  /^DROP (TABLE|INDEX) IF EXISTS\b/i,
];

/**
 * True only when every statement in `sql` is a schema change that is a no-op
 * the second time. Conservative on purpose: anything it can't classify
 * (UPDATE/INSERT, DO blocks, a semicolon inside a string) counts as unsafe.
 */
export function isRerunSafe(sql: string): boolean {
  const statements = sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((st) => st.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return statements.length > 0 && statements.every((st) => RERUN_SAFE_STATEMENT.some((re) => re.test(st)));
}

/** This build's migrations, id + name only (for diagnostics and tests). */
function appliesHere(m: { when?: () => boolean }): boolean {
  return m.when ? m.when() : true;
}

export function listMigrations(): Array<{ id: number; name: string }> {
  return migrations.map(({ id, name }) => ({ id, name }));
}

/** One migration's SQL, for tests that pin what production has recorded. */
export function migrationSql(id: number): string | undefined {
  return migrations.find((m) => m.id === id)?.sql;
}

/** Ids of this build's migrations that must never be re-run automatically. */
export function rerunUnsafeMigrationIds(): number[] {
  return migrations.filter((m) => !isRerunSafe(m.sql)).map((m) => m.id);
}

export function latestMigrationId(): number {
  return migrations[migrations.length - 1].id;
}

export async function runMigrations(p: pg.Pool): Promise<void> {
  const client = await p.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const { rows: applied } = await client.query<{ id: number; name: string }>(
      'SELECT id, name FROM schema_migrations',
    );
    const appliedNames = new Map(applied.map((r) => [Number(r.id), r.name]));

    for (const m of migrations) {
      const recorded = appliedNames.get(m.id);
      if (recorded === m.name) continue;
      if (!appliesHere(m)) continue;
      if (recorded !== undefined) {
        // Same id, different name: two branches used this number, so THIS
        // migration was never applied here. Skipping by id alone is how a
        // local DB silently lost deployed_agents.smart_account_address.
        // Never block startup over it — re-apply when that's a no-op-safe
        // schema change, otherwise leave it for a person. GET /health/db
        // keeps reporting the mismatch until schema_migrations is reconciled.
        if (isRerunSafe(m.sql)) {
          await client.query(m.sql);
          console.warn(`[neonDb] ⚠ migration ${m.id} is recorded as '${recorded}', but this build's #${m.id} is '${m.name}' (two branches used the same number). Re-applied it — it is safe to re-run — so its schema change isn't lost. Reconcile schema_migrations; see GET /health/db.`);
        } else {
          console.error(`[neonDb] ⛔ migration ${m.id} is recorded as '${recorded}', but this build's #${m.id} is '${m.name}' (two branches used the same number). It is NOT safe to re-run automatically, so it has NOT been applied. Apply it by hand, then reconcile schema_migrations; see GET /health/db.`);
        }
        continue;
      }
      await client.query(m.sql);
      await client.query(
        'INSERT INTO schema_migrations (id, name) VALUES ($1, $2)',
        [m.id, m.name],
      );
      console.log(`[neonDb] Applied migration ${m.id}: ${m.name}`);
    }
    assertPricingUnitUnchanged(appliedNames);
  } finally {
    client.release();
  }
}

/**
 * Migration 31 converted every stored price and reward floor to USDC base
 * units and is recorded only where it ran. A deployment that recorded it and
 * later switches to pricing in 0G (POSTING_CHAIN=0g) would read those
 * 6-decimal amounts as wei: a 5 USDC listing becomes 5·10⁻¹² 0G and every
 * reward floor passes. Nothing re-keys them, so refuse to run, unless the
 * operator has re-keyed the rows by hand and says so.
 */
export function assertPricingUnitUnchanged(
  applied: ReadonlyMap<number, string>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!applied.has(31)) return;
  const unit = pricingUnit();
  if (unit.decimals === USDC_UNIT.decimals) return;
  if (env.ALLOW_PRICING_UNIT_CHANGE === 'true') {
    console.warn(`[neonDb] ⚠ this database was priced in USDC (migration 31) but the posting chain prices in ${unit.symbol}; ALLOW_PRICING_UNIT_CHANGE=true, so stored prices are taken as ${unit.symbol}`);
    return;
  }
  throw new Error(
    `This database was priced in USDC (migration 31 is recorded), but the posting chain prices in ${unit.symbol} ` +
      `(${unit.decimals} decimals). Stored service prices and reward floors would be read as ${unit.symbol} wei. ` +
      `Unset POSTING_CHAIN, or re-key agent_services.price_raw and *.min_reward by hand and set ALLOW_PRICING_UNIT_CHANGE=true.`,
  );
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
