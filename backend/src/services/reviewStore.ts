import { getPool } from './neonDb.js';

export interface AgentReview {
  id: number;
  task_id: string;
  agent_address: string;
  reviewer_address: string;
  rating: number;
  review: string | null;
  created_at: string;
}

export interface AgentReviewStats {
  avgRating: number;
  totalReviews: number;
  distribution: Record<number, number>;
}

export async function submitReview(opts: {
  taskId: string;
  agentAddress: string;
  reviewerAddress: string;
  rating: number;
  review?: string;
}): Promise<AgentReview> {
  const db = await getPool();
  const { rows } = await db.query<AgentReview>(
    `INSERT INTO agent_reviews (task_id, agent_address, reviewer_address, rating, review)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (task_id, reviewer_address) DO UPDATE SET rating = $4, review = $5
     RETURNING *`,
    [opts.taskId, opts.agentAddress.toLowerCase(), opts.reviewerAddress.toLowerCase(), opts.rating, opts.review ?? null],
  );
  return rows[0];
}

export async function getAgentReviews(
  agentAddress: string,
  limit = 20,
  offset = 0,
): Promise<{ reviews: AgentReview[]; stats: AgentReviewStats }> {
  const db = await getPool();
  const addr = agentAddress.toLowerCase();

  const { rows: reviews } = await db.query<AgentReview>(
    'SELECT * FROM agent_reviews WHERE agent_address = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
    [addr, limit, offset],
  );

  const { rows: statsRows } = await db.query<{ avg: number; cnt: number }>(
    'SELECT COALESCE(AVG(rating), 0) as avg, COUNT(*) as cnt FROM agent_reviews WHERE agent_address = $1',
    [addr],
  );

  const { rows: distRows } = await db.query<{ rating: number; cnt: number }>(
    'SELECT rating, COUNT(*) as cnt FROM agent_reviews WHERE agent_address = $1 GROUP BY rating',
    [addr],
  );

  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of distRows) distribution[r.rating] = Number(r.cnt);

  return {
    reviews,
    stats: {
      avgRating: Math.round(Number(statsRows[0].avg) * 10) / 10,
      totalReviews: Number(statsRows[0].cnt),
      distribution,
    },
  };
}

export async function getReviewForTask(
  taskId: string,
  reviewerAddress: string,
): Promise<AgentReview | null> {
  const db = await getPool();
  const { rows } = await db.query<AgentReview>(
    'SELECT * FROM agent_reviews WHERE task_id = $1 AND reviewer_address = $2',
    [taskId, reviewerAddress.toLowerCase()],
  );
  return rows[0] ?? null;
}
