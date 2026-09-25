import { describe, it, expect, vi } from 'vitest';

// computeDemandGaps is pure, but demandFeed.ts imports the Redis store, the
// chain providers and the Postgres pool. Unmocked, those connect and log on
// their own schedule — after this file's few milliseconds of tests are over —
// and vitest fails the whole run with "Closing rpc while onUserConsoleLog was
// pending" whenever the log lands during teardown (seen in CI).
// What the feed reads: the open tasks, and their shadow-log rows.
const feed = vi.hoisted(() => ({ open: [] as unknown[], rows: [] as unknown[] }));
vi.mock('./neonDb.js', () => ({ getPool: vi.fn(async () => ({ query: async () => ({ rows: feed.rows }) })) }));
vi.mock('./a2aStore.js', () => ({ listOpenTasks: vi.fn(async () => feed.open) }));
vi.mock('./taskChain.js', () => ({ resolveCachedTaskByHash: vi.fn() }));
vi.mock('./escrow.js', () => ({}));
// Arc testnet and Base Sepolia: the networks the chains run on (chainScope).
vi.mock('../config.js', () => ({
  config: { arcChainId: 5042002, baseChainId: 84532, demandGapSimThreshold: 0.55, demandGapMinAgeMs: 10 * 60 * 1000 },
}));

import { computeDemandGaps, demandFeed, type DemandShadowRow, type OpenTaskInfo } from './demandFeed.js';

const NOW = 1_800_000_000_000; // fixed clock
const OPTS = { simThreshold: 0.55, minAgeMs: 10 * 60 * 1000, now: NOW };
const oldEnough = new Date(NOW - 60 * 60 * 1000).toISOString(); // 1h old

const row = (hash: string, sim: number | null, over: Partial<DemandShadowRow> = {}): DemandShadowRow => ({
  task_hash: hash,
  routing_text: `task ${hash}`,
  semantic_topk: sim === null ? [] : [{ similarity: sim, displayName: 'Best Agent' }],
  created_at: oldEnough,
  ...over,
});

const open = (over: Partial<OpenTaskInfo> = {}): OpenTaskInfo => ({ requiredCapabilities: [], ...over });

describe('computeDemandGaps (the Wanted board selector)', () => {
  it('includes weak-fit and no-candidate open tasks, worst-served first', () => {
    const gaps = computeDemandGaps(
      [row('0xweak', 0.41), row('0xnone', null), row('0xok', 0.72), row('0xweaker', 0.3)],
      new Map([
        ['0xweak', open()], ['0xnone', open()], ['0xok', open()], ['0xweaker', open()],
      ]),
      OPTS,
    );
    expect(gaps.map((g) => g.taskHash)).toEqual(['0xnone', '0xweaker', '0xweak']); // 0xok well served
    expect(gaps[0].bestFit).toBeNull();
    expect(gaps[2].bestFit).toEqual({ similarity: 0.41, displayName: 'Best Agent' });
  });

  it('excludes tasks that are no longer open', () => {
    expect(computeDemandGaps([row('0xgone', 0.2)], new Map(), OPTS)).toEqual([]);
  });

  it('excludes pinned and expired tasks', () => {
    const gaps = computeDemandGaps(
      [row('0xpinned', 0.2), row('0xexpired', 0.2)],
      new Map([
        ['0xpinned', open({ targetExecutor: '0xabc' })],
        ['0xexpired', open({ deadline: Math.floor(NOW / 1000) - 60 })],
      ]),
      OPTS,
    );
    expect(gaps).toEqual([]);
  });

  it('excludes tasks younger than the minimum age (cascade may still be running)', () => {
    const fresh = row('0xfresh', 0.2, { created_at: new Date(NOW - 30_000).toISOString() });
    expect(computeDemandGaps([fresh], new Map([['0xfresh', open()]]), OPTS)).toEqual([]);
  });

  it('carries public metadata through and lowercases the hash', () => {
    const gaps = computeDemandGaps(
      [row('0xAB', 0.1)],
      new Map([['0xab', open({ requiredCapabilities: ['translation'], privacy: 'public', deadline: Math.floor(NOW / 1000) + 3600 })]]),
      OPTS,
    );
    expect(gaps[0]).toMatchObject({
      taskHash: '0xab',
      privacy: 'public',
      requiredCapabilities: ['translation'],
      ageMs: 60 * 60 * 1000,
    });
  });

  it('tolerates malformed rows (bad timestamps, missing similarity)', () => {
    const bad = row('0xbad', 0.2, { created_at: 'not-a-date' });
    const noSim: DemandShadowRow = { ...row('0xnosim', null), semantic_topk: [{ displayName: 'X' }] };
    const gaps = computeDemandGaps([bad, noSim], new Map([['0xbad', open()], ['0xnosim', open()]]), OPTS);
    // bad timestamp dropped; missing similarity treated as no-candidates
    expect(gaps.map((g) => g.taskHash)).toEqual(['0xnosim']);
    expect(gaps[0].bestFit).toBeNull();
  });
});

describe('demandFeed', () => {
  // A task listed on a network its chain has since moved off can't be taken
  // on this one (chainScope.onCurrentNetwork): the open feed hides it, and so
  // must the board.
  it('leaves out tasks listed on a network their chain has moved off', async () => {
    const listed = (taskId: string, network: { chain: string; chainId?: number }) => ({
      meta: { taskId, targetExecutorType: 'agent', requiredCapabilities: [], ...network },
      state: { taskId, status: 'open' },
    });
    feed.open = [
      listed('0xcurrent', { chain: 'arc', chainId: 5042002 }),
      listed('0xbefore', { chain: 'arc' }), // listed before chainId existed: Arc testnet
      listed('0xmoved', { chain: 'arc', chainId: 5042 }),
    ];
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    feed.rows = ['0xcurrent', '0xbefore', '0xmoved'].map((hash) => row(hash, 0.2, { created_at: hourAgo }));
    expect((await demandFeed()).map((g) => g.taskHash).sort()).toEqual(['0xbefore', '0xcurrent']);
  });
});
