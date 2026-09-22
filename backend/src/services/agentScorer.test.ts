import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./agentStore.js', () => ({ listAgents: vi.fn() }));
vi.mock('./badgeStore.js', () => ({ getAgentBadges: vi.fn(async () => []) }));
vi.mock('./reviewStore.js', () => ({ getAgentReviews: vi.fn(async () => ({ stats: { avgRating: 0, totalReviews: 0 } })) }));
vi.mock('./a2aStore.js', () => ({ getExecutorTasks: vi.fn(async () => []) }));
vi.mock('./reputationDecay.js', () => ({ getDecayedReputation: vi.fn(async () => ({ decayedScore: 0, tasksCompleted: 0, disputes: 0 })) }));

vi.mock('./settlementUnits.js', () => ({
  pricingUnit: () => pricing.unit,
  sameUnit: (a: { symbol: string; decimals: number }, b: { symbol: string; decimals: number }) =>
    a.symbol === b.symbol && a.decimals === b.decimals,
}));

import { scoreAgent, rankAgents, pickExplorationAgent, meetsRewardFloor } from './agentScorer.js';
import * as agentStore from './agentStore.js';
import type { AgentExecutor } from '../types.js';

const USDC = { symbol: 'USDC' as const, decimals: 6 as const };
const NATIVE_0G = { symbol: '0G' as const, decimals: 18 as const };
/** What this deployment prices in; the reward floor is written in it. */
const pricing = vi.hoisted(() => ({
  unit: { symbol: 'USDC', decimals: 6 } as { symbol: 'USDC' | '0G'; decimals: 6 | 18 },
}));

const agent = (address: string, caps: string[], preferred?: string[]): AgentExecutor => ({
  address, displayName: address, capabilities: caps as never, preferredCapabilities: preferred as never,
  reputation: 0, tasksCompleted: 0, registeredAt: new Date().toISOString(),
});

describe('scoreAgent — capability overlap', () => {
  it('an empty preferredCapabilities list does not erase the overlap (rows are stored as [])', async () => {
    const withPref = await scoreAgent(agent('0xa', ['data_processing'], []), ['data_processing'] as never);
    const noPref = await scoreAgent(agent('0xb', ['data_processing']), ['data_processing'] as never);
    const wrong = await scoreAgent(agent('0xc', ['code_review'], []), ['data_processing'] as never);
    expect(withPref.breakdown.capabilityOverlap).toBe(3);
    expect(withPref.score).toBe(noPref.score);
    expect(wrong.breakdown.capabilityOverlap).toBe(0);
    expect(withPref.score).toBeGreaterThan(wrong.score);
  });

  it('a non-empty preferredCapabilities list still narrows', async () => {
    const s = await scoreAgent(agent('0xa', ['code_review', 'data_processing'], ['code_review']), ['data_processing'] as never);
    expect(s.breakdown.capabilityOverlap).toBe(0);
  });
});

describe('rankAgents', () => {
  beforeEach(() => vi.mocked(agentStore.listAgents).mockReset());
  it('puts agents holding the required capability ahead of those that do not', async () => {
    vi.mocked(agentStore.listAgents).mockResolvedValue([
      agent('0xreviewer', ['code_review'], []),
      agent('0xdata', ['data_processing'], []),
      agent('0xgeneralist', ['code_review', 'data_processing'], []),
    ]);
    const ranked = await rankAgents(['data_processing'] as never);
    expect(ranked.slice(0, 2).map((r) => r.address).sort()).toEqual(['0xdata', '0xgeneralist']);
    expect(ranked[2].address).toBe('0xreviewer');
  });
});

describe('pickExplorationAgent', () => {
  beforeEach(() => vi.mocked(agentStore.listAgents).mockReset());
  const fire = () => 0; // rng below the exploration rate → the slot fires

  it('only offers the slot to new agents that hold ALL required capabilities', async () => {
    vi.mocked(agentStore.listAgents).mockResolvedValue([
      agent('0xreviewer', ['code_review'], []),
      agent('0xdata', ['data_processing'], []),
    ]);
    for (let i = 0; i < 10; i++) {
      const pick = await pickExplorationAgent(['data_processing'] as never, 'merit', undefined, fire);
      expect(pick?.address).toBe('0xdata');
    }
  });

  it('returns null (ranked flow takes over) when no new agent is qualified', async () => {
    vi.mocked(agentStore.listAgents).mockResolvedValue([agent('0xreviewer', ['code_review'], [])]);
    expect(await pickExplorationAgent(['translation'] as never, 'merit', undefined, fire)).toBeNull();
  });

  it('caps-less tasks keep the old behaviour: any new agent qualifies', async () => {
    vi.mocked(agentStore.listAgents).mockResolvedValue([agent('0xreviewer', ['code_review'], [])]);
    expect((await pickExplorationAgent([] as never, 'merit', undefined, fire))?.address).toBe('0xreviewer');
  });

  it('does not fire when the rng lands above the exploration rate', async () => {
    vi.mocked(agentStore.listAgents).mockResolvedValue([agent('0xreviewer', ['code_review'], [])]);
    expect(await pickExplorationAgent(['code_review'] as never, 'merit', undefined, () => 0.99)).toBeNull();
  });

  it('only offers the slot to agents that support the task\'s chain', async () => {
    vi.mocked(agentStore.listAgents).mockResolvedValue([
      { ...agent('0xbase', []), supportedChains: ['base'] },
      { ...agent('0xall', []), supportedChains: ['base', 'arc'] },
    ]);
    for (let i = 0; i < 10; i++) {
      expect((await pickExplorationAgent([] as never, 'merit', undefined, fire, 'arc'))?.address).toBe('0xall');
    }
    vi.mocked(agentStore.listAgents).mockResolvedValue([{ ...agent('0xbase', []), supportedChains: ['base'] }]);
    expect(await pickExplorationAgent([] as never, 'merit', undefined, fire, 'arc')).toBeNull();
  });
});

describe('rankAgents — settlement chain', () => {
  beforeEach(() => vi.mocked(agentStore.listAgents).mockReset());

  it('leaves out agents that did not declare the chain, and treats undeclared agents as Base only', async () => {
    vi.mocked(agentStore.listAgents).mockResolvedValue([
      agent('0xlegacy', []),
      { ...agent('0xbase', []), supportedChains: ['base'] },
      { ...agent('0xarc', []), supportedChains: ['arc'] },
    ]);
    const addresses = async (chain?: string) => (await rankAgents([] as never, undefined, chain)).map((r) => r.address).sort();
    expect(await addresses('base')).toEqual(['0xbase', '0xlegacy']);
    expect(await addresses('arc')).toEqual(['0xarc']);
    expect(await addresses(undefined)).toEqual(['0xarc', '0xbase', '0xlegacy']);
  });
});

describe('meetsRewardFloor', () => {
  beforeEach(() => { pricing.unit = USDC; });

  const withFloor = (minReward?: string) => ({ minReward });

  it('keeps an agent with no floor, and a task with no reward', () => {
    expect(meetsRewardFloor(withFloor(), { amount: 1n, unit: USDC })).toBe(true);
    expect(meetsRewardFloor(withFloor('1000000'), null)).toBe(true);
  });

  it('compares amounts in the pricing unit', () => {
    expect(meetsRewardFloor(withFloor('1000000'), { amount: 1_000_000n, unit: USDC })).toBe(true);
    expect(meetsRewardFloor(withFloor('1000000'), { amount: 999_999n, unit: USDC })).toBe(false);
  });

  // A floor in USDC says nothing about a 0G amount, and an incomparable
  // reward does not clear it: waiving it let 1 wei of 0G reach every agent
  // with a floor. An agent with no floor (or a zero one) still takes it.
  it("fails a floor when the task pays in another unit, unless the floor is zero", () => {
    expect(meetsRewardFloor(withFloor('1000000'), { amount: 1n, unit: NATIVE_0G })).toBe(false);
    expect(meetsRewardFloor(withFloor('1000000'), { amount: 10n ** 18n, unit: NATIVE_0G })).toBe(false);
    expect(meetsRewardFloor(withFloor('0'), { amount: 1n, unit: NATIVE_0G })).toBe(true);
    expect(meetsRewardFloor({ minReward: undefined } as any, { amount: 1n, unit: NATIVE_0G })).toBe(true);
    // A floor that is not a number keeps the agent, as in the same-unit branch.
    expect(meetsRewardFloor(withFloor('nope'), { amount: 1n, unit: NATIVE_0G })).toBe(true);
  });

  it('applies the floor to 0G tasks on a deployment that prices in 0G', () => {
    pricing.unit = NATIVE_0G;
    expect(meetsRewardFloor(withFloor('1000000000000000000'), { amount: 10n ** 18n, unit: NATIVE_0G })).toBe(true);
    expect(meetsRewardFloor(withFloor('1000000000000000000'), { amount: 10n ** 17n, unit: NATIVE_0G })).toBe(false);
    // ...and a USDC task there cannot clear a 0G floor.
    expect(meetsRewardFloor(withFloor('1000000000000000000'), { amount: 1n, unit: USDC })).toBe(false);
  });

  it('keeps an agent whose floor is malformed, rather than excluding on bad data', () => {
    expect(meetsRewardFloor(withFloor('not-a-number'), { amount: 1n, unit: USDC })).toBe(true);
  });
});

describe('rankAgents with a reward floor', () => {
  beforeEach(() => {
    pricing.unit = USDC;
    vi.mocked(agentStore.listAgents).mockReset();
  });

  const withMin = (address: string, minReward: string): AgentExecutor => ({ ...agent(address, ['data_processing'], []), minReward });

  it('drops agents priced above a USDC task, and agents with any floor from a task in another unit', async () => {
    vi.mocked(agentStore.listAgents).mockResolvedValue([withMin('0xpricey', '5000000'), agent('0xcheap', ['data_processing'], [])]);
    const usdcRanked = await rankAgents(['data_processing'] as never, { amount: 1_000_000n, unit: USDC });
    expect(usdcRanked.map((r) => r.address)).toEqual(['0xcheap']);

    // A 0G reward cannot clear a USDC floor, so only the floorless agent is
    // offered it (1 wei of 0G used to reach every agent).
    vi.mocked(agentStore.listAgents).mockResolvedValue([withMin('0xpricey', '5000000'), agent('0xcheap', ['data_processing'], [])]);
    const nativeRanked = await rankAgents(['data_processing'] as never, { amount: 1_000_000n, unit: NATIVE_0G });
    expect(nativeRanked.map((r) => r.address)).toEqual(['0xcheap']);
  });
});
