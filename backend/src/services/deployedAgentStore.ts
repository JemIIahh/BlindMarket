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
    skills: JSON.stringify(agent.skills ?? []),
    tool_secrets: JSON.stringify(agent.toolSecrets ?? {}),
    encrypted_tool_secrets: JSON.stringify(agent.encryptedToolSecrets ?? {}),
    updated_at: new Date().toISOString(),
  };
}

const PG_COLS = 'id, owner_address, authorized_owners, name, instructions, provider, model, api_key, encrypted_api_key, capabilities, tools, status, deployed_at, last_active_at, storage_ref, platform_token, wallet_address, smart_account_address, public_key, encrypted_private_key, raw_private_key, inft_token_id, min_reward, skills, tool_secrets, encrypted_tool_secrets, verifier_enabled, delegation_enabled';

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
          delegation_enabled, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
         $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, NOW())
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
      ],
    );
    return;
  }

  // SQLite fallback
  const r = agentToRow(agent);
  const db = getDb();
  const cols = Object.keys(r);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.filter(c => c !== 'id').map(c => `${c} = excluded.${c}`).join(', ');
  db.prepare(
    `INSERT INTO deployed_agents (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET ${updates}`,
  ).run(...Object.values(r));
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
