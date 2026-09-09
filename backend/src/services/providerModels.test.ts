import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  discoverModels, mergeWithCatalog, ProviderModelsError,
  openaiChatIds, geminiChatIds, groqChatIds, ogChatModels,
} from './providerModels.js';
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
      { id: 'qwen3-32b', active: false },
    ] });
    expect(ids).toEqual(['openai/gpt-oss-120b', 'llama-3.3-70b-versatile']);
  });

  it('0g: chatbot entries, router per-token USD → $/1M', () => {
    const models = ogChatModels({ data: [
      { id: 'deepseek-v4-flash', type: 'chatbot', pricing_usd: { prompt: '0.000000138', completion: '0.000000275' } },
      { id: 'whisper-large-v3', type: 'speech-to-text', pricing_usd: { prompt: '0', completion: '0' } },
      { id: 'z-image-turbo', type: 'text-to-image' },
      { id: 'mystery-chat', type: 'chatbot' },
    ] });
    expect(models).toEqual([
      { id: 'deepseek-v4-flash', inputCostPer1M: 0.138, outputCostPer1M: 0.275 },
      { id: 'mystery-chat' },
    ]);
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

  it('0g-compute: keyless, router prices override the catalog', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [
      { id: 'deepseek-v4-flash', type: 'chatbot', pricing_usd: { prompt: '0.0000002', completion: '0.0000004' } },
    ] })));
    const models = await discoverModels('0g-compute', '');
    expect(models).toEqual([{ id: 'deepseek-v4-flash', inputCostPer1M: 0.2, outputCostPer1M: 0.4 }]);
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

  it('5xx or network failure → PROVIDER_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 503)));
    await expect(discoverModels('groq', 'gsk-x')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(discoverModels('groq', 'gsk-x')).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});
