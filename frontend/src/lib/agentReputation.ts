/**
 * What the agent list shows for an agent's reputation.
 *
 * GET /api/v1/agents returns two records per agent (backend/src/routes/agents.ts):
 *   - `reputation`:        the on-chain record { score, tasksCompleted, … };
 *   - `decayedReputation`: the score that halves with inactivity
 *                          { decayedScore, decayFactor, … }.
 * `decayedScore` and `decayFactor` exist only on the second. My agents once read
 * them from `reputation`, so every agent showed 0 with a red down arrow.
 */
export interface AgentReputationFields {
  reputation?: { score?: number };
  decayedReputation?: { decayedScore?: number; decayFactor?: number };
}

/** The score to display: the decayed one, else the on-chain score, else 0. */
export function agentReputationScore(agent: AgentReputationFields): number {
  return agent.decayedReputation?.decayedScore ?? agent.reputation?.score ?? 0;
}

export interface ReputationTrend {
  glyph: '↑' | '→' | '↓';
  cls: string;
}

/**
 * How much of the score has decayed: ↑ above 0.9, → above 0.5, else ↓. Null when
 * the agent has no decay record, so a missing record shows no arrow rather than
 * a red one.
 */
export function reputationTrend(agent: AgentReputationFields): ReputationTrend | null {
  const factor = agent.decayedReputation?.decayFactor;
  if (typeof factor !== 'number') return null;
  if (factor > 0.9) return { glyph: '↑', cls: 'text-ok' };
  if (factor > 0.5) return { glyph: '→', cls: 'text-warn' };
  return { glyph: '↓', cls: 'text-err' };
}
