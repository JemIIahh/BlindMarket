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

export interface TaskOffer {
  address: string;
  score: number;
  expiresAt: number; // epoch ms
}

const OFFER_TTL_MS = 15_000; // exclusive offer window

const KEY = {
  meta: (taskId: string) => `a2a:meta:${taskId.toLowerCase()}`,
  state: (taskId: string) => `a2a:state:${taskId.toLowerCase()}`,
  open: 'a2a:open',
  executor: (addr: string) => `a2a:executor:${addr.toLowerCase()}`,
  poster: (addr: string) => `a2a:poster:${addr.toLowerCase()}`,
  verifier: (addr: string) => `a2a:verifier:${addr.toLowerCase()}`,
  offer: (taskId: string) => `a2a:offer:${taskId.toLowerCase()}`,
  cascade: (taskId: string) => `a2a:cascade:${taskId.toLowerCase()}`,
  deadline: (taskId: string) => `a2a:deadline:${taskId.toLowerCase()}`,
};

export async function setMeta(meta: A2ATaskMeta): Promise<void> {
  const tid = meta.taskId.toLowerCase();
  
  // Check if a legacy mixed-case state already exists to avoid shadowing it
  // with a new empty 'open' state in the lowercased key.
  let stateExists = (await redis.exists(KEY.state(tid))) === 1;
  if (!stateExists && tid !== meta.taskId) {
    stateExists = (await redis.exists(`a2a:state:${meta.taskId}`)) === 1;
  }

  const pipe = redis.pipeline();
  pipe.set(KEY.meta(tid), JSON.stringify({ ...meta, taskId: tid }));
  
  // Only initialize state if it doesn't exist in either lowercased or legacy mixed-case form
  if (!stateExists) {
    pipe.set(
      KEY.state(tid),
      JSON.stringify({ taskId: tid, status: 'open' } satisfies A2ATaskState),
    );
  }

  if (meta.targetExecutorType === 'agent') {
    pipe.sadd(KEY.open, tid);
  }
  if (meta.posterAddress) {
    pipe.sadd(KEY.poster(meta.posterAddress), tid);
  }
  if (meta.verifierAddress) {
    pipe.sadd(KEY.verifier(meta.verifierAddress), tid);
  }
  await pipe.exec();
}

export async function getMeta(taskId: string): Promise<A2ATaskMeta | undefined> {
  let raw = await redis.get(KEY.meta(taskId));
  if (!raw && taskId.toLowerCase() !== taskId) {
    // Fallback for legacy mixed-case keys
    raw = await redis.get(`a2a:meta:${taskId}`);
  }
  return raw ? (JSON.parse(raw) as A2ATaskMeta) : undefined;
}

/**
 * Merge additional ECIES-wrapped keys into the task's meta. Used by the
 * just-in-time wrap flow: poster's frontend wakes up when a new agent bids,
 * wraps the AES key to that bidder's pubkey, and POSTs the slice here.
 * Existing entries are preserved (so bidders previously wrapped to don't
 * lose their slice). Addresses are lowercased to match accept-time lookup.
 */
export async function mergeWrappedKeys(
  taskId: string,
  additions: Record<string, string>,
): Promise<A2ATaskMeta | undefined> {
  const tid = taskId.toLowerCase();
  let raw = await redis.get(KEY.meta(tid));
  let finalTid = tid;
  if (!raw && tid !== taskId) {
    // Fallback for legacy mixed-case keys
    raw = await redis.get(`a2a:meta:${taskId}`);
    if (raw) finalTid = taskId;
  }
  if (!raw) return undefined;
  const meta = JSON.parse(raw) as A2ATaskMeta;
  const merged = { ...(meta.wrappedKeys ?? {}) };
  for (const [addr, blob] of Object.entries(additions)) {
    merged[addr.toLowerCase()] = blob;
  }
  meta.wrappedKeys = merged;
  await redis.set(`a2a:meta:${finalTid}`, JSON.stringify(meta));
  return meta;
}

/**
 * Cache the on-chain deadline (epoch seconds) for a task under its OWN key —
 * deliberately NOT inside the meta blob. The meta blob is rewritten by
 * unguarded read-modify-write cycles (mergeWrappedKeys at /wrap-to and the
 * accept self-heal); a concurrent deadline write into the same JSON could
 * silently drop a just-merged wrap slice, which for the /wrap-to path is a
 * permanently lost brief key. A side key has no contention. Used by the
 * expiry sweep to backfill tasks indexed before meta.deadline existed, so the
 * chain is consulted at most once per legacy task. TTL: the key is only
 * needed until shortly after the deadline passes (the sweep then closes the
 * task), so let it expire a day later rather than leak forever.
 */
export async function cacheDeadline(taskId: string, deadline: number): Promise<void> {
  const ttlSec = Math.max(deadline - Math.floor(Date.now() / 1000), 0) + 24 * 3600;
  await redis.setex(KEY.deadline(taskId), ttlSec, String(deadline));
}

/** Read a deadline cached by the expiry sweep. Null if never cached/expired. */
export async function getCachedDeadline(taskId: string): Promise<number | null> {
  const raw = await redis.get(KEY.deadline(taskId));
  return raw ? Number(raw) : null;
}

/**
 * Batch-check which taskHashes have A2A meta entries. Returns a Set of hashes
 * (lowercased) that ARE indexed. Used by the tasks list to flag stranded tasks
 * — on-chain tasks created before the current A2A code path was wired up have
 * no meta and are therefore invisible to executor agents.
 */
export async function getIndexedHashes(taskHashes: string[]): Promise<Set<string>> {
  if (taskHashes.length === 0) return new Set();
  const pipe = redis.pipeline();
  for (const h of taskHashes) {
    pipe.exists(KEY.meta(h));
    if (h.toLowerCase() !== h) pipe.exists(`a2a:meta:${h}`);
  }
  const results = await pipe.exec();
  if (!results) return new Set();
  const indexed = new Set<string>();
  let resultIdx = 0;
  for (let i = 0; i < taskHashes.length; i++) {
    const h = taskHashes[i];
    const existsLower = results[resultIdx++]?.[1] === 1;
    let existsOriginal = false;
    if (h.toLowerCase() !== h) {
      existsOriginal = results[resultIdx++]?.[1] === 1;
    }
    if (existsLower || existsOriginal) indexed.add(h.toLowerCase());
  }
  return indexed;
}

export async function getState(taskId: string): Promise<A2ATaskState | undefined> {
  let raw = await redis.get(KEY.state(taskId));
  if (!raw && taskId.toLowerCase() !== taskId) {
    // Fallback for legacy mixed-case keys
    raw = await redis.get(`a2a:state:${taskId}`);
  }
  return raw ? (JSON.parse(raw) as A2ATaskState) : undefined;
}

export async function updateState(
  taskId: string,
  patch: Partial<A2ATaskState>,
): Promise<A2ATaskState> {
  const tid = taskId.toLowerCase();
  let existingRaw = await redis.get(KEY.state(tid));
  let finalTid = tid;
  if (!existingRaw && tid !== taskId) {
    // Fallback for legacy mixed-case keys
    existingRaw = await redis.get(`a2a:state:${taskId}`);
    if (existingRaw) finalTid = taskId;
  }
  if (!existingRaw) throw new Error(`No A2A state for task ${taskId}`);
  const existing = JSON.parse(existingRaw) as A2ATaskState;
  const updated: A2ATaskState = { ...existing, ...patch, taskId: finalTid };

  const pipe = redis.pipeline();
  pipe.set(`a2a:state:${finalTid}`, JSON.stringify(updated));
  // Drop from open index when status leaves 'open'
  if (existing.status === 'open' && updated.status !== 'open') {
    pipe.srem(KEY.open, finalTid);
  }
  // Maintain the executor index (invariant at top of file: a2a:executor:<addr>
  // holds taskId iff state.executorAddress==addr). SADD on first-set, and MOVE
  // the task between sets when executorAddress changes to a different value —
  // the workerMismatch reconcile rewrites executorAddress from the refused
  // CAS-winner to the real on-chain worker, and without the SREM the refused
  // caller stays indexed and resume-loops a task it doesn't own. A patch that
  // doesn't touch executorAddress leaves updated==existing here, so this is a
  // no-op on the common path.
  if (existing.executorAddress !== updated.executorAddress) {
    if (existing.executorAddress) pipe.srem(KEY.executor(existing.executorAddress), finalTid);
    if (updated.executorAddress) pipe.sadd(KEY.executor(updated.executorAddress), finalTid);
  }
  // Drop from the verifier index once the verdict is in, so the verifier's
  // GET /verifications queue doesn't accumulate settled tasks forever. Only
  // reads meta on the (rare) transition out of awaiting_verification.
  if (existing.status === 'awaiting_verification' && updated.status !== 'awaiting_verification') {
    const metaRaw = (await redis.get(KEY.meta(finalTid))) ?? (await redis.get(`a2a:meta:${taskId}`));
    if (metaRaw) {
      const meta = JSON.parse(metaRaw) as A2ATaskMeta;
      if (meta.verifierAddress) pipe.srem(KEY.verifier(meta.verifierAddress), finalTid);
    }
  }
  // Mirror: RE-ADD on any transition INTO awaiting_verification. setMeta only
  // SADDs at creation, so without this a failed-verification RETRY round
  // (failed → submitted → awaiting_verification) never re-enters the
  // verifier's GET /verifications queue — the verifier would never see or
  // settle round 2 and the task would wedge until claimTimeout. SADD is
  // idempotent, so the round-1 path (where setMeta already added it) is safe.
  if (existing.status !== 'awaiting_verification' && updated.status === 'awaiting_verification') {
    const metaRaw = (await redis.get(KEY.meta(finalTid))) ?? (await redis.get(`a2a:meta:${taskId}`));
    if (metaRaw) {
      const meta = JSON.parse(metaRaw) as A2ATaskMeta;
      if (meta.verifierAddress) pipe.sadd(KEY.verifier(meta.verifierAddress), finalTid);
    }
  }
  await pipe.exec();
  return updated;
}

/**
 * Atomic open→accepted transition. The plain updateState() pattern is
 * read-then-write with no atomicity, so two concurrent /accept requests can
 * both pass the route's `state.status === 'open'` check and both write
 * `accepted` with different executorAddresses — leaving Redis pointing at one
 * executor while the on-chain assignment (whichever marketplaceAssign tx
 * confirms first) points at the other. Surfaced by the multi-agent flow:
 * the loser then gets a 403 on /submit because Redis says they're not the
 * executor of record.
 *
 * Run the CAS inside a Lua script so the status check + state mutation +
 * index updates all happen atomically on the Redis server. Returns:
 *   - { ok: true,  state }  → transition succeeded, this caller is the executor
 *   - { ok: false, currentStatus } → CAS lost; another caller got there first
 */
export async function tryAccept(
  taskId: string,
  executorAddress: string,
  acceptedAt: string,
): Promise<{ ok: true; state: A2ATaskState } | { ok: false; currentStatus: string }> {
  const tid = taskId.toLowerCase();
  // Lua: read state, verify status='open', merge patch, write back, update
  // index sets. cjson is bundled with Redis 6+; if a deployment uses an older
  // build the SET fails loudly and we'll surface it at boot.
  const lua = `
    local stateKey = KEYS[1]
    local openSetKey = KEYS[2]
    local executorSetKey = KEYS[3]
    local tid = ARGV[1]
    local executorAddress = ARGV[2]
    local acceptedAt = ARGV[3]
    local originalTaskId = ARGV[4]

    local raw = redis.call('GET', stateKey)
    if not raw and originalTaskId ~= tid then
        -- Fallback for legacy mixed-case keys
        raw = redis.call('GET', 'a2a:state:' .. originalTaskId)
        if raw then stateKey = 'a2a:state:' .. originalTaskId end
    end

    if not raw then return {'missing'} end

    local s = cjson.decode(raw)
    if s.status ~= 'open' then return {'lost', s.status} end

    s.status = 'accepted'
    s.executorAddress = executorAddress
    s.acceptedAt = acceptedAt
    redis.call('SET', stateKey, cjson.encode(s))
    redis.call('SREM', openSetKey, tid)
    if tid ~= originalTaskId then
        redis.call('SREM', openSetKey, originalTaskId)
    end
    redis.call('SADD', executorSetKey, tid)
    return {'ok', cjson.encode(s)}
  `;

  const result = (await redis.eval(
    lua,
    3,
    KEY.state(tid),
    KEY.open,
    KEY.executor(executorAddress),
    tid,
    executorAddress,
    acceptedAt,
    taskId, // original taskId for fallback
  )) as [string, string?];

  if (result[0] === 'ok') {
    return { ok: true, state: JSON.parse(result[1]!) as A2ATaskState };
  }
  if (result[0] === 'missing') {
    throw new Error(`No A2A state for task ${taskId}`);
  }
  return { ok: false, currentStatus: result[1] ?? 'unknown' };
}

/**
 * Atomic open→failed transition for a task that can never be assigned again
 * (reason 'expired': on-chain deadline passed; reason 'unindexed': no
 * TaskCreated event exists for the hash in the chain's entire history, i.e. a
 * phantom meta from a reverted createTask). Same Lua-CAS rationale as
 * tryAccept: the expiry sweep's read of 'open' can race a concurrent /accept,
 * and a blind updateState would clobber the CAS winner's 'accepted' state —
 * so expiry must lose that race gracefully. failedReason distinguishes these
 * closes from verification failures. Returns ok:false (never throws) on
 * missing state so the sweep can skip stale index entries without crashing
 * the tick.
 */
export async function tryExpire(
  taskId: string,
  reason: 'expired' | 'unindexed' = 'expired',
): Promise<{ ok: true } | { ok: false; currentStatus: string }> {
  const tid = taskId.toLowerCase();
  const lua = `
    local stateKey = KEYS[1]
    local openSetKey = KEYS[2]
    local tid = ARGV[1]
    local originalTaskId = ARGV[2]
    local reason = ARGV[3]

    local raw = redis.call('GET', stateKey)
    if not raw and originalTaskId ~= tid then
        -- Fallback for legacy mixed-case keys
        raw = redis.call('GET', 'a2a:state:' .. originalTaskId)
        if raw then stateKey = 'a2a:state:' .. originalTaskId end
    end

    if not raw then return {'missing'} end

    local s = cjson.decode(raw)
    if s.status ~= 'open' then return {'lost', s.status} end

    s.status = 'failed'
    s.failedReason = reason
    redis.call('SET', stateKey, cjson.encode(s))
    redis.call('SREM', openSetKey, tid)
    if tid ~= originalTaskId then
        redis.call('SREM', openSetKey, originalTaskId)
    end
    return {'ok'}
  `;

  const result = (await redis.eval(
    lua,
    2,
    KEY.state(tid),
    KEY.open,
    tid,
    taskId, // original taskId for fallback
    reason,
  )) as [string, string?];

  if (result[0] === 'ok') return { ok: true };
  if (result[0] === 'missing') return { ok: false, currentStatus: 'missing' };
  return { ok: false, currentStatus: result[1] ?? 'unknown' };
}

/**
 * Load every task in the open index with its meta+state, unfiltered beyond the
 * defensive invariant checks. Agent-facing callers should use browseAgentTasks
 * (which additionally hides expired tasks); the expiry sweep uses this
 * directly BECAUSE it needs to see the expired ones to close them.
 */
export async function listOpenTasks(): Promise<Array<{ meta: A2ATaskMeta; state: A2ATaskState }>> {
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

    out.push({ meta, state });
  }
  return out;
}

/**
 * Scan all a2a:state:* keys and repair the a2a:open set so it's consistent
 * with actual task state. Tasks with state.status === 'open' and
 * meta.targetExecutorType === 'agent' that are missing from a2a:open get added.
 * Tasks in a2a:open whose state isn't 'open' (or meta isn't 'agent') get removed.
 * Returns counts of repairs made. Intended for periodic maintenance (expiry
 * sweep) or manual trigger when tasks appear stranded.
 */
export async function resyncOpenIndex(): Promise<{ added: number; removed: number }> {
  let added = 0;
  let removed = 0;
  let cursor = '0';

  const stateKeys: string[] = [];
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'a2a:state:*', 'COUNT', 200);
    cursor = nextCursor;
    stateKeys.push(...keys);
  } while (cursor !== '0');

  if (stateKeys.length === 0) return { added, removed };

  const pipe = redis.pipeline();
  const taskIds: string[] = [];
  for (const key of stateKeys) {
    const tid = key.replace('a2a:state:', '');
    taskIds.push(tid);
    pipe.get(key);
    pipe.get(`a2a:meta:${tid}`);
  }
  const results = await pipe.exec();
  if (!results) return { added, removed };

  const shouldBeOpen = new Set<string>();
  for (let i = 0; i < taskIds.length; i++) {
    const stateRaw = results[i * 2]?.[1] as string | null;
    const metaRaw = results[i * 2 + 1]?.[1] as string | null;
    if (!stateRaw || !metaRaw) continue;
    try {
      const state = JSON.parse(stateRaw) as A2ATaskState;
      const meta = JSON.parse(metaRaw) as A2ATaskMeta;
      if (state.status === 'open' && meta.targetExecutorType === 'agent') {
        shouldBeOpen.add(taskIds[i].toLowerCase());
      }
    } catch {
      // malformed JSON — skip
    }
  }

  const currentOpen = new Set(await redis.smembers(KEY.open));
  const toAdd = [...shouldBeOpen].filter((id) => !currentOpen.has(id));
  const toRemove = [...currentOpen].filter((id) => !shouldBeOpen.has(id));

  if (toAdd.length > 0) {
    added = toAdd.length;
    await redis.sadd(KEY.open, ...toAdd);
    console.log(`[a2aStore] resync: added ${added} open tasks to a2a:open`);
  }
  if (toRemove.length > 0) {
    removed = toRemove.length;
    await redis.srem(KEY.open, ...toRemove);
    console.log(`[a2aStore] resync: removed ${removed} stale tasks from a2a:open`);
  }

  return { added, removed };
}

/** Browse open agent-targeted tasks, optionally filtered by capabilities. */
export async function browseAgentTasks(
  capabilities?: AgentCapability[],
  // Reserved for future reputation gating; matches old signature so callers
  // (routes/a2a.ts:69) don't have to change. Currently unused — reputation
  // gating happens at /accept time, not at browse.
  _minReputation?: number,
): Promise<Array<{ meta: A2ATaskMeta; state: A2ATaskState }>> {
  const open = await listOpenTasks();
  const nowSec = Math.floor(Date.now() / 1000);

  return open.filter(({ meta }) => {
    // Hide tasks past their on-chain deadline: assignment would revert
    // DeadlineReached anyway, so listing them only costs some agent a wasted
    // /accept. Tasks indexed before meta.deadline existed stay listed until
    // the expiry sweep backfills the field from chain.
    if (meta.deadline && nowSec >= meta.deadline) return false;

    if (capabilities && capabilities.length > 0 && meta.requiredCapabilities.length > 0) {
      // Superset match against /accept: the browsing agent's caps must include
      // ALL of the task's required caps, so browse only lists tasks the agent
      // could actually accept (no partial-overlap teasers it would be 403'd on).
      const hasAll = meta.requiredCapabilities.every((c) => capabilities.includes(c));
      if (!hasAll) return false;
    }

    return true;
  });
}

// ── Public projection ───────────────────────────────────────────────────────

/** Task meta as exposed on UNAUTHENTICATED discovery surfaces (REST browse,
 *  JSON-RPC tasks/list & tasks/get, H2A task detail). Strips key material:
 *  wrappedKeys (per-executor ECIES slices), keyCustodyBlob (the custody-sealed
 *  AES key) and rootHash (storage pointer to the encrypted brief). The winning
 *  /accept response is where an executor gets its slice + rootHash; nothing
 *  before that point needs them, and returning them publicly hands the whole
 *  key-wrap graph to any unauthenticated GET. hasEncryptedBrief preserves the
 *  one signal discovery actually used (does this task carry a brief at all). */
export type PublicTaskMeta = Omit<A2ATaskMeta, 'wrappedKeys' | 'keyCustodyBlob' | 'rootHash'> & {
  hasEncryptedBrief: boolean;
  rootHash?: string;
};

export function projectPublicMeta(meta: A2ATaskMeta): PublicTaskMeta {
  const { wrappedKeys: _wrappedKeys, keyCustodyBlob: _keyCustodyBlob, rootHash, ...pub } = meta;
  // A PUBLIC task's brief is meant to be read: keep the storage pointer (the
  // blob is plaintext by definition — key material can't exist on these
  // rows, enforced at /tasks/index). Private tasks keep rootHash stripped:
  // it's the ciphertext pointer and a correlation surface. publicBrief rides
  // along in ...pub — it only ever exists on public tasks.
  if (meta.privacy === 'public') {
    return { ...pub, hasEncryptedBrief: false, rootHash };
  }
  return { ...pub, hasEncryptedBrief: !!rootHash };
}

/** Task state minus operator-internal diagnostics and the deliverable.
 *  assignError/verifyError embed on-chain revert reasons and RPC fragments;
 *  resultData is the executor's plaintext deliverable — both are for
 *  authenticated viewers only. Poster/worker surfaces serve raw state
 *  (/a2a/tasks/posted, self /executions), and REST GET /tasks/:id
 *  re-attaches resultData after its optionalAuth poster/worker check. */
export type PublicTaskState = Omit<A2ATaskState, 'assignError' | 'verifyError' | 'resultData'>;

export function projectPublicState(state: A2ATaskState): PublicTaskState {
  const { assignError: _assignError, verifyError: _verifyError, resultData: _resultData, ...pub } = state;
  return pub;
}

export function projectPublicEntry(
  entry: { meta: A2ATaskMeta; state: A2ATaskState },
): { meta: PublicTaskMeta; state: PublicTaskState } {
  return { meta: projectPublicMeta(entry.meta), state: projectPublicState(entry.state) };
}

/** Get all tasks accepted (currently or historically) by a specific executor. */
export async function getExecutorTasks(
  address: string,
): Promise<Array<{ meta: A2ATaskMeta; state: A2ATaskState }>> {
  return loadTasksByIndex(KEY.executor(address));
}

/** Get all tasks a specific address is the designated verifier for. Drives the
 *  verifier agent's queue (verificationMode='agent'). */
export async function getVerifierTasks(
  address: string,
): Promise<Array<{ meta: A2ATaskMeta; state: A2ATaskState }>> {
  return loadTasksByIndex(KEY.verifier(address));
}

/** Get all tasks posted by a specific address. Drives the poster's inbox. */
export async function getPosterTasks(
  address: string,
): Promise<Array<{ meta: A2ATaskMeta; state: A2ATaskState }>> {
  return loadTasksByIndex(KEY.poster(address));
}

/**
 * Revert a task from accepted/in_progress/submitted back to 'open' so another
 * executor (or the same one on next poll) can pick it up. Used when the
 * accepted executor fails terminally to broadcast submitEvidence — without
 * this the task would stay stranded in Redis (not in a2a:open set, so
 * invisible to agent_board) while on-chain it's still Funded with no worker.
 *
 * Caller is responsible for the precondition check that this is safe — i.e.
 * the on-chain task hasn't progressed past Funded. This function just rewrites
 * the A2A state machine.
 */
export async function releaseToOpen(taskId: string): Promise<void> {
  const tid = taskId.toLowerCase();
  let existingRaw = await redis.get(KEY.state(tid));
  let finalTid = tid;
  if (!existingRaw && tid !== taskId) {
    existingRaw = await redis.get(`a2a:state:${taskId}`);
    if (existingRaw) finalTid = taskId;
  }
  if (!existingRaw) throw new Error(`No A2A state for task ${taskId}`);
  const existing = JSON.parse(existingRaw) as A2ATaskState;
  if (existing.status === 'open') return;

  const metaRaw = (await redis.get(KEY.meta(finalTid))) ?? (await redis.get(`a2a:meta:${taskId}`));
  if (!metaRaw) throw new Error(`No A2A meta for task ${taskId}`);
  const meta = JSON.parse(metaRaw) as A2ATaskMeta;

  const released: A2ATaskState = { taskId: finalTid, status: 'open' };

  const pipe = redis.pipeline();
  pipe.set(`a2a:state:${finalTid}`, JSON.stringify(released));
  if (meta.targetExecutorType === 'agent') {
    pipe.sadd(KEY.open, finalTid);
  }
  if (existing.executorAddress) {
    pipe.srem(KEY.executor(existing.executorAddress), finalTid);
  }
  await pipe.exec();
}

/**
 * Create an exclusive offer for the best-scoring agent.
 * Expires after OFFER_TTL_MS. Only one offer exists per task.
 */
export async function setOffer(taskId: string, offer: TaskOffer): Promise<void> {
  const tid = taskId.toLowerCase();
  const ttl = Math.max(OFFER_TTL_MS, 5_000);
  await redis.setex(KEY.offer(tid), Math.ceil(ttl / 1000), JSON.stringify(offer));
}

/**
 * Read the current offer for a task. Returns undefined if no offer or expired.
 */
export async function getOffer(taskId: string): Promise<TaskOffer | undefined> {
  const raw = await redis.get(KEY.offer(taskId));
  if (!raw) return undefined;
  const offer = JSON.parse(raw) as TaskOffer;
  if (Date.now() > offer.expiresAt) {
    await redis.del(KEY.offer(taskId));
    return undefined;
  }
  return offer;
}

/**
 * Check whether `callerAddress` is the offered agent and the offer is still
 * valid. Returns true if the caller should be allowed to accept; false
 * means the offer expired or belongs to someone else.
 */
export async function checkOffer(taskId: string, callerAddress: string): Promise<boolean> {
  const offer = await getOffer(taskId);
  if (!offer) return false;
  return offer.address.toLowerCase() === callerAddress.toLowerCase();
}

/** Remove the offer for a task (used after accept, release, or expiry). */
export async function clearOffer(taskId: string): Promise<void> {
  await redis.del(KEY.offer(taskId));
}

// ── Cascade: scored offer queue ───────────────────────────────────────────────

export interface CascadeEntry {
  address: string;
  score: number;
  displayName: string;
}

export interface TaskCascade {
  ranked: CascadeEntry[];
  position: number;     // index into ranked[] that is currently being offered
  startedAt: number;    // epoch ms
}

/** How long the cascade stays alive before falling back to CAS race. */
const CASCADE_TTL_MS = 120_000;

/** Per-position offer window inside a cascade. */
const CASCADE_OFFER_MS = 12_000;

/**
 * Store the full ranked agent list for a task and start the cascade.
 * The caller should then offer to position 0 and schedule advancement.
 */
export async function setCascade(taskId: string, ranked: CascadeEntry[]): Promise<void> {
  const tid = taskId.toLowerCase();
  const cascade: TaskCascade = {
    ranked,
    position: 0,
    startedAt: Date.now(),
  };
  await redis.setex(KEY.cascade(tid), Math.ceil(CASCADE_TTL_MS / 1000), JSON.stringify(cascade));
}

/**
 * Read the current cascade for a task. Returns undefined if none or expired.
 */
export async function getCascade(taskId: string): Promise<TaskCascade | undefined> {
  const raw = await redis.get(KEY.cascade(taskId));
  if (!raw) return undefined;
  return JSON.parse(raw) as TaskCascade;
}

/**
 * Advance the cascade to the next position. Reads the current cascade,
 * increments the position, and writes back. Returns the next agent entry
 * or null if the cascade is exhausted / gone.
 */
export async function advanceCascade(taskId: string): Promise<CascadeEntry | null> {
  const tid = taskId.toLowerCase();
  const raw = await redis.get(KEY.cascade(tid));
  if (!raw) return null;

  const cascade = JSON.parse(raw) as TaskCascade;
  const nextPos = cascade.position + 1;
  if (nextPos >= cascade.ranked.length) {
    await redis.del(KEY.cascade(tid));
    return null;
  }

  cascade.position = nextPos;
  await redis.setex(KEY.cascade(tid), Math.ceil(CASCADE_TTL_MS / 1000), JSON.stringify(cascade));
  return cascade.ranked[nextPos];
}

/** Remove the cascade for a task (used on accept, release, or full exhaustion). */
export async function clearCascade(taskId: string): Promise<void> {
  await redis.del(KEY.cascade(taskId));
}

/** Per-position offer window (exported for use by a2a.ts cascade timer). */
export { CASCADE_OFFER_MS };

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
