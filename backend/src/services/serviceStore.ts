import { getPool } from './neonDb.js';

/**
 * Persistent, owner-published "Service" — an agent listed as a standing, priced
 * offering (Phase 1 of rent-your-agent). Keyed off the executor wallet
 * (`agent_address` == agent_executors.address == deployed_agents.wallet_address),
 * owner-gated via the deployed agent. No invocation/settlement yet — `sold_count`
 * / `avg_rating` are stored-but-static until Phase 2.
 */

export interface AgentService {
  id: number;
  agent_address: string;
  owner_address: string;
  name: string;
  description: string;
  price_raw: string; // per-call rent price in wei (decimal string); distinct from min_reward
  service_type: 'api' | 'a2a';
  active: boolean;
  sold_count: number;
  avg_rating: number;
  created_at: string;
  updated_at: string;
}

/** Public projection: service fields + minimal joined agent meta. NEVER the full
 *  agent record (avoids the unauth strip() leak of instructions/model/tools). */
export interface AgentServicePublic extends AgentService {
  agent_name: string | null;
  agent_capabilities: string[] | null;
  agent_reputation: number | null;
  agent_public_key: string | null; // executor secp256k1 pubkey — lets a buyer ECIES-wrap a Use-now brief
}

const PUBLIC_COLS = `
  s.id, s.agent_address, s.owner_address, s.name, s.description, s.price_raw,
  s.service_type, s.active, s.sold_count, s.avg_rating, s.created_at, s.updated_at,
  ae.display_name AS agent_name, ae.capabilities AS agent_capabilities, ae.reputation AS agent_reputation,
  ae.public_key AS agent_public_key
`;

export async function createService(opts: {
  agentAddress: string;
  ownerAddress: string;
  name: string;
  description?: string;
  priceRaw: string;
  serviceType: 'api' | 'a2a';
  active?: boolean;
}): Promise<AgentService> {
  const db = await getPool();
  const { rows } = await db.query<AgentService>(
    `INSERT INTO agent_services (agent_address, owner_address, name, description, price_raw, service_type, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      opts.agentAddress.toLowerCase(),
      opts.ownerAddress.toLowerCase(),
      opts.name,
      opts.description ?? '',
      opts.priceRaw,
      opts.serviceType,
      opts.active ?? true,
    ],
  );
  return rows[0];
}

type ServicePatch = Partial<Pick<AgentService, 'name' | 'description' | 'price_raw' | 'service_type' | 'active'>>;

/** Update guarded by `agent_address` so an owner of agent A cannot mutate a
 *  serviceId belonging to agent B (returns null → 404). */
export async function updateService(
  serviceId: number,
  agentAddress: string,
  patch: ServicePatch,
): Promise<AgentService | null> {
  const allowed: (keyof ServicePatch)[] = ['name', 'description', 'price_raw', 'service_type', 'active'];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      vals.push(patch[key]);
      sets.push(`${key} = $${vals.length}`);
    }
  }
  if (sets.length === 0) return getOwnedService(serviceId, agentAddress);
  sets.push('updated_at = NOW()');
  vals.push(serviceId);
  vals.push(agentAddress.toLowerCase());
  const db = await getPool();
  const { rows } = await db.query<AgentService>(
    `UPDATE agent_services SET ${sets.join(', ')}
     WHERE id = $${vals.length - 1} AND agent_address = $${vals.length}
     RETURNING *`,
    vals,
  );
  return rows[0] ?? null;
}

export async function deleteService(serviceId: number, agentAddress: string): Promise<boolean> {
  const db = await getPool();
  const { rowCount } = await db.query(
    'DELETE FROM agent_services WHERE id = $1 AND agent_address = $2',
    [serviceId, agentAddress.toLowerCase()],
  );
  return (rowCount ?? 0) > 0;
}

async function getOwnedService(serviceId: number, agentAddress: string): Promise<AgentService | null> {
  const db = await getPool();
  const { rows } = await db.query<AgentService>(
    'SELECT * FROM agent_services WHERE id = $1 AND agent_address = $2',
    [serviceId, agentAddress.toLowerCase()],
  );
  return rows[0] ?? null;
}

/** Owner view — all services for the agent, including inactive. */
export async function listOwnerServices(agentAddress: string): Promise<AgentService[]> {
  const db = await getPool();
  const { rows } = await db.query<AgentService>(
    'SELECT * FROM agent_services WHERE agent_address = $1 ORDER BY created_at DESC',
    [agentAddress.toLowerCase()],
  );
  return rows;
}

/** Public browse — active services only, narrow projection. */
export async function listActiveServices(opts: {
  agentAddress?: string;
  limit?: number;
  offset?: number;
}): Promise<{ services: AgentServicePublic[]; total: number }> {
  const db = await getPool();
  const limit = Math.min(50, opts.limit ?? 20);
  const offset = Math.max(0, opts.offset ?? 0);
  const filters = ['s.active = true'];
  const vals: unknown[] = [];
  if (opts.agentAddress) {
    vals.push(opts.agentAddress.toLowerCase());
    filters.push(`s.agent_address = $${vals.length}`);
  }
  const where = filters.join(' AND ');
  const { rows: totalRows } = await db.query<{ cnt: string }>(
    `SELECT COUNT(*) as cnt FROM agent_services s WHERE ${where}`,
    vals,
  );
  vals.push(limit);
  vals.push(offset);
  const { rows } = await db.query<AgentServicePublic>(
    `SELECT ${PUBLIC_COLS}
     FROM agent_services s
     LEFT JOIN agent_executors ae ON ae.address = s.agent_address
     WHERE ${where}
     ORDER BY s.created_at DESC
     LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
    vals,
  );
  return { services: rows, total: Number(totalRows[0].cnt) };
}

export async function getActiveService(serviceId: number): Promise<AgentServicePublic | null> {
  const db = await getPool();
  const { rows } = await db.query<AgentServicePublic>(
    `SELECT ${PUBLIC_COLS}
     FROM agent_services s
     LEFT JOIN agent_executors ae ON ae.address = s.agent_address
     WHERE s.id = $1 AND s.active = true`,
    [serviceId],
  );
  return rows[0] ?? null;
}

/** Batched min active price per agent (single GROUP BY, avoids N+1 in browse). */
export async function getMinActivePricesByAgents(addresses: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (addresses.length === 0) return out;
  const lowered = addresses.map((a) => a.toLowerCase());
  const db = await getPool();
  const { rows } = await db.query<{ agent_address: string; min_price: string }>(
    `SELECT agent_address, MIN(price_raw::NUMERIC)::TEXT AS min_price
     FROM agent_services
     WHERE active = true AND agent_address = ANY($1)
     GROUP BY agent_address`,
    [lowered],
  );
  for (const r of rows) out.set(r.agent_address, r.min_price);
  return out;
}

/** Atomic per-call sale counter bump (statement-atomic UPDATE). Called at-most-once
 *  per invocation from INSIDE recordWorkerPayout's Redis-NX-gated block, so a
 *  finalize retry can't double-count. */
export async function incrementSoldCount(serviceId: number): Promise<void> {
  const db = await getPool();
  await db.query(
    'UPDATE agent_services SET sold_count = sold_count + 1, updated_at = NOW() WHERE id = $1',
    [serviceId],
  );
}
