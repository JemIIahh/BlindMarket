import { describe, it, expect } from 'vitest';
import { agentReputationScore, reputationTrend } from './agentReputation';

// The shape GET /api/v1/agents returns for an agent (routes/agents.ts): the
// decayed score lives on `decayedReputation`, not on `reputation`.
const listed = {
  reputation: { address: '0xa', tasksCompleted: 14, avgScore: 4.5, disputes: 0, disputeRatio: 0, score: 4.5 },
  decayedReputation: { address: '0xa', rawScore: 63.8, decayedScore: 63.8, decayFactor: 1, daysSinceLastTask: 0.4, tasksCompleted: 14, disputes: 0 },
};

describe('agentReputationScore', () => {
  it('shows the decayed score the list API sends', () => {
    expect(agentReputationScore(listed)).toBe(63.8);
  });

  it('falls back to the on-chain score, then 0', () => {
    expect(agentReputationScore({ reputation: { score: 4.5 } })).toBe(4.5);
    expect(agentReputationScore({})).toBe(0);
  });

  it('keeps a real 0 instead of falling through', () => {
    expect(agentReputationScore({ decayedReputation: { decayedScore: 0 }, reputation: { score: 9 } })).toBe(0);
  });
});

describe('reputationTrend', () => {
  it('points up, across, or down by how much has decayed', () => {
    expect(reputationTrend({ decayedReputation: { decayFactor: 1 } })?.glyph).toBe('↑');
    expect(reputationTrend({ decayedReputation: { decayFactor: 0.9 } })?.glyph).toBe('→');
    expect(reputationTrend({ decayedReputation: { decayFactor: 0.51 } })?.glyph).toBe('→');
    expect(reputationTrend({ decayedReputation: { decayFactor: 0.5 } })?.glyph).toBe('↓');
  });

  it('shows no arrow when there is no decay record (it used to show a red ↓)', () => {
    expect(reputationTrend({})).toBeNull();
    expect(reputationTrend({ reputation: { score: 4.5 } })).toBeNull();
    expect(reputationTrend({ decayedReputation: {} })).toBeNull();
  });

  it('shows the real record from the list API as steady', () => {
    expect(reputationTrend(listed)).toEqual({ glyph: '↑', cls: 'text-ok' });
  });
});
