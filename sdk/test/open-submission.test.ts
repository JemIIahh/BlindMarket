import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { BlindMarket, ApiError, openEvidenceHashOf, scorecardHashOf } from '../src/index.js';

/**
 * Open submission (docs/OPEN-SUBMISSION-TASKS.md): posting a task many agents
 * submit to, submitting to one, and picking its winner. Each transaction the
 * backend builds is checked before the key signs it, as postTask() and the
 * refunds are; these tests hand back transactions a wrong or hostile backend
 * might build and check nothing is sent.
 */

const SETTLEMENT = JSON.parse(readFileSync(new URL('../../fixtures/prod/health-settlement.json', import.meta.url), 'utf-8')).data;
const ARC = SETTLEMENT.chains.find((c: { chain: string }) => c.chain === 'arc');
const ESCROW = ARC.escrowAddress as string;
const USDC = ARC.token.address as string;
const CHAIN_ID = ARC.chainId as number;

const OWNER = '0x00000000000000000000000000000000000000a1';
const VERIFIER = '0x00000000000000000000000000000000000000c3';
const WINNER = '0x00000000000000000000000000000000000000e7';
const HASH = '0x' + 'ab'.repeat(32);
const ROOT = '0x' + '77'.repeat(32);
const SENT = '0x' + 'f1'.repeat(32);

/** What the real backend builds (backend/src/services/escrow.ts). */
const ABI = new ethers.Interface([
  'function createTask(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration)',
  'function createTaskWithVerifier(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration, address verifierAgent)',
  'function createTaskOpen(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration, address verifierAgent, uint8 mode, uint256 creatorWindow)',
  'function submitOpen(uint256 taskId, bytes32 evidenceHash)',
  'function selectWinner(uint256 taskId, address winner, bytes32 scorecardHash)',
  'function selectWinnerByVerifier(uint256 taskId, address winner, bytes32 scorecardHash)',
]);
type CreateBody = { taskHash: string; token: string; amount: string; locationZone: string; duration: string; verifierAddress: string; open: { mode: 'agent' | 'creator'; creatorWindow: number } };
const createOpenData = (b: CreateBody, over: { mode?: number; window?: number } = {}) =>
  ABI.encodeFunctionData('createTaskOpen', [b.taskHash, b.token, b.amount, 'general', b.locationZone, b.duration, b.verifierAddress, over.mode ?? (b.open.mode === 'creator' ? 1 : 0), over.window ?? b.open.creatorWindow]);

const ok = (data: unknown) => ({ status: 200, json: async () => ({ success: true, data }) }) as unknown as Response;
const fail = (status: number, code: string) => ({ status, json: async () => ({ success: false, error: { code, message: code } }) }) as unknown as Response;

const STATUS = {
  taskHash: HASH, onChainTaskId: '41', chain: 'arc', mode: 'creator', phase: 'submissions', paused: false, submissions: 2,
  windows: { submissionsEnd: 1, creatorPickEnd: 2, verifierPickEnd: 3, backupPickEnd: 4 }, outcome: null, declined: null,
};

interface Backend {
  enabled?: boolean;
  posting?: boolean;
  /** The createTask* the backend builds for POST /tasks. */
  create?: (body: CreateBody) => Record<string, unknown>;
  submit?: (body: { resultData: Record<string, unknown>; rootHash: string | null }) => Response;
  select?: (body: { winner: string; scorecard?: Record<string, unknown> }) => Response;
}

function stub(b: Backend = {}) {
  const calls: string[] = [];
  const posts: CreateBody[] = [];
  const indexes: Record<string, unknown>[] = [];
  const bodies: Record<string, unknown>[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(u.replace(/^https?:\/\/[^/]+/, ''));
    if (u.endsWith('/health/settlement')) return ok(SETTLEMENT);
    if (u.endsWith('/api/v1/api-keys/whoami')) return ok({ address: OWNER, addresses: [OWNER] });
    if (u.endsWith('/api/v1/a2a/open-submission')) {
      return ok({ enabled: b.enabled ?? true, posting: b.posting === undefined ? true : b.posting ?? undefined, pickModes: ['agent', 'creator'], windows: { creatorMinSec: 3600, creatorMaxSec: 604800, verifierSec: 172800, backupSec: 172800 }, maxResultBytes: 65536, maxScorecardBytes: 32768 });
    }
    if (u.endsWith('/api/v1/storage/upload')) return ok({ rootHash: ROOT });
    if (u.endsWith('/api/v1/tasks')) {
      posts.push(body);
      return ok(b.create?.(body) ?? { unsignedTx: { to: ESCROW, data: createOpenData(body), from: OWNER }, chain: 'arc', chainId: CHAIN_ID });
    }
    if (u.endsWith('/api/v1/a2a/tasks/index')) { indexes.push(body); return ok({ taskHash: body.taskHash, onChainTaskId: '41', indexed: true }); }
    if (u.endsWith(`/api/v1/a2a/tasks/${HASH}/open-status`)) return ok(STATUS);
    if (u.endsWith(`/api/v1/a2a/tasks/${HASH}/submit-open`)) {
      bodies.push(body);
      if (b.submit) return b.submit(body);
      const evidenceHash = openEvidenceHashOf(body.resultData, body.rootHash);
      return ok({ taskHash: HASH, onChainTaskId: '41', evidenceHash, unsignedSubmitOpen: { to: ESCROW, from: OWNER, data: ABI.encodeFunctionData('submitOpen', [41n, evidenceHash]), chainId: CHAIN_ID }, resultHeldForSec: 3600 });
    }
    if (u.endsWith(`/api/v1/a2a/tasks/${HASH}/select`)) {
      bodies.push(body);
      if (b.select) return b.select(body);
      const scorecardHash = body.scorecard ? scorecardHashOf(body.scorecard) : ethers.ZeroHash;
      return ok({ taskHash: HASH, onChainTaskId: '41', winner: body.winner.toLowerCase(), scorecardHash, unsignedSelectWinner: { to: ESCROW, from: OWNER, data: ABI.encodeFunctionData('selectWinner', [41n, body.winner, scorecardHash]), chainId: CHAIN_ID } });
    }
    throw new Error(`unhandled fetch ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls, posts, indexes, bodies };
}

const erc20 = new ethers.Interface(['function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
const word = (v: bigint) => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [v]);
// What the escrow answers about task 41: by default the open task HASH, and no submission from the signer.
const READS = new ethers.Interface([
  'function getTask(uint256 taskId) view returns (tuple(address agent, address worker, address token, uint256 amount, bytes32 taskHash, bytes32 evidenceHash, uint8 status, string category, string locationZone, uint256 createdAt, uint256 deadline, uint8 submissionAttempts, uint256 disputedAt))',
  'function getOpenTask(uint256 taskId) view returns (tuple(bool open, uint8 mode, uint32 creatorWindow, uint8 closedBy))',
  'function submissionOf(uint256 taskId, address submitter) view returns (bytes32)',
]);
interface Escrow { taskHash?: string; open?: boolean; submission?: string }

function wallet(address = OWNER, escrow: Escrow = {}) {
  const sent: { to: string; data: string; value?: bigint }[] = [];
  const signer = {
    getAddress: async () => address,
    sendTransaction: vi.fn(async (tx: { to: string; data: string; value?: bigint }) => {
      sent.push(tx);
      return { hash: SENT, nonce: 7, wait: async () => ({ status: 1 }) };
    }),
    provider: {
      call: vi.fn(async (tx: { data: string }) => {
        const sel = tx.data.slice(0, 10);
        if (sel === erc20.getFunction('balanceOf')!.selector) return word(10_000_000n);
        if (sel === erc20.getFunction('allowance')!.selector) return word(10_000_000n);
        if (sel === READS.getFunction('getTask')!.selector) {
          return READS.encodeFunctionResult('getTask', [[OWNER, ethers.ZeroAddress, USDC, 2_000_000n, escrow.taskHash ?? HASH, ethers.ZeroHash, 0, 'general', 'global', 1n, 2n, 0, 0n]]);
        }
        if (sel === READS.getFunction('getOpenTask')!.selector) return READS.encodeFunctionResult('getOpenTask', [[escrow.open ?? true, 1, 3600, 0]]);
        if (sel === READS.getFunction('submissionOf')!.selector) return READS.encodeFunctionResult('submissionOf', [escrow.submission ?? ethers.ZeroHash]);
        throw new Error(`unexpected read ${sel}`);
      }),
      getNetwork: async () => ({ chainId: BigInt(CHAIN_ID) }),
    },
  };
  return { signer: signer as unknown as ethers.Signer, sent };
}

const bb = () => new BlindMarket({ apiKey: 'k' });
const openTask = { instructions: 'Name three primary sources for the 1907 panic, with links.', amountRaw: '2000000', verifierAddress: VERIFIER as `0x${string}` };

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(() => undefined, (e) => e);
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the open-submission hashes match the backend', () => {
  // The vectors in backend/src/routes/openSubmission.test.ts ("openEvidenceHash").
  it('commits the result and its storage pointer together', () => {
    const resultData = { output: 'Done: the summary — 3 points ✓', agent: 'agent-7' };
    expect(openEvidenceHashOf(resultData, `0x${'ab'.repeat(32)}`)).toBe('0xf0c7c9b0b9ccb46409e4e35bc30f9aa94ecab88e24a57c256fff5535caa82839');
    expect(openEvidenceHashOf(resultData, null)).toBe('0x1b701a666ac7fbd05539f4c0fceac47f1793c207bca36cf5f85d514872767439');
  });

  it('hashes a scorecard as its JSON', () => {
    const card = { scores: [{ submitter: WINNER, score: 9 }] };
    expect(scorecardHashOf(card)).toBe(ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(card))));
  });
});

describe('postTask({ open }) — a task many agents submit to', () => {
  it('posts it public, judged by its verifier, and funds exactly createTaskOpen', async () => {
    const { posts, indexes } = stub();
    const w = wallet();
    const posted = await bb().postTask({ ...openTask, open: { pick: 'creator', pickWindowSeconds: 7200 } }, { signer: w.signer });
    expect(posts[0].open).toEqual({ mode: 'creator', creatorWindow: 7200 });
    expect(posts[0]).toMatchObject({ privacy: 'public', verificationMode: 'agent', verifierAddress: VERIFIER });
    expect(posts[0]).not.toHaveProperty('wrappedKeys');
    expect(indexes[0]).toMatchObject({ privacy: 'public', verificationMode: 'agent', verifierAddress: VERIFIER });
    const funded = w.sent.find((t) => t.to.toLowerCase() === ESCROW.toLowerCase())!;
    const a = ABI.decodeFunctionData('createTaskOpen', funded.data);
    expect([a[6].toLowerCase(), a[7], a[8]]).toEqual([VERIFIER, 1n, 7200n]);
    expect(posted).toMatchObject({ privacy: 'public', taskId: '41', open: { pick: 'creator', creatorWindow: 7200 } });
  });

  it('lets the verifier pick by default, with no poster window', async () => {
    const { posts } = stub();
    const w = wallet();
    await bb().postTask({ ...openTask, open: {} }, { signer: w.signer });
    expect(posts[0].open).toEqual({ mode: 'agent', creatorWindow: 0 });
    const a = ABI.decodeFunctionData('createTaskOpen', w.sent.find((t) => t.to.toLowerCase() === ESCROW.toLowerCase())!.data);
    expect([a[7], a[8]]).toEqual([0n, 0n]);
  });

  it.each([
    ['another pick mode', (b: CreateBody) => ({ unsignedTx: { to: ESCROW, data: createOpenData(b, { mode: 0 }) }, chain: 'arc', chainId: CHAIN_ID })],
    ['another window', (b: CreateBody) => ({ unsignedTx: { to: ESCROW, data: createOpenData(b, { window: 3600 }) }, chain: 'arc', chainId: CHAIN_ID })],
    ['a task one agent takes', (b: CreateBody) => ({ unsignedTx: { to: ESCROW, data: ABI.encodeFunctionData('createTaskWithVerifier', [b.taskHash, b.token, b.amount, 'general', b.locationZone, b.duration, b.verifierAddress]) }, chain: 'arc', chainId: CHAIN_ID })],
  ])('refuses a backend that builds %s, with nothing sent', async (_name, create) => {
    stub({ create });
    const w = wallet();
    const err = await refusal(bb().postTask({ ...openTask, open: { pick: 'creator', pickWindowSeconds: 7200 } }, { signer: w.signer }));
    expect(err.code).toBe('TX_MISMATCH');
    expect(w.sent).toHaveLength(0);
  });

  it.each([
    ['a private brief', { privacy: 'private' as const }, 'OPEN_TASK_MUST_BE_PUBLIC'],
    ['another check', { verificationMode: 'auto' as const }, 'OPEN_TASK_NEEDS_VERIFIER'],
    ['no verifier', { verifierAddress: undefined }, 'OPEN_TASK_NEEDS_VERIFIER'],
    ['a pinned executor', { targetExecutor: WINNER as `0x${string}` }, 'OPEN_TASK_PINNED'],
  ])('refuses %s before anything is uploaded or sent', async (_name, over, code) => {
    const { calls } = stub();
    const w = wallet();
    const err = await refusal(bb().postTask({ ...openTask, ...over, open: {} }, { signer: w.signer }));
    expect(err.code).toBe(code);
    expect(calls).toEqual([]);
    expect(w.sent).toHaveLength(0);
  });

  it.each([
    [{ pick: 'creator' as const, pickWindowSeconds: 3599 }],
    [{ pick: 'creator' as const, pickWindowSeconds: 7 * 86_400 + 1 }],
    [{ pick: 'agent' as const, pickWindowSeconds: 3600 }],
  ])('refuses a pick window the escrow would refuse (%o)', async (open) => {
    stub();
    expect((await refusal(bb().postTask({ ...openTask, open }, { signer: wallet().signer }))).code).toBe('INVALID_PICK_WINDOW');
  });

  it('refuses while the backend runs open submission off, before uploading', async () => {
    const { calls } = stub({ enabled: false });
    const err = await refusal(bb().postTask({ ...openTask, open: {} }, { signer: wallet().signer }));
    expect(err.code).toBe('OPEN_SUBMISSION_DISABLED');
    expect(calls).toEqual(['/api/v1/a2a/open-submission']);
  });

  it("refuses while the posting chain's escrow has no createTaskOpen, before uploading", async () => {
    const { calls: older } = stub({ posting: null as unknown as boolean });
    expect((await refusal(bb().postTask({ ...openTask, open: {} }, { signer: wallet().signer }))).code).toBe('OPEN_SUBMISSION_UNSUPPORTED');
    expect(older).toEqual(['/api/v1/a2a/open-submission']);
    const { calls } = stub({ posting: false });
    const err = await refusal(bb().postTask({ ...openTask, open: {} }, { signer: wallet().signer }));
    expect(err.code).toBe('OPEN_SUBMISSION_UNSUPPORTED');
    expect(calls).toEqual(['/api/v1/a2a/open-submission']);
  });

  it('refuses a verifier that is the posting wallet, before uploading', async () => {
    const { calls } = stub();
    const err = await refusal(bb().postTask({ ...openTask, verifierAddress: OWNER as `0x${string}`, open: {} }, { signer: wallet().signer }));
    expect(err.code).toBe('INVALID_VERIFIER');
    expect(calls).not.toContain('/api/v1/storage/upload');
  });

  it('is not part of a bulk post', async () => {
    stub();
    const err = await refusal(bb().postTasks([{ ...openTask, open: {} }], { signer: wallet().signer }));
    expect(err.code).toBe('INVALID_ROWS');
    expect(err.message).toMatch(/postTask\(\)/);
  });
});

describe('submitOpen()', () => {
  const result = { resultData: { output: 'Three sources: …' }, rootHash: ROOT };

  it('signs submitOpen for this task with the evidence hash computed here', async () => {
    const { bodies } = stub();
    const w = wallet();
    const sent: string[] = [];
    const out = await bb().submitOpen(HASH, result, { signer: w.signer, onSent: ({ txHash }) => { sent.push(txHash); } });
    const evidence = openEvidenceHashOf(result.resultData, ROOT);
    expect(bodies[0]).toEqual({ resultData: result.resultData, rootHash: ROOT });
    const a = ABI.decodeFunctionData('submitOpen', w.sent[0].data);
    expect([a[0], a[1]]).toEqual([41n, evidence]);
    expect(w.sent[0].to.toLowerCase()).toBe(ESCROW.toLowerCase());
    expect(out).toEqual({ taskHash: HASH, chain: 'arc', onChainTaskId: '41', evidenceHash: evidence, txHash: SENT, alreadyOnChain: false });
    expect(sent).toEqual([SENT]);
  });

  const onChainAlready = (b: { resultData: Record<string, unknown>; rootHash: string | null }) =>
    ok({ taskHash: HASH, onChainTaskId: '41', evidenceHash: openEvidenceHashOf(b.resultData, b.rootHash), alreadyOnChain: true, kept: true });

  it('sends nothing when the same result is already on-chain, as the escrow confirms', async () => {
    stub({ submit: onChainAlready });
    const w = wallet(OWNER, { submission: openEvidenceHashOf(result.resultData, ROOT) });
    expect(await bb().submitOpen(HASH, result, { signer: w.signer })).toMatchObject({ txHash: null, alreadyOnChain: true });
    expect(w.sent).toHaveLength(0);
  });

  it('refuses a backend that says the result is on-chain when the escrow holds none', async () => {
    stub({ submit: onChainAlready });
    expect((await refusal(bb().submitOpen(HASH, result, { signer: wallet().signer }))).code).toBe('TX_MISMATCH');
  });

  it.each([
    ['another task', { taskHash: '0x' + 'cd'.repeat(32) }],
    ['a task one agent takes', { open: false }],
  ])("refuses when the escrow says the backend's task id is %s, with nothing sent", async (_name, escrow) => {
    stub();
    const w = wallet(OWNER, escrow);
    expect((await refusal(bb().submitOpen(HASH, result, { signer: w.signer }))).code).toBe('TASK_MISMATCH');
    expect(w.sent).toHaveLength(0);
  });

  it('refuses an escrow that is not a known deployment', async () => {
    const unpinned = { ...SETTLEMENT, chains: SETTLEMENT.chains.map((c: { chain: string }) => (c.chain === 'arc' ? { ...c, escrowAddress: '0x' + '9a'.repeat(20) } : c)) };
    const { fn } = stub();
    const base = fn.getMockImplementation()!;
    fn.mockImplementation(async (url: string | URL, init?: RequestInit) => (String(url).endsWith('/health/settlement') ? ok(unpinned) : base(url, init)));
    const w = wallet();
    expect((await refusal(bb().submitOpen(HASH, result, { signer: w.signer }))).code).toBe('ESCROW_NOT_PINNED');
    expect(w.sent).toHaveLength(0);
  });

  const built = (over: Record<string, unknown>, evidence = openEvidenceHashOf(result.resultData, ROOT)) =>
    ok({ taskHash: HASH, onChainTaskId: '41', evidenceHash: evidence, unsignedSubmitOpen: { to: ESCROW, from: OWNER, data: ABI.encodeFunctionData('submitOpen', [41n, evidence]), chainId: CHAIN_ID, ...over }, resultHeldForSec: 3600 });

  it.each([
    ['another evidence hash', () => built({}, '0x' + '99'.repeat(32)), 'TX_MISMATCH'],
    ['another task', () => built({ data: ABI.encodeFunctionData('submitOpen', [42n, openEvidenceHashOf(result.resultData, ROOT)]) }), 'TX_MISMATCH'],
    ['another wallet', () => built({ from: WINNER }), 'OWNER_MISMATCH'],
    ['another contract', () => built({ to: USDC }), 'ESCROW_MISMATCH'],
    ['a value', () => built({ value: '1' }), 'TX_MISMATCH'],
    ['another chain', () => built({ chainId: 1 }), 'CHAIN_MISMATCH'],
  ])('refuses a submission built with %s, with nothing sent', async (_name, answer, code) => {
    stub({ submit: answer });
    const w = wallet();
    expect((await refusal(bb().submitOpen(HASH, result, { signer: w.signer }))).code).toBe(code);
    expect(w.sent).toHaveLength(0);
  });

  it('passes on the backend refusal, with nothing sent', async () => {
    stub({ submit: () => fail(409, 'DEADLINE_REACHED') });
    const w = wallet();
    expect((await refusal(bb().submitOpen(HASH, result, { signer: w.signer }))).code).toBe('DEADLINE_REACHED');
    expect(w.sent).toHaveLength(0);
  });
});

describe('pickWinner()', () => {
  const scorecard = { winner: WINNER, scores: [{ submitter: WINNER, score: 9, reason: 'All three cited.' }] };

  it("signs the poster's selectWinner with this scorecard's hash", async () => {
    const { bodies } = stub();
    const w = wallet();
    const out = await bb().pickWinner(HASH, WINNER, { scorecard, signer: w.signer });
    expect(bodies[0]).toEqual({ winner: WINNER, scorecard });
    const a = ABI.decodeFunctionData('selectWinner', w.sent[0].data);
    expect([a[0], a[1].toLowerCase(), a[2]]).toEqual([41n, WINNER, scorecardHashOf(scorecard)]);
    expect(out).toMatchObject({ role: 'poster', winner: ethers.getAddress(WINNER), scorecardHash: scorecardHashOf(scorecard), txHash: SENT });
  });

  it("signs the verifier's selectWinnerByVerifier, with no scorecard a zero hash", async () => {
    stub({ select: (b) => ok({ onChainTaskId: '41', winner: b.winner.toLowerCase(), scorecardHash: ethers.ZeroHash, unsignedSelectWinnerByVerifier: { to: ESCROW, from: OWNER, data: ABI.encodeFunctionData('selectWinnerByVerifier', [41n, b.winner, ethers.ZeroHash]), chainId: CHAIN_ID } }) });
    const w = wallet();
    expect(await bb().pickWinner(HASH, WINNER, { signer: w.signer })).toMatchObject({ role: 'verifier', scorecardHash: ethers.ZeroHash });
    expect(ABI.decodeFunctionData('selectWinnerByVerifier', w.sent[0].data)[0]).toBe(41n);
  });

  const pick = (fields: Record<string, unknown>) => ok({ onChainTaskId: '41', winner: WINNER, scorecardHash: ethers.ZeroHash, ...fields });
  const tx = (fn: string, winner = WINNER, card = ethers.ZeroHash) => ({ to: ESCROW, from: OWNER, data: ABI.encodeFunctionData(fn, [41n, winner, card]), chainId: CHAIN_ID });

  it.each([
    ['another winner', () => pick({ unsignedSelectWinner: tx('selectWinner', OWNER) })],
    ['another scorecard', () => pick({ scorecardHash: '0x' + '55'.repeat(32), unsignedSelectWinner: tx('selectWinner', WINNER, '0x' + '55'.repeat(32)) })],
    ['both picks', () => pick({ unsignedSelectWinner: tx('selectWinner'), unsignedSelectWinnerByVerifier: tx('selectWinnerByVerifier') })],
    ['the other function', () => pick({ unsignedSelectWinner: tx('selectWinnerByVerifier') })],
    ['another task', () => pick({ onChainTaskId: '42', unsignedSelectWinner: tx('selectWinner') })],
  ])('refuses a pick built with %s, with nothing sent', async (_name, answer) => {
    stub({ select: answer });
    const w = wallet();
    expect((await refusal(bb().pickWinner(HASH, WINNER, { signer: w.signer }))).code).toBe('TX_MISMATCH');
    expect(w.sent).toHaveLength(0);
  });

  it('refuses a pick for a task id the escrow says is another task, with nothing sent', async () => {
    stub();
    const w = wallet(OWNER, { taskHash: '0x' + 'cd'.repeat(32) });
    expect((await refusal(bb().pickWinner(HASH, WINNER, { signer: w.signer }))).code).toBe('TASK_MISMATCH');
    expect(w.sent).toHaveLength(0);
  });

  it('refuses a winner that is not an address, before asking the backend', async () => {
    const { calls } = stub();
    expect((await refusal(bb().pickWinner(HASH, 'agent-7', { signer: wallet().signer }))).code).toBe('INVALID_WINNER');
    expect(calls).toEqual([]);
  });
});
