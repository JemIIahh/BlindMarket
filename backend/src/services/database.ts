import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DB_DIR, 'blindmarket.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  return db;
}

// --- Migration runner ---

interface Migration {
  id: number;
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    id: 1,
    name: 'custody_entries_and_audit_log',
    sql: `
      CREATE TABLE IF NOT EXISTS custody_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        submitter TEXT NOT NULL,
        data_snapshot TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_custody_task ON custody_entries(task_id);

      CREATE TABLE IF NOT EXISTS custody_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        entry_id INTEGER REFERENCES custody_entries(id),
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_audit_task ON custody_audit_log(task_id);
    `,
  },
  {
    id: 2,
    name: 'reputation_history_and_events',
    sql: `
      CREATE TABLE IF NOT EXISTS reputation_history (
        address TEXT PRIMARY KEY,
        raw_score REAL NOT NULL DEFAULT 0,
        tasks_completed INTEGER NOT NULL DEFAULT 0,
        disputes INTEGER NOT NULL DEFAULT 0,
        last_task_at TEXT
      );

      CREATE TABLE IF NOT EXISTS reputation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        score_delta REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rep_events_addr ON reputation_events(address);
    `,
  },
  {
    id: 3,
    name: 'stakes',
    sql: `
      CREATE TABLE IF NOT EXISTS stakes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        worker TEXT NOT NULL,
        task_id TEXT NOT NULL UNIQUE,
        task_reward REAL NOT NULL,
        stake_amount REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'locked',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_stakes_worker ON stakes(worker);
      CREATE INDEX IF NOT EXISTS idx_stakes_task ON stakes(task_id);
    `,
  },
  {
    id: 4,
    name: 'transactions',
    sql: `
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        role TEXT NOT NULL,
        task_id TEXT,
        type TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        fee REAL NOT NULL DEFAULT 0,
        net REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'confirmed',
        tx_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_tx_address ON transactions(address);
      CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
      CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);
    `,
  },
  {
    id: 5,
    name: 'applications',
    sql: `
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        applicant TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(task_id, applicant)
      );
      CREATE INDEX IF NOT EXISTS idx_applications_task ON applications(task_id);
      CREATE INDEX IF NOT EXISTS idx_applications_applicant ON applications(applicant);
    `,
  },
  {
    id: 6,
    name: 'analytics_events',
    sql: `
      CREATE TABLE IF NOT EXISTS analytics_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        anon_id TEXT,
        session_id TEXT,
        address TEXT,
        path TEXT,
        referrer TEXT,
        props TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics_events(event);
      CREATE INDEX IF NOT EXISTS idx_analytics_created ON analytics_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_analytics_anon ON analytics_events(anon_id);
      CREATE INDEX IF NOT EXISTS idx_analytics_session ON analytics_events(session_id);
    `,
  },
  {
    id: 7,
    name: 'lowercase_transaction_addresses',
    sql: `UPDATE transactions SET address = LOWER(address) WHERE address != LOWER(address);`,
  },
  {
    id: 8,
    name: 'custody_integrity_hash',
    // Deterministic commitment over a custody entry's immutable fields, stored at
    // ingest so verifyIntegrity can actually recompute + compare it (previously a
    // no-op that always reported "valid").
    sql: `ALTER TABLE custody_entries ADD COLUMN integrity_hash TEXT;`,
  },
  {
    id: 9,
    name: 'deployed_agents',
    sql: `
      CREATE TABLE IF NOT EXISTS deployed_agents (
        id TEXT PRIMARY KEY,
        owner_address TEXT NOT NULL,
        authorized_owners TEXT DEFAULT '[]',
        name TEXT NOT NULL,
        instructions TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key TEXT NOT NULL DEFAULT '',
        encrypted_api_key TEXT NOT NULL DEFAULT '',
        capabilities TEXT DEFAULT '[]',
        tools TEXT DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'stopped',
        deployed_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_active_at TEXT,
        storage_ref TEXT,
        platform_token TEXT,
        wallet_address TEXT NOT NULL,
        public_key TEXT NOT NULL,
        encrypted_private_key TEXT NOT NULL,
        raw_private_key TEXT,
        inft_token_id INTEGER,
        min_reward TEXT,
        skills TEXT DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_deployed_owner ON deployed_agents(owner_address);
    `,
  },
  {
    id: 10,
    name: 'agent_executors',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_executors (
        address TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        capabilities TEXT DEFAULT '[]',
        public_key TEXT NOT NULL DEFAULT '',
        agent_card_url TEXT,
        mcp_endpoint_url TEXT,
        min_reward TEXT,
        preferred_capabilities TEXT,
        reputation INTEGER NOT NULL DEFAULT 50,
        tasks_completed INTEGER NOT NULL DEFAULT 0,
        total_earned_raw TEXT NOT NULL DEFAULT '0',
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    id: 11,
    name: 'smart_account_address',
    sql: `ALTER TABLE deployed_agents ADD COLUMN smart_account_address TEXT;`,
  },
  {
    id: 12,
    name: 'agent_usage',
    sql: `
      CREATE TABLE IF NOT EXISTS agent_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        task_hash TEXT,
        provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_usage_agent ON agent_usage(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_usage_created ON agent_usage(created_at);
    `,
  },
  {
    // M2 (audit): mirrors neonDb migration 29 — toolSecrets were built but
    // never stored, so the worker saw {} after a (re)start.
    id: 13,
    name: 'deployed_agents_tool_secrets',
    sql: `ALTER TABLE deployed_agents ADD COLUMN tool_secrets TEXT DEFAULT '{}';
      ALTER TABLE deployed_agents ADD COLUMN encrypted_tool_secrets TEXT DEFAULT '{}';`,
  },
  {
    // SDK 0.6.0: workers tell the backend which chains they have an RPC for.
    // Mirror of Postgres migration 32; its '[]' default reads back as null
    // (agentStore.rowToAgent) and migration 18 clears the rows it stamped.
    id: 14,
    name: 'agent_executors_supported_chains',
    sql: `ALTER TABLE agent_executors ADD COLUMN supported_chains TEXT DEFAULT '[]';`,
  },
  {
    // Mirror of Postgres migration 33. SQLite has no ADD COLUMN IF NOT EXISTS;
    // this runner applies each id once.
    id: 15,
    name: 'agent_executors_usdc_earnings',
    sql: `ALTER TABLE agent_executors ADD COLUMN total_earned_usdc_raw TEXT NOT NULL DEFAULT '0';`,
  },
  {
    // Mirror of Postgres migration 34 (services/creditLedger.ts).
    id: 16,
    name: 'credited_payouts',
    sql: `CREATE TABLE IF NOT EXISTS credited_payouts (
        task_hash TEXT PRIMARY KEY,
        chain TEXT NOT NULL,
        executor TEXT NOT NULL,
        credited_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`,
  },
  {
    // Mirror of Postgres migration 35.
    id: 17,
    name: 'transactions_unit',
    sql: `ALTER TABLE transactions ADD COLUMN unit TEXT;`,
  },
  {
    // Mirror of Postgres migration 36: a JSON array, NULL for legacy rows.
    // SQLite can't drop a column default without rebuilding the table, and
    // registerAgent always writes the column, so only the stamped rows change:
    // every array holding nothing but '0g' ('[]', '["0g"]', '["0g","0g"]').
    // The nested CASEs keep json_type and json_each away from a malformed
    // value (either would throw and abort the migration, and boot with it)
    // without relying on AND evaluation order, which SQLite does not promise.
    id: 18,
    name: 'agent_executors_supported_chains_nullable',
    sql: `UPDATE agent_executors SET supported_chains = NULL
      WHERE CASE WHEN json_valid(supported_chains)
        THEN CASE WHEN json_type(supported_chains) = 'array'
          THEN NOT EXISTS (SELECT 1 FROM json_each(agent_executors.supported_chains) WHERE value <> '0g')
          ELSE 0 END
        ELSE 0 END;`,
  },
];

/** One migration's SQL, for tests of what a migration does to existing rows. */
export function sqliteMigrationSql(id: number): string | undefined {
  return migrations.find((m) => m.id === id)?.sql;
}

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    database
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((row: any) => row.id as number),
  );

  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    database.exec(m.sql);
    database
      .prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)')
      .run(m.id, m.name);
    console.log(`[db] Applied migration ${m.id}: ${m.name}`);
  }
}
