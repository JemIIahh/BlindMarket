/**
 * Which chain is a task's escrow on?
 *
 * Task creation moved to Base (POST /api/v1/tasks routes there whenever
 * BASE_ESCROW_ADDRESS is set), but every task funded before that switch — and
 * every task funded while Base is unconfigured — lives on the 0G escrow. The
 * two indexers write to separate Redis namespaces (`a2a:hash2id:` for 0G,
 * `base:hash2id:` for Base), so a caller that consults only one of them sees
 * half the marketplace.
 *
 * That is not hypothetical: the a2a finalize routes resolved ids through the
 * 0G index alone, so a Base-funded task returned a permanent 503 NOT_INDEXED
 * ("wait a few seconds and retry" never succeeded) and could never be settled
 * or paid out. Everything that needs an escrow for a taskHash should go
 * through resolveTaskByHash and use the chain it reports.
 */
import { baseEscrow } from './chain.js';
import { getCachedTaskIdByHash, getTaskIdByHash, seedTaskIdMapping } from './escrowEvents.js';
import { getBaseTaskIdByHash, forceBaseTick, seedBaseTaskIdMapping } from './baseEscrowEvents.js';
import { getMeta } from './a2aStore.js';
import type { SettlementChainKey } from './settlementChains.js';

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
//
// Declaration order is the search order for a task with no recorded chain.
// Base comes first, since that is where new tasks are funded.
const TASK_INDEX: { readonly [K in TaskChain]: TaskIndex } = {
  base: {
    enabled: () => !!baseEscrow,
    cached: (taskHash) => getBaseTaskIdByHash(taskHash),
    // The create tx may just not be indexed yet.
    resolve: async (taskHash) => {
      await forceBaseTick();
      return getBaseTaskIdByHash(taskHash);
    },
    seed: (taskHash, taskId) => seedBaseTaskIdMapping(taskHash, taskId),
  },
  '0g': {
    enabled: () => true,
    cached: (taskHash) => getCachedTaskIdByHash(taskHash),
    // Retries, and can trigger a backfill.
    resolve: (taskHash) => getTaskIdByHash(taskHash),
    seed: (taskHash, taskId) => seedTaskIdMapping(taskHash, taskId),
  },
};

const SEARCH_ORDER = Object.keys(TASK_INDEX) as TaskChain[];

/**
 * The chain /tasks/index recorded for a task, or null for rows indexed before
 * the field existed (or when the meta can't be read, which falls back to
 * searching every chain, as before).
 */
async function recordedChain(taskHash: string): Promise<TaskChain | null> {
  try {
    return (await getMeta(taskHash))?.chain ?? null;
  } catch {
    return null;
  }
}

/** Which indexes to consult for a task, given its recorded chain, in search
 *  order. Exact matches only: a chain this code doesn't know searches
 *  nothing, rather than every legacy index. */
function indexesFor(chain: TaskChain | null): TaskChain[] {
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
 *
 * For older tasks with no recorded chain the ordering is deliberate. Both
 * cheap cache reads happen first, because the 0G resolver's slow path costs
 * ~6s of retries and can trigger an 850k-block backfill — paying that for a
 * task that turns out to be on Base would be pure waste. Only when neither
 * index knows the hash do we escalate, and Base goes first there since that is
 * where new tasks are funded.
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
 *
 * The a2a index route used to write every task into the 0G namespace, Base
 * tasks included. resolveTaskByHash then consulted the Base namespace first
 * (it still does for tasks with no recorded chain), so a Base task was
 * resolved as 0G for the window between indexing and the next
 * Base poller tick (~5 s). An agent accepting inside that window had its
 * assignment sent to the 0G escrow with the Base task's id, which reverted
 * NotVerifier — seen live on Base Sepolia (task 3 on 0xa1F7…): accept 1 s
 * after index → 503 SETTLEMENT_FAILED; the same accept 3 min later succeeded.
 */
export async function seedTaskId(chain: TaskChain, taskHash: string, taskId: bigint | string): Promise<void> {
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
 * Returns null when neither chain has a task with that id owned by `caller` —
 * the routes turn that into the same 403 they already returned.
 */
export async function resolveTaskChainById(
  taskId: number,
  caller: string,
): Promise<TaskChain | null> {
  const escrowService = await import('./escrow.js');
  const wanted = caller.toLowerCase();

  const readAgent = async (chain: TaskChain): Promise<string | null> => {
    try {
      const task = await escrowService.getTaskOn(chain, taskId);
      return task.agent.toLowerCase();
    } catch {
      return null;
    }
  };

  const chains = indexesFor(null);
  const agents = await Promise.all(chains.map(readAgent));

  // In search order, so Base first: it is where new tasks are funded, so on
  // the vanishingly rare id collision where one address owns the same id on
  // both chains, the newer task is the one being acted on.
  const i = agents.findIndex((agent) => agent === wanted);
  return i === -1 ? null : chains[i];
}

/**
 * Cache-only variant for callers that already poll on an interval (the expiry
 * sweep) and must not pay the slow path per unresolved hash per tick.
 */
export async function resolveCachedTaskByHash(taskHash: string): Promise<ResolvedTask | null> {
  return cachedLookup(taskHash, indexesFor(await recordedChain(taskHash)));
}
