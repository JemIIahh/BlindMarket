import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';

/**
 * Task events that reach a busy worker are queued (createDeferredAccepts) and
 * accepted once it frees up. Accepting assigns the task on-chain, after which
 * the backend refuses /release, so a task accepted by a wallet that can't pay
 * for its submit stays stuck until its deadline. The gas gate ran when each
 * event arrived, but the task that kept the worker busy spends gas of its own,
 * so by the time the queue drains that answer is stale: every queued task used
 * to be assigned to a wallet that could no longer submit.
 *
 * Draining also left no gap between tasks, so the poll loop (resume, verifier
 * duty, unjudged payouts) never ran while the queue had entries.
 */

const sock = vi.hoisted(() => ({ handlers: {} as Record<string, (data: unknown) => Promise<void>> }));

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({
  io: () => ({ on: (event: string, fn: (data: unknown) => Promise<void>) => { sock.handlers[event] = fn; }, emit: vi.fn() }),
}));

const ARC = {
  key: 'arc', chainId: 5042002, rpcUrl: 'https://arc.example/rpc', escrow: '0xaBf70843E0380F1e749d2b85C30dD6820Ff5C731',
  token: { address: '0x3600000000000000000000000000000000000000', kind: 'erc20', symbol: 'USDC', decimals: 6 },
  gasSymbol: 'USDC', nativeIsSettlementToken: true, aa: false, posting: true,
};
const BACKEND = 'http://backend.test';
const FUNDED = 10n ** 18n;
// Below one 300k-gas tx at the 1 gwei the fee stub reports.
const DUST = 10n ** 12n;

const task = (c: string) => '0x' + c.repeat(64);
const T0 = task('a');
const A = task('b');
const B = task('c');
const C = task('d');
const S = task('e');
const short = (id: string) => id.slice(0, 10);

const ORIGINAL = { ...process.env };

/** Import a fresh worker on Arc, talking to the fake backend. */
async function loadWorker(env: Record<string, string> = {}) {
  vi.resetModules();
  process.env = {
    ...ORIGINAL,
    SETTLEMENT_CHAINS_JSON: JSON.stringify([ARC]), OG_RPC_URL: '', BASE_RPC_URL: '',
    AGENT_PRIVATE_KEY: '0x' + '11'.repeat(32), AGENT_WALLET: '', AGENT_ID: 'test-agent',
    AGENT_PROVIDER: 'openai', AGENT_API_KEY: 'sk-test', AGENT_PLATFORM_TOKEN: 'token', BACKEND_URL: BACKEND,
    ...env,
  };
  // @ts-expect-error — plain-JS worker, no d.ts
  const w = await import('./worker.js');
  w.connectWebSocket();
  return w;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * The backend the worker talks to. Records every call; /accept succeeds (a
 * task with no brief, which the worker hands straight back via /release),
 * can be held open so the worker stays busy while events queue up, or can
 * first answer OFFER_HELD. The feed lists `feed`; an accepted task leaves it.
 */
function fakeBackend() {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const held = new Map<string, () => void>();
  const holdAccept = new Set<string>();
  const offerHeldOnce = new Set<string>();
  const feed: Array<{ meta: { taskId: string; chain: string; gasSponsored?: boolean } }> = [];
  const hooks = { onRelease: (_id: string) => {} };
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? 'GET', path, body });
    const m = path.match(/^\/api\/v1\/a2a\/tasks\/(0x[0-9a-f]{64})\/(accept|release)$/);
    if (m?.[2] === 'accept') {
      if (offerHeldOnce.delete(m[1])) return json(409, { error: { code: 'OFFER_HELD', message: 'offered to another agent' } });
      const answer = () => {
        const i = feed.findIndex((e) => e.meta.taskId === m[1]);
        if (i >= 0) feed.splice(i, 1);
        return json(200, { data: { chain: 'arc', gasSponsored: body?.sponsorGas === true } });
      };
      if (!holdAccept.has(m[1])) return answer();
      return new Promise<Response>((resolve) => held.set(m[1], () => resolve(answer())));
    }
    if (m?.[2] === 'release') {
      hooks.onRelease(m[1]);
      return json(200, { data: {} });
    }
    if (path === '/api/v1/a2a/executions') return json(200, { data: { executions: [] } });
    if (path === '/api/v1/a2a/verifications') return json(200, { data: { verifications: [] } });
    if (path === '/api/v1/a2a/tasks') return json(200, { data: { tasks: feed, total: feed.length } });
    return json(200, { data: {} });
  });
  return {
    calls,
    fetch,
    hooks,
    holdAccept,
    offerHeldOnce,
    feed,
    finishAccept: (id: string) => held.get(id)!(),
    accepts: () => calls.filter((c) => c.path.endsWith('/accept')).map((c) => c.path.split('/')[5]),
    released: (id: string) => calls.some((c) => c.path === `/api/v1/a2a/tasks/${id}/release`),
    scans: () => calls.filter((c) => c.path === '/api/v1/a2a/tasks').length,
  };
}

const event = (taskId: string, sponsored = false) => ({ taskId, meta: { chain: 'arc', ...(sponsored ? { gasSponsored: true } : {}) } });
const feedEntry = (taskId: string, sponsored = false) => ({ meta: { taskId, chain: 'arc', ...(sponsored ? { gasSponsored: true } : {}) } });

let be: ReturnType<typeof fakeBackend>;
let logs: string[];
// Wallet balance on Arc, read in order; the last entry repeats. An Error is an RPC failure.
let balances: Array<bigint | Error>;

beforeEach(() => {
  be = fakeBackend();
  vi.stubGlobal('fetch', be.fetch);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
  balances = [FUNDED];
  vi.spyOn(ethers.JsonRpcProvider.prototype, 'getBalance').mockImplementation(async () => {
    const next = balances.length > 1 ? balances.shift()! : balances[0];
    if (next instanceof Error) throw next;
    return next;
  });
  vi.spyOn(ethers.JsonRpcProvider.prototype, 'getFeeData').mockImplementation(async () => ({ maxFeePerGas: 10n ** 9n }) as ethers.FeeData);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL };
});

const logged = (re: RegExp) => logs.some((l) => re.test(l));
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 3_000, interval: 5 });

/** Make the worker busy on T0 (its /accept held open), then queue `queued`. */
async function busyWith(queued: Array<[string, boolean?]>) {
  be.holdAccept.add(T0);
  void sock.handlers['task:available'](event(T0));
  await waitFor(() => expect(be.accepts()).toEqual([T0]));
  for (const [id, sponsored] of queued) await sock.handlers['task:available'](event(id, sponsored));
  for (const [id] of queued) expect(logged(new RegExp(`WS accept deferred for ${short(id)}`))).toBe(true);
}

describe('a task event deferred while busy is gas-checked again before accept', () => {
  it('accepts only the queued tasks the wallet can still pay for, and keeps the rest acceptable', async () => {
    await loadWorker();
    await busyWith([[A], [B], [C]]);
    // A's run spends the wallet below one tx's worth.
    be.hooks.onRelease = (id) => { if (id === A) balances = [DUST]; };
    be.finishAccept(T0);
    await waitFor(() => expect(logged(new RegExp(`${short(C)}….*below the`))).toBe(true));
    expect(be.accepts()).toEqual([T0, A]);
    expect(logged(new RegExp(`skipping task ${short(B)}… on arc: wallet .* below the`))).toBe(true);

    // Skipped, not marked applied: once the wallet is funded, B is taken.
    balances = [FUNDED];
    await sock.handlers['task:available'](event(B));
    await waitFor(() => expect(be.released(B)).toBe(true));
    expect(be.accepts()).toEqual([T0, A, B]);
  });

  it('still takes a sponsor-hinted queued task when the wallet is low', async () => {
    await loadWorker();
    await busyWith([[A], [S, true]]);
    be.hooks.onRelease = (id) => { if (id === T0) balances = [DUST]; };
    be.finishAccept(T0);
    await waitFor(() => expect(be.released(S)).toBe(true));
    expect(be.accepts()).toEqual([T0, S]);
    expect(be.calls.find((c) => c.path.endsWith(`${S}/accept`))?.body).toEqual({ sponsorGas: true });
  });

  it('stops draining while a task it holds waits for gas, and resumes once that clears', async () => {
    const w = await loadWorker();
    await busyWith([[A]]);
    // T0 itself can't be paid for (held for gas after accept); the next read
    // fails, which the gas check lets through.
    balances = [DUST, new Error('rpc timeout')];
    be.finishAccept(T0);
    await waitFor(() => expect(logged(new RegExp(`not working on ${short(T0)}… yet`))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(be.accepts()).toEqual([T0]);

    // T0 is no longer owed (the poll's /executions omits it) and the wallet is
    // funded: the next poll lifts the hold and the queue drains.
    balances = [FUNDED];
    await w.pollAndWork();
    await waitFor(() => expect(be.released(A)).toBe(true));
    expect(be.accepts()).toEqual([T0, A]);
  });
});

describe('a poll that comes due while busy runs before the next queued task', () => {
  it('fetches verifications between deferred tasks', async () => {
    const w = await loadWorker({ AGENT_VERIFIER_ENABLED: 'true' });
    be.holdAccept.add(A);
    be.holdAccept.add(B);
    await busyWith([[A], [B]]);
    // Each task outlasts the poll interval: a tick lands while it runs.
    for (const [current, next] of [[T0, A], [A, B], [B, null]] as Array<[string, string | null]>) {
      await w.pollAndWork();
      be.finishAccept(current);
      if (next) await waitFor(() => expect(be.accepts().at(-1)).toBe(next));
      else await waitFor(() => expect(be.calls.filter((c) => c.path === '/api/v1/a2a/verifications')).toHaveLength(3));
    }
    const order = be.calls
      .filter((c) => c.path.endsWith('/accept') || c.path === '/api/v1/a2a/verifications')
      .map((c) => (c.path.endsWith('/accept') ? `accept ${short(c.path.split('/')[5])}` : 'verifications'));
    expect(order).toEqual([
      `accept ${short(T0)}`, 'verifications',
      `accept ${short(A)}`, 'verifications',
      `accept ${short(B)}`, 'verifications',
    ]);
  });
});

describe("an accept retried after another agent's offer window", () => {
  it('asks again for the sponsored submit the task was hinted for', async () => {
    const w = await loadWorker();
    // The wallet can't pay its own gas; the task's submit is sponsored.
    balances = [DUST];
    be.feed.push({ meta: { taskId: S, chain: 'arc', gasSponsored: true }, state: { status: 'open' } });
    be.offerHeldOnce.add(S);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const poll = w.pollAndWork();
      await vi.waitFor(() => expect(be.accepts()).toEqual([S]));
      await vi.advanceTimersByTimeAsync(15_000);
      await poll;
    } finally {
      vi.useRealTimers();
    }
    expect(be.calls.filter((c) => c.path.endsWith(`${S}/accept`)).map((c) => c.body)).toEqual([{ sponsorGas: true }, { sponsorGas: true }]);
    expect(logged(new RegExp(`not working on ${short(S)}… yet`))).toBe(false);
    expect(be.released(S)).toBe(true);
  });
});

describe('tasks skipped for gas, once the wallet is funded', () => {
  // The feed scan runs on the WS reconcile floor (5 min) while the socket is
  // up, and on the gas re-check cadence (GAS_RECHECK_MS, 60 s) while tasks
  // wait for gas. The clock is fixed so each poll below is one re-check tick.
  const T = Date.UTC(2026, 9, 6, 12);
  const at = (seconds: number) => vi.setSystemTime(T + seconds * 1000);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('are all taken on the gas cadence, one per scan, and then the cadence relaxes', async () => {
    const w = await loadWorker();
    sock.handlers.connect(undefined);
    balances = [DUST];
    be.feed.push(feedEntry(A), feedEntry(B), feedEntry(C));
    await w.pollAndWork();
    expect(be.accepts()).toEqual([]);

    balances = [FUNDED];
    for (const [seconds, taken] of [[60, [A]], [120, [A, B]], [180, [A, B, C]]] as Array<[number, string[]]>) {
      at(seconds);
      await w.pollAndWork();
      expect(be.accepts()).toEqual(taken);
    }
    // Nothing waits for gas any more: the next tick does not scan.
    const scans = be.scans();
    at(240);
    await w.pollAndWork();
    expect(be.scans()).toBe(scans);
  });
});
