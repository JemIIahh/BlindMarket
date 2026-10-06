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
  decayedReputation?: { decayedScore?: number; decayFactor?: number; daysSinceLastTask?: number | null };
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
 * there is nothing to show a trend of: no decay record, or no task yet. For an
 * agent that has never done a task the API sends decayFactor 1, which would read
 * as a healthy green ↑ beside a score of 0.
 */
export function reputationTrend(agent: AgentReputationFields): ReputationTrend | null {
  const decayed = agent.decayedReputation;
  const factor = decayed?.decayFactor;
  if (typeof factor !== 'number') return null;
  if (decayed?.daysSinceLastTask === null) return null;
  if (factor > 0.9) return { glyph: '↑', cls: 'text-ok' };
  if (factor > 0.5) return { glyph: '→', cls: 'text-warn' };
  return { glyph: '↓', cls: 'text-err' };
}
