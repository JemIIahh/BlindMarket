import { randomBytes, createHash } from 'crypto';
import { getPool } from './neonDb.js';
import { config } from '../config.js';

const KEY_PREFIX = 'sk_';

export interface ApiKeyRow {
  id: number;
  ownerAddress: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  capabilities: string[];
  agentAddress: string | null;
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ApiKeyView {
  id: number;
  name: string;
  prefix: string;
  capabilities: string[];
  agentAddress: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

function hashKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf-8').digest('hex');
}

function rowToView(row: Record<string, unknown>): ApiKeyView {
  return {
    id: row.id as number,
    name: row.name as string,
    prefix: row.key_prefix as string,
    capabilities: row.capabilities as string[],
    agentAddress: (row.agent_address as string) || null,
    lastUsedAt: (row.last_used_at as string) || null,
    createdAt: row.created_at as string,
  };
}

/**
 * Create a new API key for a user. Returns the raw key once — it will not
 * be stored in plaintext and cannot be retrieved later.
 */
export async function createApiKey(params: {
  ownerAddress: string;
  name: string;
  capabilities?: string[];
  agentAddress?: string;
}): Promise<{ id: number; rawKey: string }> {
  const db = await getPool();
  const raw = KEY_PREFIX + randomBytes(32).toString('hex');
  const prefix = raw.slice(0, 8) + '...';
  const hash = hashKey(raw);

  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO api_keys (owner_address, name, key_prefix, key_hash, capabilities, agent_address)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      params.ownerAddress.toLowerCase(),
      params.name,
      prefix,
      hash,
      params.capabilities ?? [],
      params.agentAddress?.toLowerCase() ?? null,
    ],
  );

  return { id: rows[0].id, rawKey: raw };
}

/** List active keys for a user (plaintext key never returned). */
export async function listApiKeys(ownerAddress: string): Promise<ApiKeyView[]> {
  const db = await getPool();
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT id, name, key_prefix, capabilities, agent_address, last_used_at, created_at
     FROM api_keys
     WHERE owner_address = $1 AND is_active = true
     ORDER BY created_at DESC`,
    [ownerAddress.toLowerCase()],
  );
  return rows.map(rowToView);
}

/**
 * Look up an api_key by its raw value. Returns null if not found or inactive.
 * Updates last_used_at on match.
 */
export async function lookupApiKey(rawKey: string): Promise<{
  id: number;
  ownerAddress: string;
  capabilities: string[];
} | null> {
  // No Neon configured (local dev): treat as "no such key" so requireAuth
  // falls through to legacy-key/JWT auth instead of 500ing every request.
  if (!config.databaseUrl) return null;
  const db = await getPool();
  const hash = hashKey(rawKey);
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT id, owner_address, capabilities FROM api_keys
     WHERE key_hash = $1 AND is_active = true`,
    [hash],
  );
  if (rows.length === 0) return null;

  // Touch last_used_at (non-blocking)
  await db.query(
    'UPDATE api_keys SET last_used_at = NOW() WHERE id = $1',
    [rows[0].id],
  ).catch(() => {});

  return {
    id: rows[0].id as number,
    ownerAddress: rows[0].owner_address as string,
    capabilities: rows[0].capabilities as string[],
  };
}

/** Revoke (soft-delete) an API key. Only the owner can revoke. */
export async function revokeApiKey(keyId: number, ownerAddress: string): Promise<boolean> {
  const db = await getPool();
  const { rowCount } = await db.query(
    'UPDATE api_keys SET is_active = false WHERE id = $1 AND owner_address = $2',
    [keyId, ownerAddress.toLowerCase()],
  );
  return (rowCount ?? 0) > 0;
}
