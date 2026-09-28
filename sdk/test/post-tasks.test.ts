import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { BlindMarket, ApiError } from '../src/index.js';
import type { PostTaskParams, PostTasksOptions } from '../src/index.js';

/**
 * postTasks(): many posts from the API key owner's wallet. Every row is
 * checked and sealed before anything is sent; the escrow is approved once for
 * the total; an escrow with createTasks takes several rows per transaction
 * (docs/BULK-POSTING.md), one without it takes one each. A funding
 * transaction is never sent twice, and a problem after funding stops the run.
 */

const SETTLEMENT = JSON.parse(readFileSync(new URL('../../fixtures/prod/health-settlement.json', import.meta.url), 'utf-8')).data;
const ARC = SETTLEMENT.chains.find((c: { chain: string }) => c.chain === 'arc');
const ESCROW = ARC.escrowAddress as string;
const USDC = ARC.token.address as string;
const CHAIN_ID = ARC.chainId as number;
/** The same backend once its escrow has createTasks. */
const withBatch = (maxBatch = 50) => ({
  ...SETTLEMENT,
  chains: SETTLEMENT.chains.map((c: { chain: string }) => (c.chain === 'arc' ? { ...c, batchCreate: { supported: true, maxBatch } } : c)),
});

const OWNER = '0x00000000000000000000000000000000000000a1';
const APPROVED = '0x' + 'a9'.repeat(32);

const executorA = ethers.Wallet.createRandom();
const EXECUTORS = [{ address: executorA.address, publicKey: executorA.signingKey.publicKey }];

const ESCROW_ABI = new ethers.Interface([
  'function createTask(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration)',
  'function createTasks(address token, tuple(bytes32 taskHash, uint256 amount, string category, string locationZone, uint256 duration, address verifierAgent)[] tasks)',
]);
type TaskBody = { taskHash: string; amount: string; locationZone: string; duration: string; verificationMode?: string; verifierAddress?: string };
let category = 'general';
const createTaskData = (b: TaskBody & { token: string }) =>
  ESCROW_ABI.encodeFunctionData('createTask', [b.taskHash, b.token, b.amount, category, b.locationZone, b.duration]);
const createTasksData = (token: string, tasks: TaskBody[]) =>
  ESCROW_ABI.encodeFunctionData('createTasks', [token, tasks.map((t) => [
    t.taskHash, t.amount, category, t.locationZone, t.duration,
    t.verificationMode === 'agent' && t.verifierAddress ? t.verifierAddress : ethers.ZeroAddress,
  ])]);

const ok = (data: unknown) => ({ status: 200, json: async () => ({ success: true, data }) }) as unknown as Response;
const fail = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  ({ status, json: async () => ({ success: false, error: { code, message: code, ...extra } }) }) as unknown as Response;

interface Backend {
  settlement?: unknown;
  executors?: unknown[];
  /** Answers queued per path, one per call, before the default; null takes the default for that call. */
  queued?: Record<string, (Response | null)[]>;
  /** Rewrites a /tasks/batch build before it is encoded (a misbehaving backend). */
  tamperBatch?: (tasks: TaskBody[]) => TaskBody[];
  /** Every call and send, in order, shared with wallet({ events }). */
  events?: string[];
}

function stub(b: Backend = {}) {
  const calls: { path: string; body?: any }[] = [];
  let root = 0;
  let taskId = 100;
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    b.events?.push(`fetch ${path}`);
    const key = path.split('?')[0];
    const queued = b.queued?.[key]?.shift();
    if (queued) return queued;
    if (key === '/health/settlement') return ok(b.settlement ?? SETTLEMENT);
    if (key === '/api/v1/api-keys/whoami') return ok({ address: OWNER, addresses: [OWNER] });
    if (key === '/api/v1/a2a/executors') return ok({ executors: b.executors ?? EXECUTORS });
    if (key === '/api/v1/storage/upload') return ok({ rootHash: `0x${(++root).toString(16).padStart(64, '0')}` });
    if (key === '/api/v1/storage/upload-batch') {
      return ok({ results: body.items.map(() => ({ rootHash: `0x${(++root).toString(16).padStart(64, '0')}` })) });
    }
    const arcEntry = ((b.settlement ?? SETTLEMENT) as { chains: Array<{ chain: string; escrowAddress: string; chainId: number }> }).chains.find((c) => c.chain === 'arc')!;
    if (key === '/api/v1/tasks') return ok({ unsignedTx: { to: arcEntry.escrowAddress, data: createTaskData(body) }, chain: 'arc', chainId: arcEntry.chainId });
    if (key === '/api/v1/tasks/batch') {
      const tasks = (b.tamperBatch ?? ((t) => t))(body.tasks);
      return ok({ unsignedTx: { to: ESCROW, data: createTasksData(body.token, tasks) }, chain: 'arc', chainId: CHAIN_ID, taskHashes: tasks.map((t) => t.taskHash) });
    }
    if (key === '/api/v1/a2a/tasks/index') return ok({ taskHash: body.taskHash, onChainTaskId: String(taskId++), indexed: true });
    if (key === '/api/v1/a2a/tasks/index-batch') {
      return ok({ results: body.tasks.map((t: { taskHash: string }) => ({ taskHash: t.taskHash, onChainTaskId: String(taskId++), indexed: true })) });
    }
    throw new Error(`unhandled fetch ${path}`);
  });
  vi.stubGlobal('fetch', fn);
  const to = (path: string) => calls.filter((c) => c.path.split('?')[0] === path);
  return { fn, calls, to };
}

const erc20 = new ethers.Interface([
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256)',
]);
const word = (v: bigint) => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [v]);

/** A wallet whose sends each get their own hash; `wait` can fail a chosen send. */
function wallet(o: { balance?: bigint; allowance?: bigint; waitFor?: (n: number) => Promise<unknown>; estimate?: () => Promise<bigint>; events?: string[] } = {}) {
  const sent: { to: string; data: string; nonce?: number; value?: bigint; gasLimit?: bigint; hash: string }[] = [];
  let nextNonce = 7;
  const signer = {
    getAddress: async () => OWNER,
    estimateGas: vi.fn(o.estimate ?? (async () => 4_100_000n)),
    sendTransaction: vi.fn(async (tx: { to: string; data: string; nonce?: number; value?: bigint; gasLimit?: bigint }) => {
      const nonce = tx.nonce ?? nextNonce;
      nextNonce = nonce + 1;
      const hash = tx.to === USDC ? APPROVED : `0x${'f'.repeat(56)}${nonce.toString(16).padStart(8, '0')}`;
      o.events?.push(`send ${tx.to === USDC ? 'approve' : 'escrow'}`);
      const n = sent.push({ ...tx, hash });
      return { hash, nonce, wait: o.waitFor ? () => o.waitFor!(n) : async () => ({ status: 1 }) };
    }),
    provider: {
      call: vi.fn(async (tx: { data: string }) => {
        const sel = tx.data.slice(0, 10);
        if (sel === erc20.getFunction('balanceOf')!.selector) return word(o.balance ?? 1_000_000_000n);
        if (sel === erc20.getFunction('allowance')!.selector) return word(o.allowance ?? 0n);
        throw new Error(`unexpected read ${sel}`);
      }),
      getNetwork: async () => ({ chainId: BigInt(CHAIN_ID) }),
    },
  };
  return { signer: signer as unknown as ethers.Signer, sent };
}

const bb = () => new BlindMarket({ apiKey: 'k' });
const row = (n: number, extra: Partial<PostTaskParams> = {}): PostTaskParams => ({
  instructions: `Task ${n}: summarise the attached paper in five bullets.`,
  amountRaw: String(1_000_000 * (n + 1)),
  privacy: 'public',
  ...extra,
});
const rows = (count: number, extra: Partial<PostTaskParams> = {}) => Array.from({ length: count }, (_, n) => row(n, extra));
const fast: PostTasksOptions['retry'] = { baseDelayMs: 1 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  category = 'general';
});

describe('postTasks — every row is checked before anything is sent', () => {
  it('refuses the whole list, naming every bad row, without asking the backend anything', async () => {
    const s = stub();
    const w = wallet();
    const err = await bb().postTasks([
      row(0),
      row(1, { amountRaw: '1.5' }),
      row(2, { durationSeconds: 60 }),
      row(3, { instructions: '   ' }),
      row(4, { privacy: 'secret' as never }),
      row(5, { targetExecutor: 'bob' as never }),
    ], { signer: w.signer }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'INVALID_ROWS' });
    expect(err.body.errors.map((e: { index: number; code: string }) => [e.index, e.code])).toEqual([
      [1, 'INVALID_AMOUNT'], [2, 'INVALID_DURATION'], [3, 'INVALID_ROW'], [4, 'INVALID_ROW'], [5, 'INVALID_ROW'],
    ]);
    expect(err.message).toMatch(/5 of 6 rows/);
    expect(s.calls).toHaveLength(0);
    expect(w.sent).toHaveLength(0);
  });

  it('refuses briefs no executor could open, and the same public brief twice, before uploading anything', async () => {
    const s = stub();
    const w = wallet();
    const err = await bb().postTasks([
      row(0),
      row(1, { privacy: 'private', targetExecutor: '0x00000000000000000000000000000000000000ee' }),
      row(0), // the same public brief as rows[0]: the same task hash
    ], { signer: w.signer }).catch((e) => e);
    expect(err).toMatchObject({ code: 'INVALID_ROWS' });
    expect(err.body.errors.map((e: { index: number; code: string }) => [e.index, e.code])).toEqual([[1, 'EXECUTOR_NOT_FOUND'], [2, 'DUPLICATE_BRIEF']]);
    expect(s.to('/api/v1/storage/upload')).toHaveLength(0);
    expect(w.sent).toHaveLength(0);
  });

  it('needs the wallet to hold the total, and keeps under maxTotalRaw', async () => {
    const s = stub();
    const w = wallet({ balance: 5_999_999n });
    // 1 + 2 + 3 USDC
    const short = await bb().postTasks(rows(3), { signer: w.signer }).catch((e) => e);
    expect(short).toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(short.message).toContain('holds 5.999999 USDC');
    expect(short.message).toContain('the escrow needs 6.0.'); // postTask()'s wording
    await expect(bb().postTasks(rows(3), { signer: wallet().signer, maxTotalRaw: 5_000_000n })).rejects.toMatchObject({ code: 'AMOUNT_ABOVE_MAX' });
    expect(s.to('/api/v1/storage/upload')).toHaveLength(0);
    expect(w.sent).toHaveLength(0);
  });

  it('refuses an empty list, a bad chunk size, and more rows than one call takes', async () => {
    stub();
    await expect(bb().postTasks([], { signer: wallet().signer })).rejects.toMatchObject({ code: 'NO_ROWS' });
    await expect(bb().postTasks(rows(2), { signer: wallet().signer, chunkSize: 0 })).rejects.toMatchObject({ code: 'INVALID_CHUNK_SIZE' });
    await expect(bb().postTasks(Array.from({ length: 1001 }, () => row(0)), { signer: wallet().signer })).rejects.toMatchObject({ code: 'TOO_MANY_ROWS' });
  });

  it('lists each row with its routing summary, and refuses one too long for the board before sending anything', async () => {
    const s = stub();
    const res = await bb().postTasks([row(0, { routingSummary: '  Five-bullet paper summary  ' }), row(1)], { signer: wallet().signer });
    expect(res.posted).toBe(2);
    expect(s.to('/api/v1/a2a/tasks/index')[0].body.routingSummary).toBe('Five-bullet paper summary');
    expect(s.to('/api/v1/a2a/tasks/index')[1].body).not.toHaveProperty('routingSummary');

    const t = stub();
    const w = wallet();
    const err = await bb().postTasks([row(0, { routingSummary: 'x'.repeat(501) })], { signer: w.signer }).catch((e) => e);
    expect(err.body.errors).toEqual([expect.objectContaining({ index: 0, code: 'INVALID_ROUTING_SUMMARY' })]);
    expect(t.calls).toHaveLength(0);
    expect(w.sent).toHaveLength(0);
  });

  it("keeps postTask()'s wallet checks: the API key's own wallet, on the posting chain", async () => {
    stub();
    const other = { ...wallet().signer, getAddress: async () => '0x00000000000000000000000000000000000000b2' } as unknown as ethers.Signer;
    await expect(bb().postTasks(rows(2), { signer: other })).rejects.toMatchObject({ code: 'OWNER_MISMATCH' });
  });
});

describe('postTasks — on an escrow without createTasks, one transaction per row', () => {
  it('approves the total once, then funds and lists each row with the next nonce', async () => {
    const s = stub();
    const w = wallet();
    const funded: { index: number; batch: boolean }[] = [];
    const progress: number[] = [];
    const res = await bb().postTasks(rows(3, { privacy: 'private' }), {
      signer: w.signer,
      onFunded: ({ index, batch, indexParams, txHash }) => { funded.push({ index, batch }); expect(indexParams.txHash).toBe(txHash); },
      onProgress: ({ done }) => { progress.push(done); },
    });

    expect(res).toMatchObject({ mode: 'single', chain: 'arc', chainId: CHAIN_ID, posted: 3, unlisted: 0, failed: 0, skipped: 0 });
    expect(res.stopped).toBeUndefined();
    // One approve for 1 + 2 + 3 USDC, then three createTask calls, nonces in a row.
    expect(w.sent.map((t) => t.to)).toEqual([USDC, ESCROW, ESCROW, ESCROW]);
    expect(erc20.decodeFunctionData('approve', w.sent[0].data).map(String)).toEqual([ESCROW, '6000000']);
    expect(w.sent.slice(1).map((t) => t.nonce)).toEqual([8, 9, 10]);
    // Executors asked for once, for every private row.
    expect(s.to('/api/v1/a2a/executors')).toHaveLength(1);
    expect(res.results.map((r) => r.status === 'posted' && r.task.taskId)).toEqual(['100', '101', '102']);
    expect(res.results.every((r) => r.status === 'posted' && r.task.privacy === 'private' && /^[0-9a-f]{64}$/.test(r.task.aesKey ?? ''))).toBe(true);
    expect(funded).toEqual([{ index: 0, batch: false }, { index: 1, batch: false }, { index: 2, batch: false }]);
    expect(progress).toEqual([1, 2, 3]);
  });

  it('tells onFunded each funding transaction\'s nonce, as postTask() does', async () => {
    stub();
    const w = wallet();
    const nonces: number[] = [];
    await bb().postTasks(rows(3), { signer: w.signer, onFunded: ({ nonce }) => { nonces.push(nonce); } });
    expect(nonces).toEqual([8, 9, 10]); // the approve took 7
    const single: number[] = [];
    stub();
    await bb().postTask(row(5), { signer: wallet().signer, onFunded: ({ nonce }) => { single.push(nonce); } });
    expect(single).toEqual([8]);
  });

  it('sends no approve when the allowance already covers the total', async () => {
    stub();
    const w = wallet({ allowance: 6_000_000n });
    await bb().postTasks(rows(3), { signer: w.signer });
    expect(w.sent.map((t) => t.to)).toEqual([ESCROW, ESCROW, ESCROW]);
  });

  it('fails a row the backend refuses before funding, and goes on with the rest', async () => {
    stub({ queued: { '/api/v1/tasks': [null, fail(409, 'TASK_EXISTS')] } });
    const w = wallet();
    const res = await bb().postTasks(rows(3), { signer: w.signer });
    expect(res.results.map((r) => r.status)).toEqual(['posted', 'failed', 'posted']);
    expect(res.results[1]).toMatchObject({ status: 'failed', error: { code: 'TASK_EXISTS' } });
    expect(res.stopped).toBeUndefined();
    // Approved once, before the first funding, for every row pending then: 1 + 2 + 3 USDC.
    expect(erc20.decodeFunctionData('approve', w.sent[0].data).map(String)).toEqual([ESCROW, '6000000']);
    expect(w.sent.map((t) => t.to)).toEqual([USDC, ESCROW, ESCROW]);
  });

  it('a row refused first leaves the approval to the rows still pending', async () => {
    stub({ queued: { '/api/v1/tasks': [fail(409, 'TASK_EXISTS')] } });
    const w = wallet();
    const res = await bb().postTasks(rows(3), { signer: w.signer });
    expect(res.results.map((r) => r.status)).toEqual(['failed', 'posted', 'posted']);
    expect(erc20.decodeFunctionData('approve', w.sent[0].data).map(String)).toEqual([ESCROW, '5000000']);
  });

  it('asks again after a rate limit, a 5xx or a network error, before funding', async () => {
    const s = stub({ queued: { '/api/v1/storage/upload': [fail(429, 'RATE_LIMIT'), fail(503, 'UNAVAILABLE')] } });
    const base = s.fn.getMockImplementation()!;
    let dropped = false;
    s.fn.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      if (!dropped && String(url).endsWith('/api/v1/tasks')) { dropped = true; throw new TypeError('fetch failed'); }
      return base(url, init);
    });
    const res = await bb().postTasks(rows(1), { signer: wallet().signer, retry: fast });
    expect(res.posted).toBe(1);
    expect(s.to('/api/v1/storage/upload')).toHaveLength(3);
    expect(dropped).toBe(true); // the dropped build was asked again
    expect(s.to('/api/v1/tasks')).toHaveLength(1);
  });

  it('gives up after the retries and stops the run, having funded nothing', async () => {
    const down = Array.from({ length: 5 }, () => fail(503, 'UNAVAILABLE'));
    stub({ queued: { '/api/v1/storage/upload': down } });
    const w = wallet();
    const res = await bb().postTasks(rows(2), { signer: w.signer, retry: fast });
    expect(res.results.map((r) => r.status)).toEqual(['failed', 'skipped']);
    expect(res.stopped).toMatchObject({ index: 0, code: 'UNAVAILABLE' });
    expect(w.sent).toHaveLength(0);
  });

  it('never sends a funding transaction twice: one sent but not confirmed stops the run as unlisted', async () => {
    stub();
    const timeout = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    // Send 1 is the approve; send 2 (rows[0]) confirms; send 3 (rows[1]) never does.
    const w = wallet({ waitFor: async (n) => { if (n === 3) throw timeout; return { status: 1 }; } });
    const res = await bb().postTasks(rows(3), { signer: w.signer, retry: fast });
    expect(w.sent).toHaveLength(3);
    expect(res.results.map((r) => r.status)).toEqual(['posted', 'unlisted', 'skipped']);
    const unlisted = res.results[1];
    expect(unlisted).toMatchObject({ status: 'unlisted', batch: false, txHash: w.sent[2].hash, error: { code: 'UNCONFIRMED' } });
    expect(unlisted.status === 'unlisted' && unlisted.indexParams.txHash).toBe(w.sent[2].hash);
    expect(res.stopped).toMatchObject({ index: 1, code: 'UNCONFIRMED' });
  });

  it('a funding that reverts fails the row and stops the run: nothing moved, and nothing is funded behind it', async () => {
    stub();
    const w = wallet({ waitFor: async (n) => ({ status: n === 2 ? 0 : 1 }) });
    const res = await bb().postTasks(rows(2), { signer: w.signer });
    expect(res.results.map((r) => r.status)).toEqual(['failed', 'skipped']);
    expect(res.results[0]).toMatchObject({ error: { message: expect.stringContaining('reverted') } });
    expect(w.sent).toHaveLength(2); // the approve and rows[0]
  });

  it('a listing that fails leaves the row unlisted with what indexTask() needs, and stops the run', async () => {
    stub({ queued: { '/api/v1/a2a/tasks/index': [fail(403, 'NOT_TASK_AGENT')] } });
    const w = wallet();
    const res = await bb().postTasks(rows(3), { signer: w.signer, retry: fast });
    expect(res.results.map((r) => r.status)).toEqual(['unlisted', 'skipped', 'skipped']);
    const r0 = res.results[0];
    expect(r0).toMatchObject({ status: 'unlisted', error: { code: 'NOT_TASK_AGENT' } });
    expect(r0.status === 'unlisted' && r0.indexParams).toMatchObject({ txHash: w.sent[1].hash, privacy: 'public' });
    expect(res.stopped).toMatchObject({ index: 0, code: 'NOT_TASK_AGENT' });
    expect(w.sent).toHaveLength(2);
  });

  it('stops before the next row when the signal is aborted, and says so', async () => {
    stub();
    const w = wallet();
    const abort = new AbortController();
    const res = await bb().postTasks(rows(3), { signer: w.signer, signal: abort.signal, onProgress: ({ done }) => { if (done === 1) abort.abort(); } });
    expect(res.results.map((r) => r.status)).toEqual(['posted', 'skipped', 'skipped']);
    expect(res.results[1]).toMatchObject({ reason: 'aborted' });
    expect(res.stopped).toMatchObject({ index: 1, code: 'ABORTED' });
    expect(w.sent.filter((t) => t.to === ESCROW)).toHaveLength(1);
  });
});

describe('postTasks — on an escrow with createTasks, several rows per transaction', () => {
  it('uploads, builds, funds and lists each chunk together, and posts a last single row alone', async () => {
    const s = stub({ settlement: withBatch() });
    const w = wallet();
    const funded: { index: number; batch: boolean; txHash: string }[] = [];
    const res = await bb().postTasks(rows(5), { signer: w.signer, chunkSize: 2, onFunded: ({ index, batch, txHash }) => { funded.push({ index, batch, txHash }); } });

    expect(res).toMatchObject({ mode: 'batch', posted: 5 });
    // approve(15 USDC), createTasks(rows 0-1), createTasks(rows 2-3), createTask(row 4)
    expect(w.sent.map((t) => t.to)).toEqual([USDC, ESCROW, ESCROW, ESCROW]);
    expect(erc20.decodeFunctionData('approve', w.sent[0].data).map(String)).toEqual([ESCROW, '15000000']);
    const [token, tasks] = ESCROW_ABI.decodeFunctionData('createTasks', w.sent[1].data);
    expect(token.toLowerCase()).toBe(USDC.toLowerCase());
    expect(tasks.map((t: ethers.Result) => t[1])).toEqual([1_000_000n, 2_000_000n]);
    expect(ESCROW_ABI.getFunction('createTask')!.selector).toBe(w.sent[3].data.slice(0, 10));
    // A batch gets its own gas limit: the local estimate plus a fifth, never the backend's.
    expect(w.sent[1].gasLimit).toBe(4_920_000n);
    expect(w.sent[3].gasLimit).toBeUndefined();
    expect(s.to('/api/v1/storage/upload-batch').map((c) => c.body.items.length)).toEqual([2, 2]);
    expect(s.to('/api/v1/a2a/tasks/index-batch').map((c) => c.body.tasks.length)).toEqual([2, 2]);
    expect(s.to('/api/v1/a2a/tasks/index-batch')[0].body.txHash).toBe(w.sent[1].hash);
    // Each row listed with its own root hash, from the batch upload's order.
    expect(s.to('/api/v1/tasks/batch')[0].body.tasks.map((t: { rootHash: string }) => t.rootHash)).toEqual([`0x${'1'.padStart(64, '0')}`, `0x${'2'.padStart(64, '0')}`]);
    expect(funded.map((f) => [f.index, f.batch])).toEqual([[0, true], [1, true], [2, true], [3, true], [4, false]]);
    expect(funded[0].txHash).toBe(funded[1].txHash);
    expect(res.results.map((r) => r.status === 'posted' && r.task.txHash)).toEqual([w.sent[1].hash, w.sent[1].hash, w.sent[2].hash, w.sent[2].hash, w.sent[3].hash]);
  });

  it("never puts more rows in a transaction than the escrow's maxBatch", async () => {
    stub({ settlement: withBatch(3) });
    const w = wallet();
    await bb().postTasks(rows(7), { signer: w.signer });
    const sizes = w.sent.filter((t) => t.to === ESCROW).map((t) => (t.data.startsWith(ESCROW_ABI.getFunction('createTasks')!.selector) ? ESCROW_ABI.decodeFunctionData('createTasks', t.data)[1].length : 1));
    expect(sizes).toEqual([3, 3, 1]);
  });

  it('refuses a createTasks with other amounts, or the rows in another order, and signs nothing', async () => {
    for (const tamper of [
      (t: TaskBody[]) => t.map((x) => ({ ...x, amount: '999000000' })),
      (t: TaskBody[]) => [...t].reverse(),
      (t: TaskBody[]) => t.slice(1),
    ]) {
      stub({ settlement: withBatch(), tamperBatch: tamper });
      const w = wallet();
      const res = await bb().postTasks(rows(4), { signer: w.signer, chunkSize: 2 });
      expect(w.sent).toHaveLength(0); // not even the approve
      expect(res.results.map((r) => r.status)).toEqual(['failed', 'failed', 'skipped', 'skipped']);
      expect(res.stopped).toMatchObject({ index: 0, code: 'TX_MISMATCH' });
    }
  });

  it('fails the rows the backend refuses in a batch build, and builds the rest again', async () => {
    const refused = fail(400, 'INVALID_TASKS', { errors: [{ index: 1, code: 'TASK_EXISTS', message: 'already on the market' }] });
    const s = stub({ settlement: withBatch(), queued: { '/api/v1/tasks/batch': [refused] } });
    const w = wallet();
    const res = await bb().postTasks(rows(3), { signer: w.signer, chunkSize: 3 });
    expect(res.results.map((r) => r.status)).toEqual(['posted', 'failed', 'posted']);
    expect(res.results[1]).toMatchObject({ error: { code: 'TASK_EXISTS' } });
    expect(s.to('/api/v1/tasks/batch').map((c) => c.body.tasks.length)).toEqual([3, 2]);
    // Approved for the rows still pending: 1 + 3 USDC.
    expect(erc20.decodeFunctionData('approve', w.sent[0].data).map(String)).toEqual([ESCROW, '4000000']);
  });

  it('a batch whose gas estimate fails (a revert predicted) sends nothing and stops the run', async () => {
    stub({ settlement: withBatch() });
    const w = wallet({ estimate: async () => { throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' }); } });
    const res = await bb().postTasks(rows(4), { signer: w.signer, chunkSize: 2 });
    expect(w.sent.map((t) => t.to)).toEqual([USDC]); // the approve, before the estimate it depends on
    expect(res.results.map((r) => r.status)).toEqual(['failed', 'failed', 'skipped', 'skipped']);
    expect(res.stopped).toMatchObject({ index: 0, code: 'CALL_EXCEPTION' });
  });

  it('posts one by one when the escrow refuses createTasks after all', async () => {
    const s = stub({ settlement: withBatch(), queued: { '/api/v1/tasks/batch': [fail(409, 'BATCH_UNSUPPORTED')] } });
    const w = wallet();
    const res = await bb().postTasks(rows(4), { signer: w.signer, chunkSize: 2 });
    expect(res).toMatchObject({ mode: 'single', posted: 4 });
    expect(s.to('/api/v1/tasks')).toHaveLength(4);
    expect(w.sent.map((t) => t.to)).toEqual([USDC, ESCROW, ESCROW, ESCROW, ESCROW]);
  });

  it('asks the listing again while the RPC has not seen the receipt', async () => {
    const s = stub({ settlement: withBatch(), queued: { '/api/v1/a2a/tasks/index-batch': [fail(404, 'RECEIPT_NOT_FOUND')] } });
    const res = await bb().postTasks(rows(2), { signer: wallet().signer, retry: fast });
    expect(res.posted).toBe(2);
    expect(s.to('/api/v1/a2a/tasks/index-batch')).toHaveLength(2);
  });

  it('a row the listing does not take comes back unlisted, for indexTasks(), and stops the run', async () => {
    const s = stub({ settlement: withBatch() });
    const w = wallet();
    // Answer the first listing with rows[0] listed and rows[1] refused.
    const base = s.fn.getMockImplementation()!;
    s.fn.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/api/v1/a2a/tasks/index-batch')) {
        const body = JSON.parse(String(init!.body));
        return ok({ results: [
          { taskHash: body.tasks[0].taskHash, onChainTaskId: '100', indexed: true },
          { taskHash: body.tasks[1].taskHash, error: { code: 'NOT_IN_RECEIPT', message: 'not in the receipt' } },
        ] });
      }
      return base(url, init);
    });
    const res = await bb().postTasks(rows(4), { signer: w.signer, chunkSize: 2 });
    expect(res.results.map((r) => r.status)).toEqual(['posted', 'unlisted', 'skipped', 'skipped']);
    const r1 = res.results[1];
    expect(r1).toMatchObject({ status: 'unlisted', batch: true, error: { code: 'NOT_IN_RECEIPT' } });
    expect(r1.status === 'unlisted' && r1.indexParams.txHash).toBe(w.sent[1].hash);
    expect(res.stopped).toMatchObject({ index: 1, code: 'NOT_IN_RECEIPT' });

    // indexTasks() finishes it later, from what came back.
    if (r1.status !== 'unlisted') throw new Error('unreachable');
    const { txHash, ...task } = r1.indexParams;
    const later = stub({ settlement: withBatch() });
    await expect(bb().indexTasks({ txHash, tasks: [task] })).resolves.toMatchObject({ results: [{ indexed: true }] });
    expect(later.to('/api/v1/a2a/tasks/index-batch')[0].body).toEqual({ txHash, tasks: [task] });
  });

  it('a batch funding sent but not confirmed leaves every row in it unlisted, and nothing more is sent', async () => {
    stub({ settlement: withBatch() });
    const timeout = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
    const w = wallet({ waitFor: async (n) => { if (n === 2) throw timeout; return { status: 1 }; } });
    const res = await bb().postTasks(rows(4), { signer: w.signer, chunkSize: 2 });
    expect(w.sent).toHaveLength(2);
    expect(res.results.map((r) => r.status)).toEqual(['unlisted', 'unlisted', 'skipped', 'skipped']);
    expect(res.results[0]).toMatchObject({ batch: true, txHash: w.sent[1].hash, error: { code: 'UNCONFIRMED' } });
  });
});

describe('postTasks — storing briefs: two per request, one at a time on a slow node', () => {
  const html524 = () => ({ status: 524, json: async () => { throw new SyntaxError('Unexpected token <'); } }) as unknown as Response;
  const sizes = (s: ReturnType<typeof stub>) => s.to('/api/v1/storage/upload-batch').map((c) => c.body.items.length);

  it('sends a chunk\'s briefs two per request, in order: 5 briefs are 2, 2, 1', async () => {
    const s = stub({ settlement: withBatch() });
    const res = await bb().postTasks(rows(5), { signer: wallet().signer, chunkSize: 5 });
    expect(res.posted).toBe(5);
    expect(sizes(s)).toEqual([2, 2, 1]);
    // Each row gets the root hash of its own brief, in order.
    expect(s.to('/api/v1/tasks/batch')[0].body.tasks.map((t: { rootHash: string }) => Number(BigInt(t.rootHash)))).toEqual([1, 2, 3, 4, 5]);
  });

  it('a pair that times out at the edge (Cloudflare 524) is sent again one brief per request, keeping the order', async () => {
    const s = stub({ settlement: withBatch(), queued: { '/api/v1/storage/upload-batch': [html524()] } });
    const res = await bb().postTasks(rows(3), { signer: wallet().signer, chunkSize: 3, retry: fast });
    expect(res.posted).toBe(3);
    expect(sizes(s)).toEqual([2, 1, 1, 1]); // the failed pair, its briefs one by one, then the last group
    const briefs = s.to('/api/v1/storage/upload-batch').map((c) => c.body.items.map((it: { data: string }) => it.data));
    expect(briefs[1][0]).toBe(briefs[0][0]);
    expect(briefs[2][0]).toBe(briefs[0][1]);
    expect(s.to('/api/v1/tasks/batch')[0].body.tasks.map((t: { rootHash: string }) => Number(BigInt(t.rootHash)))).toEqual([1, 2, 3]);
  });

  it('this client\'s own timeout counts as transient too, and each single brief gets the backoff', async () => {
    const s = stub({ settlement: withBatch(), queued: { '/api/v1/storage/upload-batch': [null, fail(503, 'STORAGE_UNAVAILABLE'), fail(503, 'STORAGE_UNAVAILABLE')] } });
    const base = s.fn.getMockImplementation()!;
    let timedOut = false;
    s.fn.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      if (!timedOut && String(url).endsWith('/api/v1/storage/upload-batch')) {
        timedOut = true;
        s.calls.push({ path: '/api/v1/storage/upload-batch', body: JSON.parse(String(init!.body)) });
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
      return base(url, init);
    });
    const res = await bb().postTasks(rows(2), { signer: wallet().signer, chunkSize: 2, retry: fast });
    expect(res.posted).toBe(2);
    // The pair timed out; the first single stored at once; the second failed twice, then stored.
    expect(sizes(s)).toEqual([2, 1, 1, 1, 1]);
  });

  it('a brief the backend refuses (400) fails at once, with no retry, and nothing is funded', async () => {
    const s = stub({ settlement: withBatch(), queued: { '/api/v1/storage/upload-batch': [fail(400, 'DATA_TOO_LARGE')] } });
    const w = wallet();
    const res = await bb().postTasks(rows(4), { signer: w.signer, chunkSize: 4, retry: fast });
    expect(sizes(s)).toEqual([2]);
    expect(res.results.map((r) => r.status)).toEqual(['failed', 'failed', 'failed', 'failed']);
    expect(res.results[0]).toMatchObject({ error: { code: 'DATA_TOO_LARGE' } });
    expect(w.sent).toHaveLength(0);
  });

  it('an answer that does not add up (one root hash for two briefs) fails at once and stops the run', async () => {
    const s = stub({ settlement: withBatch(), queued: { '/api/v1/storage/upload-batch': [ok({ results: [{ rootHash: `0x${'9'.repeat(64)}` }] })] } });
    const w = wallet();
    const res = await bb().postTasks(rows(4), { signer: w.signer, chunkSize: 2, retry: fast });
    expect(sizes(s)).toEqual([2]);
    expect(res.stopped).toMatchObject({ index: 0, code: 'UPLOAD_MISMATCH' });
    expect(res.results.map((r) => r.status)).toEqual(['failed', 'failed', 'skipped', 'skipped']);
    expect(w.sent).toHaveLength(0);
  });

  it('never funds a chunk before every one of its briefs is stored', async () => {
    const events: string[] = [];
    stub({ settlement: withBatch(), events, queued: { '/api/v1/storage/upload-batch': [html524()] } });
    await bb().postTasks(rows(5), { signer: wallet({ events }).signer, chunkSize: 5, retry: fast });
    const lastUpload = events.lastIndexOf('fetch /api/v1/storage/upload-batch');
    const build = events.indexOf('fetch /api/v1/tasks/batch');
    const firstSend = events.findIndex((e) => e.startsWith('send'));
    expect(lastUpload).toBeLessThan(build);
    expect(build).toBeLessThan(firstSend);
  });

  it('one row at a time, each brief is its own /storage/upload request, with the same backoff', async () => {
    const s = stub({ queued: { '/api/v1/storage/upload': [html524(), fail(502, 'BAD_GATEWAY')] } });
    const res = await bb().postTasks(rows(2), { signer: wallet().signer, retry: fast });
    expect(res.posted).toBe(2);
    expect(s.to('/api/v1/storage/upload')).toHaveLength(4);
    expect(s.to('/api/v1/storage/upload-batch')).toHaveLength(0);
  });
});

describe('postTasks and postTask — only a known escrow and token are approved or funded', () => {
  const arcWith = (patch: Record<string, unknown>) => ({
    ...SETTLEMENT,
    chains: SETTLEMENT.chains.map((c: { chain: string }) => (c.chain === 'arc' ? { ...c, ...patch } : c)),
  });
  const OTHER = '0x' + '1b'.repeat(20);

  it('refuses an escrow the backend names that is not the deployment pinned for its chain, before anything is sent', async () => {
    const s = stub({ settlement: arcWith({ escrowAddress: OTHER }) });
    const w = wallet();
    const err = await bb().postTasks(rows(2), { signer: w.signer }).catch((e) => e);
    expect(err).toMatchObject({ code: 'ESCROW_NOT_PINNED', message: expect.stringContaining('trustedEscrows') });
    expect(err.message).toContain(ESCROW);
    await expect(bb().postTask(row(0), { signer: w.signer })).rejects.toMatchObject({ code: 'ESCROW_NOT_PINNED' });
    expect(s.to('/api/v1/storage/upload')).toHaveLength(0);
    expect(w.sent).toHaveLength(0);
  });

  it('refuses another settlement token, and a chain with no known deployment', async () => {
    stub({ settlement: arcWith({ token: { ...ARC.token, address: OTHER } }) });
    await expect(bb().postTasks(rows(1), { signer: wallet().signer })).rejects.toMatchObject({ code: 'ESCROW_NOT_PINNED' });
    stub({ settlement: arcWith({ chainId: 999 }) });
    await expect(bb().postTasks(rows(1), { signer: wallet().signer })).rejects.toMatchObject({ code: 'ESCROW_NOT_PINNED', message: expect.stringContaining('no known deployment') });
  });

  it('funds a custom or local deployment the client lists in trustedEscrows', async () => {
    stub({ settlement: arcWith({ escrowAddress: OTHER }) });
    const w = wallet();
    const client = new BlindMarket({ apiKey: 'k', trustedEscrows: [{ chainId: CHAIN_ID, escrow: OTHER, token: USDC }] });
    const res = await client.postTasks(rows(1), { signer: w.signer });
    expect(res.posted).toBe(1);
    expect(w.sent.map((t) => t.to.toLowerCase())).toEqual([USDC.toLowerCase(), OTHER.toLowerCase()]);
  });
});

describe('postTasks — the category is bound like every other argument', () => {
  it('refuses a createTask or createTasks built with another category, and signs nothing', async () => {
    category = 'lottery';
    stub();
    const w = wallet();
    const single = await bb().postTasks(rows(1), { signer: w.signer });
    expect(single.stopped).toMatchObject({ code: 'TX_MISMATCH' });
    stub({ settlement: withBatch() });
    const batch = await bb().postTasks(rows(2), { signer: w.signer, chunkSize: 2 });
    expect(batch.stopped).toMatchObject({ code: 'TX_MISMATCH' });
    expect(w.sent).toHaveLength(0);
  });
});
