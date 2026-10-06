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
 * task with no brief, which the worker hands straight back via /release) and
 * can be held open so the worker stays busy while events queue up.
 */
function fakeBackend() {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const held = new Map<string, () => void>();
  const holdAccept = new Set<string>();
  const hooks = { onRelease: (_id: string) => {} };
  const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? 'GET', path, body });
    const m = path.match(/^\/api\/v1\/a2a\/tasks\/(0x[0-9a-f]{64})\/(accept|release)$/);
    if (m?.[2] === 'accept') {
      const answer = () => json(200, { data: { chain: 'arc', gasSponsored: body?.sponsorGas === true } });
      if (!holdAccept.has(m[1])) return answer();
      return new Promise<Response>((resolve) => held.set(m[1], () => resolve(answer())));
    }
    if (m?.[2] === 'release') {
      hooks.onRelease(m[1]);
      return json(200, { data: {} });
    }
    if (path === '/api/v1/a2a/executions') return json(200, { data: { executions: [] } });
    if (path === '/api/v1/a2a/verifications') return json(200, { data: { verifications: [] } });
    if (path === '/api/v1/a2a/tasks') return json(200, { data: { tasks: [], total: 0 } });
    return json(200, { data: {} });
  });
  return {
    calls,
    fetch,
    hooks,
    holdAccept,
    finishAccept: (id: string) => held.get(id)!(),
    accepts: () => calls.filter((c) => c.path.endsWith('/accept')).map((c) => c.path.split('/')[5]),
    released: (id: string) => calls.some((c) => c.path === `/api/v1/a2a/tasks/${id}/release`),
  };
}

const event = (taskId: string, sponsored = false) => ({ taskId, meta: { chain: 'arc', ...(sponsored ? { gasSponsored: true } : {}) } });

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
