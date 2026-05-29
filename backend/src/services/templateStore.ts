import { getPool } from './neonDb.js';

export interface TaskTemplate {
  id: number;
  creator_address: string;
  name: string;
  category: string;
  description: string;
  required_capabilities: string[];
  verification_criteria: Record<string, unknown> | null;
  suggested_reward: string | null;
  is_public: boolean;
  use_count: number;
  created_at: string;
}

export async function createTemplate(opts: {
  creatorAddress: string;
  name: string;
  category: string;
  description: string;
  requiredCapabilities?: string[];
  verificationCriteria?: Record<string, unknown>;
  suggestedReward?: string;
  isPublic?: boolean;
}): Promise<TaskTemplate> {
  const db = await getPool();
  const { rows } = await db.query<TaskTemplate>(
    `INSERT INTO task_templates (creator_address, name, category, description, required_capabilities, verification_criteria, suggested_reward, is_public)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      opts.creatorAddress.toLowerCase(),
      opts.name,
      opts.category,
      opts.description,
      opts.requiredCapabilities ?? [],
      opts.verificationCriteria ? JSON.stringify(opts.verificationCriteria) : null,
      opts.suggestedReward ?? null,
      opts.isPublic ?? true,
    ],
  );
  return rows[0];
}

export async function getPublicTemplates(limit = 20, offset = 0): Promise<{ templates: TaskTemplate[]; total: number }> {
  const db = await getPool();
  const countRow = await db.query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM task_templates WHERE is_public = true');
  const { rows } = await db.query<TaskTemplate>(
    'SELECT * FROM task_templates WHERE is_public = true ORDER BY use_count DESC, created_at DESC LIMIT $1 OFFSET $2',
    [limit, offset],
  );
  return { templates: rows, total: Number(countRow.rows[0].cnt) };
}

export async function getTemplatesByCreator(creatorAddress: string): Promise<TaskTemplate[]> {
  const db = await getPool();
  const { rows } = await db.query<TaskTemplate>(
    'SELECT * FROM task_templates WHERE creator_address = $1 ORDER BY created_at DESC',
    [creatorAddress.toLowerCase()],
  );
  return rows;
}

export async function getTemplate(id: number): Promise<TaskTemplate | null> {
  const db = await getPool();
  const { rows } = await db.query<TaskTemplate>('SELECT * FROM task_templates WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function useTemplate(id: number): Promise<void> {
  const db = await getPool();
  await db.query('UPDATE task_templates SET use_count = use_count + 1 WHERE id = $1', [id]);
}

export async function deleteTemplate(id: number, creatorAddress: string): Promise<boolean> {
  const db = await getPool();
  const { rowCount } = await db.query(
    'DELETE FROM task_templates WHERE id = $1 AND creator_address = $2',
    [id, creatorAddress.toLowerCase()],
  );
  return (rowCount ?? 0) > 0;
}
