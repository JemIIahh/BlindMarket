import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A hosted worker's heartbeat says whether it is taking tasks (it takes one
 * only after a model check passes) and, for a 0g-compute agent that can't open
 * its 0G Compute account, how much 0G its wallet needs. The owner's agent page
 * shows it. The report comes from a process that runs owner-configured tools,
 * so it is shape-checked and capped before it is stored.
 */

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('./redis.js', () => ({
  redis: {
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    get: vi.fn(async (k: string) => store.get(k) ?? null),
  },
}));

const { parseReadiness, saveAgentReadiness, loadAgentReadiness } = await import('./agentReadiness.js');
const { redis } = await import('./redis.js');

const NOW = new Date('2026-09-25T12:00:00Z');
const WALLET = '0x3a38cd7A3321A6716815f7B555F4dA6baDCCBC82';
const fund = { chain: '0g', address: WALLET, holdsWei: '1600000000000000000', needWei: '3100000000000000000', shortfallWei: '1500000000000000000' };

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('parseReadiness', () => {
  it('reads a ready agent, dropping any reason or funding it carried', () => {
    expect(parseReadiness({ ready: true, reason: 'stale', fund }, NOW)).toEqual({ ready: true, reason: null, reportedAt: NOW.toISOString() });
  });

  it('reads an agent still running its first check', () => {
    expect(parseReadiness({ ready: false, checking: true, reason: 'the model has not been checked yet' }, NOW))
      .toEqual({ ready: false, checking: true, reason: null, reportedAt: NOW.toISOString() });
  });

  it('keeps the reason and the 0G it needs for an agent that is not taking tasks', () => {
    expect(parseReadiness({ ready: false, reason: 'no 0G Compute account yet', fund }, NOW)).toEqual({
      ready: false, reason: 'no 0G Compute account yet', fund, reportedAt: NOW.toISOString(),
    });
  });

  it('drops a malformed funding block but keeps the reason', () => {
    for (const bad of [
      { ...fund, address: 'not-an-address' },
      { ...fund, needWei: '3.1' },
      { ...fund, shortfallWei: 15 },
      { ...fund, holdsWei: '1'.repeat(41) },
    ]) {
      const r = parseReadiness({ ready: false, reason: 'why', fund: bad }, NOW);
      expect(r).toEqual({ ready: false, reason: 'why', reportedAt: NOW.toISOString() });
    }
  });

  it('caps the reason and fills in a missing one', () => {
    expect(parseReadiness({ ready: false, reason: 'x'.repeat(2000) }, NOW)!.reason).toHaveLength(500);
    expect(parseReadiness({ ready: false }, NOW)!.reason).toBe('the model check has not passed');
  });

  it('ignores a heartbeat without a readiness report', () => {
    for (const raw of [undefined, null, 'ready', { reason: 'no flag' }, { ready: 'yes' }]) {
      expect(parseReadiness(raw, NOW)).toBeNull();
    }
  });
});

describe('storage', () => {
  it('keeps the last report for a few heartbeats, so a dead worker reads as unknown', async () => {
    const r = parseReadiness({ ready: false, reason: 'why', fund }, NOW)!;
    await saveAgentReadiness('agent-1', r);
    expect(redis.set).toHaveBeenCalledWith('agent:agent-1:readiness', JSON.stringify(r), 'EX', 120);
    expect(await loadAgentReadiness('agent-1')).toEqual(r);
    expect(await loadAgentReadiness('agent-2')).toBeNull();
  });
});
