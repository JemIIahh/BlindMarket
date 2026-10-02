/**
 * Live model discovery for the deploy and edit forms.
 *
 * LLM_PROVIDER_MODELS is a hand-edited table and it goes stale — its last
 * refresh before this was 2026-08-05, by which point every provider had
 * shipped a generation it didn't list. The platform holds no provider keys,
 * so the only key that can ask a provider "what can I use?" is the owner's:
 * the one just pasted into the form, or the one an agent already runs on. It
 * is sent once to that provider's fixed models endpoint and nowhere else:
 * never logged, never echoed back in an error.
 *
 * The same list checks a model id the catalog doesn't know (checkKeyedModel),
 * so an owner can run a model released today. Listing models is free; no
 * model is called.
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
  /** USD per 1M tokens — present when the catalog (or the provider's own list: xAI, 0G's status API) prices the model. */
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  /** The catalog marks it preview or beta. */
  preview?: true;
}

/** The providers an owner brings an API key for. */
export type KeyedProvider = Exclude<LLMProvider, '0g-compute'>;

/** One chat model as a provider's models endpoint lists it. */
export interface LiveModel {
  id: string;
  /** When the provider says the model was created, in Unix seconds. */
  created?: number;
  /** Other ids the provider takes for it in a request (xAI lists these). */
  aliases?: string[];
  /** USD per 1M tokens, when the provider's list carries prices (xAI). */
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

/** OpenAI: drop embeddings/audio/image/etc. and dated snapshots (the alias suffices). chat-latest is ChatGPT's Instant model. */
export function openaiChatIds(body: unknown): string[] {
  return listIds(body)
    .filter((id) => /^(gpt-|o\d|chatgpt-|chat-latest$)/.test(id))
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
    .filter((id) => !/(image|tts|live|embedding|transcribe|translate|omni|audio|computer-use|robotics)/.test(id));
}

/**
 * xAI: GET /v1/language-models lists the chat and image-understanding models
 * with their modalities, aliases and prices (USD cents per 100M tokens, so
 * /10,000 gives USD per 1M). The multi-agent variants are left out: xAI
 * documents no client-side function calling for them, and the worker's tools
 * are client-side functions.
 */
export function xaiChatModels(body: unknown): LiveModel[] {
  const models = (body as { models?: Array<Record<string, unknown>> })?.models ?? [];
  const out: LiveModel[] = [];
  for (const m of models) {
    if (typeof m.id !== 'string' || !Array.isArray(m.output_modalities) || !m.output_modalities.includes('text')) continue;
    const aliases = Array.isArray(m.aliases) ? m.aliases.filter((a): a is string => typeof a === 'string') : [];
    if ([m.id, ...aliases].some((id) => /multi-agent/.test(id))) continue;
    const input = xaiPrice(m.prompt_text_token_price);
    const output = xaiPrice(m.completion_text_token_price);
    out.push({
      id: m.id,
      ...(typeof m.created === 'number' ? { created: m.created } : {}),
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(input !== undefined && output !== undefined ? { inputCostPer1M: input, outputCostPer1M: output } : {}),
    });
  }
  return out;
}

function xaiPrice(centsPer100M: unknown): number | undefined {
  return typeof centsPer100M === 'number' && centsPer100M > 0 ? round3(centsPer100M / 10_000) : undefined;
}

/**
 * The ids, each with the creation time an OpenAI-shaped list gives it:
 * `created` in Unix seconds (OpenAI, Groq) or `created_at` as RFC 3339
 * (Anthropic). Gemini's list has neither.
 */
export function withCreated(body: unknown, ids: readonly string[]): LiveModel[] {
  const data = (body as { data?: Array<{ id?: unknown; created?: unknown; created_at?: unknown }> })?.data ?? [];
  const created = new Map<string, number>();
  for (const m of data) {
    if (typeof m.id !== 'string') continue;
    const t = typeof m.created === 'number' ? m.created
      : typeof m.created_at === 'string' ? Date.parse(m.created_at) / 1000 : NaN;
    if (Number.isFinite(t)) created.set(m.id, t);
  }
  return ids.map((id) => (created.has(id) ? { id, created: created.get(id)! } : { id }));
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

const KEYED: Record<KeyedProvider, {
  url: string;
  headers: (key: string) => Record<string, string>;
  models: (body: unknown) => LiveModel[];
}> = {
  openai: {
    url: 'https://api.openai.com/v1/models',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    models: (b) => withCreated(b, openaiChatIds(b)),
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/models?limit=1000',
    headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
    models: (b) => withCreated(b, anthropicChatIds(b)),
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/models',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    models: (b) => withCreated(b, groqChatIds(b)),
  },
  gemini: {
    // Key goes in a header, not the ?key= query string, so it never lands in
    // a URL anywhere (access logs, error messages).
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    headers: (k) => ({ 'x-goog-api-key': k }),
    models: (b) => withCreated(b, geminiChatIds(b)),
  },
  xai: {
    // Not /v1/models: this one says which models are chat models, and prices them.
    url: 'https://api.x.ai/v1/language-models',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
    models: xaiChatModels,
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

/** What `apiKey` can use on `provider`: its chat models, and every id the list named. */
async function fetchLive(provider: KeyedProvider, apiKey: string): Promise<{ models: LiveModel[]; listed: string[] }> {
  const spec = KEYED[provider];
  const body = await fetchJson(spec.url, spec.headers(apiKey), provider);
  return { models: spec.models(body), listed: listIds(body) };
}

/**
 * Catalog order first (it's curated newest-first and carries prices), then
 * whatever else the provider listed, newest-looking first. Catalog entries the
 * provider no longer lists are dropped — that's the retirement signal the
 * static table can't give. 0g-compute's list; keyed providers use mergeLive.
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

/** A dated snapshot's alias: claude-haiku-4-5-20251001 and gpt-4o-2024-08-06 → claude-haiku-4-5, gpt-4o. */
function undated(id: string): string {
  return id.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');
}

/** The catalog entry `liveId` is, directly or as a dated snapshot of it. */
function catalogEntry(provider: LLMProvider, liveId: string) {
  const catalog = LLM_PROVIDER_MODELS[provider] ?? [];
  return catalog.find((m) => m.id === liveId) ?? catalog.find((m) => m.id === undated(liveId));
}

/** The version numbers in a model id, for ordering a list with no dates: gemini-3.8-flash → [3, 8]. */
function versionOf(id: string): number[] {
  const run = /\d+(?:[.-]\d+)*/.exec(id)?.[0] ?? '';
  return run.split(/[.-]/).filter((p) => p !== '' && p.length < 6).map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Every chat model the provider listed, newest first, so a model released
 * after the catalog was last edited sits at the top rather than under the
 * models it replaced. Newest by the provider's own creation time; Gemini's
 * list has none, so by the version in the id. A model the catalog knows,
 * including as a dated snapshot, takes the catalog's id and price; a price
 * in the provider's own list (xAI) wins over the catalog's dated one. A
 * catalog entry the provider no longer lists is dropped: that's the
 * retirement signal the static table can't give.
 */
export function mergeLive(provider: KeyedProvider, live: readonly LiveModel[]): DiscoveredModel[] {
  const catalog = LLM_PROVIDER_MODELS[provider] ?? [];
  const rows = new Map<string, { model: DiscoveredModel; created?: number; rank: number }>();
  for (const m of live) {
    const known = catalogEntry(provider, m.id);
    const id = known?.id ?? m.id;
    if (rows.has(id)) continue;
    const model: DiscoveredModel = m.inputCostPer1M !== undefined && m.outputCostPer1M !== undefined
      ? { id, inputCostPer1M: m.inputCostPer1M, outputCostPer1M: m.outputCostPer1M, ...(known?.preview ? { preview: true as const } : {}) }
      : known ? { ...known } : { id };
    rows.set(id, { model, created: m.created, rank: known ? catalog.indexOf(known) : catalog.length });
  }
  const list = [...rows.values()];
  const dated = list.every((r) => r.created !== undefined);
  return list
    .sort((a, b) => (dated ? b.created! - a.created! : compareVersions(versionOf(b.model.id), versionOf(a.model.id)))
      || a.rank - b.rank
      || b.model.id.localeCompare(a.model.id, undefined, { numeric: true }))
    .map((r) => r.model);
}

/**
 * Whether `model` names one of the provider's chat models for this key: its
 * id or an alias the provider gives, the alias of a dated snapshot it lists
 * (claude-haiku-4-5), or a dated snapshot of a chat model it lists
 * (gpt-5.5-2026-04-23, which the chat filter keeps only as gpt-5.5).
 */
export function listsModel(live: { models: readonly LiveModel[]; listed: readonly string[] }, model: string): boolean {
  const chat = new Set(live.models.flatMap((m) => [m.id, ...(m.aliases ?? [])]));
  if (chat.has(model)) return true;
  if ([...chat].some((id) => undated(id) === model)) return true;
  return model !== undated(model) && live.listed.includes(model) && chat.has(undated(model));
}

/**
 * Whether an agent on `provider` with `apiKey` can run `model`, by the
 * provider's own models list for that key (one request; no model is called).
 * `models` is what it can run instead. Throws ProviderModelsError when the
 * key is refused or the list can't be read: an unchecked model is not passed.
 */
export async function checkKeyedModel(provider: KeyedProvider, apiKey: string, model: string): Promise<{ ok: boolean; models: string[] }> {
  const live = await fetchLive(provider, apiKey);
  return { ok: listsModel(live, model), models: mergeLive(provider, live.models).map((m) => m.id) };
}

/**
 * Whether deploy and edit should check `model` against the provider's list.
 * Not for a catalog model: those are known, and a deploy on one never waits
 * on the provider. Not for openai when OPENAI_BASE_URL points its agents at
 * another endpoint (a self-hosted model, a proxy, the E2E stub): that
 * endpoint serves models api.openai.com would not list.
 */
export function needsModelCheck(provider: KeyedProvider, model: string): boolean {
  if ((LLM_PROVIDER_MODELS[provider] ?? []).some((m) => m.id === model)) return false;
  return !(provider === 'openai' && process.env.OPENAI_BASE_URL);
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
  return mergeLive(provider, (await fetchLive(provider, apiKey)).models);
}
