/**
 * The model picker behind the deploy and edit forms: the providers, what each
 * is called, and which list of models to offer.
 *
 * Before there is a key, the list is the backend's catalog (GET
 * /agents/providers, LLM_PROVIDER_MODELS). Once there is one, it is the
 * provider's own list for that key, newest first, with models the catalog
 * doesn't know yet shown unpriced: POST /agents/provider-models with a pasted
 * key, or POST /agents/:id/provider-models with the key an agent already runs
 * on. An owner can also type a model id; the backend checks it against that
 * same list when the agent is deployed or saved.
 */

export type Provider = 'openai' | 'anthropic' | 'groq' | 'gemini' | 'xai' | '0g-compute';

export interface ModelOption {
  id: string;
  /** USD per 1M tokens, when the catalog or the provider's list prices it. */
  inputCostPer1M?: number;
  outputCostPer1M?: number;
}

/** xAI's Grok and Groq are different companies: the labels say which is which. */
export const PROVIDER_LABELS: Record<Provider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  groq: 'Groq',
  gemini: 'Google Gemini',
  xai: 'xAI (Grok)',
  '0g-compute': '0G Compute',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider as Provider] ?? provider;
}

/**
 * Pre-fetch fallback — mirrors LLM_PROVIDER_MODELS in backend/src/types.ts,
 * which GET /agents/providers replaces as soon as it answers.
 */
export const FALLBACK_MODELS: Record<Provider, string[]> = {
  openai: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
  anthropic: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
  gemini: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  xai: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning', 'grok-build-0.1'],
  '0g-compute': ['glm-5', 'qwen3.7-plus', 'glm-5.3', '0GM-1.0-35B-A3B', '0GM-1.0-35B-A3B-SIA'],
};

/** The select value that switches the picker to a typed model id. */
export const CUSTOM_MODEL = '__custom__';

/** Shorter than this is a key still being typed: never sent to a provider. */
export const MIN_KEY_LENGTH = 20;

/** Whether the provider takes an API key (all but 0G Compute, which bills the agent's wallet). */
export function isKeyed(provider: string): boolean {
  return provider !== '0g-compute';
}

/**
 * The models to offer for `provider`: the live list when there is one for it,
 * else the catalog ids with the catalog's prices.
 */
export function modelOptions(
  provider: string,
  live: { provider: string; models: ModelOption[] } | null,
  catalogIds: readonly string[],
  pricing: readonly ModelOption[] = [],
): ModelOption[] {
  if (live && live.provider === provider) return live.models;
  return catalogIds.map((id) => pricing.find((p) => p.id === id) ?? { id });
}

/** `options`, plus `model` at the end when they lack it, so a select never shows a model the agent isn't on. */
export function withModel(options: readonly ModelOption[], model: string): ModelOption[] {
  return !model || options.some((m) => m.id === model) ? [...options] : [...options, { id: model }];
}

export function isPriced(m: ModelOption | undefined): m is Required<ModelOption> {
  return m?.inputCostPer1M !== undefined && m.outputCostPer1M !== undefined;
}

/** $ per 1M tokens: two decimals, or more when a price is under 10 cents ($0.075). */
export function usdPer1M(n: number): string {
  return `$${n >= 0.1 || n === 0 ? n.toFixed(2) : String(n)}`;
}

/** "grok-4.7 · $2.00 / $6.00 per 1M", or "grok-5 · price not listed". */
export function modelLabel(m: ModelOption): string {
  return isPriced(m)
    ? `${m.id} · ${usdPer1M(m.inputCostPer1M)} / ${usdPer1M(m.outputCostPer1M)} per 1M`
    : `${m.id} · price not listed`;
}

/**
 * Where to read the live model list from, or null for nowhere (the catalog
 * stands in). A key typed for `provider` wins. Without one, the edit form
 * (`agentId`) reads with the key the agent already runs on, but only for the
 * agent's own provider: a key belongs to one provider. 0G Compute needs no key.
 */
export function liveListRequest(opts: {
  provider: string;
  newKey: string;
  agentId?: string;
  agentProvider?: string;
}): { path: string; body: { provider?: string; apiKey?: string } } | null {
  const { provider, newKey, agentId, agentProvider } = opts;
  if (!isKeyed(provider)) return { path: '/api/v1/agents/provider-models', body: { provider, apiKey: '' } };
  if (newKey.length >= MIN_KEY_LENGTH) return { path: '/api/v1/agents/provider-models', body: { provider, apiKey: newKey } };
  if (agentId && provider === agentProvider && !newKey) return { path: `/api/v1/agents/${encodeURIComponent(agentId)}/provider-models`, body: {} };
  return null;
}

/** What to tell the owner when the live list can't be read. */
export function liveListError(provider: string, err: { code?: string; status?: number; message?: string }): string {
  const label = providerLabel(provider);
  return err?.code === 'PROVIDER_AUTH' ? `${label} rejected this API key`
    : err?.code === 'API_KEY_REQUIRED' ? `Enter an API key for ${label} to list its models`
    : err?.code === 'RATE_LIMIT' ? 'Too many lookups — wait a minute and try again'
    : err?.status === 401 ? 'Sign in to list the models your key can use'
    : 'Could not list models from the provider — showing our defaults';
}
