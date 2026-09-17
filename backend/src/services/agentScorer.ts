import * as agentStore from './agentStore.js';
import { supportsChain } from './executorChains.js';
import * as badgeStore from './badgeStore.js';
import * as reviewStore from './reviewStore.js';
import * as a2aStore from './a2aStore.js';
import { getDecayedReputation } from './reputationDecay.js';
import type { AgentExecutor, AgentCapability } from '../types.js';

// ── Cold-start constants (Part 2) ────────────────────────────────────────────

/** Percentage of task assignments that bypass ranking for new agents. */
export const EXPLORATION_RATE = 0.15;

/** More aggressive exploration rate when poster opts into "balanced" mode. */
export const EXPLORATION_RATE_BALANCED = 0.45;

/** Agent with fewer than this many completed tasks is considered "new". */
export const EXPERIENCE_THRESHOLD = 10;

/** Rolling window for dominance cap (days). */
export const DOMINANCE_WINDOW_DAYS = 7;

/** Max tasks assigned in rolling window before soft penalty applies. */
export const DOMINANCE_CAP = 20;

/** Soft penalty multiplier when an agent exceeds the dominance cap. */
export const DOMINANCE_PENALTY = 0.7;

// ── Scoring ──────────────────────────────────────────────────────────────────

export interface ScoredAgent {
  address: string;
  displayName: string;
  capabilities: AgentCapability[];
  score: number;
  breakdown: {
    capabilityOverlap: number;
    badgeScore: number;
    reputationScore: number;
    ratingScore: number;
    experienceScore: number;
    disputePenalty: number;
  };
}

/**
 * Composite score: 0-100.
 *
 * Weights:
 *   - Capability overlap count (max 3.0 per overlapping cap)
 *   - Verified badge bonus (+2.0 per badge matching a required cap)
 *   - Decayed reputation (decayedScore/100 * 2.0)
 *   - Average rating (avgRating/5 * 1.5, or neutral default if no reviews)
 *   - Experience (diminishing returns, or flat 0.3 if zero tasks)
 *   - Dispute penalty (-2.0 * disputeRatio)
 *
 * Clamped to [0, 100] at the end.
 */
export async function scoreAgent(
  agent: AgentExecutor,
  requiredCapabilities: AgentCapability[],
): Promise<ScoredAgent> {
  const addr = agent.address.toLowerCase();

  // 1. Capability overlap — use preferredCapabilities if set, else full set.
  // preferredCapabilities is a narrowing hint. Rows are stored with `[]`
  // (not null) when the agent declared no preference, and `[] ?? caps` keeps
  // the empty list — which made every agent score 0 overlap on every task,
  // so the tag ranking was capability-blind (seen live: a code_review-only
  // agent was offered a data_processing task ahead of two qualified agents,
  // all with the same 0.9 score).
  const effectiveCaps = agent.preferredCapabilities?.length ? agent.preferredCapabilities : agent.capabilities;
  const overlap = requiredCapabilities.filter((c) => effectiveCaps.includes(c));
  const capabilityOverlap = overlap.length;

  // 2. Badge bonus, weighted by provenance: founder-reviewed 'verified' (and
  // future 'certified') +2.0 per required cap; auto-'earned' (5+ settled
  // completions via skill_stats) +1.0 — real proof, but founder review stays
  // the stronger signal.
  let badgeScore = 0;
  if (capabilityOverlap > 0) {
    const badges = await badgeStore.getAgentBadges(addr);
    const badgeTypeByCap = new Map(badges.map((b) => [b.capability, b.badge_type]));
    for (const cap of overlap) {
      const type = badgeTypeByCap.get(cap);
      if (type === 'earned') badgeScore += 1.0;
      else if (type) badgeScore += 2.0;
    }
  }

  // 3. Decayed reputation
  const rep = await getDecayedReputation(addr);
  const reputationScore = (rep.decayedScore / 100) * 2.0;

  // 4. Average rating — neutral default for zero reviews (no data ≠ bad data)
  const reviewStats = await reviewStore.getAgentReviews(addr, 1, 0);
  const avgRating = reviewStats.stats.avgRating;
  const totalReviews = reviewStats.stats.totalReviews;
  const ratingScore = totalReviews > 0
    ? (avgRating / 5) * 1.5
    : 0.6; // neutral "unproven, not bad"

  // 5. Experience — flat floor for new agents so they aren't locked out
  const tasksCompleted = rep.tasksCompleted || agent.tasksCompleted || 0;
  const experienceScore = tasksCompleted === 0
    ? 0.3 // mid-pack placeholder, not last
    : (tasksCompleted / (tasksCompleted + 10)) * 1.0;

  // 6. Dispute penalty
  const disputes = rep.disputes || 0;
  const denominator = tasksCompleted + disputes + 1;
  const disputeRatio = disputes / denominator;
  const disputePenalty = disputeRatio * 2.0;

  const rawScore =
    capabilityOverlap * 3.0 +
    badgeScore +
    reputationScore +
    ratingScore + // always included now (neutral default for zero reviews)
    experienceScore -
    disputePenalty;

  const score = Math.max(0, Math.min(100, rawScore));

  return {
    address: addr,
    displayName: agent.displayName,
    capabilities: agent.capabilities,
    score: Math.round(score * 100) / 100,
    breakdown: {
      capabilityOverlap: capabilityOverlap * 3.0,
      badgeScore,
      reputationScore: Math.round(reputationScore * 100) / 100,
      ratingScore: Math.round(ratingScore * 100) / 100,
      experienceScore: Math.round(experienceScore * 100) / 100,
      disputePenalty: Math.round(disputePenalty * 100) / 100,
    },
  };
}

/**
 * Shared "holds ALL required capability tags" predicate — the ONE definition
 * used by the /accept gate, the /bid gate, and the semantic cascade's mirror
 * of them, so an edit to the rule can't leave the ranking offering windows to
 * agents the gates will 403.
 */
export function hasAllCapabilities(
  agent: Pick<AgentExecutor, 'capabilities'>,
  required: AgentCapability[],
): boolean {
  return required.every((c) => agent.capabilities.includes(c));
}

/**
 * Shared minReward floor check — the ONE definition of "is this task's reward
 * at or above the agent's declared floor". A malformed floor keeps the agent
 * (never exclude on bad data). Used by rankAgents, pickExplorationAgent, and
 * the semantic cascade ranking so the three paths can't drift.
 */
export function meetsRewardFloor(
  agent: Pick<AgentExecutor, 'minReward'>,
  taskReward: bigint | null,
): boolean {
  if (taskReward === null || !agent.minReward) return true;
  try { return BigInt(agent.minReward) <= taskReward; } catch { return true; }
}

/**
 * Check if an agent has been assigned too many tasks recently (dominance cap).
 * Returns the penalty multiplier (1.0 = no penalty, 0.7 = soft taper).
 * Exported so the semantic cascade ranking applies the same taper — without
 * it a doc-stuffing agent could top the similarity queue on every task with
 * no rate limit.
 */
export async function dominanceMultiplier(agentAddr: string): Promise<number> {
  const executorTasks = await a2aStore.getExecutorTasks(agentAddr);
  const cutoff = Date.now() - DOMINANCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recentCount = executorTasks.filter((t) => {
    const ts = t.state.acceptedAt;
    return ts && new Date(ts).getTime() > cutoff;
  }).length;

  return recentCount > DOMINANCE_CAP ? DOMINANCE_PENALTY : 1.0;
}

/**
 * Pick a random element from an array.
 */
function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Exploration slot: randomly select a new/small agent to receive a cascade
 * offer first, bypassing normal ranking. Returns null if no eligible agent
 * or exploration doesn't trigger.
 */
export async function pickExplorationAgent(
  requiredCapabilities: AgentCapability[],
  mode: 'merit' | 'balanced' = 'merit',
  taskRewardWei?: string,
  rng: () => number = Math.random,
  chain?: string,
): Promise<ScoredAgent | null> {
  const rate = mode === 'balanced' ? EXPLORATION_RATE_BALANCED : EXPLORATION_RATE;
  if (rng() >= rate) return null;

  const agents = await agentStore.listAgents();
  if (agents.length === 0) return null;

  // Filter to eligible agents (minReward check). When the task names required
  // capabilities, the exploration slot only considers NEW agents that hold all
  // of them: the slot exists to give unproven-but-qualified agents a first
  // job, not to hand a task's first exclusive offer to an agent that cannot
  // do it. (The ranked flow that follows scores overlap but does not filter
  // on it — capability tags are soft there; see semanticMatch.ts.)
  const taskReward = taskRewardWei ? BigInt(taskRewardWei) : null;
  const eligible = agents.filter((a) =>
    meetsRewardFloor(a, taskReward)
    && hasAllCapabilities(a, requiredCapabilities)
    && supportsChain(a, chain),
  );

  // Filter to "new" agents: fewer than EXPERIENCE_THRESHOLD completed tasks
  const newAgents = eligible.filter((a) => {
    const completed = a.tasksCompleted || 0;
    return completed < EXPERIENCE_THRESHOLD;
  });
  if (newAgents.length === 0) return null;

  const chosen = randomPick(newAgents);
  return scoreAgent(chosen, requiredCapabilities);
}

/**
 * Score all registered agents against the task's required capabilities
 * and return them sorted best-first.
 *
 * Dominance cap: agents exceeding DOMINANCE_CAP assignments in the last
 * DOMINANCE_WINDOW_DAYS get a soft score taper (× 0.7).
 */
export async function rankAgents(
  requiredCapabilities: AgentCapability[],
  taskRewardWei?: string,
  chain?: string,
): Promise<ScoredAgent[]> {
  // Semantic matching is the primary router — list ALL agents, KNN ranks them.
  const agents = await agentStore.listAgents();
  if (agents.length === 0) return [];

  // Filter by minReward
  const taskReward = taskRewardWei ? BigInt(taskRewardWei) : null;
  const eligible = agents.filter((a) => meetsRewardFloor(a, taskReward) && supportsChain(a, chain));
  if (eligible.length === 0) return [];

  const scored = await Promise.all(
    eligible.map(async (a) => {
      const s = await scoreAgent(a, requiredCapabilities);
      const mult = await dominanceMultiplier(a.address.toLowerCase());
      if (mult < 1) {
        s.score = Math.round(s.score * mult * 100) / 100;
      }
      return s;
    }),
  );

  scored.sort((a, b) => b.score - a.score);
  return scored;
}
