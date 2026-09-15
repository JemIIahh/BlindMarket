import { getPool } from './neonDb.js';
import { getDb } from './database.js';
import { config } from '../config.js';

function usePg(): boolean {
  return Boolean(config.databaseUrl);
}

// ── Model prices (USD per 1M tokens) ─────────────────────────────────────────
// Approximate list prices — spot-check against the provider's pricing page.
// Override wholesale via MODEL_PRICES_JSON env (same shape). Models missing
// from the table use FALLBACK_RATE and are flagged estimated:true.
const FALLBACK_RATE = { input: 1.0, output: 3.0 };

const STATIC_PRICES: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-oss-120b': { input: 0.15, output: 0.75 },
  'claude-sonnet-4': { input: 3.0, output: 15.0 },
  'claude-haiku': { input: 0.25, output: 1.25 },
  'llama-3.3-70b': { input: 0.35, output: 0.4 },
  'gemini-flash': { input: 0.1, output: 0.4 },
};

function priceTable(): Record<string, { input: number; output: number }> {
  const raw = process.env.MODEL_PRICES_JSON;
  if (!raw) return STATIC_PRICES;
  try {
    const parsed = JSON.parse(raw) as Record<string, { input: number; output: number }>;
    return { ...STATIC_PRICES, ...parsed };
  } catch {
    return STATIC_PRICES;
  }
}

/** Normalize "groq/openai/gpt-oss-120b" or "provider/model" to the bare model id. */
export function normalizeModel(model: string): string {
  const parts = model.split('/');
  return (parts[parts.length - 1] || model).toLowerCase();
}

export function priceFor(model: string): { input: number; output: number; estimated: boolean } {
  const table = priceTable();
  const key = normalizeModel(model);
  for (const [name, rate] of Object.entries(table)) {
    if (key === name.toLowerCase() || key.endsWith('/' + name.toLowerCase())) {
      return { ...rate, estimated: false };
    }
  }
  return { ...FALLBACK_RATE, estimated: true };
}

export interface UsageRow {
  id: number;
  agentId: string;
  taskHash: string | null;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  createdAt: string;
}

export async function recordUsage(entry: {
  agentId: string;
  taskHash?: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}): Promise<void> {
  const prompt = Math.max(0, Math.floor(entry.promptTokens) || 0);
  const completion = Math.max(0, Math.floor(entry.completionTokens) || 0);
  const total = Math.max(0, Math.floor(entry.totalTokens) || 0) || prompt + completion;
  if (usePg()) {
    const db = await getPool();
    await db.query(
      `INSERT INTO agent_usage (agent_id, task_hash, provider, model, prompt_tokens, completion_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [entry.agentId, entry.taskHash ?? null, entry.provider, entry.model, prompt, completion, total],
    );
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO agent_usage (agent_id, task_hash, provider, model, prompt_tokens, completion_tokens, total_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(entry.agentId, entry.taskHash ?? null, entry.provider, entry.model, prompt, completion, total);
}

export interface ModelSummary {
  provider: string;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  estimatedCost: boolean;
}

export interface DailyPoint {
  day: string;
  totalTokens: number;
  byModel: Record<string, number>;
}

export interface UsageSummary {
  agentId: string;
  windowDays: number;
  totals: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number; estimatedCost: boolean };
  byModel: ModelSummary[];
  daily: DailyPoint[];
}

export async function getUsageSummary(agentId: string, windowDays = 30): Promise<UsageSummary> {
  const days = Math.min(365, Math.max(1, Math.floor(windowDays) || 30));
  let rows: UsageRow[];
  if (usePg()) {
    const db = await getPool();
    const { rows: raw } = await db.query<Record<string, unknown>>(
      `SELECT id, agent_id, task_hash, provider, model, prompt_tokens, completion_tokens, total_tokens, created_at
       FROM agent_usage WHERE agent_id = $1 AND created_at >= NOW() - ($2 || ' days')::INTERVAL
       ORDER BY created_at ASC`,
      [agentId, String(days)],
    );
    rows = raw.map(mapRow);
  } else {
    const db = getDb();
    const raw = db
      .prepare(
        `SELECT id, agent_id, task_hash, provider, model, prompt_tokens, completion_tokens, total_tokens, created_at
         FROM agent_usage WHERE agent_id = ? AND created_at >= datetime('now', '-' || ? || ' days')
         ORDER BY created_at ASC`,
      )
      .all(agentId, days) as Record<string, unknown>[];
    rows = raw.map(mapRow);
  }

  const byModel = new Map<string, ModelSummary>();
  const byDay = new Map<string, DailyPoint>();
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let estimatedCost = false;

  for (const r of rows) {
    calls++;
    promptTokens += r.promptTokens;
    completionTokens += r.completionTokens;
    totalTokens += r.totalTokens;
    const price = priceFor(r.model);
    const cost = (r.promptTokens / 1_000_000) * price.input + (r.completionTokens / 1_000_000) * price.output;
    costUsd += cost;
    if (price.estimated) estimatedCost = true;

    const key = `${r.provider}/${r.model}`;
    const m = byModel.get(key) ?? {
      provider: r.provider, model: r.model, calls: 0,
      promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, estimatedCost: price.estimated,
    };
    m.calls++;
    m.promptTokens += r.promptTokens;
    m.completionTokens += r.completionTokens;
    m.totalTokens += r.totalTokens;
    m.costUsd += cost;
    if (price.estimated) m.estimatedCost = true;
    byModel.set(key, m);

    const day = String(r.createdAt).slice(0, 10);
    const d = byDay.get(day) ?? { day, totalTokens: 0, byModel: {} };
    d.totalTokens += r.totalTokens;
    d.byModel[key] = (d.byModel[key] ?? 0) + r.totalTokens;
    byDay.set(day, d);
  }

  return {
    agentId,
    windowDays: days,
    totals: { calls, promptTokens, completionTokens, totalTokens, costUsd, estimatedCost },
    byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    daily: [...byDay.values()],
  };
}

function mapRow(row: Record<string, unknown>): UsageRow {
  const created = row.created_at;
  return {
    id: Number(row.id),
    agentId: String(row.agent_id),
    taskHash: row.task_hash == null ? null : String(row.task_hash),
    provider: String(row.provider ?? ''),
    model: String(row.model ?? ''),
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
    createdAt: created instanceof Date ? created.toISOString() : String(created ?? ''),
  };
}
