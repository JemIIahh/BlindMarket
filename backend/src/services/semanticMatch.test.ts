import { describe, it, expect, vi } from 'vitest';

// Hermetic: pin the mock provider BEFORE config loads so rerankCandidates
// takes its passthrough path and never calls the live Voyage API — a
// developer's real EMBEDDING_API_KEY must not turn a unit test into a network
// call. dotenv never overrides pre-set process.env, so this wins.
vi.hoisted(() => {
  process.env.EMBEDDING_PROVIDER = 'mock';
  process.env.EMBEDDING_API_KEY = '';
  // Phase 2 flip on for this file so semanticCascadeRanking's routing logic is
  // exercisable; the flag-off path is the same `false` short-circuit that the
  // pinned/no-text eligibility tests already cover.
  process.env.SEMANTIC_ROUTING_ENABLED = 'true';
  process.env.RERANK_ENABLED = 'false';
});

// semanticMatch imports neonDb/agentScorer at module load; the functions under
// test here are pure, so leaf stubs are enough (same pattern as the
// projection tests).
/** What this deployment prices in; reward floors are written in it. */
const PRICING = vi.hoisted(() => ({ symbol: 'USDC', decimals: 6 }));

vi.mock('./neonDb.js', () => ({ getPool: vi.fn() }));
vi.mock('./agentScorer.js', () => ({
  rankAgents: vi.fn(),
  dominanceMultiplier: vi.fn(async () => 1),
  // Real logic mirrored (importActual would drag in redis via a2aStore).
  // Real logic mirrored (importActual would drag in redis via a2aStore),
  // including the unit rule: a floor is written in the deployment's pricing
  // unit and says nothing about a task escrowed in another one.
  meetsRewardFloor: (
    a: { minReward?: string },
    t: { amount: bigint; unit: { symbol: string; decimals: number } } | null,
  ) => {
    if (t === null || !a.minReward) return true;
    if (t.unit.symbol !== PRICING.symbol || t.unit.decimals !== PRICING.decimals) return true;
    try { return BigInt(a.minReward) <= t.amount; } catch { return true; }
  },
  hasAllCapabilities: (a: { capabilities: string[] }, req: string[]) =>
    req.every((c) => a.capabilities.includes(c)),
}));
vi.mock('./agentStore.js', () => ({ getAgent: vi.fn() }));
vi.mock('./agentEmbedding.js', () => ({ buildAgentDoc: vi.fn() }));
vi.mock('./embeddingService.js', () => ({
  embed: vi.fn(),
  toVectorLiteral: (v: number[]) => `[${v.join(',')}]`,
  embeddingModelId: () => 'mock-v1',
}));

import {
  buildTaskRoutingText,
  computeShadowMetrics,
  rerankCandidates,
  semanticRoutingEligible,
  semanticCascadeRanking,
  type ShadowRow,
} from './semanticMatch.js';
import { getPool } from './neonDb.js';
import { getAgent } from './agentStore.js';
import { embed } from './embeddingService.js';

describe('buildTaskRoutingText (source precedence)', () => {
  it('prefers publicBrief over everything', () => {
    expect(buildTaskRoutingText({
      publicBrief: 'Mint a dragon NFT',
      routingSummary: 'nft stuff',
      requiredCapabilities: ['content_generation'] as never,
    })).toBe('Mint a dragon NFT');
  });

  it('falls back to routingSummary for private tasks', () => {
    expect(buildTaskRoutingText({
      routingSummary: 'Need SQL from English',
      requiredCapabilities: ['data_processing'] as never,
    })).toBe('Need SQL from English');
  });

  it('falls back to capability tags as last resort', () => {
    expect(buildTaskRoutingText({ requiredCapabilities: ['testing', 'code_review'] as never }))
      .toBe('Task requiring: testing, code_review');
  });

  it('returns empty when there is no public signal at all (no shadow row)', () => {
    expect(buildTaskRoutingText({ requiredCapabilities: [] as never })).toBe('');
  });
});

describe('rerankCandidates (mock passthrough)', () => {
  const cands = [
    { address: '0xa', displayName: 'A', similarity: 0.7 },
    { address: '0xb', displayName: 'B', similarity: 0.69 },
  ];
  it('preserves KNN order and shape when no real reranker is configured', async () => {
    // embeddingService is mocked here → mock path → identity passthrough.
    const out = await rerankCandidates('q', cands, new Map([['0xa', 'docA'], ['0xb', 'docB']]));
    expect(out.map((c) => c.address)).toEqual(['0xa', '0xb']);
    expect(out.every((c) => typeof c.rerankScore === 'number')).toBe(true);
  });
  it('returns [] for no candidates', async () => {
    expect(await rerankCandidates('q', [], new Map())).toEqual([]);
  });
});

describe('computeShadowMetrics (the loop success gate)', () => {
  const row = (semRank: number | null, tagRank: number | null, settled = true): ShadowRow => {
    const acceptor = '0xwinner';
    const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ address: `0xother${i}` }));
    const mk = (rank: number | null) =>
      rank === null ? filler(5) : [...filler(rank - 1), { address: acceptor }, ...filler(5 - rank)];
    return { semantic_topk: mk(semRank), tag_topk: mk(tagRank), accepted_by: acceptor, settled };
  };

  it('scores hit@1 / hit@3 / MRR per ranking', () => {
    const m = computeShadowMetrics([
      row(1, 3),  // semantic nailed it; tag ranked it 3rd
      row(2, 1),  // tag nailed it; semantic 2nd
      row(1, null), // semantic 1st; tag missed entirely
    ]);
    expect(m.tasks).toBe(3);
    expect(m.semantic.hit1).toBeCloseTo(2 / 3, 3);
    expect(m.semantic.hit3).toBe(1);
    expect(m.semantic.mrr).toBeCloseTo((1 + 0.5 + 1) / 3, 2);
    expect(m.tag.hit1).toBeCloseTo(1 / 3, 3);
    expect(m.tag.mrr).toBeCloseTo((1 / 3 + 1 + 0) / 3, 2);
    // No rerank list present → semanticRerank mirrors semantic (back-compat).
    expect(m.semanticRerank).toEqual(m.semantic);
  });

  it('uses semantic_rerank_topk when present, else falls back to semantic', () => {
    const acceptor = '0xwinner';
    const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ address: `0xo${i}` }));
    const withRerank: ShadowRow = {
      semantic_topk: [...filler(2), { address: acceptor }],       // semantic: rank 3
      semantic_rerank_topk: [{ address: acceptor }, ...filler(2)], // rerank promotes to rank 1
      tag_topk: [],
      accepted_by: acceptor,
      settled: true,
    };
    const m = computeShadowMetrics([withRerank]);
    expect(m.semantic.hit1).toBe(0);       // semantic had it at rank 3
    expect(m.semanticRerank.hit1).toBe(1); // rerank fixed it
  });

  it('ignores rows with no known acceptor and counts settled', () => {
    const noAcceptor: ShadowRow = { semantic_topk: [], tag_topk: [], accepted_by: null, settled: null };
    const m = computeShadowMetrics([noAcceptor, row(1, 1, true), row(1, 1, false)]);
    expect(m.tasks).toBe(2);
    expect(m.settledTasks).toBe(1);
  });

  it('skips rows with no ranking data (a routed_by placeholder whose shadow write failed)', () => {
    const placeholder: ShadowRow = { semantic_topk: [], tag_topk: [], accepted_by: '0xwinner', settled: true };
    const m = computeShadowMetrics([placeholder, row(1, 1, true)]);
    expect(m.tasks).toBe(1);         // placeholder is not scorable…
    expect(m.unscoredTasks).toBe(1); // …but its exclusion is visible…
    expect(m.semantic.hit1).toBe(1); // …and doesn't deflate the real row's metrics
  });

  it('is case-insensitive on addresses', () => {
    const m = computeShadowMetrics([{
      semantic_topk: [{ address: '0xWINNER' }],
      tag_topk: [],
      accepted_by: '0xwinner',
      settled: true,
    }]);
    expect(m.semantic.hit1).toBe(1);
  });
});

describe('semanticRoutingEligible (Phase 2 flip gate)', () => {
  it('true for an unpinned task with routing text (flag on in this file)', () => {
    expect(semanticRoutingEligible({ publicBrief: 'Translate docs to French', requiredCapabilities: [] as never })).toBe(true);
  });

  it('true via the caps-only routing-text fallback', () => {
    expect(semanticRoutingEligible({ requiredCapabilities: ['code_review'] as never })).toBe(true);
  });

  it('false when the task is pinned to one executor', () => {
    expect(semanticRoutingEligible({
      publicBrief: 'Translate docs',
      requiredCapabilities: [] as never,
      targetExecutor: '0xpinned',
    })).toBe(false);
  });

  it('false when there is no routing text at all', () => {
    expect(semanticRoutingEligible({ requiredCapabilities: [] as never })).toBe(false);
  });
});

describe('semanticCascadeRanking (Phase 2 flip — cascade offer queue)', () => {
  // KNN rows the mocked pool returns: Alice closest (dist 0.1 → sim 0.9),
  // Bob further (dist 0.4 → sim 0.6).
  const knnRows = [
    { address: '0xaaa', display_name: 'Alice', dist: 0.1 },
    { address: '0xbbb', display_name: 'Bob', dist: 0.4 },
  ];
  const meta = { publicBrief: 'Summarize this repo', requiredCapabilities: [] as never };
  const agentRow = (address: string, minReward?: string) =>
    ({ address, displayName: address, capabilities: [], reputation: 0, tasksCompleted: 0, registeredAt: '' , minReward }) as never;

  const arm = (rows: unknown[] = knnRows) => {
    vi.mocked(embed).mockResolvedValue({ vector: [1, 2], model: 'mock-v1' });
    vi.mocked(getPool).mockResolvedValue({ query: vi.fn().mockResolvedValue({ rows }) } as never);
    vi.mocked(getAgent).mockImplementation(async (addr: string) => agentRow(addr));
  };

  it('short-circuits to null on an ineligible (pinned) task without spending an embedding', async () => {
    vi.mocked(embed).mockClear();
    const out = await semanticCascadeRanking({ ...meta, targetExecutor: '0xpinned' });
    expect(out).toBeNull();
    expect(vi.mocked(embed)).not.toHaveBeenCalled();
  });

  it('maps KNN order onto cascade entries with 0-100 scores', async () => {
    arm();
    const out = await semanticCascadeRanking(meta);
    expect(out).toEqual([
      { address: '0xaaa', displayName: 'Alice', score: 90 },
      { address: '0xbbb', displayName: 'Bob', score: 60 },
    ]);
  });

  // Capability tags no longer gate the cascade. 371e92c removed the
  // hasAllCapabilities hard gate on the premise that KNN similarity is a
  // better fit signal than a 20-value enum, and there is no longer a
  // capability rejection on /accept either — so dropping a candidate here
  // would deny an offer to an agent that is in fact allowed to take the task.
  // This test asserted the old gate and was not updated with that change.
  it('ranks every candidate, tags or not — capability tags do not gate', async () => {
    arm();
    vi.mocked(getAgent).mockImplementation(async (addr: string) =>
      ({ ...(agentRow(addr) as Record<string, unknown>), capabilities: addr === '0xbbb' ? ['code_review'] : [] }) as never);
    const out = await semanticCascadeRanking({
      publicBrief: 'Review my PR',
      requiredCapabilities: ['code_review'] as never,
    });
    // 0xaaa carries no tags at all and is still offered — KNN order decides.
    expect(out?.map((e) => e.address)).toEqual(['0xaaa', '0xbbb']);
  });

  it('drops candidates whose minReward floor exceeds the task reward', async () => {
    arm();
    vi.mocked(getAgent).mockImplementation(async (addr: string) =>
      agentRow(addr, addr === '0xaaa' ? '2000' : undefined));
    const usdc = { symbol: 'USDC' as const, decimals: 6 as const };
    const out = await semanticCascadeRanking(meta, { amount: 1000n, unit: usdc });
    expect(out?.map((e) => e.address)).toEqual(['0xbbb']);
  });

  it("keeps a candidate whose floor is in another unit than the task's reward", async () => {
    arm();
    vi.mocked(getAgent).mockImplementation(async (addr: string) =>
      agentRow(addr, addr === '0xaaa' ? '2000' : undefined));
    // A native-0G task: 1000 wei is not 1000 USDC base units, so the USDC
    // floor says nothing about it and 0xaaa stays in the cascade.
    const native = { symbol: '0G' as const, decimals: 18 as const };
    const out = await semanticCascadeRanking(meta, { amount: 1000n, unit: native });
    expect(out?.map((e) => e.address)).toEqual(['0xaaa', '0xbbb']);
  });

  it('drops candidates that did not declare the task\'s chain (their /accept would 409)', async () => {
    arm();
    vi.mocked(getAgent).mockImplementation(async (addr: string) =>
      ({ ...(agentRow(addr) as object), supportedChains: addr === '0xaaa' ? ['arc'] : null }) as never);
    expect((await semanticCascadeRanking({ ...meta, chain: 'base' }))?.map((e) => e.address)).toEqual(['0xbbb']);
    expect((await semanticCascadeRanking({ ...meta, chain: 'arc' }))?.map((e) => e.address)).toEqual(['0xaaa']);
  });

  it('drops the poster and the designated verifier (their /accept would 403)', async () => {
    arm();
    const out = await semanticCascadeRanking({
      ...meta,
      posterAddress: '0xAAA',      // case-insensitive vs candidate 0xaaa
      verifierAddress: '0xbbb',
    });
    expect(out).toBeNull(); // both candidates gate-blocked → no usable queue
  });

  it('drops slice-less candidates on a sealed task with no custody blob (NEEDS_WRAP)', async () => {
    arm();
    const out = await semanticCascadeRanking({
      ...meta,
      rootHash: '0xroot',
      wrappedKeys: { '0xbbb': 'eciesblob' },
    });
    expect(out?.map((e) => e.address)).toEqual(['0xbbb']);
  });

  it('with a custody blob, keeps only slice-holders or self-heal-capable candidates (registered publicKey)', async () => {
    arm();
    vi.mocked(getAgent).mockImplementation(async (addr: string) =>
      ({ ...(agentRow(addr) as Record<string, unknown>), publicKey: addr === '0xbbb' ? '04abc' : undefined }) as never);
    const out = await semanticCascadeRanking({
      ...meta,
      rootHash: '0xroot',
      keyCustodyBlob: { keyId: 'k1', blob: 'aa' },
    });
    // 0xaaa has no slice and no publicKey → accept's re-wrap would 403 → dropped.
    expect(out?.map((e) => e.address)).toEqual(['0xbbb']);
  });

  it('drops candidates whose registration row has vanished; null when none survive', async () => {
    arm();
    vi.mocked(getAgent).mockResolvedValue(undefined);
    expect(await semanticCascadeRanking(meta)).toBeNull();
  });

  it('returns null when KNN finds no embedded agents (→ tag fallback)', async () => {
    arm([]);
    expect(await semanticCascadeRanking(meta)).toBeNull();
  });

  it('returns null instead of throwing when the provider fails', async () => {
    vi.mocked(embed).mockRejectedValue(new Error('voyage 500'));
    expect(await semanticCascadeRanking(meta)).toBeNull();
  });
});
