import { describe, it, expect, vi, afterEach } from 'vitest';

// 0g-compute's list is read from the chain; never from a test.
vi.mock('./ogComputeCatalog.js', () => ({ readOgServices: vi.fn() }));

import {
  discoverModels, mergeWithCatalog, mergeLive, ProviderModelsError, checkKeyedModel, needsModelCheck,
  openaiChatIds, geminiChatIds, groqChatIds, xaiChatModels, ogOfferedModels, checkOgComputeModel,
  type KeyedProvider,
} from './providerModels.js';
import { readOgServices, type OgService } from './ogComputeCatalog.js';
import { LLM_PROVIDER_MODELS } from '../types.js';

/**
 * The static catalog goes stale; discovery asks the provider. These pin the
 * two things that matter: each provider's list shape is read correctly (chat
 * models only), and the key travels in the right header and nowhere else.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const headersOf = (fetchMock: ReturnType<typeof vi.fn>) =>
  ((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers ?? {}) as Record<string, string>;
const urlOf = (fetchMock: ReturnType<typeof vi.fn>) =>
  (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[0];

afterEach(() => { vi.unstubAllGlobals(); });

describe('list shapes', () => {
  it('openai: chat models only, aliases not dated snapshots', () => {
    const ids = openaiChatIds({ data: [
      { id: 'gpt-5.6-sol' }, { id: 'gpt-5.5' }, { id: 'gpt-4o-2024-08-06' }, { id: 'gpt-4-0613' },
      { id: 'text-embedding-3-large' }, { id: 'gpt-4o-mini-tts' }, { id: 'whisper-1' }, { id: 'gpt-image-1' },
      { id: 'o3' }, { id: 'gpt-4o-realtime-preview' }, { id: 'dall-e-3' }, { id: 'omni-moderation-latest' },
    ] });
    expect(ids).toEqual(['gpt-5.6-sol', 'gpt-5.5', 'o3']);
  });

  it('gemini: strips models/ and keeps generateContent text models', () => {
    const ids = geminiChatIds({ models: [
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-embedding-2-preview', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.1-flash-tts-preview', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/imagen-4', supportedGenerationMethods: ['predict'] },
    ] });
    expect(ids).toEqual(['gemini-3.8-flash']);
  });

  it('groq: active chat models, no speech or guard models', () => {
    const ids = groqChatIds({ data: [
      { id: 'openai/gpt-oss-120b', active: true },
      { id: 'llama-3.3-70b-versatile', active: true },
      { id: 'whisper-large-v3', active: true },
      { id: 'meta-llama/llama-guard-4-12b', active: true },
      { id: 'playai-tts', active: true },
      { id: 'canopylabs/orpheus-v1-english', active: true },
      { id: 'qwen3-32b', active: false },
    ] });
    expect(ids).toEqual(['openai/gpt-oss-120b', 'llama-3.3-70b-versatile']);
  });
});

// GET https://api.x.ai/v1/language-models, shaped as docs.x.ai documents it
// (developers/rest-api-reference/inference/models), trimmed to the fields read.
const XAI_LANGUAGE_MODELS = { models: [
  {
    id: 'grok-4.7', created: 1789000000, object: 'model', owned_by: 'xai', version: '1.0',
    input_modalities: ['text', 'image'], output_modalities: ['text'],
    prompt_text_token_price: 20000, cached_prompt_text_token_price: 5000, completion_text_token_price: 60000,
    aliases: [],
  },
  {
    id: 'grok-4.20-0309-reasoning', created: 1773000000, object: 'model', owned_by: 'xai', version: '1.0',
    input_modalities: ['text', 'image'], output_modalities: ['text'],
    prompt_text_token_price: 12500, completion_text_token_price: 25000,
    aliases: ['grok-4.20', 'grok-4.20-reasoning'],
  },
  {
    // Client-side function calling isn't supported on the multi-agent variant.
    id: 'grok-4.20-multi-agent-0309', created: 1773000000, object: 'model', owned_by: 'xai', version: '1.0',
    input_modalities: ['text', 'image'], output_modalities: ['text'],
    prompt_text_token_price: 12500, completion_text_token_price: 25000,
    aliases: ['grok-4.20-multi-agent'],
  },
  {
    // A model released after the catalog was written, unpriced in the list.
    id: 'grok-5', created: 1790000000, object: 'model', owned_by: 'xai', version: '1.0',
    input_modalities: ['text'], output_modalities: ['text'], aliases: ['grok-5-latest'],
  },
  {
    id: 'grok-imagine-image', created: 1769472000, object: 'model', owned_by: 'xai', version: '1.0',
    input_modalities: ['text'], output_modalities: ['image'], aliases: [],
  },
] };

describe('xai list shape', () => {
  it('chat models with their aliases and prices; no multi-agent, no image output', () => {
    expect(xaiChatModels(XAI_LANGUAGE_MODELS)).toEqual([
      { id: 'grok-4.7', created: 1789000000, inputCostPer1M: 2, outputCostPer1M: 6 },
      { id: 'grok-4.20-0309-reasoning', created: 1773000000, aliases: ['grok-4.20', 'grok-4.20-reasoning'], inputCostPer1M: 1.25, outputCostPer1M: 2.5 },
      { id: 'grok-5', created: 1790000000, aliases: ['grok-5-latest'] },
    ]);
  });

  it('reads nothing from a body of another shape', () => {
    expect(xaiChatModels({ data: [{ id: 'grok-4.7' }] })).toEqual([]);
    expect(xaiChatModels(null)).toEqual([]);
  });
});

describe('mergeWithCatalog (0g-compute)', () => {
  it('catalog order and prices first, retired catalog entries dropped, extras appended', () => {
    const [newest, second] = LLM_PROVIDER_MODELS['0g-compute'];
    const merged = mergeWithCatalog('0g-compute', ['zz-brand-new', second.id, newest.id]);
    expect(merged).toEqual([newest, second, { id: 'zz-brand-new' }]);
  });
});

describe('mergeLive', () => {
  const price = (provider: KeyedProvider, id: string) => LLM_PROVIDER_MODELS[provider].find((m) => m.id === id)!;

  it('newest first by the provider\'s creation time, so a model the catalog lacks sits on top, unpriced', () => {
    const merged = mergeLive('anthropic', [
      { id: 'claude-opus-5-5', created: 300 },
      { id: 'claude-haiku-4-5-20251001', created: 100 },
      { id: 'claude-opus-6', created: 400 },
      { id: 'claude-sonnet-5-5', created: 350 },
    ]);
    expect(merged).toEqual([
      { id: 'claude-opus-6' },
      price('anthropic', 'claude-sonnet-5-5'),
      price('anthropic', 'claude-opus-5-5'),
      // A dated snapshot takes its catalog alias and price.
      price('anthropic', 'claude-haiku-4-5'),
    ]);
  });

  it('drops catalog entries the provider no longer lists', () => {
    const ids = mergeLive('groq', [{ id: 'openai/gpt-oss-20b', created: 1 }]).map((m) => m.id);
    expect(ids).toEqual(['openai/gpt-oss-20b']);
  });

  it('by the version in the id when the list has no dates (Gemini)', () => {
    const ids = mergeLive('gemini', [
      { id: 'gemini-2.5-flash' }, { id: 'gemini-3.5-flash-lite' }, { id: 'gemini-3.9-pro' },
      { id: 'gemini-3.5-flash' }, { id: 'gemini-3.8-flash' }, { id: 'gemini-flash-latest' },
    ]).map((m) => m.id);
    expect(ids).toEqual(['gemini-3.9-pro', 'gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-flash-latest']);
  });

  it("a price in the provider's own list wins over the catalog's", () => {
    const [m] = mergeLive('xai', [{ id: 'grok-4.7', created: 1, inputCostPer1M: 3, outputCostPer1M: 9 }]);
    expect(m).toEqual({ id: 'grok-4.7', inputCostPer1M: 3, outputCostPer1M: 9 });
  });
});

describe('discoverModels', () => {
  it('anthropic: key in x-api-key, never in the URL; newest first by created_at', async () => {
    const fetchMock = vi.fn(async () => json({ data: [
      { id: 'claude-next', created_at: '2026-10-01T00:00:00Z' },
      { id: 'claude-fable-5-1', created_at: '2026-09-01T00:00:00Z' },
      { id: 'claude-opus-5', created_at: '2026-07-24T00:00:00Z' },
    ] }));
    vi.stubGlobal('fetch', fetchMock);
    const models = await discoverModels('anthropic', 'sk-ant-test');
    expect(urlOf(fetchMock)).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models/);
    expect(urlOf(fetchMock)).not.toContain('sk-ant-test');
    expect(headersOf(fetchMock)['x-api-key']).toBe('sk-ant-test');
    expect(models.map(m => m.id)).toEqual(['claude-next', 'claude-fable-5-1', 'claude-opus-5']);
    expect(models[0]).toEqual({ id: 'claude-next' });
    expect(models[1]).toMatchObject({ inputCostPer1M: 10, outputCostPer1M: 50 });
  });

  it('openai: a model newer than every catalog entry comes first', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [
      { id: 'gpt-4o', created: 1715367049 },
      { id: 'gpt-6.1-sol', created: 1788000000 },
      { id: 'gpt-7', created: 1795000000 },
      { id: 'text-embedding-3-large', created: 1705953180 },
    ] })));
    const models = await discoverModels('openai', 'sk-test');
    expect(models.map(m => m.id)).toEqual(['gpt-7', 'gpt-6.1-sol', 'gpt-4o']);
  });

  it('xai: Bearer key to /v1/language-models, never in the URL; prices from the list', async () => {
    const fetchMock = vi.fn(async () => json(XAI_LANGUAGE_MODELS));
    vi.stubGlobal('fetch', fetchMock);
    const models = await discoverModels('xai', 'xai-test-key');
    expect(urlOf(fetchMock)).toBe('https://api.x.ai/v1/language-models');
    expect(urlOf(fetchMock)).not.toContain('xai-test-key');
    expect(headersOf(fetchMock).Authorization).toBe('Bearer xai-test-key');
    expect(models).toEqual([
      { id: 'grok-5' },
      { id: 'grok-4.7', inputCostPer1M: 2, outputCostPer1M: 6 },
      { id: 'grok-4.20-0309-reasoning', inputCostPer1M: 1.25, outputCostPer1M: 2.5 },
    ]);
  });

  it('gemini: key in x-goog-api-key, never in the URL', async () => {
    const fetchMock = vi.fn(async () => json({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] }));
    vi.stubGlobal('fetch', fetchMock);
    await discoverModels('gemini', 'AIza-test');
    expect(urlOf(fetchMock)).not.toContain('AIza-test');
    expect(headersOf(fetchMock)['x-goog-api-key']).toBe('AIza-test');
  });

  it('401 → PROVIDER_AUTH, message carries no key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'bad key' }, 401)));
    const err = await discoverModels('openai', 'sk-SECRET').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderModelsError);
    expect((err as ProviderModelsError).code).toBe('PROVIDER_AUTH');
    expect((err as Error).message).not.toContain('SECRET');
  });

  it('gemini 400 is a bad key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { status: 'INVALID_ARGUMENT', message: 'API key not valid' } }, 400)));
    await expect(discoverModels('gemini', 'AIza-bad')).rejects.toMatchObject({ code: 'PROVIDER_AUTH' });
  });

  it('a malformed key that undici rejects at header time is not echoed', async () => {
    // The one branch where the key text sits in the thrown error's message.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Headers.append: "Bearer sk-SECRET" is an invalid header value'); }));
    const err = await discoverModels('openai', 'sk-SECRET').catch((e: unknown) => e);
    expect((err as ProviderModelsError).code).toBe('PROVIDER_UNAVAILABLE');
    expect((err as Error).message).not.toContain('SECRET');
  });

  it('5xx or network failure → PROVIDER_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 503)));
    await expect(discoverModels('groq', 'gsk-x')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(discoverModels('groq', 'gsk-x')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('checkKeyedModel: a model id the catalog lacks, against the owner\'s own list', () => {
  const list = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => json(body, status)));

  it('accepts a model the provider lists for the key', async () => {
    list(XAI_LANGUAGE_MODELS);
    expect(await checkKeyedModel('xai', 'xai-k', 'grok-5')).toMatchObject({ ok: true });
  });

  it('accepts an alias the provider gives for one', async () => {
    list(XAI_LANGUAGE_MODELS);
    expect((await checkKeyedModel('xai', 'xai-k', 'grok-4.20')).ok).toBe(true);
    expect((await checkKeyedModel('xai', 'xai-k', 'grok-5-latest')).ok).toBe(true);
  });

  it('refuses one it does not list, and names the ones it does', async () => {
    list(XAI_LANGUAGE_MODELS);
    expect(await checkKeyedModel('xai', 'xai-k', 'grok-9')).toEqual({ ok: false, models: ['grok-5', 'grok-4.7', 'grok-4.20-0309-reasoning'] });
  });

  it('refuses a model it lists that the worker cannot run (multi-agent, image-only)', async () => {
    list(XAI_LANGUAGE_MODELS);
    expect((await checkKeyedModel('xai', 'xai-k', 'grok-4.20-multi-agent-0309')).ok).toBe(false);
    expect((await checkKeyedModel('xai', 'xai-k', 'grok-imagine-image')).ok).toBe(false);
  });

  it('accepts the alias of a dated snapshot, and a dated snapshot of a chat model', async () => {
    list({ data: [{ id: 'claude-haiku-4-5-20251001', created_at: '2025-10-01T00:00:00Z' }] });
    expect((await checkKeyedModel('anthropic', 'sk-ant', 'claude-haiku-4-5')).ok).toBe(true);
    list({ data: [{ id: 'gpt-5.5', created: 2 }, { id: 'gpt-5.5-2026-04-23', created: 1 }, { id: 'text-embedding-3-large-2024-01-25', created: 1 }] });
    expect((await checkKeyedModel('openai', 'sk', 'gpt-5.5-2026-04-23')).ok).toBe(true);
    expect((await checkKeyedModel('openai', 'sk', 'text-embedding-3-large-2024-01-25')).ok).toBe(false);
  });

  it('is case-sensitive, like the providers', async () => {
    list(XAI_LANGUAGE_MODELS);
    expect((await checkKeyedModel('xai', 'xai-k', 'GROK-5')).ok).toBe(false);
  });

  it('throws PROVIDER_AUTH on a refused key, without the key in the message', async () => {
    list({ error: 'Incorrect API key provided' }, 401);
    const err = await checkKeyedModel('xai', 'xai-SECRET', 'grok-5').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderModelsError);
    expect((err as ProviderModelsError).code).toBe('PROVIDER_AUTH');
    expect((err as Error).message).not.toContain('SECRET');
  });

  it('throws PROVIDER_UNAVAILABLE when the list cannot be read', async () => {
    list({}, 503);
    await expect(checkKeyedModel('groq', 'gsk', 'qwen/qwen3.9-32b')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('needsModelCheck', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('skips catalog models and checks the rest', () => {
    expect(needsModelCheck('anthropic', 'claude-opus-5-5')).toBe(false);
    expect(needsModelCheck('xai', 'grok-4.7')).toBe(false);
    expect(needsModelCheck('xai', 'grok-5')).toBe(true);
    // The catalog of another provider is not this one's.
    expect(needsModelCheck('groq', 'grok-4.7')).toBe(true);
  });

  it('skips openai when OPENAI_BASE_URL sends its agents elsewhere', () => {
    vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:4477/v1');
    expect(needsModelCheck('openai', 'stub-model')).toBe(false);
    expect(needsModelCheck('groq', 'stub-model')).toBe(true);
  });
});

describe('the catalog', () => {
  it('offers Claude Opus 5.5 and xAI Grok at their published prices', () => {
    expect(LLM_PROVIDER_MODELS.anthropic.find((m) => m.id === 'claude-opus-5-5')).toEqual({ id: 'claude-opus-5-5', inputCostPer1M: 4, outputCostPer1M: 20 });
    expect(LLM_PROVIDER_MODELS.anthropic.find((m) => m.id === 'claude-sonnet-5-5')).toEqual({ id: 'claude-sonnet-5-5', inputCostPer1M: 2, outputCostPer1M: 10 });
    expect(LLM_PROVIDER_MODELS.xai[0]).toEqual({ id: 'grok-4.7', inputCostPer1M: 2, outputCostPer1M: 6 });
    expect(LLM_PROVIDER_MODELS.openai[0]).toEqual({ id: 'gpt-6.1-sol', inputCostPer1M: 2, outputCostPer1M: 10 });
  });

  it('has no duplicate ids and no unpriced entries', () => {
    for (const [provider, models] of Object.entries(LLM_PROVIDER_MODELS)) {
      expect(new Set(models.map((m) => m.id)).size, provider).toBe(models.length);
      for (const m of models) {
        expect(m.inputCostPer1M, `${provider} ${m.id}`).toBeGreaterThan(0);
        expect(m.outputCostPer1M, `${provider} ${m.id}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps no model that Groq took off its developer tier, or that xAI gives no client tools', () => {
    expect(LLM_PROVIDER_MODELS.groq.map((m) => m.id)).not.toContain('llama-3.3-70b-versatile');
    expect(LLM_PROVIDER_MODELS.xai.map((m) => m.id).some((id) => id.includes('multi-agent'))).toBe(false);
  });
});

// What 0G Compute's mainnet looked like on 2026-10-02 (InferenceServing plus the
// status API), trimmed: the shapes the backend reads.
const service = (provider: string, model: string, extra: Partial<OgService> = {}): OgService => ({
  provider, model, serviceType: 'chatbot', url: `https://${provider.slice(2, 8)}.example`,
  inputPrice: 5_000_000_000_000n, outputPrice: 20_000_000_000_000n, teeSignerAcknowledged: true,
  formats: ['openai'], usdIn: 0.000001, usdOut: 0.000004, ...extra,
});
const MAINNET: OgService[] = [
  service('0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C', 'glm-5', { usdIn: 0.000000666667, usdOut: 0.000003 }),
  service('0x36aCffCEa3CCe07cAdd1740Ad992dB16Ab324517', 'openai/whisper-large-v3', { serviceType: 'speech-to-text' }),
  service('0xd3f02c1a04160389d98D2192AE2034159f731011', 'claude-opus-5', { formats: ['anthropic'] }),
  service('0x1B3AAef3ae5050EEE04ea38cD4B087472BD85EB0', 'qwen3.7-plus', { usdIn: 0.000000291667, usdOut: 0.000001166667 }),
  service('0x44ba5021daDa2eDc84b4f5FC170b85F7bC51ef64', 'openai/gpt-oss-20b', { teeSignerAcknowledged: false }),
  // No status-API detail on it: no formats, no price.
  service('0x25F8f01cA76060ea40895472b1b79f76613Ca497', 'openai/gpt-5.4-mini', { formats: undefined, usdIn: undefined, usdOut: undefined }),
  service('0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D', 'glm-5.3', {
    inputPrice: 4_690_000_000_000n, outputPrice: 14_740_000_000_000n, formats: ['openai', 'anthropic'], usdIn: 0.0000014, usdOut: 0.0000044,
  }),
  service('0x6446fE523D8f3678185ed53e3ADEffB4d27475cC', 'glm-5.3', {
    inputPrice: 7_140_000_000_000n, outputPrice: 22_450_000_000_000n, formats: ['openai', 'anthropic'], usdIn: 0.0000021, usdOut: 0.0000066,
  }),
];

describe('0g-compute models: what an agent can pay a provider for', () => {
  afterEach(() => { vi.mocked(readOgServices).mockReset(); });

  it('one entry per on-chain chat model served over the OpenAI API, priced from the provider the worker picks', () => {
    expect(ogOfferedModels(MAINNET)).toEqual([
      { id: 'glm-5', inputCostPer1M: 0.667, outputCostPer1M: 3 },
      { id: 'qwen3.7-plus', inputCostPer1M: 0.292, outputCostPer1M: 1.167 },
      { id: 'openai/gpt-5.4-mini' },
      // The cheaper of the two glm-5.3 providers.
      { id: 'glm-5.3', inputCostPer1M: 1.4, outputCostPer1M: 4.4 },
    ]);
  });

  it('discoverModels lists them from the chain, in catalog order, and never the Router catalog', async () => {
    vi.mocked(readOgServices).mockResolvedValue(MAINNET);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const models = await discoverModels('0g-compute', '');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(models.map((m) => m.id)).toEqual(['glm-5', 'qwen3.7-plus', 'glm-5.3', 'openai/gpt-5.4-mini']);
    expect(models.map((m) => m.id)).not.toContain('deepseek-v4-flash');
    expect(models[0]).toEqual({ id: 'glm-5', inputCostPer1M: 0.667, outputCostPer1M: 3 });
  });

  it("discoverModels keeps the catalog's dated price when 0G's status API has none", async () => {
    vi.mocked(readOgServices).mockResolvedValue([service('0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C', 'glm-5', { formats: undefined, usdIn: undefined, usdOut: undefined })]);
    const [glm5] = await discoverModels('0g-compute', '');
    expect(glm5).toEqual(LLM_PROVIDER_MODELS['0g-compute'].find((m) => m.id === 'glm-5'));
  });

  it('discoverModels reports an unreadable chain as PROVIDER_UNAVAILABLE', async () => {
    vi.mocked(readOgServices).mockRejectedValue(new Error('could not detect network'));
    await expect(discoverModels('0g-compute', '')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('a chain read that hangs falls back to the catalog instead of holding a deploy', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(readOgServices).mockReturnValue(new Promise(() => {}));
      const pending = checkOgComputeModel('glm-5');
      await vi.advanceTimersByTimeAsync(12_000);
      expect((await pending).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkOgComputeModel refuses a Router-only model and names the ones that work', async () => {
    vi.mocked(readOgServices).mockResolvedValue(MAINNET);
    const check = await checkOgComputeModel('deepseek-v4-flash');
    expect(check.ok).toBe(false);
    expect(check.models).toEqual(['glm-5', 'qwen3.7-plus', 'openai/gpt-5.4-mini', 'glm-5.3']);
  });

  it('checkOgComputeModel accepts an on-chain model, matched the way the worker matches it', async () => {
    vi.mocked(readOgServices).mockResolvedValue(MAINNET);
    expect((await checkOgComputeModel('glm-5')).ok).toBe(true);
    expect((await checkOgComputeModel('GLM-5.3')).ok).toBe(true);
  });

  it('checkOgComputeModel refuses a model served only over the Anthropic API, or only unacknowledged', async () => {
    vi.mocked(readOgServices).mockResolvedValue(MAINNET);
    expect((await checkOgComputeModel('claude-opus-5')).ok).toBe(false);
    expect((await checkOgComputeModel('openai/gpt-oss-20b')).ok).toBe(false);
  });

  it('checkOgComputeModel falls back to the catalog when the chain cannot be read', async () => {
    vi.mocked(readOgServices).mockRejectedValue(new Error('timeout'));
    expect(await checkOgComputeModel('glm-5')).toEqual({ ok: true, models: LLM_PROVIDER_MODELS['0g-compute'].map((m) => m.id) });
    expect((await checkOgComputeModel('deepseek-v4-flash')).ok).toBe(false);
  });
});
