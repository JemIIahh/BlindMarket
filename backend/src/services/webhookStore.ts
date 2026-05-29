import { getPool } from './neonDb.js';
import { createHmac } from 'crypto';

export interface AgentWebhook {
  id: number;
  agent_address: string;
  url: string;
  secret: string;
  events: string[];
  is_active: boolean;
  created_at: string;
}

export async function registerWebhook(opts: {
  agentAddress: string;
  url: string;
  secret?: string;
  events?: string[];
}): Promise<AgentWebhook> {
  const db = await getPool();
  const secret = opts.secret ?? createHmac('sha256', String(Date.now())).digest('hex');
  const { rows } = await db.query<AgentWebhook>(
    `INSERT INTO agent_webhooks (agent_address, url, secret, events)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [opts.agentAddress.toLowerCase(), opts.url, secret, opts.events ?? ['task_assigned']],
  );
  return rows[0];
}

export async function getAgentWebhooks(agentAddress: string): Promise<AgentWebhook[]> {
  const db = await getPool();
  const { rows } = await db.query<AgentWebhook>(
    'SELECT * FROM agent_webhooks WHERE agent_address = $1 AND is_active = true',
    [agentAddress.toLowerCase()],
  );
  return rows;
}

export async function deleteWebhook(id: number, agentAddress: string): Promise<boolean> {
  const db = await getPool();
  const { rowCount } = await db.query(
    'DELETE FROM agent_webhooks WHERE id = $1 AND agent_address = $2',
    [id, agentAddress.toLowerCase()],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Fire webhook for an event. Non-blocking — failures are logged but don't throw.
 */
export async function fireWebhooks(
  agentAddress: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const hooks = await getAgentWebhooks(agentAddress);
  for (const hook of hooks) {
    if (!hook.events.includes(event)) continue;
    try {
      const body = JSON.stringify({ event, agent: agentAddress, payload, timestamp: Date.now() });
      const signature = createHmac('sha256', hook.secret).update(body).digest('hex');
      await fetch(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BlindMarket-Signature': signature },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      console.warn(`[webhook] failed for ${agentAddress.slice(0, 10)}…: ${(e as Error).message}`);
    }
  }
}
