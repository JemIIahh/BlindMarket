import { describe, it, expect, vi, afterEach } from 'vitest';

// 0g-compute's list is read from the chain; never from a test.
vi.mock('./ogComputeCatalog.js', () => ({ readOgServices: vi.fn() }));

import {
  discoverModels, mergeWithCatalog, ProviderModelsError,
  openaiChatIds, geminiChatIds, groqChatIds, ogOfferedModels, checkOgComputeModel,
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

describe('mergeWithCatalog', () => {
  it('catalog order and prices first, retired catalog entries dropped, extras appended', () => {
    const [newest, second] = LLM_PROVIDER_MODELS.anthropic;
    const merged = mergeWithCatalog('anthropic', ['claude-brand-new', second.id, newest.id]);
    expect(merged).toEqual([newest, second, { id: 'claude-brand-new' }]);
  });
});

describe('discoverModels', () => {
  it('anthropic: key in x-api-key, never in the URL; catalog-first result', async () => {
    const fetchMock = vi.fn(async () => json({ data: [{ id: 'claude-opus-5' }, { id: 'claude-fable-5-1' }, { id: 'claude-next' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const models = await discoverModels('anthropic', 'sk-ant-test');
    expect(urlOf(fetchMock)).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models/);
    expect(urlOf(fetchMock)).not.toContain('sk-ant-test');
    expect(headersOf(fetchMock)['x-api-key']).toBe('sk-ant-test');
    expect(models.map(m => m.id)).toEqual(['claude-fable-5-1', 'claude-opus-5', 'claude-next']);
    expect(models[0]).toMatchObject({ inputCostPer1M: 10, outputCostPer1M: 50 });
    expect(models[2]).toEqual({ id: 'claude-next' });
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
