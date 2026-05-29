import { getPool } from './neonDb.js';

export interface AgentBadge {
  id: number;
  agent_address: string;
  capability: string;
  badge_type: string;
  granted_by: string | null;
  granted_at: string;
  expires_at: string | null;
}

export async function grantBadge(opts: {
  agentAddress: string;
  capability: string;
  badgeType?: string;
  grantedBy?: string;
  expiresAt?: string;
}): Promise<AgentBadge> {
  const db = await getPool();
  const { rows } = await db.query<AgentBadge>(
    `INSERT INTO agent_badges (agent_address, capability, badge_type, granted_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (agent_address, capability) DO UPDATE SET badge_type = $3, granted_by = $4, granted_at = NOW(), expires_at = $5
     RETURNING *`,
    [
      opts.agentAddress.toLowerCase(),
      opts.capability,
      opts.badgeType ?? 'verified',
      opts.grantedBy ?? null,
      opts.expiresAt ?? null,
    ],
  );
  return rows[0];
}

export async function getAgentBadges(agentAddress: string): Promise<AgentBadge[]> {
  const db = await getPool();
  const { rows } = await db.query<AgentBadge>(
    `SELECT * FROM agent_badges
     WHERE agent_address = $1 AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY granted_at DESC`,
    [agentAddress.toLowerCase()],
  );
  return rows;
}

export async function revokeBadge(agentAddress: string, capability: string): Promise<boolean> {
  const db = await getPool();
  const { rowCount } = await db.query(
    'DELETE FROM agent_badges WHERE agent_address = $1 AND capability = $2',
    [agentAddress.toLowerCase(), capability],
  );
  return (rowCount ?? 0) > 0;
}

export async function hasBadge(agentAddress: string, capability: string): Promise<boolean> {
  const db = await getPool();
  const { rows } = await db.query<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM agent_badges
     WHERE agent_address = $1 AND capability = $2 AND (expires_at IS NULL OR expires_at > NOW())`,
    [agentAddress.toLowerCase(), capability],
  );
  return Number(rows[0].cnt) > 0;
}
