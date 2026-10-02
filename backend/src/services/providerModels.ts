/**
 * Live model discovery for the deploy form.
 *
 * LLM_PROVIDER_MODELS is a hand-edited table and it goes stale — its last
 * refresh before this was 2026-08-05, by which point every provider had
 * shipped a generation it didn't list. The platform holds no provider keys,
 * so the only key that can ask a provider "what can I use?" is the one the
 * user just pasted into the form. It is forwarded once to that provider's
 * fixed models endpoint and dropped: never stored, never logged, never echoed
 * back in an error.
 *
 * 0g-compute needs no key: its models are the chat services registered on
 * 0G Compute (ogComputeCatalog.ts), the only ones a 0g-compute agent's
 * account can pay for.
 */
import { LLM_PROVIDER_MODELS, type LLMProvider } from '../types.js';
import { readOgServices, type OgService } from './ogComputeCatalog.js';
import { matchOgService, ogChatServices } from './ogComputeModels.js';

export interface DiscoveredModel {
  id: string;
  /** USD per 1M tokens — present when the catalog (or, for 0G, 0G's status API) prices the model. */
  inputCostPer1M?: number;
  outputCostPer1M?: number;
}

export class ProviderModelsError extends Error {
  constructor(public code: 'PROVIDER_AUTH' | 'PROVIDER_UNAVAILABLE', message: string) {
    super(message);
    this.name = 'ProviderModelsError';
  }
}

const FETCH_TIMEOUT_MS = 8_000;

// ── Per-provider list shapes ─────────────────────────────────────────────────
// Each provider's /models lists every modality it serves. These keep the
// chat-capable ids — the only ones worker.js can drive through generateText.

/** OpenAI: drop embeddings/audio/image/etc. and dated snapshots (the alias suffices). */
export function openaiChatIds(body: unknown): string[] {
  return listIds(body)
    .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id))
    .filter((id) => !/(embedding|tts|whisper|audio|realtime|transcribe|image|moderation|search|instruct|codex|computer-use|deep-research)/.test(id))
    .filter((id) => !/-\d{4}(-\d{2}-\d{2})?$/.test(id));
}

/** Anthropic: every listed model is a chat model. */
export function anthropicChatIds(body: unknown): string[] {
  return listIds(body);
}

/**
 * Groq: OpenAI-shaped list plus an `active` flag, but no modality field — so
 * speech models are recognised by name: whisper (STT), playai/orpheus (TTS,
 * billed per character), plus the llama-guard classifiers.
 */
export function groqChatIds(body: unknown): string[] {
  const data = (body as { data?: Array<{ id?: unknown; active?: unknown }> })?.data ?? [];
  return data
    .filter((m) => typeof m.id === 'string' && m.active !== false)
    .map((m) => m.id as string)
    .filter((id) => !/(whisper|tts|orpheus|playai|guard)/i.test(id));
}

/** Gemini: `models/<id>` names; keep the text models that answer generateContent. */
export function geminiChatIds(body: unknown): string[] {
  const models = (body as { models?: Array<{ name?: unknown; supportedGenerationMethods?: unknown }> })?.models ?? [];
  return models
    .filter((m) => typeof m.name === 'string'
      && Array.isArray(m.supportedGenerationMethods)
      && m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => (m.name as string).replace(/^models\//, ''))
    .filter((id) => /^gemini-/.test(id))
    .filter((id) => !/(image|tts|live|embedding|transcribe|translate|omni|audio|computer-use)/.test(id));
}

/**
 * 0G Compute services a 0g-compute agent can call: on-chain chat services
 * (ogChatServices) that answer OpenAI chat completions, the only API the
 * worker speaks to them. The status API lists the Claude providers as
 * 'anthropic' only (Oct 2026), so they are left out; a service it has no
 * detail on is kept, since 0G's serving broker is OpenAI-compatible.
 */
export function ogCallableServices(services: readonly OgService[]): OgService[] {
  return ogChatServices(services).filter((s) => !s.formats || s.formats.includes('openai'));
}

/**
 * One entry per model a 0g-compute agent can run, priced (USD per 1M tokens,
 * from 0G's status API) from the provider the worker would pick for it.
 */
export function ogOfferedModels(services: readonly OgService[]): DiscoveredModel[] {
  const callable = ogCallableServices(services);
  const ids = [...new Set(callable.map((s) => s.model))];
  return ids.map((id) => {
    const s = matchOgService(callable, id)!;
    return s.usdIn !== undefined && s.usdOut !== undefined
      ? { id, inputCostPer1M: round3(s.usdIn * 1e6), outputCostPer1M: round3(s.usdOut * 1e6) }
      : { id };
  });
}

// The chain read has no timeout of its own; a deploy must not hang on it.
const OG_READ_TIMEOUT_MS = 12_000;

function readOgServicesWithin(ms = OG_READ_TIMEOUT_MS): Promise<OgService[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    readOgServices(),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function readOgServicesOrThrow(): Promise<OgService[]> {
  try {
    return await readOgServicesWithin();
  } catch (err) {
    throw new ProviderModelsError('PROVIDER_UNAVAILABLE', `0g-compute services could not be read: ${(err as Error).message}`);
  }
}

/**
 * Whether a 0g-compute agent can run `model`: some provider on 0G Compute
 * serves it (matched the way worker.js matches it). `models` is what can be
 * run instead. When 0G Compute can't be read, the static catalog answers.
 */
export async function checkOgComputeModel(model: string): Promise<{ ok: boolean; models: string[] }> {
  let services: OgService[] | null = null;
  try {
    services = await readOgServicesWithin();
  } catch {
    services = null;
  }
  if (services) {
    const callable = ogCallableServices(services);
    return { ok: matchOgService(callable, model) !== null, models: ogOfferedModels(services).map((m) => m.id) };
  }
  const models = LLM_PROVIDER_MODELS['0g-compute'].map((m) => m.id);
  return { ok: models.some((id) => id.toLowerCase() === model.toLowerCase()), models };
}

function listIds(body: unknown): string[] {
  const data = (body as { data?: Array<{ id?: unknown }> })?.data ?? [];
  return data.map((m) => m.id).filter((id): id is string => typeof id === 'string');
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── Fetch ────────────────────────────────────────────────────────────────────

const KEYED: Record<Exclude<LLMProvider, '0g-compute'>, {
  url: string;
  headers: (key: string) => Record<string, string>;
  ids: (body: unknown) => string[];
}> = {
  openai: {
    url: 'https://api.openai.com/v1/models',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    ids: openaiChatIds,
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/models?limit=1000',
    headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
    ids: anthropicChatIds,
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/models',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    ids: groqChatIds,
  },
  gemini: {
    // Key goes in a header, not the ?key= query string, so it never lands in
    // a URL anywhere (access logs, error messages).
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    headers: (k) => ({ 'x-goog-api-key': k }),
    ids: geminiChatIds,
  },
};

async function fetchJson(url: string, headers: Record<string, string>, provider: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new ProviderModelsError('PROVIDER_UNAVAILABLE', `${provider} models endpoint unreachable: ${(err as Error).name}`);
  }
  // Gemini answers a bad key with 400 (API_KEY_INVALID); the others use 401/403.
  if (res.status === 401 || res.status === 403 || (provider === 'gemini' && res.status === 400)) {
    throw new ProviderModelsError('PROVIDER_AUTH', `${provider} rejected the API key`);
  }
  if (!res.ok) {
    throw new ProviderModelsError('PROVIDER_UNAVAILABLE', `${provider} models endpoint returned ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new ProviderModelsError('PROVIDER_UNAVAILABLE', `${provider} models endpoint returned non-JSON`);
  }
}

/**
 * Catalog order first (it's curated newest-first and carries prices), then
 * whatever else the provider listed, newest-looking first. Catalog entries the
 * provider no longer lists are dropped — that's the retirement signal the
 * static table can't give.
 */
export function mergeWithCatalog(provider: LLMProvider, liveIds: string[]): DiscoveredModel[] {
  const live = new Set(liveIds);
  const head: DiscoveredModel[] = (LLM_PROVIDER_MODELS[provider] ?? []).filter((m) => live.has(m.id));
  const seen = new Set(head.map((m) => m.id));
  const tail = liveIds
    .filter((id) => !seen.has(id))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((id) => ({ id }));
  return [...head, ...tail];
}

export async function discoverModels(provider: LLMProvider, apiKey: string): Promise<DiscoveredModel[]> {
  if (provider === '0g-compute') {
    const live = ogOfferedModels(await readOgServicesOrThrow());
    // The catalog sets the order; 0G's prices win over its dated ones.
    const byId = new Map(live.map((m) => [m.id, m]));
    return mergeWithCatalog(provider, live.map((m) => m.id)).map((m) => {
      const fresh = byId.get(m.id);
      return fresh && fresh.inputCostPer1M !== undefined ? fresh : m;
    });
  }
  const spec = KEYED[provider];
  return mergeWithCatalog(provider, spec.ids(await fetchJson(spec.url, spec.headers(apiKey), provider)));
}
