import { getPool } from './neonDb.js';
import { getDb } from './database.js';
import { config } from '../config.js';
import type { DeployedAgent, AgentCapability, AgentTool, LLMProvider, AgentStatus, InstalledSkill } from '../types.js';

function usePg(): boolean {
  return Boolean(config.databaseUrl);
}

function rowToAgent(row: Record<string, unknown>): DeployedAgent {
  return {
    id: row.id as string,
    ownerAddress: row.owner_address as string,
    authorizedOwners: safeJsonArray(row.authorized_owners),
    name: row.name as string,
    instructions: row.instructions as string,
    provider: row.provider as LLMProvider,
    model: row.model as string,
    apiKey: row.api_key as string,
    encryptedApiKey: row.encrypted_api_key as string,
    capabilities: safeJsonArray(row.capabilities) as AgentCapability[],
    tools: safeJsonJson(row.tools) as AgentTool[],
    status: (row.status as AgentStatus) ?? 'stopped',
    deployedAt: isoTimestamp(row.deployed_at) ?? new Date().toISOString(),
    lastActiveAt: isoTimestamp(row.last_active_at),
    storageRef: (row.storage_ref as string) ?? undefined,
    platformToken: (row.platform_token as string) ?? undefined,
    walletAddress: row.wallet_address as string,
    smartAccountAddress: (row.smart_account_address as string) ?? undefined,
    publicKey: row.public_key as string,
    encryptedPrivateKey: row.encrypted_private_key as string,
    rawPrivateKey: (row.raw_private_key as string) ?? undefined,
    inftTokenId: (row.inft_token_id as number) ?? undefined,
    minReward: (row.min_reward as string) ?? undefined,
    verifierEnabled: row.verifier_enabled === true || row.verifier_enabled === 1,
    delegationEnabled: row.delegation_enabled === true || row.delegation_enabled === 1,
    privyUserId: typeof row.privy_user_id === 'string' && row.privy_user_id ? row.privy_user_id : undefined,
    skills: safeJsonJson(row.skills) as InstalledSkill[] | undefined,
    // M2 (audit): these columns are new (migrations neonDb:29 / database:13) —
    // older rows read back as undefined, same as a deploy with no secrets.
    toolSecrets: safeJsonRecord(row.tool_secrets),
    encryptedToolSecrets: safeJsonRecord(row.encrypted_tool_secrets),
  };
}

/**
 * A timestamp column as an ISO string. Postgres TIMESTAMPTZ comes back from
 * node-pg as a Date, which reconcileAgents' localeCompare sort threw on
 * (with two or more running agents, at boot); SQLite stores text.
 */
function isoTimestamp(v: unknown): string | undefined {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString();
  return typeof v === 'string' && v ? v : undefined;
}

function safeJsonRecord(v: unknown): Record<string, string> | undefined {
  if (v == null) return undefined;
  const o = typeof v === 'object' ? v : (() => { try { return JSON.parse(v as string); } catch { return undefined; } })();
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(o as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function safeJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
  return [];
}

function safeJsonJson(v: unknown): unknown {
  if (v == null) return undefined;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return undefined; } }
  return undefined;
}

function agentToRow(agent: DeployedAgent): Record<string, unknown> {
  return {
    id: agent.id,
    owner_address: agent.ownerAddress,
    authorized_owners: JSON.stringify(agent.authorizedOwners ?? []),
    name: agent.name,
    instructions: agent.instructions,
    provider: agent.provider,
    model: agent.model,
    api_key: agent.apiKey,
    encrypted_api_key: agent.encryptedApiKey,
    capabilities: JSON.stringify(agent.capabilities),
    tools: JSON.stringify(agent.tools ?? []),
    status: agent.status,
    deployed_at: agent.deployedAt,
    last_active_at: agent.lastActiveAt ?? null,
    storage_ref: agent.storageRef ?? null,
    platform_token: agent.platformToken ?? null,
    wallet_address: agent.walletAddress,
    smart_account_address: agent.smartAccountAddress ?? null,
    public_key: agent.publicKey,
    encrypted_private_key: agent.encryptedPrivateKey,
    raw_private_key: agent.rawPrivateKey ?? null,
    inft_token_id: agent.inftTokenId ?? null,
    min_reward: agent.minReward ?? null,
    verifier_enabled: agent.verifierEnabled ? 1 : 0,
    delegation_enabled: agent.delegationEnabled ? 1 : 0,
    privy_user_id: agent.privyUserId ?? null,
    skills: JSON.stringify(agent.skills ?? []),
    tool_secrets: JSON.stringify(agent.toolSecrets ?? {}),
    encrypted_tool_secrets: JSON.stringify(agent.encryptedToolSecrets ?? {}),
    updated_at: new Date().toISOString(),
  };
}

const PG_COLS = 'id, owner_address, authorized_owners, name, instructions, provider, model, api_key, encrypted_api_key, capabilities, tools, status, deployed_at, last_active_at, storage_ref, platform_token, wallet_address, smart_account_address, public_key, encrypted_private_key, raw_private_key, inft_token_id, min_reward, skills, tool_secrets, encrypted_tool_secrets, verifier_enabled, delegation_enabled, privy_user_id';

export async function saveAgent(agent: DeployedAgent): Promise<void> {
  if (usePg()) {
    const db = await getPool();
    await db.query(
      `INSERT INTO deployed_agents
         (id, owner_address, authorized_owners, name, instructions,
          provider, model, api_key, encrypted_api_key, capabilities,
          tools, status, deployed_at, last_active_at, storage_ref,
          platform_token, wallet_address, smart_account_address, public_key,
          encrypted_private_key, raw_private_key, inft_token_id, min_reward,
          skills, tool_secrets, encrypted_tool_secrets, verifier_enabled,
          delegation_enabled, privy_user_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
         $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, NOW())
       ON CONFLICT (id) DO UPDATE SET
         owner_address = EXCLUDED.owner_address,
         authorized_owners = EXCLUDED.authorized_owners,
         name = EXCLUDED.name,
         instructions = EXCLUDED.instructions,
         provider = EXCLUDED.provider,
         model = EXCLUDED.model,
         api_key = EXCLUDED.api_key,
         encrypted_api_key = EXCLUDED.encrypted_api_key,
         capabilities = EXCLUDED.capabilities,
         tools = EXCLUDED.tools,
         status = EXCLUDED.status,
         last_active_at = EXCLUDED.last_active_at,
         storage_ref = EXCLUDED.storage_ref,
         platform_token = EXCLUDED.platform_token,
         wallet_address = EXCLUDED.wallet_address,
         smart_account_address = EXCLUDED.smart_account_address,
         public_key = EXCLUDED.public_key,
         encrypted_private_key = EXCLUDED.encrypted_private_key,
         raw_private_key = EXCLUDED.raw_private_key,
         inft_token_id = EXCLUDED.inft_token_id,
         min_reward = EXCLUDED.min_reward,
         skills = EXCLUDED.skills,
         tool_secrets = EXCLUDED.tool_secrets,
         encrypted_tool_secrets = EXCLUDED.encrypted_tool_secrets,
         verifier_enabled = EXCLUDED.verifier_enabled,
         delegation_enabled = EXCLUDED.delegation_enabled,
         -- Set once: a save from a copy loaded before the backfill never clears it.
         privy_user_id = COALESCE(deployed_agents.privy_user_id, EXCLUDED.privy_user_id),
         updated_at = NOW()`,
      [
        agent.id, agent.ownerAddress, agent.authorizedOwners ?? [],
        agent.name, agent.instructions, agent.provider, agent.model,
        agent.apiKey, agent.encryptedApiKey, agent.capabilities,
        JSON.stringify(agent.tools ?? []), agent.status,
        agent.deployedAt, agent.lastActiveAt ?? null, agent.storageRef ?? null,
        agent.platformToken ?? null, agent.walletAddress,
        agent.smartAccountAddress ?? null, agent.publicKey,
        agent.encryptedPrivateKey, agent.rawPrivateKey ?? null,
        agent.inftTokenId ?? null, agent.minReward ?? null,
        JSON.stringify(agent.skills ?? []),
        JSON.stringify(agent.toolSecrets ?? {}),
        JSON.stringify(agent.encryptedToolSecrets ?? {}),
        agent.verifierEnabled === true,
        agent.delegationEnabled === true,
        agent.privyUserId ?? null,
      ],
    );
    return;
  }

  // SQLite fallback
  const r = agentToRow(agent);
  const db = getDb();
  const cols = Object.keys(r);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols
    .filter(c => c !== 'id')
    .map(c => (c === 'privy_user_id' ? `${c} = COALESCE(deployed_agents.${c}, excluded.${c})` : `${c} = excluded.${c}`))
    .join(', ');
  db.prepare(
    `INSERT INTO deployed_agents (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updates}`,
  ).run(...Object.values(r));
}

/** The fields of an existing agent that change after deploy. */
export type AgentFieldPatch = Partial<Pick<DeployedAgent,
  'instructions' | 'provider' | 'model' | 'apiKey' | 'encryptedApiKey' | 'tools' | 'capabilities' | 'minReward'
  | 'skills' | 'verifierEnabled' | 'delegationEnabled' | 'status' | 'lastActiveAt' | 'platformToken' | 'authorizedOwners'>>;

// Column and bound value per field, for Postgres and SQLite: the same
// encodings saveAgent uses for each column.
const FIELD_COLUMNS: { [K in keyof Required<AgentFieldPatch>]: { col: string; pg: (v: NonNullable<AgentFieldPatch[K]>) => unknown; sqlite: (v: NonNullable<AgentFieldPatch[K]>) => unknown } } = {
  instructions: { col: 'instructions', pg: (v) => v, sqlite: (v) => v },
  provider: { col: 'provider', pg: (v) => v, sqlite: (v) => v },
  model: { col: 'model', pg: (v) => v, sqlite: (v) => v },
  apiKey: { col: 'api_key', pg: (v) => v, sqlite: (v) => v },
  encryptedApiKey: { col: 'encrypted_api_key', pg: (v) => v, sqlite: (v) => v },
  tools: { col: 'tools', pg: (v) => JSON.stringify(v), sqlite: (v) => JSON.stringify(v) },
  capabilities: { col: 'capabilities', pg: (v) => v, sqlite: (v) => JSON.stringify(v) },
  minReward: { col: 'min_reward', pg: (v) => v, sqlite: (v) => v },
  skills: { col: 'skills', pg: (v) => JSON.stringify(v), sqlite: (v) => JSON.stringify(v) },
  verifierEnabled: { col: 'verifier_enabled', pg: (v) => v === true, sqlite: (v) => (v ? 1 : 0) },
  delegationEnabled: { col: 'delegation_enabled', pg: (v) => v === true, sqlite: (v) => (v ? 1 : 0) },
  status: { col: 'status', pg: (v) => v, sqlite: (v) => v },
  lastActiveAt: { col: 'last_active_at', pg: (v) => v, sqlite: (v) => v },
  platformToken: { col: 'platform_token', pg: (v) => v, sqlite: (v) => v },
  authorizedOwners: { col: 'authorized_owners', pg: (v) => v, sqlite: (v) => JSON.stringify(v) },
};

/**
 * Write only the given fields of an existing agent; every other column keeps
 * whatever it holds now. saveAgent rewrites the whole row from the caller's
 * copy, so a copy loaded before someone else's change undid it: the worker
 * heartbeat reverted an owner's delegation opt-out, and a Stop back to
 * 'running' (delta audit 2026-10-06, deploy-2). With `ifStatus`, the write
 * happens only while the agent's status is still that. Returns whether a row
 * was written; an unknown id writes nothing.
 */
export async function updateAgentFields(
  id: string,
  fields: AgentFieldPatch,
  opts: { ifStatus?: AgentStatus } = {},
): Promise<boolean> {
  const entries = (Object.keys(fields) as Array<keyof AgentFieldPatch>)
    .filter((k) => fields[k] !== undefined && FIELD_COLUMNS[k]);
  if (entries.length === 0) return false;
  if (usePg()) {
    const db = await getPool();
    const params: unknown[] = [id];
    const sets = entries.map((k) => {
      params.push((FIELD_COLUMNS[k].pg as (v: unknown) => unknown)(fields[k]));
      return `${FIELD_COLUMNS[k].col} = $${params.length}`;
    });
    let where = 'id = $1';
    if (opts.ifStatus) { params.push(opts.ifStatus); where += ` AND status = $${params.length}`; }
    const res = await db.query(`UPDATE deployed_agents SET ${sets.join(', ')}, updated_at = NOW() WHERE ${where}`, params);
    return (res.rowCount ?? 0) > 0;
  }
  const db = getDb();
  const sets = entries.map((k) => `${FIELD_COLUMNS[k].col} = ?`);
  const values = entries.map((k) => (FIELD_COLUMNS[k].sqlite as (v: unknown) => unknown)(fields[k]));
  let where = 'id = ?';
  const whereValues: unknown[] = [id];
  if (opts.ifStatus) { where += ' AND status = ?'; whereValues.push(opts.ifStatus); }
  const info = db.prepare(`UPDATE deployed_agents SET ${sets.join(', ')}, updated_at = ? WHERE ${where}`)
    .run(...values, new Date().toISOString(), ...whereValues);
  return info.changes > 0;
}

/** Set an agent's status alone; with `from`, only while it is still that. */
export function setAgentStatus(id: string, status: AgentStatus, opts: { from?: AgentStatus } = {}): Promise<boolean> {
  return updateAgentFields(id, { status }, { ifStatus: opts.from });
}

export async function loadAgent(id: string): Promise<DeployedAgent | null> {
  if (usePg()) {
    const db = await getPool();
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT ${PG_COLS} FROM deployed_agents WHERE id = $1`, [id],
    );
    return rows[0] ? rowToAgent(rows[0]) : null;
  }
  const db = getDb();
  const row = db.prepare(`SELECT ${PG_COLS} FROM deployed_agents WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToAgent(row) : null;
}

export async function loadAgentByWallet(walletAddress: string): Promise<DeployedAgent | null> {
  if (usePg()) {
    const db = await getPool();
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT ${PG_COLS} FROM deployed_agents WHERE LOWER(wallet_address) = LOWER($1) LIMIT 1`, [walletAddress],
    );
    return rows[0] ? rowToAgent(rows[0]) : null;
  }
  const db = getDb();
  const row = db.prepare(`SELECT ${PG_COLS} FROM deployed_agents WHERE LOWER(wallet_address) = LOWER(?) LIMIT 1`).get(walletAddress) as Record<string, unknown> | undefined;
  return row ? rowToAgent(row) : null;
}

/**
 * Reverse lookup: owner EOA for a smart-account address. Used when
 * reconciling chain truth that names a BlindAccount (assignment, worker
 * fields) back to the deployed agent that owns it, so off-chain identity
 * (always the EOA) stays canonical.
 */
export async function loadAgentBySmartAccount(smartAccountAddress: string): Promise<DeployedAgent | null> {
  if (usePg()) {
    const db = await getPool();
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT ${PG_COLS} FROM deployed_agents WHERE LOWER(smart_account_address) = LOWER($1) LIMIT 1`, [smartAccountAddress],
    );
    return rows[0] ? rowToAgent(rows[0]) : null;
  }
  const db = getDb();
  const row = db.prepare(`SELECT ${PG_COLS} FROM deployed_agents WHERE LOWER(smart_account_address) = LOWER(?) LIMIT 1`).get(smartAccountAddress) as Record<string, unknown> | undefined;
  return row ? rowToAgent(row) : null;
}

/**
 * Wallet and smart-account addresses (lowercase) of every hosted agent that
 * one of `owners` owns or is a linked owner of. One query whatever the number
 * of agents, and it reads no key material.
 */
export async function walletsOfOwners(owners: readonly string[]): Promise<string[]> {
  const want = [...new Set(owners.map((o) => o.toLowerCase()))];
  if (want.length === 0) return [];
  let rows: Record<string, unknown>[];
  if (usePg()) {
    const db = await getPool();
    ({ rows } = await db.query<Record<string, unknown>>(
      `SELECT wallet_address, smart_account_address FROM deployed_agents
        WHERE LOWER(owner_address) = ANY($1::text[])
           OR EXISTS (SELECT 1 FROM unnest(authorized_owners) AS o WHERE LOWER(o) = ANY($1::text[]))`,
      [want],
    ));
  } else {
    const db = getDb();
    rows = (db.prepare('SELECT wallet_address, smart_account_address, owner_address, authorized_owners FROM deployed_agents').all() as Record<string, unknown>[])
      .filter((r) => want.includes(String(r.owner_address).toLowerCase())
        || safeJsonArray(r.authorized_owners).some((o) => want.includes(o.toLowerCase())));
  }
  return rows
    .flatMap((r) => [r.wallet_address, r.smart_account_address])
    .filter((a): a is string => typeof a === 'string' && a.length > 0)
    .map((a) => a.toLowerCase());
}

export async function loadAllAgents(): Promise<DeployedAgent[]> {
  if (usePg()) {
    const db = await getPool();
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT ${PG_COLS} FROM deployed_agents ORDER BY deployed_at DESC`,
    );
    return rows.map(rowToAgent);
  }
  const db = getDb();
  const rows = db.prepare(`SELECT ${PG_COLS} FROM deployed_agents ORDER BY deployed_at DESC`).all() as Record<string, unknown>[];
  return rows.map(rowToAgent);
}

export async function deleteAgent(id: string): Promise<void> {
  if (usePg()) {
    const db = await getPool();
    await db.query('DELETE FROM deployed_agents WHERE id = $1', [id]);
    return;
  }
  const db = getDb();
  db.prepare('DELETE FROM deployed_agents WHERE id = ?').run(id);
}

/**
 * Record `privyUserId` on the agents owned by any of `addresses` (owner or
 * authorized owner) that have none yet: agents deployed before the id was
 * stored at deploy (docs/AGENT-GAS-FUNDING.md, "Who is eligible"). Never
 * overwrites an id already there; those that differ are returned so the
 * caller can log them. The caller must pass a verified Privy identity and its
 * own linked wallets.
 */
export async function backfillPrivyUserId(
  privyUserId: string,
  addresses: string[],
): Promise<{ filled: string[]; mismatched: Array<{ id: string; privyUserId: string }> }> {
  const owners = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => /^0x[0-9a-f]{40}$/.test(a));
  if (!privyUserId || owners.length === 0) return { filled: [], mismatched: [] };
  if (usePg()) {
    const db = await getPool();
    const { rows } = await db.query<{ id: string; privy_user_id: string | null }>(
      `SELECT id, privy_user_id FROM deployed_agents
       WHERE lower(owner_address) = ANY($1::text[])
          OR EXISTS (SELECT 1 FROM unnest(authorized_owners) o WHERE lower(o) = ANY($1::text[]))`,
      [owners],
    );
    const mismatched = rows
      .filter((r) => r.privy_user_id != null && r.privy_user_id !== privyUserId)
      .map((r) => ({ id: r.id, privyUserId: r.privy_user_id as string }));
    const missing = rows.filter((r) => r.privy_user_id == null).map((r) => r.id);
    if (missing.length === 0) return { filled: [], mismatched };
    const updated = await db.query<{ id: string }>(
      `UPDATE deployed_agents SET privy_user_id = $1, updated_at = NOW()
       WHERE id = ANY($2::text[]) AND privy_user_id IS NULL RETURNING id`,
      [privyUserId, missing],
    );
    return { filled: updated.rows.map((r) => r.id), mismatched };
  }
  const db = getDb();
  const rows = db.prepare('SELECT id, owner_address, authorized_owners, privy_user_id FROM deployed_agents').all() as Array<{
    id: string; owner_address: string; authorized_owners: unknown; privy_user_id: string | null;
  }>;
  const owned = rows.filter((r) =>
    owners.includes(String(r.owner_address).toLowerCase()) || safeJsonArray(r.authorized_owners).some((o) => owners.includes(o.toLowerCase())));
  const mismatched = owned
    .filter((r) => r.privy_user_id != null && r.privy_user_id !== privyUserId)
    .map((r) => ({ id: r.id, privyUserId: r.privy_user_id as string }));
  const fill = db.prepare('UPDATE deployed_agents SET privy_user_id = ? WHERE id = ? AND privy_user_id IS NULL');
  const filled = owned.filter((r) => r.privy_user_id == null && fill.run(privyUserId, r.id).changes > 0).map((r) => r.id);
  return { filled, mismatched };
}
