import { describe, it, expect, vi } from 'vitest';

// Hermetic: pin the mock provider before config loads (a real key must never
// turn unit tests into live API calls), and pin the slug threshold so the
// argmax tests are deterministic regardless of local env.
vi.hoisted(() => {
  process.env.EMBEDDING_PROVIDER = 'mock';
  process.env.EMBEDDING_API_KEY = '';
  process.env.PROOF_SLUG_SIM_THRESHOLD = '0.5';
});

vi.mock('./embeddingService.js', () => ({ embedMany: vi.fn() }));
vi.mock('./deployedAgentStore.js', () => ({ loadAgentByWallet: vi.fn() }));
vi.mock('./skillStore.js', () => ({ listPublicSlugs: vi.fn() }));

import {
  cosine,
  bestSkillSlug,
  skillDocText,
  mergeProofKeys,
  resolveProofSkillSlug,
  PROOF_SLUG_PREFIX,
} from './semanticProof.js';
import { embedMany } from './embeddingService.js';
import { loadAgentByWallet } from './deployedAgentStore.js';
import { listPublicSlugs } from './skillStore.js';

describe('cosine', () => {
  it('identical direction → 1, orthogonal → 0, opposite → -1', () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 3])).toBeCloseTo(0, 6);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
  it('zero vector → 0 (no crash)', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('bestSkillSlug (argmax with floor)', () => {
  const skills = [
    { slug: 'sql-analyst', vector: [1, 0] },
    { slug: 'translator', vector: [0.6, 0.8] },
  ];
  it('picks the closest skill above the floor', () => {
    expect(bestSkillSlug([0.9, 0.1], skills, 0.5)?.slug).toBe('sql-analyst');
    expect(bestSkillSlug([0.5, 0.86], skills, 0.5)?.slug).toBe('translator');
  });
  it('returns null when nothing clears the floor', () => {
    expect(bestSkillSlug([0, 1], [{ slug: 'x', vector: [1, 0] }], 0.5)).toBeNull();
  });
  it('returns null for no skills', () => {
    expect(bestSkillSlug([1, 0], [], 0.1)).toBeNull();
  });
});

describe('mergeProofKeys (the shared success/dispute key set)', () => {
  it('namespaces the slug so it can never collide with a capability tag', () => {
    // 'testing' is BOTH a valid capability tag and a valid author-chosen skill
    // slug — without the prefix the two would merge into one proof row.
    expect(mergeProofKeys(['testing'], 'testing')).toEqual(['testing', `${PROOF_SLUG_PREFIX}testing`]);
  });
  it('passes tags through untouched when no slug resolved', () => {
    expect(mergeProofKeys(['code_review'], null)).toEqual(['code_review']);
    expect(mergeProofKeys([], null)).toEqual([]);
  });
  it('lists each key once, so a repeated tag is one completion or failure, not N (security audit run 1, C13)', () => {
    // skillStatsStore upserts once per key: five copies of a tag used to turn
    // one settlement into five completions (the earned-badge threshold).
    const five = Array(5).fill('data_processing');
    expect(mergeProofKeys(five, null)).toEqual(['data_processing']);
    expect(mergeProofKeys([...five, 'translation', 'data_processing'], 'sql-analyst')).toEqual([
      'data_processing', 'translation', `${PROOF_SLUG_PREFIX}sql-analyst`,
    ]);
  });
});

describe('skillDocText', () => {
  it('uses name + tags ONLY — instructions are author IP and must not reach the provider', () => {
    const txt = skillDocText({
      name: 'PDF Invoice Extractor',
      capabilities: ['data_processing'] as never,
    });
    expect(txt).toBe('PDF Invoice Extractor (data_processing)');
  });
});

describe('resolveProofSkillSlug', () => {
  const meta = { publicBrief: 'Turn these invoices into a CSV', requiredCapabilities: [] as never };
  const skill = (slug: string) =>
    ({ slug, name: slug, instructions: 'do the thing', capabilities: [], skillId: 1, version: '1', tools: [], secretRefs: [], source: 'skillmd', installedAt: '' }) as never;
  const allPublic = () => vi.mocked(listPublicSlugs).mockImplementation(async (slugs: string[]) => new Set(slugs.map((s) => s.toLowerCase())));

  it('null when the worker has no deployed agent or no skills', async () => {
    allPublic();
    vi.mocked(loadAgentByWallet).mockResolvedValue(null);
    expect(await resolveProofSkillSlug('0xw', meta)).toBeNull();
    vi.mocked(loadAgentByWallet).mockResolvedValue({ skills: [] } as never);
    expect(await resolveProofSkillSlug('0xw', meta)).toBeNull();
  });

  it('null when the task has no routing text', async () => {
    allPublic();
    vi.mocked(loadAgentByWallet).mockResolvedValue({ skills: [skill('a')] } as never);
    expect(await resolveProofSkillSlug('0xw', { requiredCapabilities: [] as never })).toBeNull();
  });

  it('excludes private-registry skills — their slugs must never reach the public proof tables', async () => {
    vi.mocked(loadAgentByWallet).mockResolvedValue({ skills: [skill('secret-draft')] } as never);
    vi.mocked(listPublicSlugs).mockResolvedValue(new Set()); // nothing public
    expect(await resolveProofSkillSlug('0xw', meta)).toBeNull();
    expect(vi.mocked(embedMany)).not.toHaveBeenCalled(); // no provider spend either
  });

  it('credits the closest public skill above the floor via ONE batched embed call', async () => {
    allPublic();
    vi.mocked(loadAgentByWallet).mockResolvedValue({ skills: [skill('invoice-extractor'), skill('poem-writer')] } as never);
    vi.mocked(embedMany).mockClear();
    vi.mocked(embedMany).mockResolvedValue({
      vectors: [
        [1, 0],        // task
        [0.95, 0.31],  // invoice-extractor (close)
        [0, 1],        // poem-writer (orthogonal)
      ],
      model: 'mock-v1',
    });
    expect(await resolveProofSkillSlug('0xw', meta)).toBe('invoice-extractor');
    expect(vi.mocked(embedMany)).toHaveBeenCalledTimes(1); // batched, not per-skill
  });

  it('null when even the best skill is below the floor', async () => {
    allPublic();
    vi.mocked(loadAgentByWallet).mockResolvedValue({ skills: [skill('poem-writer')] } as never);
    vi.mocked(embedMany).mockResolvedValue({ vectors: [[1, 0], [0.2, 0.98]], model: 'mock-v1' });
    expect(await resolveProofSkillSlug('0xw', meta)).toBeNull();
  });

  it('null (not a throw) when anything fails — proof must never block a payout', async () => {
    vi.mocked(loadAgentByWallet).mockRejectedValue(new Error('pg down'));
    expect(await resolveProofSkillSlug('0xw', meta)).toBeNull();
  });
});
