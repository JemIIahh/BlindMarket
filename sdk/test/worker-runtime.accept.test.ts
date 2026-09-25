import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { WorkerRuntime, type TaskExecutionInfo, type WorkerRuntimeEvent } from '../src/executor/index.js';
import { AgentCap } from '../src/types.js';

/**
 * The /accept failure paths of WorkerRuntime, against a stubbed fetch. The
 * status codes, error codes and messages are the ones
 * backend/src/routes/a2a.ts sends from POST /tasks/:id/accept.
 */

const TASK_ID = `0x${'ab'.repeat(32)}`;
const ROOT_HASH = `0x${'cd'.repeat(32)}`;
const PRIVATE_KEY = `0x${'1'.repeat(64)}`;
const OWNER = new ethers.Wallet(PRIVATE_KEY).address;

const ROTATED_MESSAGE =
  'Task brief is sealed to a rotated custody key — the platform cannot re-wrap it. POST /a2a/tasks/:id/bid to register intent; only the poster can wrap a slice to your pubkey (or cancel and repost).';
const NOT_WRAPPED_MESSAGE =
  'Task brief is not yet wrapped to your pubkey — POST /a2a/tasks/:id/bid to register intent; the poster will wrap on their next polling cycle.';

function ok(data: unknown): Response {
  return { status: 200, json: async () => ({ success: true, data }) } as unknown as Response;
}
function fail(status: number, code: string, message = code): Response {
  return { status, json: async () => ({ success: false, error: { code, message } }) } as unknown as Response;
}

const ACCEPTED = { taskId: TASK_ID, status: 'accepted', rootHash: ROOT_HASH, privacy: 'public' };

interface Counters { accepts: Record<string, number>; bids: Record<string, number>; browses: number }

/** `accept(taskId, n)` answers the n-th /accept for that task; everything after accept succeeds. */
function stubBackend(accept: (taskId: string, n: number) => Response, listing: () => unknown[] = () => []): Counters {
  const c: Counters = { accepts: {}, bids: {}, browses: 0 };
  const idOf = (u: string) => /\/a2a\/tasks\/([^/]+)\//.exec(u)?.[1] ?? '';
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/bid')) { c.bids[idOf(u)] = (c.bids[idOf(u)] ?? 0) + 1; return ok({}); }
    if (u.includes('/accept')) {
      const id = idOf(u);
      c.accepts[id] = (c.accepts[id] ?? 0) + 1;
      return accept(id, c.accepts[id]);
    }
    if (u.includes('/health/settlement')) return ok({ postingChain: 'arc', chains: [] });
    if (u.includes('/storage/')) return ok({ rootHash: ROOT_HASH, blob: Buffer.from('brief').toString('base64') });
    if (u.includes('/submit')) return ok({ taskId: idOf(u), status: 'submitted', unsignedSubmitEvidence: null });
    if (u.includes('/finalize')) return ok({ taskId: idOf(u), status: 'awaiting_verification' });
    if (u.includes('/a2a/tasks')) { c.browses++; return ok({ tasks: listing() }); }
    throw new Error(`unhandled fetch ${u}`);
  }));
  return c;
}

// biome-ignore lint/suspicious/noExplicitAny: private fields/methods are the only offline seam into this class
type Internals = any;

let live: WorkerRuntime | undefined;

function mkRuntime(config: Record<string, unknown> = {}): { runtime: WorkerRuntime; r: Internals; events: WorkerRuntimeEvent[] } {
  const runtime = new WorkerRuntime({
    apiKey: 'test-key',
    displayName: 'test-agent',
    capabilities: [AgentCap.DATA_PROCESSING],
    executeTask: async () => ({ done: true }),
    privateKey: PRIVATE_KEY,
    rpcUrl: 'http://og.invalid',
    watchIntervalMs: 1,
    ...config,
  });
  const r = runtime as Internals;
  r.wallet = { address: OWNER, privateKey: PRIVATE_KEY, publicKey: `04${'1'.repeat(128)}` };
  r.running = true; // as after start(), without its registration + browse timer
  const events: WorkerRuntimeEvent[] = [];
  runtime.on((e) => events.push(e));
  live = runtime;
  return { runtime, r, events };
}

/** What browse() does for one listed task, awaited. */
async function run(r: Internals, taskId = TASK_ID): Promise<void> {
  r.executions.set(taskId, { taskId, status: 'bidding', startedAt: Date.now() } satisfies TaskExecutionInfo);
  await r.executeTask(taskId, { taskId, status: 'open' });
}

const open = (taskId: string) => ({ meta: { taskId, chain: '0g' }, state: { taskId, status: 'open' } });
const failures = (events: WorkerRuntimeEvent[]) =>
  events.filter((e): e is Extract<WorkerRuntimeEvent, { type: 'task_failed' }> => e.type === 'task_failed');

afterEach(() => {
  live?.stop(); // clears retry timers
  live = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('WorkerRuntime /accept — 503 ASSIGNMENT_PENDING', () => {
  it('re-tries /accept while the assignment is confirming, then executes the task', async () => {
    const c = stubBackend((_id, n) => (n < 3 ? fail(503, 'ASSIGNMENT_PENDING') : ok(ACCEPTED)));
    const { r } = mkRuntime();
    await run(r);
    expect(c.accepts[TASK_ID]).toBe(3);
    expect(r.executions.get(TASK_ID).status).toBe('completed');
    expect(r.retries.has(TASK_ID)).toBe(false);
  });

  it('keeps re-trying through a SETTLEMENT_FAILED re-check once the task is known to be held', async () => {
    const c = stubBackend((_id, n) => (n === 1 ? fail(503, 'ASSIGNMENT_PENDING') : n === 2 ? fail(503, 'SETTLEMENT_FAILED', 'On-chain assignment re-check failed: boom.') : ok(ACCEPTED)));
    const { r } = mkRuntime();
    await run(r);
    expect(c.accepts[TASK_ID]).toBe(3);
    expect(r.executions.get(TASK_ID).status).toBe('completed');
  });

  it('gives up after assignmentPendingTimeoutMs without leaving the task in executions, then re-accepts it from browse although it is not listed', async () => {
    let confirm = false;
    const c = stubBackend(() => (confirm ? ok(ACCEPTED) : fail(503, 'ASSIGNMENT_PENDING')));
    const { r, events } = mkRuntime({ assignmentPendingTimeoutMs: 30 });
    await run(r);

    expect(c.accepts[TASK_ID]).toBeGreaterThan(1);
    expect(r.executions.has(TASK_ID)).toBe(false); // the slot is free again
    expect(failures(events)).toHaveLength(1);
    expect(failures(events)[0].error).toMatch(/may still be held/);
    const retry = r.retries.get(TASK_ID);
    expect(retry.reaccept.rounds).toBe(1);
    expect(retry.notBefore).toBeGreaterThan(Date.now() + 20_000); // 30 s back-off

    // Backing off: a browse leaves it alone.
    const before = c.accepts[TASK_ID];
    await r.browse();
    expect(c.accepts[TASK_ID]).toBe(before);

    // Back-off over: the task is `accepted` for us, so it is NOT in the open
    // listing — browse re-accepts it anyway.
    retry.notBefore = 0;
    confirm = true;
    await r.browse();
    await vi.waitFor(() => expect(r.executions.get(TASK_ID)?.status).toBe('completed'));
    expect(r.retries.has(TASK_ID)).toBe(false);
  });

  it('drops a task whose accept never confirms after a bounded number of rounds', async () => {
    stubBackend(() => fail(503, 'ASSIGNMENT_PENDING'));
    const { r, events } = mkRuntime({ assignmentPendingTimeoutMs: 0 });
    for (let i = 0; i < 7; i++) {
      await run(r);
      if (r.retries.has(TASK_ID)) r.retries.get(TASK_ID).notBefore = 0;
    }
    expect(r.retries.has(TASK_ID)).toBe(false);
    expect(r.executions.has(TASK_ID)).toBe(false);
    expect(failures(events).at(-1)?.error).toMatch(/never confirmed after 6 rounds/);
  });
});

describe('WorkerRuntime /accept — the backend released the task', () => {
  it.each([
    ['REWRAP_FAILED', 'Key-custody re-wrap failed; task released — retry shortly.'],
    ['SETTLEMENT_FAILED', 'On-chain assignment failed: boom. Task released — another agent may retry.'],
  ])('503 %s: forgets the execution and backs the task off exponentially instead of hot-looping', async (code, message) => {
    const c = stubBackend(() => fail(503, code, message), () => [open(TASK_ID)]);
    const { r } = mkRuntime();
    await run(r);

    expect(c.accepts[TASK_ID]).toBe(1); // a released task is not re-tried in place
    expect(r.executions.has(TASK_ID)).toBe(false);
    const retry = r.retries.get(TASK_ID);
    expect(retry.reaccept).toBeUndefined();
    const first = retry.notBefore - Date.now();
    expect(first).toBeGreaterThan(25_000);
    expect(first).toBeLessThanOrEqual(30_000);

    // Listed as open again, but still backing off.
    await r.browse();
    expect(c.accepts[TASK_ID]).toBe(1);

    // Back-off over: a later browse picks it up again; a second failure doubles the wait.
    retry.notBefore = 0;
    await r.browse();
    await vi.waitFor(() => expect(c.accepts[TASK_ID]).toBe(2));
    await vi.waitFor(() => expect(r.executions.has(TASK_ID)).toBe(false));
    expect(r.retries.get(TASK_ID).notBefore - Date.now()).toBeGreaterThan(55_000);
  });

  it('503 SETTLEMENT_FAILED that does NOT say the task was released (the idempotent re-check) is treated as still held: re-accepted from browse', async () => {
    const c = stubBackend((_id, n) => (n === 1 ? fail(503, 'SETTLEMENT_FAILED', 'On-chain assignment re-check failed: boom.') : ok(ACCEPTED)));
    const { r } = mkRuntime();
    await run(r);
    expect(r.executions.has(TASK_ID)).toBe(false);
    expect(r.retries.get(TASK_ID).reaccept.rounds).toBe(1);
    r.retries.get(TASK_ID).notBefore = 0;
    await r.browse(); // not listed
    await vi.waitFor(() => expect(r.executions.get(TASK_ID)?.status).toBe('completed'));
    expect(c.accepts[TASK_ID]).toBe(2);
  });

  it('409 (lost the race): forgets the task with no back-off', async () => {
    stubBackend(() => fail(409, 'NOT_OPEN'));
    const { r } = mkRuntime();
    await run(r);
    expect(r.executions.has(TASK_ID)).toBe(false);
    expect(r.retries.has(TASK_ID)).toBe(false);
  });

  it('a refusal a retry cannot change (403 SELF_ACCEPT) holds no slot and is not re-tried while listed', async () => {
    const c = stubBackend(() => fail(403, 'SELF_ACCEPT'), () => [open(TASK_ID)]);
    const { r } = mkRuntime();
    await run(r);
    await r.browse();
    expect(c.accepts[TASK_ID]).toBe(1);
    expect(r.executions.has(TASK_ID)).toBe(false);
  });
});

describe('WorkerRuntime /accept — 403 NEEDS_WRAP', () => {
  it('bids once, waits WITHOUT a concurrency slot, and re-tries until the wrapped key lands', async () => {
    const c = stubBackend((_id, n) => (n < 3 ? fail(403, 'NEEDS_WRAP', NOT_WRAPPED_MESSAGE) : ok(ACCEPTED)));
    const { r, events } = mkRuntime();
    await run(r);

    // After the first NEEDS_WRAP the task holds nothing.
    expect(r.executions.has(TASK_ID)).toBe(false);
    expect(r.inFlight()).toBe(0);

    await vi.waitFor(() => expect(r.executions.get(TASK_ID)?.status).toBe('completed'));
    expect(c.bids[TASK_ID]).toBe(1);
    expect(c.accepts[TASK_ID]).toBe(3);
    expect(events.filter((e) => e.type === 'task_bidded')).toHaveLength(1);
  });

  it('the scheduled re-try runs even when its timer fires before Date.now() reaches the back-off', async () => {
    // Timers fire by the monotonic clock; Date.now() can read behind it (CI
    // saw the re-try refused by its own back-off, and the task never re-tried).
    const c = stubBackend((_id, n) => (n < 2 ? fail(403, 'NEEDS_WRAP', NOT_WRAPPED_MESSAGE) : ok(ACCEPTED)));
    const { r } = mkRuntime({ watchIntervalMs: 20 });
    await run(r);
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 1_000);
    await vi.waitFor(() => expect(r.executions.get(TASK_ID)?.status).toBe('completed'));
    expect(c.accepts[TASK_ID]).toBe(2);
  });

  it('a back-off set after the re-try was scheduled still holds', async () => {
    const c = stubBackend(() => fail(403, 'NEEDS_WRAP', NOT_WRAPPED_MESSAGE));
    const { r } = mkRuntime({ watchIntervalMs: 20 });
    await run(r);
    r.retries.get(TASK_ID).notBefore = Date.now() + 60_000; // e.g. a failure elsewhere backed it off
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(c.accepts[TASK_ID]).toBe(1);
  });

  it('tasks waiting for a wrap do not starve a runnable task (maxConcurrentTasks = 3)', async () => {
    const stuck = [1, 2, 3].map((n) => `0x${String(n).repeat(64)}`);
    const READY = `0x${'9'.repeat(64)}`;
    const c = stubBackend(
      (id) => (id === READY ? ok({ ...ACCEPTED, taskId: READY }) : fail(403, 'NEEDS_WRAP', NOT_WRAPPED_MESSAGE)),
      () => [...stuck.map(open), open(READY)],
    );
    // A long watch interval: the waiting tasks are not re-tried during the test.
    const { r } = mkRuntime({ watchIntervalMs: 60_000, maxConcurrentTasks: 3 });

    await r.browse(); // the three stuck tasks take every slot for one /accept each
    await vi.waitFor(() => expect(r.inFlight()).toBe(0));
    expect(c.accepts[READY]).toBeUndefined();

    await r.browse(); // they are waiting slot-free, so the fourth task runs
    await vi.waitFor(() => expect(r.executions.get(READY)?.status).toBe('completed'));
    for (const id of stuck) expect(c.accepts[id]).toBe(1);
  });

  it('backs a task off exponentially once wrapTimeoutMs has passed, and bids again afterwards', async () => {
    const c = stubBackend(() => fail(403, 'NEEDS_WRAP', NOT_WRAPPED_MESSAGE), () => [open(TASK_ID)]);
    const { r, events } = mkRuntime({ watchIntervalMs: 60_000, wrapTimeoutMs: 600_000 });
    await run(r);
    const retry = r.retries.get(TASK_ID);
    expect(retry.notBefore - Date.now()).toBeLessThanOrEqual(60_000); // still waiting

    retry.wrapSince = Date.now() - 600_001; // the wait has run out
    await run(r);
    expect(r.executions.has(TASK_ID)).toBe(false);
    expect(retry.wrapTimeouts).toBe(1);
    expect(retry.notBefore - Date.now()).toBeGreaterThan(590_000); // 10 min
    expect(failures(events).at(-1)?.error).toMatch(/no wrapped key after 600s; skipping for 10 min/);

    // Listed as open the whole time — browse must not pick it up again.
    await r.browse();
    expect(c.accepts[TASK_ID]).toBe(2);

    // Next round: bids again, and the second timeout doubles the back-off.
    await run(r);
    expect(c.bids[TASK_ID]).toBe(2);
    retry.wrapSince = Date.now() - 600_001;
    await run(r);
    expect(retry.wrapTimeouts).toBe(2);
    expect(retry.notBefore - Date.now()).toBeGreaterThan(1_190_000); // 20 min
  });

  it('skips at once when the backend says the platform can never wrap it (custody key rotated)', async () => {
    const c = stubBackend(() => fail(403, 'NEEDS_WRAP', ROTATED_MESSAGE), () => [open(TASK_ID)]);
    const { r, events } = mkRuntime({ wrapTimeoutMs: 600_000 });
    await run(r);

    expect(c.bids[TASK_ID]).toBe(1); // only the poster can still wrap, and it wraps to bidders
    expect(c.accepts[TASK_ID]).toBe(1);
    expect(r.executions.has(TASK_ID)).toBe(false);
    expect(r.retryTimers.size).toBe(0); // no wait loop at all
    expect(r.retries.get(TASK_ID).notBefore - Date.now()).toBeGreaterThan(590_000);
    expect(failures(events)[0].error).toMatch(/rotated custody key/);

    await r.browse();
    expect(c.accepts[TASK_ID]).toBe(1);
  });

  it('forgets back-off state for a task that left the open listing', async () => {
    stubBackend(() => fail(403, 'NEEDS_WRAP', ROTATED_MESSAGE), () => []);
    const { r } = mkRuntime();
    await run(r);
    expect(r.retries.has(TASK_ID)).toBe(true);
    await r.browse();
    expect(r.retries.has(TASK_ID)).toBe(false);
  });
});

describe('WorkerRuntime.start — refuses a configuration that can only strand tasks', () => {
  const base = {
    apiKey: 'test-key',
    displayName: 'a',
    capabilities: [AgentCap.DATA_PROCESSING],
    executeTask: async () => ({}),
  };

  it('throws without a key, before any request: nothing is registered and nothing is browsed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new WorkerRuntime({ ...base, rpcUrl: 'http://og.invalid' });
    await expect(runtime.start()).rejects.toThrow(/no executor key\. Pass `privateKey`/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runtime.isRunning).toBe(false);
  });

  it('throws without any RPC — there is no default network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new WorkerRuntime({ ...base, privateKey: PRIVATE_KEY });
    await expect(runtime.start()).rejects.toThrow(/no RPC configured\. Set `rpcUrls\.arc`/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws, without registering, when privateKey is not the API key's owner", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/api-keys/whoami')) return ok({ address: '0x00000000000000000000000000000000000000e1' });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new WorkerRuntime({ ...base, privateKey: PRIVATE_KEY, rpcUrl: 'http://og.invalid' });
    await expect(runtime.start()).rejects.toMatchObject({ code: 'OWNER_MISMATCH' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runtime.isRunning).toBe(false);
  });

  it('restore mode: throws, without registering, when existingPrivateKey is not the executor the API key resolves to', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/a2a/profile')) {
        return ok({ agent: { address: '0x00000000000000000000000000000000000000e1', displayName: 's', capabilities: [], supportedChains: null } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const runtime = new WorkerRuntime({ ...base, existingPrivateKey: PRIVATE_KEY, rpcUrl: 'http://og.invalid' });
    await expect(runtime.start()).rejects.toThrow(/could accept tasks but never sign submitEvidence/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('restore mode: rejects an existingAddress that is not the key’s address', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const runtime = new WorkerRuntime({
      ...base, existingPrivateKey: PRIVATE_KEY, existingAddress: '0x00000000000000000000000000000000000000e1', rpcUrl: 'http://og.invalid',
    });
    await expect(runtime.start()).rejects.toThrow(/is not existingPrivateKey's address/);
  });
});
