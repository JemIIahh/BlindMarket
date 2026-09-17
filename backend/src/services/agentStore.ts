import { getPool } from './neonDb.js';
import { getDb } from './database.js';
import { config } from '../config.js';
import type { AgentExecutor, AgentCapability } from '../types.js';
import type { SettlementUnit } from './settlementUnits.js';

const MAX_AGENTS = 1_000;

function usePg(): boolean {
  return Boolean(config.databaseUrl);
}

const PG_COLS = 'address, display_name, capabilities, public_key, agent_card_url, mcp_endpoint_url, min_reward, preferred_capabilities, reputation, tasks_completed, total_earned_raw, total_earned_usdc_raw, registered_at';

function rowToAgent(row: Record<string, unknown>): AgentExecutor {
  return {
    address: row.address as string,
    displayName: row.display_name as string,
    capabilities: safeJsonArray(row.capabilities) as AgentCapability[],
    publicKey: row.public_key as string,
    agentCardUrl: (row.agent_card_url as string) ?? undefined,
    mcpEndpointUrl: (row.mcp_endpoint_url as string) ?? undefined,
    minReward: (row.min_reward as string) ?? undefined,
    preferredCapabilities: safeJsonArray(row.preferred_capabilities) as AgentCapability[] | undefined,
    reputation: (row.reputation as number) ?? 50,
    tasksCompleted: (row.tasks_completed as number) ?? 0,
    totalEarnedRaw: (row.total_earned_raw as string) ?? '0',
    totalEarnedUsdcRaw: (row.total_earned_usdc_raw as string) ?? '0',
    registeredAt: (row.registered_at as string) ?? new Date().toISOString(),
  };
}

function safeJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
  return [];
}

/**
 * Insert an executor, or update its profile if it already exists. The
 * counters (reputation, tasksCompleted, totalEarnedRaw, totalEarnedUsdcRaw)
 * are only written on insert: every worker re-registers at boot without them,
 * and overwriting here reset each agent's earnings to 0 on restart while its
 * task count stayed. Change counters with `creditPayout` / `adjustReputation`.
 */
export async function registerAgent(agent: AgentExecutor): Promise<void> {
  const addr = agent.address.toLowerCase();

  if (usePg()) {
    const db = await getPool();
    const { rows: existing } = await db.query<{ c: string }>(
      'SELECT address AS c FROM agent_executors WHERE address = $1', [addr],
    );
    if (existing.length === 0) {
      const { rows: count } = await db.query<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM agent_executors',
      );
      if ((count[0]?.n ?? 0) >= MAX_AGENTS) throw new Error('Agent registry full');
    }
    await db.query(
      `INSERT INTO agent_executors
         (address, display_name, capabilities, public_key, agent_card_url,
          mcp_endpoint_url, min_reward, preferred_capabilities,
          reputation, tasks_completed, total_earned_raw, total_earned_usdc_raw, registered_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         COALESCE((SELECT registered_at FROM agent_executors WHERE address = $1), NOW()), NOW())
       ON CONFLICT (address) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         capabilities = EXCLUDED.capabilities,
         public_key = EXCLUDED.public_key,
         agent_card_url = EXCLUDED.agent_card_url,
         mcp_endpoint_url = EXCLUDED.mcp_endpoint_url,
         min_reward = EXCLUDED.min_reward,
         preferred_capabilities = EXCLUDED.preferred_capabilities,
         updated_at = NOW()`,
      [
        addr, agent.displayName, agent.capabilities, agent.publicKey,
        agent.agentCardUrl ?? null, agent.mcpEndpointUrl ?? null,
        agent.minReward ?? null, agent.preferredCapabilities ?? null,
        agent.reputation, agent.tasksCompleted, agent.totalEarnedRaw ?? '0', agent.totalEarnedUsdcRaw ?? '0',
      ],
    );
    return;
  }

  // SQLite fallback
  const db = getDb();
  const existing = db.prepare('SELECT address FROM agent_executors WHERE address = ?').get(addr);
  if (!existing) {
    const { cnt } = db.prepare('SELECT COUNT(*) as cnt FROM agent_executors').get() as { cnt: number };
    if (cnt >= MAX_AGENTS) throw new Error('Agent registry full');
  }
  db.prepare(
    `INSERT INTO agent_executors
       (address, display_name, capabilities, public_key, agent_card_url,
        mcp_endpoint_url, min_reward, preferred_capabilities,
        reputation, tasks_completed, total_earned_raw, total_earned_usdc_raw, registered_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT registered_at FROM agent_executors WHERE address = ?), datetime('now')), datetime('now'))
     ON CONFLICT(address) DO UPDATE SET
       display_name = excluded.display_name,
       capabilities = excluded.capabilities,
       public_key = excluded.public_key,
       agent_card_url = excluded.agent_card_url,
       mcp_endpoint_url = excluded.mcp_endpoint_url,
       min_reward = excluded.min_reward,
       preferred_capabilities = excluded.preferred_capabilities,
       updated_at = datetime('now')`,
  ).run(
    addr, agent.displayName, JSON.stringify(agent.capabilities), agent.publicKey,
    agent.agentCardUrl ?? null, agent.mcpEndpointUrl ?? null,
    agent.minReward ?? null, agent.preferredCapabilities ? JSON.stringify(agent.preferredCapabilities) : null,
    agent.reputation, agent.tasksCompleted, agent.totalEarnedRaw ?? '0', agent.totalEarnedUsdcRaw ?? '0', addr,
  );
}

// Each earnings total holds one currency at one scale.
const EARNINGS_COLUMN = {
  '0G': { column: 'total_earned_raw', decimals: 18 },
  USDC: { column: 'total_earned_usdc_raw', decimals: 6 },
} as const;

/** Whether `unit` has an earnings total it can be added to as-is. */
export function hasEarningsTotal(unit: SettlementUnit): boolean {
  const target = EARNINGS_COLUMN[unit.symbol];
  return !!target && target.decimals === unit.decimals;
}

/**
 * Credit one completed task to an executor: task count +1, reputation +1
 * (capped at 100), and `amountRaw` added to the earnings total for `unit`.
 * The three move together, and the increments happen in the database, so
 * two payouts for the same executor can't overwrite each other. Returns
 * false when no such executor exists.
 */
export async function creditPayout(
  address: string,
  unit: SettlementUnit,
  amountRaw: bigint,
): Promise<boolean> {
  const target = EARNINGS_COLUMN[unit.symbol];
  if (!hasEarningsTotal(unit)) {
    // e.g. native 18-decimal USDC on Arc: it must be scaled to 6 decimals
    // before it can join the USDC total.
    throw new Error(`no earnings total for ${unit.symbol} with ${unit.decimals} decimals`);
  }
  const addr = address.toLowerCase();
  const col = target.column;
  if (usePg()) {
    const db = await getPool();
    const { rowCount } = await db.query(
      `UPDATE agent_executors
         SET tasks_completed = tasks_completed + 1,
             reputation = LEAST(100, reputation + 1),
             ${col} = (COALESCE(NULLIF(${col}, ''), '0')::numeric + $2::numeric)::text,
             updated_at = NOW()
       WHERE address = $1`,
      [addr, amountRaw.toString()],
    );
    return (rowCount ?? 0) > 0;
  }
  // SQLite integers are 64-bit, too small for 18-decimal totals, so the sum
  // is done in JS inside a transaction (better-sqlite3 is synchronous).
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`SELECT ${col} AS earned FROM agent_executors WHERE address = ?`).get(addr) as
      { earned: string | null } | undefined;
    if (!row) return false;
    const total = (BigInt(row.earned || '0') + amountRaw).toString();
    db.prepare(
      `UPDATE agent_executors
         SET tasks_completed = tasks_completed + 1,
             reputation = MIN(100, reputation + 1),
             ${col} = ?,
             updated_at = datetime('now')
       WHERE address = ?`,
    ).run(total, addr);
    return true;
  })();
}

/** Move an executor's reputation by `delta`, kept within 0–100. Returns
 *  false when no such executor exists. */
export async function adjustReputation(address: string, delta: number): Promise<boolean> {
  const addr = address.toLowerCase();
  if (usePg()) {
    const db = await getPool();
    const { rowCount } = await db.query(
      `UPDATE agent_executors
         SET reputation = LEAST(100, GREATEST(0, reputation + $2)), updated_at = NOW()
       WHERE address = $1`,
      [addr, delta],
    );
    return (rowCount ?? 0) > 0;
  }
  const { changes } = getDb().prepare(
    `UPDATE agent_executors
       SET reputation = MIN(100, MAX(0, reputation + ?)), updated_at = datetime('now')
     WHERE address = ?`,
  ).run(delta, addr);
  return changes > 0;
}

export async function getAgent(address: string): Promise<AgentExecutor | undefined> {
  if (usePg()) {
    const db = await getPool();
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT ${PG_COLS} FROM agent_executors WHERE address = $1`, [address.toLowerCase()],
    );
    return rows[0] ? rowToAgent(rows[0]) : undefined;
  }
  const db = getDb();
  const row = db.prepare(`SELECT ${PG_COLS} FROM agent_executors WHERE address = ?`).get(address.toLowerCase()) as Record<string, unknown> | undefined;
  return row ? rowToAgent(row) : undefined;
}

export async function listAgents(requiredCapabilities?: string[]): Promise<AgentExecutor[]> {
  if (usePg()) {
    const db = await getPool();
    let rows: Record<string, unknown>[];
    if (requiredCapabilities && requiredCapabilities.length > 0) {
      const { rows: r } = await db.query<Record<string, unknown>>(
        'SELECT * FROM agent_executors WHERE capabilities @> $1::TEXT[] ORDER BY registered_at DESC',
        [requiredCapabilities],
      );
      rows = r;
    } else {
      const { rows: r } = await db.query<Record<string, unknown>>(
        'SELECT * FROM agent_executors ORDER BY registered_at DESC',
      );
      rows = r;
    }
    return rows.map(rowToAgent);
  }

  const db = getDb();
  let rows: Record<string, unknown>[];
  if (requiredCapabilities && requiredCapabilities.length > 0) {
    // SQLite: filter in JS since no @> operator
    rows = db.prepare('SELECT * FROM agent_executors ORDER BY registered_at DESC').all() as Record<string, unknown>[];
    rows = rows.filter((r) => {
      const caps = safeJsonArray(r.capabilities);
      return requiredCapabilities.every((c) => caps.includes(c));
    });
  } else {
    rows = db.prepare('SELECT * FROM agent_executors ORDER BY registered_at DESC').all() as Record<string, unknown>[];
  }
  return rows.map(rowToAgent);
}
