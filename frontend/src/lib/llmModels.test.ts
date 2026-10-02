import { describe, it, expect } from 'vitest';
import {
  FALLBACK_MODELS, MIN_KEY_LENGTH, PROVIDER_LABELS, isKeyed, liveListError, liveListRequest,
  modelLabel, modelOptions, providerLabel, usdPer1M, withModel,
} from './llmModels';

const KEY = 'xai-' + 'k'.repeat(MIN_KEY_LENGTH);

describe('providers', () => {
  it('labels xAI so it is not mistaken for Groq', () => {
    expect(providerLabel('xai')).toBe('xAI (Grok)');
    expect(providerLabel('groq')).toBe('Groq');
    expect(providerLabel('mistral')).toBe('mistral');
  });

  it('offers the same providers as the backend catalog, xai among them', () => {
    expect(Object.keys(FALLBACK_MODELS).sort()).toEqual(Object.keys(PROVIDER_LABELS).sort());
    expect(FALLBACK_MODELS.xai[0]).toBe('grok-4.7');
    expect(FALLBACK_MODELS.anthropic).toContain('claude-opus-5-5');
    expect(FALLBACK_MODELS.openai).toContain('gpt-5.5-pro');
    expect(FALLBACK_MODELS.gemini).not.toContain('gemini-2.5-flash');
  });

  it('only 0G Compute goes without a key', () => {
    expect(isKeyed('0g-compute')).toBe(false);
    expect(isKeyed('xai')).toBe(true);
  });
});

describe('modelOptions', () => {
  const live = { provider: 'xai', models: [{ id: 'grok-5' }, { id: 'grok-4.7', inputCostPer1M: 2, outputCostPer1M: 6 }] };

  it("uses the provider's live list, newest first and unpriced models included, once there is one", () => {
    expect(modelOptions('xai', live, FALLBACK_MODELS.xai)).toEqual(live.models);
  });

  it('falls back to the catalog, priced where the catalog prices it', () => {
    const opts = modelOptions('xai', null, ['grok-4.7', 'grok-4.3'], [{ id: 'grok-4.7', inputCostPer1M: 2, outputCostPer1M: 6 }]);
    expect(opts).toEqual([{ id: 'grok-4.7', inputCostPer1M: 2, outputCostPer1M: 6 }, { id: 'grok-4.3' }]);
  });

  it("never shows one provider's live list under another", () => {
    expect(modelOptions('groq', live, ['openai/gpt-oss-120b']).map((m) => m.id)).toEqual(['openai/gpt-oss-120b']);
  });

  it("keeps the agent's own model on the list when the provider no longer lists it", () => {
    expect(withModel(live.models, 'grok-4.20').map((m) => m.id)).toEqual(['grok-5', 'grok-4.7', 'grok-4.20']);
    expect(withModel(live.models, 'grok-4.7')).toEqual(live.models);
    expect(withModel(live.models, '')).toEqual(live.models);
  });
});

describe('labels', () => {
  it('shows the price when known, and says so when not', () => {
    expect(modelLabel({ id: 'grok-4.7', inputCostPer1M: 2, outputCostPer1M: 6 })).toBe('grok-4.7 · $2.00 / $6.00 per 1M');
    expect(modelLabel({ id: 'openai/gpt-oss-20b', inputCostPer1M: 0.075, outputCostPer1M: 0.3 })).toBe('openai/gpt-oss-20b · $0.075 / $0.30 per 1M');
    expect(modelLabel({ id: 'grok-5' })).toBe('grok-5 · price not listed');
  });

  it('marks preview models', () => {
    expect(modelLabel({ id: 'qwen/qwen3.8-27b', inputCostPer1M: 0.8, outputCostPer1M: 4, preview: true })).toBe('qwen/qwen3.8-27b · preview · $0.80 / $4.00 per 1M');
    expect(modelLabel({ id: 'gemini-3-flash-preview', preview: true })).toBe('gemini-3-flash-preview · preview · price not listed');
  });

  it('formats sub-dime prices without rounding them away', () => {
    expect(usdPer1M(0.05)).toBe('$0.05');
    expect(usdPer1M(10)).toBe('$10.00');
  });
});

describe('liveListRequest', () => {
  it('deploy form: lists with the pasted key, only once it looks whole', () => {
    expect(liveListRequest({ provider: 'xai', newKey: KEY })).toEqual({ path: '/api/v1/agents/provider-models', body: { provider: 'xai', apiKey: KEY } });
    expect(liveListRequest({ provider: 'xai', newKey: 'xai-half' })).toBeNull();
    expect(liveListRequest({ provider: 'xai', newKey: '' })).toBeNull();
  });

  it('0G Compute needs no key', () => {
    expect(liveListRequest({ provider: '0g-compute', newKey: '' })).toEqual({ path: '/api/v1/agents/provider-models', body: { provider: '0g-compute', apiKey: '' } });
  });

  it('edit form: lists with the key on file until a new one is pasted', () => {
    expect(liveListRequest({ provider: 'xai', newKey: '', agentId: 'agent-1', agentProvider: 'xai' }))
      .toEqual({ path: '/api/v1/agents/agent-1/provider-models', body: {} });
    expect(liveListRequest({ provider: 'xai', newKey: KEY, agentId: 'agent-1', agentProvider: 'xai' }))
      .toEqual({ path: '/api/v1/agents/provider-models', body: { provider: 'xai', apiKey: KEY } });
  });

  it("edit form: never lists another provider's models with the key on file", () => {
    expect(liveListRequest({ provider: 'anthropic', newKey: '', agentId: 'agent-1', agentProvider: 'xai' })).toBeNull();
  });

  it('edit form: a half-typed new key does not fall back to the key on file', () => {
    expect(liveListRequest({ provider: 'xai', newKey: 'xai-half', agentId: 'agent-1', agentProvider: 'xai' })).toBeNull();
  });
});

describe('liveListError', () => {
  it('names the provider by its label', () => {
    expect(liveListError('xai', { code: 'PROVIDER_AUTH' })).toBe('xAI (Grok) rejected this API key');
    expect(liveListError('xai', { code: 'API_KEY_REQUIRED' })).toBe('Enter an API key for xAI (Grok) to list its models');
    expect(liveListError('openai', { status: 502 })).toBe('Could not list models from the provider — showing our defaults');
  });
});
