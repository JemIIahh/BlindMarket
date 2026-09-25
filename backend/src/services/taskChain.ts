/**
 * Which chain is a task's escrow on?
 *
 * Tasks are funded on Base or Arc. Each chain has its own Redis namespace
 * (`base:hash2id:` or `arc:hash2id:`), so a caller that consults only one of
 * them sees half the marketplace. Everything that needs an escrow for a
 * taskHash should go through resolveTaskByHash and use the chain it reports.
 */
import { baseEscrow } from './chain.js';
import { getBaseTaskIdByHash, forceBaseTick, seedBaseTaskIdMapping } from './baseEscrowEvents.js';
import { getArcTaskIdByHash, forceArcTick, seedArcTaskIdMapping } from './arcEscrowEvents.js';
import { getMeta } from './a2aStore.js';
import { isSettlementChainKey, postingChain, settlementChainConfig, type SettlementChainKey } from './settlementChains.js';
import { onCurrentNetwork } from './chainScope.js';

/** A settlement chain, as a task's escrow names it (services/settlementChains.ts). */
export type TaskChain = SettlementChainKey;

export type ResolvedTask = {
  taskId: string;
  chain: TaskChain;
};

/** One chain's hash<->id index. */
interface TaskIndex {
  /** Whether this backend indexes the chain at all. */
  enabled(): boolean;
  /** Cache read only. */
  cached(taskHash: string): Promise<string | null>;
  /** The slower lookup once no cache knows the hash. */
  resolve(taskHash: string): Promise<string | null>;
  seed(taskHash: string, taskId: bigint | string): Promise<void>;
}

// Each index is read through a wrapper, when called: tests replace these
// modules with mocks that define only what the test uses.
const TASK_INDEX: { readonly [K in TaskChain]: TaskIndex } = {
  base: {
    enabled: () => !!baseEscrow,
    cached: (taskHash) => getBaseTaskIdByHash(taskHash),
    resolve: async (taskHash) => {
      await forceBaseTick();
      return getBaseTaskIdByHash(taskHash);
    },
    seed: (taskHash, taskId) => seedBaseTaskIdMapping(taskHash, taskId),
  },
  arc: {
    enabled: () => settlementChainConfig('arc').escrowAddress !== null,
    cached: (taskHash) => getArcTaskIdByHash(taskHash),
    resolve: async (taskHash) => {
      await forceArcTick();
      return getArcTaskIdByHash(taskHash);
    },
    seed: (taskHash, taskId) => seedArcTaskIdMapping(taskHash, taskId),
  },
};

const SEARCH_ORDER = Object.keys(TASK_INDEX) as TaskChain[];

/** A task listed on a network its chain has since moved off (onCurrentNetwork). */
const RETIRED = 'retired' as const;

/**
 * The chain /tasks/index recorded for a task, or null for rows indexed before
 * the field existed (or when the meta can't be read, which falls back to
 * searching every chain, as before). RETIRED when the task was listed on a
 * network its chain has since moved off: that escrow is not the one this
 * backend reads, so the task resolves to nothing rather than to whatever the
 * new network's escrow holds under the same id.
 */
async function recordedChain(taskHash: string): Promise<TaskChain | null | typeof RETIRED> {
  try {
    const meta = await getMeta(taskHash);
    if (!onCurrentNetwork(meta)) return RETIRED;
    return meta?.chain ?? null;
  } catch {
    return null;
  }
}

/** Which indexes to consult for a task, given its recorded chain, in search
 *  order. Exact matches only: a chain this code doesn't know, or a retired
 *  task, searches nothing, rather than every legacy index. */
function indexesFor(chain: TaskChain | null | typeof RETIRED): TaskChain[] {
  if (chain === RETIRED) return [];
  return SEARCH_ORDER.filter((c) => (chain === null || chain === c) && TASK_INDEX[c].enabled());
}

/** The first of `chains` whose cache knows the hash. All caches are read at once. */
async function cachedLookup(taskHash: string, chains: TaskChain[]): Promise<ResolvedTask | null> {
  const ids = await Promise.all(chains.map((c) => TASK_INDEX[c].cached(taskHash)));
  const i = ids.findIndex((id) => !!id);
  return i === -1 ? null : { taskId: ids[i]!, chain: chains[i] };
}

/**
 * Resolve a taskHash to its on-chain id and the chain that holds it.
 *
 * A task stays on the chain it was indexed on: when the meta records one,
 * only that chain is searched. The poster picks the hash, so the same hash can
 * be escrowed on both chains, and searching both would settle whichever
 * answered first.
 */
export async function resolveTaskByHash(taskHash: string): Promise<ResolvedTask | null> {
  const chains = indexesFor(await recordedChain(taskHash));
  const cached = await cachedLookup(taskHash, chains);
  if (cached) return cached;

  // Nothing cached: try each chain's slower lookup, in search order.
  for (const chain of chains) {
    const taskId = await TASK_INDEX[chain].resolve(taskHash);
    if (taskId) return { taskId, chain };
  }
  return null;
}

/**
 * Seed the hash<->id mapping in the namespace of the chain that holds the task.
 */
export async function seedTaskId(chain: TaskChain, taskHash: string, taskId: bigint | string): Promise<void> {
  if (!isSettlementChainKey(chain)) throw new Error(`unknown settlement chain ${String(chain)}`);
  await TASK_INDEX[chain].seed(taskHash, taskId);
}

/**
 * Resolve which chain holds a task when all the caller has is the numeric id.
 *
 * Task ids are per-contract counters, so id 7 can exist on both chains and the
 * number alone is ambiguous. The refund routes always know who is asking and
 * only proceed for the task's own agent, so ownership is the discriminator:
 * read id 7 from each escrow and keep the one whose `agent` is the caller.
 * Reading an id that was never created returns a zero-filled struct rather than
 * reverting, so a wrong guess resolves to the zero address and is rejected.
 *
 * When the client knows the task's chain (the detail page does), it passes it
 * and only that chain is read: a poster can own id 7 on both chains, and the
 * refund must go to the task they are looking at. Without it the posting chain
 * wins a tie, since that is where new tasks live.
 */
export async function resolveTaskChainById(
  taskId: number,
  caller: string,
  chain?: TaskChain,
): Promise<TaskChain | null> {
  return (await resolvePosterTask(taskId, [caller], chain))?.chain ?? null;
}

/**
 * The chain holding task `taskId` whose poster (the escrow's `agent`) is one of
 * `callers`, and which of them it is. A user's session names one wallet, but
 * they may have posted from another linked wallet; the refund must be built
 * for, and signed by, the wallet that posted. Ownership still gates it: a
 * chain where none of the callers is the poster never matches.
 */
export async function resolvePosterTask(
  taskId: number,
  callers: readonly string[],
  chain?: TaskChain,
): Promise<{ chain: TaskChain; poster: string } | null> {
  const escrowService = await import('./escrow.js');
  const wanted = new Set(callers.map((c) => c.toLowerCase()));
  if (wanted.size === 0) return null;

  const readAgent = async (chain: TaskChain): Promise<string | null> => {
    try {
      const task = await escrowService.getTaskOn(chain, taskId);
      return task.agent.toLowerCase();
    } catch {
      return null;
    }
  };

  const posting = postingChain();
  const chains = chain !== undefined
    ? indexesFor(chain)
    : indexesFor(null).sort((a, b) => Number(b === posting) - Number(a === posting));
  const agents = await Promise.all(chains.map(readAgent));

  const i = agents.findIndex((agent) => agent !== null && wanted.has(agent));
  return i === -1 ? null : { chain: chains[i], poster: agents[i]! };
}

/**
 * Cache-only variant for callers that already poll on an interval (the expiry
 * sweep) and must not pay the slow path per unresolved hash per tick.
 */
export async function resolveCachedTaskByHash(taskHash: string): Promise<ResolvedTask | null> {
  return cachedLookup(taskHash, indexesFor(await recordedChain(taskHash)));
}

/**
 * Is escrow task `taskId` on `chain` the task its hash is indexed to? The
 * escrow does not enforce unique hashes, so anyone can fund a second task
 * under a live task's hash. Off-chain A2A state (brief meta, result) is keyed
 * by hash alone: a lookup by the duplicate's id must not serve it, or its
 * funder passes the poster check with their own on-chain task and reads the
 * original's result. The index keeps the first writer (the indexers write
 * with NX; the index route seeds only for the poster who claimed the hash).
 */
export async function isIndexedTask(chain: TaskChain, taskId: number | string, taskHash: string): Promise<boolean> {
  const resolved = await resolveCachedTaskByHash(taskHash.toLowerCase());
  return !!resolved && resolved.chain === chain && resolved.taskId === String(taskId);
}

/**
 * isIndexedTask for the settlement observers (/submissions/confirm, the
 * DisputeResolved listener), which must not drop a real credit or ruling
 * just because the index entry is missing (never written, or evicted from
 * Redis) — unlike a read, a skipped credit is lost. An entry that names
 * another task still means "a duplicate: skip". With no entry, the task is
 * taken as the listed one when its on-chain poster is the poster it was
 * listed by (`posterAddress`, A2A meta): a duplicate funded by anyone else
 * has a different agent. A task with no listing has nothing to take over.
 */
export async function isListedTask(
  chain: TaskChain,
  taskId: number | string,
  taskHash: string,
  onChainAgent: string,
  posterAddress: string | null | undefined,
): Promise<boolean> {
  const resolved = await resolveCachedTaskByHash(taskHash.toLowerCase());
  if (resolved) return resolved.chain === chain && resolved.taskId === String(taskId);
  return !posterAddress || onChainAgent.toLowerCase() === posterAddress.toLowerCase();
}
