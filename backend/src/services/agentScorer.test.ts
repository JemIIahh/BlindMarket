import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./agentStore.js', () => ({ listAgents: vi.fn() }));
vi.mock('./badgeStore.js', () => ({ getAgentBadges: vi.fn(async () => []) }));
vi.mock('./reviewStore.js', () => ({ getAgentReviews: vi.fn(async () => ({ stats: { avgRating: 0, totalReviews: 0 } })) }));
vi.mock('./a2aStore.js', () => ({ getExecutorTasks: vi.fn(async () => []) }));
vi.mock('./reputationDecay.js', () => ({ getDecayedReputation: vi.fn(async () => ({ decayedScore: 0, tasksCompleted: 0, disputes: 0 })) }));

vi.mock('./settlementUnits.js', () => ({ pricingUnit: () => pricing.unit }));

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
      { ...agent('0xzerog', []), supportedChains: ['0g'] },
      { ...agent('0xall', []), supportedChains: ['0g', 'base', 'arc'] },
    ]);
    for (let i = 0; i < 10; i++) {
      expect((await pickExplorationAgent([] as never, 'merit', undefined, fire, 'arc'))?.address).toBe('0xall');
    }
    vi.mocked(agentStore.listAgents).mockResolvedValue([{ ...agent('0xzerog', []), supportedChains: ['0g'] }]);
    expect(await pickExplorationAgent([] as never, 'merit', undefined, fire, 'base')).toBeNull();
  });
});

describe('rankAgents — settlement chain', () => {
  beforeEach(() => vi.mocked(agentStore.listAgents).mockReset());

  it('leaves out agents that did not declare the chain, and treats undeclared agents as 0G and Base', async () => {
    vi.mocked(agentStore.listAgents).mockResolvedValue([
      agent('0xlegacy', []),
      { ...agent('0xzerog', []), supportedChains: ['0g'] },
      { ...agent('0xarc', []), supportedChains: ['arc'] },
    ]);
    const addresses = async (chain?: string) => (await rankAgents([] as never, undefined, chain)).map((r) => r.address).sort();
    expect(await addresses('base')).toEqual(['0xlegacy']);
    expect(await addresses('0g')).toEqual(['0xlegacy', '0xzerog']);
    expect(await addresses('arc')).toEqual(['0xarc']);
    expect(await addresses(undefined)).toEqual(['0xarc', '0xlegacy', '0xzerog']);
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

  // BEHAVIOUR CHANGE: before, the raw amounts were compared whatever the
  // units, so 10^6 wei of 0G (a millionth of a millionth of a 0G) cleared a
  // 1 USDC floor and, below that, dropped every agent that had one.
  it("ignores a floor when the task pays in another unit", () => {
    expect(meetsRewardFloor(withFloor('1000000'), { amount: 1n, unit: NATIVE_0G })).toBe(true);
    expect(meetsRewardFloor(withFloor('1000000'), { amount: 10n ** 18n, unit: NATIVE_0G })).toBe(true);
  });

  it('applies the floor to 0G tasks on a deployment that prices in 0G', () => {
    pricing.unit = NATIVE_0G;
    expect(meetsRewardFloor(withFloor('1000000000000000000'), { amount: 10n ** 18n, unit: NATIVE_0G })).toBe(true);
    expect(meetsRewardFloor(withFloor('1000000000000000000'), { amount: 10n ** 17n, unit: NATIVE_0G })).toBe(false);
    // ...and not to USDC tasks there.
    expect(meetsRewardFloor(withFloor('1000000000000000000'), { amount: 1n, unit: USDC })).toBe(true);
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

  it('drops agents priced above a USDC task, and keeps them for a 0G one', async () => {
    vi.mocked(agentStore.listAgents).mockResolvedValue([withMin('0xpricey', '5000000'), agent('0xcheap', ['data_processing'], [])]);
    const usdcRanked = await rankAgents(['data_processing'] as never, { amount: 1_000_000n, unit: USDC });
    expect(usdcRanked.map((r) => r.address)).toEqual(['0xcheap']);

    vi.mocked(agentStore.listAgents).mockResolvedValue([withMin('0xpricey', '5000000'), agent('0xcheap', ['data_processing'], [])]);
    const nativeRanked = await rankAgents(['data_processing'] as never, { amount: 1_000_000n, unit: NATIVE_0G });
    expect(nativeRanked.map((r) => r.address).sort()).toEqual(['0xcheap', '0xpricey']);
  });
});
