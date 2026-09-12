import { createHash, randomBytes } from 'crypto';
import { getPool } from './neonDb.js';

/**
 * Pre-launch waitlist (table `waitlist_signups`, migrations 27–28).
 *
 * The X follow/like/repost/comment checks on the landing page are
 * SELF-REPORTED — the page has no X API access, so nothing here can prove a
 * task was done. What the server does own is the scoring: the client sends
 * task NAMES, never a point total, so the most anyone can claim from tasks is
 * the sum of WAITLIST_TASK_POINTS (6 points = 60 places).
 *
 * Referrals are the one uncapped source of points: each brand-new signup made
 * through someone's referral code credits that referrer REFERRAL_POINTS. The
 * credit is written by the same statement that creates the signup, so it
 * can't be claimed twice or sent from the client.
 */

export const WAITLIST_TASKS = ['follow', 'like', 'repost', 'comment'] as const;
export type WaitlistTask = (typeof WAITLIST_TASKS)[number];

export const WAITLIST_TASK_POINTS: Record<WaitlistTask, number> = {
  follow: 1,
  like: 1,
  repost: 1,
  comment: 3,
};

/** Points a referrer earns for each new signup made with their code. */
export const REFERRAL_POINTS = 2;

/** Each point moves a signup this many places up the line (matches the page copy). */
export const POSITION_BOOST_PER_POINT = 10;

/** Rows returned by the public leaderboard. */
export const LEADERBOARD_SIZE = 25;

export interface WaitlistStanding {
  position: number;
  total: number;
  /** Task points + referral points — the number the ranking uses. */
  points: number;
  taskPoints: number;
  referrals: number;
  referralCode: string;
  xHandle: string | null;
  tasks: WaitlistTask[];
}

export interface LeaderboardEntry {
  rank: number;
  handle: string | null;
  points: number;
  referrals: number;
}

export function pointsFor(tasks: readonly WaitlistTask[]): number {
  return tasks.reduce((sum, t) => sum + WAITLIST_TASK_POINTS[t], 0);
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// No 0/o, 1/i/l: codes get read aloud and retyped from screenshots. Codes are
// public (they're in every share link), so they only need to be unique, not secret.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function newReferralCode(): string {
  let code = '';
  for (const byte of randomBytes(8)) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

function isReferralCodeCollision(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e.constraint === 'waitlist_signups_referral_code_key';
}

/**
 * Position is a live rank, not a stored number: base = join order (1-based,
 * gap-free even though SERIAL ids skip on ON CONFLICT), minus the points
 * boost; ties go to whoever joined first. Later signups with more points can
 * pass you — that is the "before the line moves" the page promises. The
 * leaderboard orders by exactly the same key, so its ranks are positions.
 */
async function standingById(id: number): Promise<WaitlistStanding> {
  const db = await getPool();
  const { rows } = await db.query<{
    task_points: number;
    referral_count: number;
    referral_code: string;
    x_handle: string | null;
    tasks: WaitlistTask[];
    total: number;
    position: number;
  }>(
    `WITH scored AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY id) - (points + referral_count * $3) * $2 AS eff
         FROM waitlist_signups
     )
     SELECT w.points AS task_points, w.referral_count, w.referral_code, w.x_handle, w.tasks,
            (SELECT COUNT(*) FROM scored)::int AS total,
            (SELECT COUNT(*) FROM scored s
              WHERE s.eff < me.eff OR (s.eff = me.eff AND s.id < me.id))::int + 1 AS position
       FROM scored me
       JOIN waitlist_signups w ON w.id = me.id
      WHERE me.id = $1`,
    [id, POSITION_BOOST_PER_POINT, REFERRAL_POINTS],
  );
  const row = rows[0];
  if (!row) throw new Error(`waitlist signup ${id} vanished mid-request`);
  return {
    position: row.position,
    total: row.total,
    points: row.task_points + row.referral_count * REFERRAL_POINTS,
    taskPoints: row.task_points,
    referrals: row.referral_count,
    referralCode: row.referral_code,
    xHandle: row.x_handle,
    tasks: row.tasks,
  };
}

/**
 * Join by email. Idempotent: a repeat email returns the existing standing and
 * NO token — the token is a bearer secret, so it is handed out exactly once,
 * to whoever created the signup, never to someone who merely knows the email.
 * A repeat join also never changes the stored handle, and never credits a
 * referral: only the statement that creates a row can credit its referrer.
 */
export async function joinWaitlist(input: {
  email: string;
  xHandle: string;
  tasks: readonly WaitlistTask[];
  ref?: string;
}): Promise<{ token: string | null; standing: WaitlistStanding }> {
  const db = await getPool();
  const token = `wl_${randomBytes(24).toString('base64url')}`;

  let inserted: { id: number } | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      // One statement: insert the signup and, only if a row was actually
      // created, bump the referrer. An unknown or missing ref resolves to NULL
      // and credits no one.
      const { rows } = await db.query<{ id: number }>(
        `WITH ins AS (
           INSERT INTO waitlist_signups (email, x_handle, tasks, points, token_hash, referral_code, referred_by)
           VALUES ($1, $2, $3, $4, $5, $6, (SELECT id FROM waitlist_signups WHERE referral_code = $7))
           ON CONFLICT (email) DO NOTHING
           RETURNING id, referred_by
         ), credit AS (
           UPDATE waitlist_signups
              SET referral_count = referral_count + 1, updated_at = NOW()
            WHERE id = (SELECT referred_by FROM ins)
         )
         SELECT id FROM ins`,
        [input.email, input.xHandle, input.tasks, pointsFor(input.tasks), hashToken(token), newReferralCode(), input.ref ?? null],
      );
      inserted = rows[0];
      break;
    } catch (err) {
      // A fresh code collided with an existing one (≈1 in 10^11 per signup at
      // 1M signups). The failed statement changed nothing; draw again.
      if (attempt < 3 && isReferralCodeCollision(err)) continue;
      throw err;
    }
  }
  if (inserted) return { token, standing: await standingById(inserted.id) };

  const existing = await db.query<{ id: number }>('SELECT id FROM waitlist_signups WHERE email = $1', [input.email]);
  if (!existing.rows[0]) throw new Error('waitlist insert conflicted but no row matched the email');
  return { token: null, standing: await standingById(existing.rows[0].id) };
}

export async function getStandingByToken(token: string): Promise<WaitlistStanding | null> {
  const db = await getPool();
  const { rows } = await db.query<{ id: number }>(
    'SELECT id FROM waitlist_signups WHERE token_hash = $1',
    [hashToken(token)],
  );
  return rows[0] ? standingById(rows[0].id) : null;
}

/** Record one more task. Atomic and idempotent — a repeat never double-counts. */
export async function addTaskByToken(token: string, task: WaitlistTask): Promise<WaitlistStanding | null> {
  const db = await getPool();
  const { rows } = await db.query<{ id: number }>(
    `UPDATE waitlist_signups
        SET tasks = CASE WHEN $2::text = ANY(tasks) THEN tasks ELSE array_append(tasks, $2::text) END,
            points = CASE WHEN $2::text = ANY(tasks) THEN points ELSE points + $3::int END,
            updated_at = NOW()
      WHERE token_hash = $1
      RETURNING id`,
    [hashToken(token), task, WAITLIST_TASK_POINTS[task]],
  );
  return rows[0] ? standingById(rows[0].id) : null;
}

// Every page view asks for the total and the leaderboard, and this table
// shares the Neon pool with the live marketplace — so a launch-day traffic
// spike is answered from memory, costing at most one query per TTL per
// process instead of one per visitor.
const PUBLIC_TTL_MS = 10_000;

function ttlCached<T>(load: () => Promise<T>): () => Promise<T> {
  let cache: { value: T; at: number } | null = null;
  let inFlight: Promise<T> | null = null;
  return () => {
    if (cache && Date.now() - cache.at < PUBLIC_TTL_MS) return Promise.resolve(cache.value);
    inFlight ??= load()
      .then((value) => {
        cache = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

export const getWaitlistTotal = ttlCached(async () => {
  const db = await getPool();
  const { rows } = await db.query<{ total: number }>('SELECT COUNT(*)::int AS total FROM waitlist_signups');
  return rows[0]?.total ?? 0;
});

/** The front of the line. Public, so it carries handles only — never emails. */
export const getLeaderboard = ttlCached(async (): Promise<LeaderboardEntry[]> => {
  const db = await getPool();
  const { rows } = await db.query<{ x_handle: string | null; score: number; referral_count: number }>(
    `SELECT x_handle, score, referral_count
       FROM (
         SELECT id, x_handle, referral_count,
                points + referral_count * $2 AS score,
                ROW_NUMBER() OVER (ORDER BY id) - (points + referral_count * $2) * $3 AS eff
           FROM waitlist_signups
       ) scored
      ORDER BY eff, id
      LIMIT $1`,
    [LEADERBOARD_SIZE, REFERRAL_POINTS, POSITION_BOOST_PER_POINT],
  );
  return rows.map((r, i) => ({ rank: i + 1, handle: r.x_handle, points: r.score, referrals: r.referral_count }));
});
