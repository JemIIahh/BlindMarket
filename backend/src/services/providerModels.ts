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
 */
import { LLM_PROVIDER_MODELS, type LLMProvider } from '../types.js';

export interface DiscoveredModel {
  id: string;
  /** USD per 1M tokens — present when the catalog (or, for 0G, the router) prices the model. */
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
export const OG_ROUTER_MODELS_URL = 'https://router-api.0g.ai/v1/models';

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

/** Groq: OpenAI-shaped list plus an `active` flag; skip speech and guard models. */
export function groqChatIds(body: unknown): string[] {
  const data = (body as { data?: Array<{ id?: unknown; active?: unknown }> })?.data ?? [];
  return data
    .filter((m) => typeof m.id === 'string' && m.active !== false)
    .map((m) => m.id as string)
    .filter((id) => !/(whisper|tts|guard)/i.test(id));
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

/** 0G router: typed entries with per-token USD pricing. */
export function ogChatModels(body: unknown): DiscoveredModel[] {
  const data = (body as {
    data?: Array<{ id?: unknown; type?: unknown; pricing_usd?: { prompt?: string; completion?: string } }>;
  })?.data ?? [];
  return data
    .filter((m) => typeof m.id === 'string' && m.type === 'chatbot')
    .map((m) => {
      const id = m.id as string;
      const inp = m.pricing_usd?.prompt !== undefined ? Number(m.pricing_usd.prompt) * 1e6 : NaN;
      const out = m.pricing_usd?.completion !== undefined ? Number(m.pricing_usd.completion) * 1e6 : NaN;
      return Number.isFinite(inp) && Number.isFinite(out)
        ? { id, inputCostPer1M: round3(inp), outputCostPer1M: round3(out) }
        : { id };
    });
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
    const live = ogChatModels(await fetchJson(OG_ROUTER_MODELS_URL, {}, provider));
    // Router prices are the authority for 0G; the catalog only sets the order.
    const byId = new Map(live.map((m) => [m.id, m]));
    return mergeWithCatalog(provider, live.map((m) => m.id)).map((m) => byId.get(m.id) ?? m);
  }
  const spec = KEYED[provider];
  return mergeWithCatalog(provider, spec.ids(await fetchJson(spec.url, spec.headers(apiKey), provider)));
}
