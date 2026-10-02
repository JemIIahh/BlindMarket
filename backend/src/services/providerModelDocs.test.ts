import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LLM_PROVIDER_MODELS } from '../types.js';
import type { KeyedProvider } from './providerModels.js';

/**
 * providerModelDocs.json is each provider's model list as its public docs
 * showed it (scripts/check-model-catalog.ts --record). A catalog id that isn't
 * there, or whose price differs, is a typo, an invented id or a stale price:
 * the kind of entry that put a bare 'gpt-oss-120b' in the groq list.
 */
describe('the catalog against the recorded provider docs', () => {
  type DocModel = { id: string; inputCostPer1M?: number; outputCostPer1M?: number; status?: string };
  const docs = JSON.parse(readFileSync(new URL('./providerModelDocs.json', import.meta.url), 'utf8')) as {
    providers: Record<KeyedProvider, { source: string; models: DocModel[] }>;
  };
  const keyed = Object.keys(LLM_PROVIDER_MODELS).filter((p) => p !== '0g-compute') as KeyedProvider[];
  const docFor = (provider: KeyedProvider, id: string) =>
    docs.providers[provider].models.find((m) => m.id === id || m.id.replace(/-\d{8}$/, '') === id);

  it.each(keyed)('%s: every catalog id is on the provider\'s page, not retired or deprecated', (provider) => {
    expect(docs.providers[provider]?.models.length, `no recorded list for ${provider}`).toBeGreaterThan(0);
    for (const m of LLM_PROVIDER_MODELS[provider]) {
      const doc = docFor(provider, m.id);
      expect(doc, `${provider} ${m.id} is not on ${docs.providers[provider].source}`).toBeDefined();
      expect(doc!.status ?? 'Active', `${provider} ${m.id}`).not.toMatch(/Deprecated|Retired/);
    }
  });

  it.each(keyed)('%s: every catalog price is the page\'s price', (provider) => {
    for (const m of LLM_PROVIDER_MODELS[provider]) {
      const doc = docFor(provider, m.id)!;
      if (doc.inputCostPer1M === undefined) continue;
      expect([m.inputCostPer1M, m.outputCostPer1M], `${provider} ${m.id}`).toEqual([doc.inputCostPer1M, doc.outputCostPer1M]);
    }
  });
});
