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
import { getCachedTaskIdByHash, getTaskIdByHash } from './escrowEvents.js';
import { getBaseTaskIdByHash, forceBaseTick } from './baseEscrowEvents.js';

export type TaskChain = 'base' | '0g';

export type ResolvedTask = {
  taskId: string;
  chain: TaskChain;
};

/**
 * Resolve a taskHash to its on-chain id and the chain that holds it.
 *
 * Ordering is deliberate. Both cheap cache reads happen first, because the
 * 0G resolver's slow path costs ~6s of retries and can trigger an 850k-block
 * backfill — paying that for a task that turns out to be on Base would be
 * pure waste. Only when neither index knows the hash do we escalate, and Base
 * goes first there since that is where new tasks are funded.
 */
export async function resolveTaskByHash(taskHash: string): Promise<ResolvedTask | null> {
  const [baseId, ogId] = await Promise.all([
    baseEscrow ? getBaseTaskIdByHash(taskHash) : Promise.resolve(null),
    getCachedTaskIdByHash(taskHash),
  ]);

  if (baseId) return { taskId: baseId, chain: 'base' };
  if (ogId) return { taskId: ogId, chain: '0g' };

  // Nothing cached — the create tx may just not be indexed yet.
  if (baseEscrow) {
    await forceBaseTick();
    const retried = await getBaseTaskIdByHash(taskHash);
    if (retried) return { taskId: retried, chain: 'base' };
  }

  // Falls through to the 0G resolver, which retries and can backfill.
  const resolved = await getTaskIdByHash(taskHash);
  return resolved ? { taskId: resolved, chain: '0g' } : null;
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

  const [baseAgent, ogAgent] = await Promise.all([
    baseEscrow ? readAgent('base') : Promise.resolve(null),
    readAgent('0g'),
  ]);

  // Base first: it is where new tasks are funded, so on the vanishingly rare
  // id collision where one address owns the same id on both chains, the newer
  // task is the one being acted on.
  if (baseAgent === wanted) return 'base';
  if (ogAgent === wanted) return '0g';
  return null;
}

/**
 * Cache-only variant for callers that already poll on an interval (the expiry
 * sweep) and must not pay the slow path per unresolved hash per tick.
 */
export async function resolveCachedTaskByHash(taskHash: string): Promise<ResolvedTask | null> {
  const [baseId, ogId] = await Promise.all([
    baseEscrow ? getBaseTaskIdByHash(taskHash) : Promise.resolve(null),
    getCachedTaskIdByHash(taskHash),
  ]);

  if (baseId) return { taskId: baseId, chain: 'base' };
  if (ogId) return { taskId: ogId, chain: '0g' };
  return null;
}
