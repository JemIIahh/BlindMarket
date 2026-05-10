import { redis } from './redis.js';
import type { A2ATaskMeta, A2ATaskState, AgentCapability } from '../types.js';

// ── Keys ─────────────────────────────────────────────────────────────────────
//
// Persistence model:
//   a2a:meta:<taskId>      — string (JSON A2ATaskMeta)
//   a2a:state:<taskId>     — string (JSON A2ATaskState)
//   a2a:open               — set of taskIds where targetExecutorType=='agent'
//                            and status=='open'. Used by browseAgentTasks for
//                            O(open) reads instead of O(all-tasks-ever).
//   a2a:executor:<addr>    — set of taskIds the address has accepted. Used by
//                            getExecutorTasks. Address is lowercased.
//
// Invariants maintained by setMeta/updateState:
//   - a2a:open contains a taskId iff (meta.targetExecutorType=='agent' AND
//     state.status=='open'). updateState removes on status transition.
//   - a2a:executor:<addr> contains a taskId iff state.executorAddress==addr.

const KEY = {
  meta: (taskId: string) => `a2a:meta:${taskId}`,
  state: (taskId: string) => `a2a:state:${taskId}`,
  open: 'a2a:open',
  executor: (addr: string) => `a2a:executor:${addr.toLowerCase()}`,
  // Tasks posted by a given address — populated when meta.posterAddress is set.
  // Used by the manual-verify inbox query.
  poster: (addr: string) => `a2a:poster:${addr.toLowerCase()}`,
};

export async function setMeta(meta: A2ATaskMeta): Promise<void> {
  const pipe = redis.pipeline();
  pipe.set(KEY.meta(meta.taskId), JSON.stringify(meta));
  // Initialize state only if not already present — preserves the original
  // in-memory semantic (`if (!taskStates.has(...))`). SETNX is atomic.
  pipe.setnx(
    KEY.state(meta.taskId),
    JSON.stringify({ taskId: meta.taskId, status: 'open' } satisfies A2ATaskState),
  );
  if (meta.targetExecutorType === 'agent') {
    pipe.sadd(KEY.open, meta.taskId);
  }
  if (meta.posterAddress) {
    pipe.sadd(KEY.poster(meta.posterAddress), meta.taskId);
  }
  await pipe.exec();
}

export async function getMeta(taskId: string): Promise<A2ATaskMeta | undefined> {
  const raw = await redis.get(KEY.meta(taskId));
  return raw ? (JSON.parse(raw) as A2ATaskMeta) : undefined;
}

export async function getState(taskId: string): Promise<A2ATaskState | undefined> {
  const raw = await redis.get(KEY.state(taskId));
  return raw ? (JSON.parse(raw) as A2ATaskState) : undefined;
}

export async function updateState(
  taskId: string,
  patch: Partial<A2ATaskState>,
): Promise<A2ATaskState> {
  const existingRaw = await redis.get(KEY.state(taskId));
  if (!existingRaw) throw new Error(`No A2A state for task ${taskId}`);
  const existing = JSON.parse(existingRaw) as A2ATaskState;
  const updated: A2ATaskState = { ...existing, ...patch, taskId };

  const pipe = redis.pipeline();
  pipe.set(KEY.state(taskId), JSON.stringify(updated));
  // Drop from open index when status leaves 'open'
  if (existing.status === 'open' && updated.status !== 'open') {
    pipe.srem(KEY.open, taskId);
  }
  // Index by executor when an executorAddress is first set
  if (!existing.executorAddress && updated.executorAddress) {
    pipe.sadd(KEY.executor(updated.executorAddress), taskId);
  }
  await pipe.exec();
  return updated;
}

/** Browse open agent-targeted tasks, optionally filtered by capabilities. */
export async function browseAgentTasks(
  capabilities?: AgentCapability[],
  // Reserved for future reputation gating; matches old signature so callers
  // (routes/a2a.ts:69) don't have to change. Currently unused — reputation
  // gating happens at /accept time, not at browse.
  _minReputation?: number,
): Promise<Array<{ meta: A2ATaskMeta; state: A2ATaskState }>> {
  const ids = await redis.smembers(KEY.open);
  if (ids.length === 0) return [];

  const pipe = redis.pipeline();
  for (const id of ids) {
    pipe.get(KEY.meta(id));
    pipe.get(KEY.state(id));
  }
  const results = await pipe.exec();
  if (!results) return [];

  const out: Array<{ meta: A2ATaskMeta; state: A2ATaskState }> = [];
  for (let i = 0; i < ids.length; i++) {
    const metaRaw = results[i * 2]?.[1] as string | null | undefined;
    const stateRaw = results[i * 2 + 1]?.[1] as string | null | undefined;
    if (!metaRaw || !stateRaw) continue;

    const meta = JSON.parse(metaRaw) as A2ATaskMeta;
    const state = JSON.parse(stateRaw) as A2ATaskState;

    // Defensive: the open index is supposed to be a strict subset, but verify
    // in case state was rewritten outside of this module.
    if (meta.targetExecutorType !== 'agent') continue;
    if (state.status !== 'open') continue;

    if (capabilities && capabilities.length > 0 && meta.requiredCapabilities.length > 0) {
      const overlap = meta.requiredCapabilities.filter((c) => capabilities.includes(c));
      if (overlap.length === 0) continue;
    }

    out.push({ meta, state });
  }
  return out;
}

/** Get all tasks accepted (currently or historically) by a specific executor. */
export async function getExecutorTasks(
  address: string,
): Promise<Array<{ meta: A2ATaskMeta; state: A2ATaskState }>> {
  return loadTasksByIndex(KEY.executor(address));
}

/** Get all tasks posted by a specific address. Drives the poster's inbox. */
export async function getPosterTasks(
  address: string,
): Promise<Array<{ meta: A2ATaskMeta; state: A2ATaskState }>> {
  return loadTasksByIndex(KEY.poster(address));
}

/** Helper used by getExecutorTasks and getPosterTasks — same shape, different
 *  index. Returns meta+state pairs for every taskId in the named set. */
async function loadTasksByIndex(
  setKey: string,
): Promise<Array<{ meta: A2ATaskMeta; state: A2ATaskState }>> {
  const ids = await redis.smembers(setKey);
  if (ids.length === 0) return [];

  const pipe = redis.pipeline();
  for (const id of ids) {
    pipe.get(KEY.meta(id));
    pipe.get(KEY.state(id));
  }
  const results = await pipe.exec();
  if (!results) return [];

  const out: Array<{ meta: A2ATaskMeta; state: A2ATaskState }> = [];
  for (let i = 0; i < ids.length; i++) {
    const metaRaw = results[i * 2]?.[1] as string | null | undefined;
    const stateRaw = results[i * 2 + 1]?.[1] as string | null | undefined;
    if (!metaRaw || !stateRaw) continue;
    out.push({
      meta: JSON.parse(metaRaw) as A2ATaskMeta,
      state: JSON.parse(stateRaw) as A2ATaskState,
    });
  }
  return out;
}
