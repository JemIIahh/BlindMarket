import { getPool } from './neonDb.js';

const HALF_LIFE_DAYS = 7;

export interface DecayedReputation {
  address: string;
  rawScore: number;
  decayedScore: number;
  decayFactor: number;
  daysSinceLastTask: number | null;
  tasksCompleted: number;
  disputes: number;
}

export interface ReputationEvent {
  id: number;
  address: string;
  task_id: string;
  event_type: string;
  score_delta: number;
  created_at: string;
}

// reputation_history.address and reputation_events.address are TEXT keys that
// compare case-sensitively. Settlement wrote whatever principal it was handed
// (the EIP-55 walletAddress in a hosted worker's platform JWT, ethers-decoded
// chain reads) while scoreAgent reads the lowercase agent_executors key, so a
// hosted agent's disputes and decayed score never reached the ranker. Every
// read and write goes through this, like agentStore and skillStatsStore;
// migration 38 merged the rows already split by case (security audit run 1, C31).
const key = (address: string): string => address.toLowerCase();

function computeDecayFactor(daysSinceLastTask: number | null): number {
  if (daysSinceLastTask === null) return 1;
  return Math.pow(0.5, daysSinceLastTask / HALF_LIFE_DAYS);
}

export async function getDecayedReputation(address: string): Promise<DecayedReputation> {
  address = key(address);
  const db = await getPool();
  const { rows } = await db.query(
    'SELECT * FROM reputation_history WHERE address = $1',
    [address],
  );

  if (rows.length === 0) {
    return {
      address,
      rawScore: 0,
      decayedScore: 0,
      decayFactor: 1,
      daysSinceLastTask: null,
      tasksCompleted: 0,
      disputes: 0,
    };
  }

  const row = rows[0] as {
    address: string;
    raw_score: number;
    tasks_completed: number;
    disputes: number;
    last_task_at: string | null;
  };

  let daysSinceLastTask: number | null = null;
  if (row.last_task_at) {
    const lastTaskDate = new Date(row.last_task_at);
    daysSinceLastTask = (Date.now() - lastTaskDate.getTime()) / (1000 * 60 * 60 * 24);
  }

  const decayFactor = computeDecayFactor(daysSinceLastTask);
  const decayedScore = row.raw_score * decayFactor;

  return {
    address,
    rawScore: row.raw_score,
    decayedScore: Math.round(decayedScore * 100) / 100,
    decayFactor: Math.round(decayFactor * 1000) / 1000,
    daysSinceLastTask: daysSinceLastTask !== null ? Math.round(daysSinceLastTask * 10) / 10 : null,
    tasksCompleted: row.tasks_completed,
    disputes: row.disputes,
  };
}

export async function recordTaskCompletion(address: string, taskId: string, scoreDelta: number): Promise<void> {
  address = key(address);
  const db = await getPool();
  const now = new Date().toISOString();

  // One upsert: a read-then-write let two first completions race to INSERT.
  await db.query(
    `INSERT INTO reputation_history (address, raw_score, tasks_completed, last_task_at) VALUES ($1, $2, 1, $3)
     ON CONFLICT (address) DO UPDATE SET
       raw_score = reputation_history.raw_score + EXCLUDED.raw_score,
       tasks_completed = reputation_history.tasks_completed + 1,
       last_task_at = EXCLUDED.last_task_at`,
    [address, scoreDelta, now],
  );

  await db.query(
    'INSERT INTO reputation_events (address, task_id, event_type, score_delta) VALUES ($1, $2, $3, $4)',
    [address, taskId, 'task_completed', scoreDelta],
  );
}

export async function recordDispute(address: string, taskId: string): Promise<void> {
  address = key(address);
  const db = await getPool();

  await db.query(
    `INSERT INTO reputation_history (address, raw_score, disputes) VALUES ($1, 0, 1)
     ON CONFLICT (address) DO UPDATE SET disputes = reputation_history.disputes + 1`,
    [address],
  );

  await db.query(
    'INSERT INTO reputation_events (address, task_id, event_type, score_delta) VALUES ($1, $2, $3, $4)',
    [address, taskId, 'dispute', 0],
  );
}

export async function getLeaderboard(limit: number = 20): Promise<DecayedReputation[]> {
  const db = await getPool();
  const { rows } = await db.query(
    'SELECT * FROM reputation_history ORDER BY raw_score DESC LIMIT $1',
    [limit],
  );

  return rows
    .map((row: any) => {
      let daysSinceLastTask: number | null = null;
      if (row.last_task_at) {
        daysSinceLastTask = (Date.now() - new Date(row.last_task_at).getTime()) / (1000 * 60 * 60 * 24);
      }
      const decayFactor = computeDecayFactor(daysSinceLastTask);
      return {
        address: row.address,
        rawScore: row.raw_score,
        decayedScore: Math.round(row.raw_score * decayFactor * 100) / 100,
        decayFactor: Math.round(decayFactor * 1000) / 1000,
        daysSinceLastTask: daysSinceLastTask !== null ? Math.round(daysSinceLastTask * 10) / 10 : null,
        tasksCompleted: row.tasks_completed,
        disputes: row.disputes,
      };
    })
    .sort((a: DecayedReputation, b: DecayedReputation) => b.decayedScore - a.decayedScore);
}

export async function getReputationHistory(address: string, limit: number = 100): Promise<ReputationEvent[]> {
  const db = await getPool();
  const { rows } = await db.query(
    'SELECT * FROM reputation_events WHERE address = $1 ORDER BY created_at DESC LIMIT $2',
    [key(address), limit],
  );
  return rows as ReputationEvent[];
}
