/**
 * Whether a settlement chain's escrow has createTasks (docs/BULK-POSTING.md),
 * and whether it has createTaskOpen (docs/OPEN-SUBMISSION-TASKS.md).
 *
 * Detected by calling the escrow's MAX_BATCH() (and getOpenTask(0)): an
 * escrow from before the upgrade has no such function, so the call reverts. A revert, an RPC error
 * or a slow RPC all read as unsupported, and clients post one task per
 * transaction. The answer is cached per chain and escrow address: a
 * supported one for 10 minutes, an unsupported one for 1 minute, so an escrow
 * upgrade is noticed within a minute. A request never waits more than 2 s
 * for a probe; one still running when that wait ends fills the cache for the
 * next request. Nothing here throws.
 */
import { chainRuntime } from './chainRuntime.js';
import { MAX_BATCH_REQUEST } from '../constants.js';
import { settlementChainConfig, type SettlementChainKey } from './settlementChains.js';

export interface BatchCreateSupport {
  supported: boolean;
  /** Tasks per createTasks: the escrow's MAX_BATCH, at most MAX_BATCH_REQUEST. 0 when unsupported. */
  maxBatch: number;
}

export const BATCH_UNSUPPORTED: Readonly<BatchCreateSupport> = Object.freeze({ supported: false, maxBatch: 0 });

const SUPPORTED_TTL_MS = 10 * 60_000;
const UNSUPPORTED_TTL_MS = 60_000;
/** How long a request waits for a probe that has not answered yet. */
const REQUEST_WAIT_MS = 2_000;
/** How long a probe may run; the providers' own timeout is two minutes. */
const PROBE_TIMEOUT_MS = 10_000;

type Support = { supported: boolean };

const OPEN_UNSUPPORTED: Readonly<Support> = Object.freeze({ supported: false });

const cache = new Map<string, { value: Support; expiresAt: number }>();
const inflight = new Map<string, Promise<Support>>();

function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms).unref());
}

/** createTaskOpen's escrow has getOpenTask, which answers for any id (zeros for none). */
async function probeOpen(chain: SettlementChainKey): Promise<Support> {
  try {
    const escrow = chainRuntime(chain).escrow;
    if (!escrow) return OPEN_UNSUPPORTED;
    const answer = await Promise.race([
      (escrow.getOpenTask(0) as Promise<unknown>).then(() => true),
      after(PROBE_TIMEOUT_MS, null),
    ]);
    return answer === true ? { supported: true } : OPEN_UNSUPPORTED;
  } catch {
    return OPEN_UNSUPPORTED;
  }
}

async function probe(chain: SettlementChainKey): Promise<BatchCreateSupport> {
  try {
    const escrow = chainRuntime(chain).escrow;
    if (!escrow) return BATCH_UNSUPPORTED;
    const raw = await Promise.race([
      escrow.MAX_BATCH() as Promise<bigint>,
      after(PROBE_TIMEOUT_MS, null),
    ]);
    if (raw === null) return BATCH_UNSUPPORTED;
    const max = Number(raw);
    if (!Number.isSafeInteger(max) || max < 1) return BATCH_UNSUPPORTED;
    return { supported: true, maxBatch: Math.min(max, MAX_BATCH_REQUEST) };
  } catch {
    return BATCH_UNSUPPORTED;
  }
}

function store(key: string, value: Support): void {
  cache.set(key, { value, expiresAt: Date.now() + (value.supported ? SUPPORTED_TTL_MS : UNSUPPORTED_TTL_MS) });
}

/** One probe per chain and escrow at a time; its answer is cached when it lands. */
function refresh<T extends Support>(key: string, run: () => Promise<T>): Promise<T> {
  let pending = inflight.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = run().then((value) => {
      store(key, value);
      return value;
    });
    const settled = pending.finally(() => inflight.delete(key));
    settled.catch(() => {});
    inflight.set(key, pending);
  }
  return pending;
}

/**
 * A cached support answer for `chain`'s escrow. A chain with no escrow is
 * unsupported without a read. An expired answer is served while a new probe
 * runs, so only the first request after boot (or after an escrow change)
 * waits on the RPC.
 */
async function cachedSupport<T extends Support>(chain: SettlementChainKey, kind: string, run: () => Promise<T>, unsupported: T): Promise<T> {
  try {
    const { escrowAddress } = settlementChainConfig(chain);
    if (!escrowAddress) return unsupported;
    const key = `${kind}:${chain}:${escrowAddress.toLowerCase()}`;
    const hit = cache.get(key) as { value: T; expiresAt: number } | undefined;
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const pending = refresh(key, run);
    if (hit) return hit.value;
    const answer = await Promise.race([pending, after(REQUEST_WAIT_MS, null)]);
    if (answer) return answer;
    // Still probing: answer "no" for now, and keep saying so without waiting
    // until the probe lands (it overwrites this) or a minute passes.
    if (!cache.has(key)) store(key, unsupported);
    return unsupported;
  } catch {
    return unsupported;
  }
}

/** The createTasks support of `chain`'s escrow. */
export function batchCreateSupport(chain: SettlementChainKey): Promise<BatchCreateSupport> {
  return cachedSupport(chain, 'batch', () => probe(chain), BATCH_UNSUPPORTED);
}

/** Whether `chain`'s escrow has createTaskOpen (open submission). */
export async function openCreateSupport(chain: SettlementChainKey): Promise<boolean> {
  return (await cachedSupport(chain, 'open', () => probeOpen(chain), OPEN_UNSUPPORTED)).supported;
}

/** Tests only: forget every cached answer. */
export function _resetBatchCreateSupportCache(): void {
  cache.clear();
  inflight.clear();
}
