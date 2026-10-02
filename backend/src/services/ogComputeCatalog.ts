/**
 * The services registered on 0G Compute, read from the chain this backend's
 * agents use (config.ogRpcUrl / ogChainId: the InferenceServing contract the
 * SDK picks for that chain) with what 0G's status API adds about each: the
 * API formats it serves and its USD price. Read-only, keyless and cached:
 * the deploy form and deploy validation both read it.
 */
import { createRequire } from 'module';
import { config } from '../config.js';
import type { OgServiceLike } from './ogComputeModels.js';

// The SDK's ESM build doesn't load under tsx; its CommonJS build does (same
// as services/verification.ts).
const require = createRequire(import.meta.url);

/** An InferenceServing service plus 0G's status-API detail on it. */
export interface OgService extends OgServiceLike {
  url: string;
  /** API formats the provider serves ('openai', 'anthropic'). Undefined when the status API has no detail on it. */
  formats?: string[];
  /** USD per token (the status API's pricing_usd). Undefined when it has none. */
  usdIn?: number;
  usdOut?: number;
}

// InferenceServing.getAllServices refuses a page over 50 (LimitTooLarge).
const PAGE = 50;
const MAX_PAGES = 20;
const TTL_MS = 5 * 60_000;

type DetailRow = {
  provider: string; serviceType: string; url: string; model: string;
  inputPrice: bigint; outputPrice: bigint; teeSignerAcknowledged: boolean;
  modelInfo?: { supported_formats?: unknown; pricing_usd?: { prompt?: unknown; completion?: unknown } };
};

let broker: { listServiceWithDetail(offset: number, limit: number, includeUnacknowledged: boolean): Promise<DetailRow[]> } | null = null;
let cached: { at: number; services: OgService[] } | null = null;
let inFlight: Promise<OgService[]> | null = null;

function usd(v: unknown): number | undefined {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function toOgService(row: DetailRow): OgService {
  const info = row.modelInfo;
  const formats = Array.isArray(info?.supported_formats)
    ? info.supported_formats.filter((f): f is string => typeof f === 'string')
    : undefined;
  return {
    provider: row.provider,
    serviceType: row.serviceType,
    url: row.url,
    model: row.model,
    inputPrice: BigInt(row.inputPrice),
    outputPrice: BigInt(row.outputPrice),
    teeSignerAcknowledged: row.teeSignerAcknowledged,
    formats,
    usdIn: usd(info?.pricing_usd?.prompt),
    usdOut: usd(info?.pricing_usd?.completion),
  };
}

/** Every registered service, acknowledged or not; cached for five minutes. A failed read is not cached. */
export async function readOgServices(): Promise<OgService[]> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.services;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    if (!broker) {
      const sdk = require('@0gfoundation/0g-compute-ts-sdk');
      broker = await sdk.createReadOnlyInferenceBroker(config.ogRpcUrl, config.ogChainId);
    }
    const services: OgService[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await broker!.listServiceWithDetail(page * PAGE, PAGE, true);
      services.push(...rows.map(toOgService));
      if (rows.length < PAGE) break;
    }
    cached = { at: Date.now(), services };
    return services;
  })().finally(() => { inFlight = null; });
  return inFlight;
}
