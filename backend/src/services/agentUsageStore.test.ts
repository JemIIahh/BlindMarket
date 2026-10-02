import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./neonDb.js', () => ({ getPool: vi.fn() }));
vi.mock('./database.js', () => ({ getDb: vi.fn() }));

const { priceFor } = await import('./agentUsageStore.js');

/** Usage cost reads the model catalog, so a provider added there (xAI) is priced, not estimated. */
describe('priceFor', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('prices a catalog model from the catalog, on its provider', () => {
    expect(priceFor('grok-4.7', 'xai')).toEqual({ input: 2, output: 6, estimated: false });
    expect(priceFor('claude-opus-5-5', 'anthropic')).toEqual({ input: 4, output: 20, estimated: false });
    expect(priceFor('openai/gpt-oss-120b', 'groq')).toEqual({ input: 0.15, output: 0.6, estimated: false });
  });

  it('still prices the older ids the catalog dropped, by name', () => {
    expect(priceFor('claude-sonnet-4', 'anthropic')).toEqual({ input: 3, output: 15, estimated: false });
  });

  it('flags a model nothing prices as estimated', () => {
    expect(priceFor('grok-9', 'xai')).toEqual({ input: 1, output: 3, estimated: true });
  });

  it('lets MODEL_PRICES_JSON override the catalog', () => {
    vi.stubEnv('MODEL_PRICES_JSON', JSON.stringify({ 'grok-4.7': { input: 9, output: 9 } }));
    expect(priceFor('grok-4.7', 'xai')).toEqual({ input: 9, output: 9, estimated: false });
  });
});
