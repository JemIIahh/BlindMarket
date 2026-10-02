/**
 * Which 0G Compute provider a 0g-compute agent pays for its model.
 *
 * A 0g-compute agent pays per call from its own 0G Compute account (the
 * LedgerManager ledger and one sub-account per provider), so it can only use
 * a model some provider registered on 0G Compute's InferenceServing contract
 * serves. The backend uses this to offer and accept models (deploy form,
 * deploy and PATCH validation); agents/worker.js uses it to pick the provider
 * it funds and calls. One rule in both places, so a model the backend accepts
 * is a model the worker can find.
 *
 * Self-contained on purpose: the backend image ships the compiled file alone
 * at the path the worker imports it from (backend/Dockerfile).
 */

/** The fields of an InferenceServing service this reads (the SDK's ServiceStructOutput). */
export interface OgServiceLike {
  provider: string;
  serviceType: string;
  model: string;
  inputPrice: bigint;
  outputPrice: bigint;
  teeSignerAcknowledged: boolean;
}

/**
 * The services an agent can chat with: chatbot services whose TEE signer 0G
 * has acknowledged. The SDK's listService() drops unacknowledged ones by
 * default for the same reason; filtering here as well lets callers page with
 * includeUnacknowledged=true, where a page's length says whether more remain.
 */
export function ogChatServices<T extends OgServiceLike>(services: readonly T[]): T[] {
  return services.filter((s) => s.serviceType === 'chatbot' && s.teeSignerAcknowledged === true);
}

/**
 * The service a 0g-compute agent on `model` uses, or null when no chat
 * service serves it. An exact model id wins; otherwise one that matches
 * ignoring case. Among several providers of the model: one the agent's
 * account already funds (`funded`, provider addresses), so a restart never
 * strands a balance on a provider it stops using; then the cheapest per token;
 * then the lowest provider address, so the choice never depends on list order.
 */
export function matchOgService<T extends OgServiceLike>(
  services: readonly T[],
  model: string,
  funded: readonly string[] = [],
): T | null {
  const chat = ogChatServices(services);
  let matches = chat.filter((s) => s.model === model);
  if (matches.length === 0) {
    const wanted = model.toLowerCase();
    matches = chat.filter((s) => s.model.toLowerCase() === wanted);
  }
  if (matches.length === 0) return null;
  const fundedSet = new Set(funded.map((a) => a.toLowerCase()));
  const price = (s: T) => BigInt(s.inputPrice) + BigInt(s.outputPrice);
  return [...matches].sort((a, b) => {
    const fa = fundedSet.has(a.provider.toLowerCase()) ? 0 : 1;
    const fb = fundedSet.has(b.provider.toLowerCase()) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const pa = price(a);
    const pb = price(b);
    if (pa !== pb) return pa < pb ? -1 : 1;
    const la = a.provider.toLowerCase();
    const lb = b.provider.toLowerCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  })[0];
}
