import { getPool } from './neonDb.js';

export interface AgentMessage {
  id: number;
  task_id: string | null;
  from_address: string;
  to_address: string;
  subject: string | null;
  body: string;
  read_at: string | null;
  created_at: string;
}

/**
 * Send a message from one address to another.
 * Agents use this to message poster, or poster to message agent.
 */
export async function sendMessage(opts: {
  from: string;
  to: string;
  taskId?: string;
  subject?: string;
  body: string;
}): Promise<AgentMessage> {
  const db = await getPool();
  const { rows } = await db.query<AgentMessage>(
    'INSERT INTO agent_messages (task_id, from_address, to_address, subject, body) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [opts.taskId ?? null, opts.from.toLowerCase(), opts.to.toLowerCase(), opts.subject ?? null, opts.body],
  );
  return rows[0];
}

/**
 * Get inbox for an address (messages addressed to them).
 */
export async function getInbox(
  address: string,
  opts?: { taskId?: string; unreadOnly?: boolean; limit?: number; offset?: number },
): Promise<{ messages: AgentMessage[]; total: number }> {
  const db = await getPool();
  const addr = address.toLowerCase();
  let where = 'WHERE to_address = $1';
  const params: (string | number)[] = [addr];
  let paramIdx = 2;

  if (opts?.taskId) {
    where += ` AND task_id = $${paramIdx++}`;
    params.push(opts.taskId);
  }
  if (opts?.unreadOnly) {
    where += ' AND read_at IS NULL';
  }

  const countRow = await db.query<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM agent_messages ${where}`,
    params,
  );

  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;
  const { rows } = await db.query<AgentMessage>(
    `SELECT * FROM agent_messages ${where} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limit, offset],
  );

  return { messages: rows, total: Number(countRow.rows[0].cnt) };
}

/**
 * Get sent messages from an address.
 */
export async function getSent(
  address: string,
  opts?: { taskId?: string; limit?: number; offset?: number },
): Promise<{ messages: AgentMessage[]; total: number }> {
  const db = await getPool();
  const addr = address.toLowerCase();
  let where = 'WHERE from_address = $1';
  const params: (string | number)[] = [addr];
  let paramIdx = 2;

  if (opts?.taskId) {
    where += ` AND task_id = $${paramIdx++}`;
    params.push(opts.taskId);
  }

  const countRow = await db.query<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM agent_messages ${where}`,
    params,
  );

  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;
  const { rows } = await db.query<AgentMessage>(
    `SELECT * FROM agent_messages ${where} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    [...params, limit, offset],
  );

  return { messages: rows, total: Number(countRow.rows[0].cnt) };
}

/**
 * Get the full conversation thread between two addresses for a specific task.
 */
export async function getThread(
  addressA: string,
  addressB: string,
  taskId: string,
): Promise<AgentMessage[]> {
  const db = await getPool();
  const a = addressA.toLowerCase();
  const b = addressB.toLowerCase();
  const { rows } = await db.query<AgentMessage>(
    `SELECT * FROM agent_messages
     WHERE task_id = $1
       AND ((from_address = $2 AND to_address = $3) OR (from_address = $3 AND to_address = $2))
     ORDER BY created_at ASC`,
    [taskId, a, b],
  );
  return rows;
}

/**
 * Mark messages as read.
 */
export async function markRead(address: string, messageIds?: number[]): Promise<void> {
  const db = await getPool();
  const addr = address.toLowerCase();

  if (messageIds?.length) {
    const placeholders = messageIds.map((_, i) => `$${i + 2}`).join(',');
    await db.query(
      `UPDATE agent_messages SET read_at = NOW() WHERE id IN (${placeholders}) AND to_address = $1 AND read_at IS NULL`,
      [addr, ...messageIds],
    );
  } else {
    await db.query('UPDATE agent_messages SET read_at = NOW() WHERE to_address = $1 AND read_at IS NULL', [addr]);
  }
}

/**
 * Count unread messages for an address.
 */
export async function unreadCount(address: string): Promise<number> {
  const db = await getPool();
  const { rows } = await db.query<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM agent_messages WHERE to_address = $1 AND read_at IS NULL',
    [address.toLowerCase()],
  );
  return Number(rows[0].cnt);
}
