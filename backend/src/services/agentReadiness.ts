import { redis } from './redis.js';

/**
 * What a hosted worker last reported about taking work. The worker takes a
 * task only after a model check passes (worker.js createInferenceGate); its
 * heartbeat carries the answer here, and GET /agents/:id/readiness shows it
 * to the owner.
 */
export interface AgentReadiness {
  ready: boolean;
  /** Just started: the first model check has not finished. */
  checking?: boolean;
  /**
   * Why it is not taking tasks. Owner-only: a model provider's error can echo
   * part of an API key.
   */
  reason: string | null;
  /**
   * A 0g-compute agent with no 0G Compute account yet: what its wallet holds
   * and must hold on the 0G chain to open one, in wei.
   */
  fund?: { chain: '0g'; address: string; holdsWei: string; needWei: string; shortfallWei: string };
  reportedAt: string;
}

// A few heartbeats (30 s apart): a dead worker's report expires with it.
const READINESS_TTL_S = 120;
const key = (agentId: string) => `agent:${agentId}:readiness`;

const WEI = /^\d{1,40}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The readiness in a worker heartbeat, or null when it carries none or a malformed one. */
export function parseReadiness(raw: unknown, now = new Date()): AgentReadiness | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ready !== 'boolean') return null;
  if (r.ready) return { ready: true, reason: null, reportedAt: now.toISOString() };

  if (r.checking === true) return { ready: false, checking: true, reason: null, reportedAt: now.toISOString() };
  const reason = typeof r.reason === 'string' && r.reason.trim() ? r.reason.slice(0, 500) : 'the model check has not passed';
  const f = r.fund && typeof r.fund === 'object' ? (r.fund as Record<string, unknown>) : null;
  const fund =
    f && typeof f.address === 'string' && ADDRESS.test(f.address) &&
    [f.holdsWei, f.needWei, f.shortfallWei].every((v) => typeof v === 'string' && WEI.test(v))
      ? { chain: '0g' as const, address: f.address, holdsWei: f.holdsWei as string, needWei: f.needWei as string, shortfallWei: f.shortfallWei as string }
      : undefined;
  return { ready: false, reason, ...(fund ? { fund } : {}), reportedAt: now.toISOString() };
}

export async function saveAgentReadiness(agentId: string, readiness: AgentReadiness): Promise<void> {
  await redis.set(key(agentId), JSON.stringify(readiness), 'EX', READINESS_TTL_S);
}

/** The worker's last report, or null when it has not reported (stopped, starting, or gone). */
export async function loadAgentReadiness(agentId: string): Promise<AgentReadiness | null> {
  const raw = await redis.get(key(agentId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AgentReadiness;
  } catch {
    return null;
  }
}
