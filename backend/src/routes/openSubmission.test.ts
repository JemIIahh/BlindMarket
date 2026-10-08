import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

/**
 * The open-submission routes (routes/openSubmission.ts): an agent submits,
 * the poster and verifier read the submissions, the poster picks. Each route
 * checks the escrow's rules first, so nobody is handed a transaction that
 * reverts, and results stay hidden from other agents until the deadline.
 * The real openSubmissionStore runs on an in-memory Redis.
 */

const POSTER = '0x' + 'a'.repeat(40);
const POSTER_OTHER_WALLET = '0x' + 'b'.repeat(40);
const VERIFIER = '0x' + 'c'.repeat(40);
const AGENT = '0x' + '1'.repeat(40);
const AGENT2 = '0x' + '2'.repeat(40);
const HASH = '0x' + 'ab'.repeat(32);
/** The on-chain task the store keys by. */
const REF = 'arc:7';
const NOW = Math.floor(Date.now() / 1000);

const flag = vi.hoisted(() => ({ on: true }));
vi.mock('../config.js', () => ({ config: { get openSubmissionEnabled() { return flag.on; } } }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!req.headers['x-test-address']) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });
      return;
    }
    const address = req.headers['x-test-address'];
    const extra = req.headers['x-test-addresses'];
    req.user = { address, ...(extra ? { addresses: [address, ...String(extra).split(',')] } : {}) };
    next();
  },
}));

const mem = vi.hoisted(() => ({ kv: new Map<string, string>(), ttl: new Map<string, number>(), hashes: new Map<string, Map<string, string>>(), zsets: new Map<string, Map<string, number>>() }));
vi.mock('../services/redis.js', () => {
  const h = (k: string) => {
    const m = mem.hashes.get(k) ?? new Map<string, string>();
    mem.hashes.set(k, m);
    return m;
  };
  return {
    redis: {
      get: async (k: string) => mem.kv.get(k) ?? null,
      // Honours NX, and records EX so the tests can check what lapses.
      set: async (k: string, v: string, ...args: unknown[]) => {
        if (args.includes('NX') && mem.kv.has(k)) return null;
        mem.kv.set(k, v);
        const ex = args.indexOf('EX');
        if (ex >= 0) mem.ttl.set(k, Number(args[ex + 1]));
        return 'OK';
      },
      del: async (k: string) => (mem.kv.delete(k) ? 1 : 0),
      hset: async (k: string, f: string, v: string) => { h(k).set(f, v); return 1; },
      hsetnx: async (k: string, f: string, v: string) => (h(k).has(f) ? 0 : (h(k).set(f, v), 1)),
      hget: async (k: string, f: string) => h(k).get(f) ?? null,
      hmget: async (k: string, ...fs: string[]) => fs.map((f) => h(k).get(f) ?? null),
      hlen: async (k: string) => h(k).size,
      expire: async () => 1,
      zadd: async (k: string, score: number, m: string) => { const z = mem.zsets.get(k) ?? new Map<string, number>(); mem.zsets.set(k, z); z.set(m, score); return 1; },
      zrem: async (k: string, m: string) => (mem.zsets.get(k)?.delete(m) ? 1 : 0),
      zscore: async (k: string, m: string) => (mem.zsets.get(k)?.has(m) ? String(mem.zsets.get(k)!.get(m)) : null),
      zcard: async (k: string) => mem.zsets.get(k)?.size ?? 0,
      zremrangebyscore: async (k: string, _min: string, max: number) => {
        let n = 0;
        for (const [m, sc] of mem.zsets.get(k) ?? []) if (sc <= max) { mem.zsets.get(k)!.delete(m); n++; }
        return n;
      },
      // Pages of one entry, so paging is exercised.
      hscan: async (k: string, cursor: string) => {
        const entries = [...h(k).entries()];
        const i = Number(cursor);
        const next = i + 1 < entries.length ? String(i + 1) : '0';
        return [next, entries[i] ? [...entries[i]] : []];
      },
    },
  };
});

// The wallet budget is a token bucket (middleware/rateLimit.ts, tested there):
// a pass-through here, so many calls from one test wallet are not refused.
const walletBudget = vi.hoisted(() => vi.fn((_opts: { name: string; perMinute: number }) => (_req: unknown, _res: unknown, next: () => void) => next()));
vi.mock('../middleware/rateLimit.js', () => ({ createWalletBudget: walletBudget }));

const a2a = vi.hoisted(() => ({
  getMeta: vi.fn(),
  getState: vi.fn(),
  getVerifierTasks: vi.fn(async (_address: string) => [] as unknown[]),
  // The public view hides the answer key (a2aStore.projectCriteria).
  projectPublicMeta: (meta: any) => {
    const { verificationCriteria, ...rest } = meta;
    if (!verificationCriteria) return rest;
    const { expected_answer: _key, ...criteria } = verificationCriteria;
    return { ...rest, verificationCriteria: criteria };
  },
}));
vi.mock('../services/a2aStore.js', () => a2a);
const agents = vi.hoisted(() => ({ getAgent: vi.fn() }));
vi.mock('../services/agentStore.js', () => agents);
const escrow = vi.hoisted(() => ({ openPhase: vi.fn(), submissionOf: vi.fn(), paused: vi.fn() }));
const builders = vi.hoisted(() => ({
  buildSubmitOpenOn: vi.fn(async (_c: string, from: string, taskId: number, evidenceHash: string) => ({ to: '0xescrow', from, data: `submitOpen(${taskId},${evidenceHash})` })),
  buildSelectWinnerOn: vi.fn(async (_c: string, from: string, taskId: number, winner: string, scorecard: string) => ({ to: '0xescrow', from, data: `selectWinner(${taskId},${winner},${scorecard})` })),
  buildSelectWinnerByVerifierOn: vi.fn(async (_c: string, from: string, taskId: number, winner: string, scorecard: string) => ({ to: '0xescrow', from, data: `selectWinnerByVerifier(${taskId},${winner},${scorecard})` })),
  getTaskOn: vi.fn(async () => ({ agent: POSTER }) as { agent: string }),
  getTaskVerifierOn: vi.fn(async () => VERIFIER),
}));
vi.mock('../services/escrow.js', () => ({ escrowFor: () => escrow, ...builders }));
vi.mock('../services/taskChain.js', () => ({ resolveCachedTaskByHash: vi.fn(async () => ({ chain: 'arc', taskId: '7' })) }));
// Bare chain keys, so refs read 'arc:7' (openSubmissionStore.test.ts checks the network-scoped form).
vi.mock('../services/chainScope.js', () => ({ chainScope: (chain: string) => chain, onCurrentNetwork: (meta: any) => meta.chainId !== 1 }));
const sameOwner = vi.hoisted(() => vi.fn(async () => false));
const ownAgent = vi.hoisted(() => vi.fn(async (_agent: string, _owners: Iterable<string>) => false));
vi.mock('../services/delegationGuard.js', () => ({ sameOwnerSubtask: sameOwner, ownAgentOf: ownAgent }));
vi.mock('../services/openSubmissionSweep.js', () => ({
  PHASE: { Submissions: 0, CreatorPick: 1, VerifierPick: 2, BackupPick: 3, AdminResolve: 4, Closed: 5 },
}));

const { openSubmissionRouter, MAX_RESULT_BYTES, MAX_SCORECARD_BYTES, openEvidenceHash, scorecardHashOf } = await import('./openSubmission.js');
// Made at import, before any beforeEach clears the mocks.
const budgetsMade = [...walletBudget.mock.calls];
const { globalErrorHandler } = await import('../middleware/errorHandler.js');
const store = await import('../services/openSubmissionStore.js');

function app() {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use('/api/v1/a2a', openSubmissionRouter);
  a.use(globalErrorHandler);
  return a;
}
const as = (who: string, extra?: string) => ({ 'x-test-address': who, ...(extra ? { 'x-test-addresses': extra } : {}) });
const submit = (who: string, resultData: Record<string, unknown> = { output: `work of ${who}` }) =>
  request(app()).post(`/api/v1/a2a/tasks/${HASH}/submit-open`).set(as(who)).send({ resultData, rootHash: null });
const list = (who: string, query = '', extra?: string) =>
  request(app()).get(`/api/v1/a2a/tasks/${HASH}/submissions${query}`).set(as(who, extra));
const select = (who: string, winner: string, extra?: string) =>
  request(app()).post(`/api/v1/a2a/tasks/${HASH}/select`).set(as(who, extra)).send({ winner });

const openMeta = (over: Record<string, unknown> = {}) => ({
  taskId: HASH, posterAddress: POSTER, verifierAddress: VERIFIER, deadline: NOW + 3600,
  submissionMode: 'open', openPick: { mode: 'creator', creatorWindow: 86_400 }, privacy: 'public', ...over,
});
// The submit() helper sends rootHash null.
const evidence = (resultData: Record<string, unknown>, rootHash: string | null = null) => openEvidenceHash(resultData, rootHash);
/** The indexer recording an on-chain submission, and keeping its result if the hash matches. */
async function onChain(who: string, resultData: Record<string, unknown>, ordinal = 1) {
  await store.recordSubmission(REF, who, { evidenceHash: evidence(resultData), ordinal, recordedAt: new Date().toISOString() });
  await store.keepResult(REF, who, evidence(resultData));
}
const pending = (who: string) => mem.kv.get(`a2a:open:pending:${REF}:${who}`);

beforeEach(() => {
  vi.clearAllMocks();
  flag.on = true;
  mem.kv.clear();
  mem.hashes.clear();
  mem.zsets.clear();
  a2a.getMeta.mockResolvedValue(openMeta());
  a2a.getState.mockResolvedValue({ taskId: HASH, status: 'collecting' });
  agents.getAgent.mockResolvedValue({ address: AGENT });
  escrow.openPhase.mockResolvedValue(0n);
  escrow.submissionOf.mockResolvedValue(ethers.ZeroHash);
  escrow.paused.mockResolvedValue(false);
  builders.getTaskOn.mockResolvedValue({ agent: POSTER });
  builders.getTaskVerifierOn.mockResolvedValue(VERIFIER);
  a2a.getVerifierTasks.mockResolvedValue([]);
  mem.ttl.clear();
  sameOwner.mockResolvedValue(false);
  ownAgent.mockResolvedValue(false);
});

describe('limits', () => {
  it('gives submit-open and select per-wallet budgets', () => {
    expect(budgetsMade).toEqual([[{ name: 'submissions', perMinute: 20 }], [{ name: 'picks', perMinute: 10 }], [{ name: 'scorecards', perMinute: 10 }]]);
  });
});

describe('openEvidenceHash', () => {
  // The same vector is pinned in agents/open-submission.test.ts: the worker
  // checks the submitOpen it signs against its own copy of this hash.
  it('is keccak256 of the JSON of the resultData and the storage pointer', () => {
    const resultData = { output: 'Done: the summary — 3 points ✓', agent: 'agent-7' };
    expect(openEvidenceHash(resultData, `0x${'ab'.repeat(32)}`)).toBe('0xf0c7c9b0b9ccb46409e4e35bc30f9aa94ecab88e24a57c256fff5535caa82839');
    expect(openEvidenceHash(resultData, null)).toBe('0x1b701a666ac7fbd05539f4c0fceac47f1793c207bca36cf5f85d514872767439');
  });
});

describe('the flag', () => {
  it('hides every route while open submission is off, signed in or not', async () => {
    flag.on = false;
    expect((await submit(AGENT)).status).toBe(404);
    expect((await list(POSTER)).status).toBe(404);
    expect((await select(POSTER, AGENT)).status).toBe(404);
    expect((await request(app()).get(`/api/v1/a2a/tasks/${HASH}/submissions`)).status).toBe(404);
  });
});

describe('POST /tasks/:id/submit-open', () => {
  it('holds the result and hands back submitOpen with its evidence hash, for the caller to sign', async () => {
    const res = await submit(AGENT, { output: 'haiku' });
    expect(res.status).toBe(200);
    expect(res.body.data.evidenceHash).toBe(evidence({ output: 'haiku' }));
    expect(res.body.data.unsignedSubmitOpen).toMatchObject({ from: AGENT, data: `submitOpen(7,${evidence({ output: 'haiku' })})` });
    expect(res.body.data.resultHeldForSec).toBe(3600);
    // Held, not kept: kept only once the on-chain submission carries its hash.
    expect(JSON.parse(pending(AGENT)!)).toMatchObject({ resultData: { output: 'haiku' } });
    expect((await store.getResults(REF, [AGENT]))[0]).toBeNull();
  });

  it('lets an agent replace its result until its submission is on-chain, then refuses a second', async () => {
    await submit(AGENT, { output: 'draft' });
    await submit(AGENT, { output: 'final' });
    expect(JSON.parse(pending(AGENT)!).resultData).toEqual({ output: 'final' });
    // The escrow decides, not the indexer, which may lag.
    escrow.submissionOf.mockResolvedValue(evidence({ output: 'final' }));
    const res = await submit(AGENT, { output: 'third' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_SUBMITTED');
    expect(JSON.parse(pending(AGENT)!).resultData).toEqual({ output: 'final' });
  });

  it('keeps a re-sent result whose hold lapsed, when the escrow already holds its hash', async () => {
    // The indexer missed the hour (an outage); the agent sends the same result again.
    escrow.submissionOf.mockResolvedValue(evidence({ output: 'final' }));
    const res = await submit(AGENT, { output: 'final' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ alreadyOnChain: true, kept: true });
    expect(res.body.data.unsignedSubmitOpen).toBeUndefined();
    expect((await store.getResults(REF, [AGENT]))[0]?.resultData).toEqual({ output: 'final' });
    // A different result is not the committed one.
    expect((await submit(AGENT, { output: 'other' })).body.error.code).toBe('ALREADY_SUBMITTED');
    // And a kept result is never replaced.
    await submit(AGENT, { output: 'final' });
    expect((await store.getResults(REF, [AGENT]))[0]?.resultData).toEqual({ output: 'final' });
  });

  it('commits the storage pointer too: the same resultData with another rootHash is another submission', async () => {
    const ROOT_A = '0x' + 'aa'.repeat(32);
    const ROOT_B = '0x' + 'bb'.repeat(32);
    expect(evidence({ output: 'x' }, ROOT_A)).not.toBe(evidence({ output: 'x' }, ROOT_B));
    expect(evidence({ output: 'x' }, ROOT_A)).toBe(ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ resultData: { output: 'x' }, rootHash: ROOT_A }))));
    // On-chain with a placeholder and no pointer; after the deadline, the
    // same resultData with a pointer to a copied result is refused.
    escrow.submissionOf.mockResolvedValue(evidence({ summary: 'see storage' }, null));
    escrow.openPhase.mockResolvedValue(1n);
    const res = await request(app()).post(`/api/v1/a2a/tasks/${HASH}/submit-open`).set(as(AGENT))
      .send({ resultData: { summary: 'see storage' }, rootHash: ROOT_B });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ALREADY_SUBMITTED');
    expect((await store.getResults(REF, [AGENT]))[0]).toBeNull();
  });

  it('keeps no attestation through the recovery path: it is not in the commitment', async () => {
    escrow.submissionOf.mockResolvedValue(evidence({ output: 'final' }));
    await request(app()).post(`/api/v1/a2a/tasks/${HASH}/submit-open`).set(as(AGENT))
      .send({ resultData: { output: 'final' }, rootHash: null, teeAttestation: { signature: 'sig', signedText: 'claimed later' } });
    const kept = (await store.getResults(REF, [AGENT]))[0];
    expect(kept?.resultData).toEqual({ output: 'final' });
    expect(kept?.teeAttestation).toBeUndefined();
  });

  it('caps how many results one wallet holds at once, across tasks', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    for (let t = 0; t < 10; t++) expect(await store.takeHeldSlot(AGENT, `arc:${100 + t}`, nowSec)).toBe(true);
    // Re-sending for a task it already holds reuses that slot.
    expect(await store.takeHeldSlot(AGENT, 'arc:100', nowSec)).toBe(true);
    const res = await submit(AGENT);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_HELD');
    // An hour later the holds have lapsed.
    expect(await store.takeHeldSlot(AGENT, REF, nowSec + 3601)).toBe(true);
  });

  it("refuses the task's on-chain poster even when another wallet listed it", async () => {
    builders.getTaskOn.mockResolvedValue({ agent: AGENT2 });
    expect((await submit(AGENT2)).body.error.code).toBe('SELF_SUBMIT');
  });

  it("refuses the poster's own hosted agent, and while the escrow is paused", async () => {
    ownAgent.mockResolvedValueOnce(true);
    expect((await submit(AGENT)).body.error.code).toBe('OWN_AGENT');
    expect(ownAgent).toHaveBeenCalledWith(AGENT, [POSTER, POSTER]);
    escrow.paused.mockResolvedValueOnce(true);
    expect((await submit(AGENT)).body.error.code).toBe('ESCROW_PAUSED');
  });

  it.each([
    ['the poster', POSTER, 'SELF_SUBMIT'],
    ["the task's verifier", VERIFIER, 'IS_VERIFIER'],
  ])('refuses %s', async (_who, address, code) => {
    const res = await submit(address);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(code);
  });

  it('refuses an unregistered agent, and one with the same owner as the poster', async () => {
    agents.getAgent.mockResolvedValueOnce(undefined);
    expect((await submit(AGENT)).body.error.code).toBe('NOT_REGISTERED');
    sameOwner.mockResolvedValueOnce(true);
    expect((await submit(AGENT)).body.error.code).toBe('SAME_OWNER');
  });

  it('refuses once the deadline has passed on-chain, but not while a pause keeps submissions open', async () => {
    a2a.getMeta.mockResolvedValue(openMeta({ deadline: NOW - 60 }));
    escrow.openPhase.mockResolvedValue(1n);
    expect((await submit(AGENT)).body.error.code).toBe('DEADLINE_REACHED');
    escrow.openPhase.mockResolvedValue(0n);
    expect((await submit(AGENT)).status).toBe(200);
  });

  it('refuses a task that no longer takes submissions, and one that is not open', async () => {
    a2a.getState.mockResolvedValueOnce({ taskId: HASH, status: 'completed' });
    expect((await submit(AGENT)).body.error.code).toBe('SUBMISSIONS_CLOSED');
    a2a.getMeta.mockResolvedValueOnce({ taskId: HASH, posterAddress: POSTER });
    expect((await submit(AGENT)).status).toBe(404);
  });

  it('refuses a result over the cap, attestation included: the full result belongs in storage', async () => {
    const res = await submit(AGENT, { output: 'x'.repeat(MAX_RESULT_BYTES) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('RESULT_TOO_LARGE');
    const bigAttestation = await request(app()).post(`/api/v1/a2a/tasks/${HASH}/submit-open`).set(as(AGENT))
      .send({ resultData: { output: 'short' }, teeAttestation: { signature: 's', signedText: 'x'.repeat(MAX_RESULT_BYTES) } });
    expect(bigAttestation.status).toBe(413);
    expect(pending(AGENT)).toBeUndefined();
  });

  it('takes an attestation only in the shape /submit takes it', async () => {
    const res = await request(app()).post(`/api/v1/a2a/tasks/${HASH}/submit-open`).set(as(AGENT))
      .send({ resultData: { output: 'short' }, teeAttestation: { anything: 'goes' } });
    expect(res.status).toBe(400);
  });
});

describe('GET /tasks/:id/submissions', () => {
  beforeEach(async () => {
    await submit(AGENT, { output: 'one' });
    await onChain(AGENT, { output: 'one' }, 1);
    await submit(AGENT2, { output: 'two' });
    // Agent 2 swapped its saved result after sending submitOpen: it no longer matches the chain.
    await onChain(AGENT2, { output: 'two, as sent on-chain' }, 2);
  });

  it('shows the poster every submission, with only the results that match the chain', async () => {
    const pages: any[] = [];
    let cursor = '0';
    do {
      const res = await list(POSTER, `?cursor=${cursor}&limit=1`);
      expect(res.status).toBe(200);
      pages.push(...res.body.data.submissions);
      cursor = res.body.data.cursor;
    } while (cursor !== '0');
    expect(pages.map((s) => [s.submitter, s.result?.resultData ?? null])).toEqual([
      [AGENT, { output: 'one' }],
      [AGENT2, null],
    ]);
  });

  it('lets the verifier read them, and the poster from another of their wallets', async () => {
    expect((await list(VERIFIER)).status).toBe(200);
    expect((await list(POSTER_OTHER_WALLET, '', POSTER)).status).toBe(200);
  });

  it('hides them from everyone else until submissions close, so no agent can copy another', async () => {
    const res = await list(AGENT);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SUBMISSIONS_HIDDEN');
    // Past the stored deadline, but a pause keeps the escrow taking submissions.
    a2a.getMeta.mockResolvedValue(openMeta({ deadline: NOW - 60 }));
    expect((await list(AGENT)).status).toBe(403);
    escrow.openPhase.mockResolvedValue(1n);
    expect((await list(AGENT)).status).toBe(200);
  });
});

describe('POST /tasks/:id/select', () => {
  beforeEach(() => {
    escrow.openPhase.mockResolvedValue(1n);
    escrow.submissionOf.mockImplementation(async (_id: number, who: string) => (who.toLowerCase() === AGENT ? '0x' + '11'.repeat(32) : ethers.ZeroHash));
  });

  it("hands the poster's on-chain wallet selectWinner for an agent that submitted", async () => {
    const res = await select(POSTER_OTHER_WALLET, AGENT, POSTER);
    expect(res.status).toBe(200);
    expect(res.body.data.unsignedSelectWinner).toMatchObject({ from: POSTER, data: `selectWinner(7,${ethers.getAddress(AGENT)},${ethers.ZeroHash})` });
  });

  it('refuses anyone but the poster and the task verifier', async () => {
    const res = await select(AGENT2, AGENT);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_A_JUDGE');
  });

  it('refuses while the escrow is paused: selectWinner would revert', async () => {
    escrow.paused.mockResolvedValueOnce(true);
    expect((await select(POSTER, AGENT)).body.error.code).toBe('ESCROW_PAUSED');
  });

  it("refuses on a task whose verifier picks, outside the poster's window, and for a non-submitter", async () => {
    a2a.getMeta.mockResolvedValueOnce(openMeta({ openPick: { mode: 'agent', creatorWindow: 0 } }));
    expect((await select(POSTER, AGENT)).body.error.code).toBe('VERIFIER_PICKS');
    escrow.openPhase.mockResolvedValueOnce(2n);
    expect((await select(POSTER, AGENT)).body.error.code).toBe('NOT_PICK_WINDOW');
    expect((await select(POSTER, AGENT2)).body.error.code).toBe('NOT_A_SUBMITTER');
  });
});

describe("POST /tasks/:id/select by the task's verifier", () => {
  beforeEach(() => {
    a2a.getMeta.mockResolvedValue(openMeta({ openPick: { mode: 'agent', creatorWindow: 0 } }));
    escrow.openPhase.mockResolvedValue(2n);
    escrow.submissionOf.mockImplementation(async (_id: number, who: string) => (who.toLowerCase() === AGENT ? '0x' + '11'.repeat(32) : ethers.ZeroHash));
  });

  it('hands the on-chain verifier selectWinnerByVerifier in its window', async () => {
    const res = await select(VERIFIER, AGENT);
    expect(res.status).toBe(200);
    expect(res.body.data.unsignedSelectWinnerByVerifier).toMatchObject({ from: VERIFIER, data: `selectWinnerByVerifier(7,${ethers.getAddress(AGENT)},${ethers.ZeroHash})` });
    expect(res.body.data.unsignedSelectWinner).toBeUndefined();
  });

  it('finds the verifier among the caller’s linked wallets', async () => {
    const res = await select(AGENT2, AGENT, VERIFIER);
    expect(res.status).toBe(200);
    expect(res.body.data.unsignedSelectWinnerByVerifier.from).toBe(VERIFIER);
  });

  it('picks after the poster on a task they review, once their window has passed', async () => {
    a2a.getMeta.mockResolvedValue(openMeta());
    expect((await select(VERIFIER, AGENT)).status).toBe(200);
    escrow.openPhase.mockResolvedValueOnce(1n);
    const early = await select(VERIFIER, AGENT);
    expect(early.body.error.code).toBe('NOT_PICK_WINDOW');
    expect(early.body.error.message).toMatch(/poster's pick window/);
  });

  it("gives a caller holding both the poster's and the verifier's wallets the pick whose window is open", async () => {
    a2a.getMeta.mockResolvedValue(openMeta());
    const late = await select(POSTER, AGENT, VERIFIER);
    expect(late.body.data.unsignedSelectWinnerByVerifier.from).toBe(VERIFIER);
    escrow.openPhase.mockResolvedValue(1n);
    const early = await select(POSTER, AGENT, VERIFIER);
    expect(early.body.data.unsignedSelectWinner.from).toBe(POSTER);
  });

  it('goes by the escrow, not the listing: an address the escrow does not name is refused', async () => {
    builders.getTaskVerifierOn.mockResolvedValueOnce(ethers.ZeroAddress);
    expect((await select(VERIFIER, AGENT)).body.error.code).toBe('NOT_A_JUDGE');
  });

  it('refuses after its window, while paused, a non-submitter, and itself', async () => {
    escrow.openPhase.mockResolvedValueOnce(3n);
    expect((await select(VERIFIER, AGENT)).body.error.code).toBe('NOT_PICK_WINDOW');
    escrow.paused.mockResolvedValueOnce(true);
    expect((await select(VERIFIER, AGENT)).body.error.code).toBe('ESCROW_PAUSED');
    expect((await select(VERIFIER, AGENT2)).body.error.code).toBe('NOT_A_SUBMITTER');
    expect((await select(VERIFIER, VERIFIER)).body.error.code).toBe('SELF_PICK');
  });

  it('gives a caller holding both wallets the verifier’s answer outside its window on a task the verifier picks', async () => {
    escrow.openPhase.mockResolvedValue(3n);
    expect((await select(POSTER, AGENT, VERIFIER)).body.error.code).toBe('NOT_PICK_WINDOW');
  });

  it("refuses to pick another wallet of the judge's own account", async () => {
    escrow.submissionOf.mockResolvedValue('0x' + '11'.repeat(32));
    const res = await select(VERIFIER, AGENT2, AGENT2);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SELF_PICK');
  });

  it("refuses an agent owned by any of the judge's wallets (the poster's too)", async () => {
    ownAgent.mockImplementation(async (agent: string, owners: Iterable<string>) => agent.toLowerCase() === AGENT && [...owners].includes(POSTER_OTHER_WALLET));
    expect((await select(VERIFIER, AGENT, POSTER_OTHER_WALLET)).body.error.code).toBe('OWN_AGENT_PICK');
    a2a.getMeta.mockResolvedValue(openMeta());
    escrow.openPhase.mockResolvedValue(1n);
    expect((await select(POSTER, AGENT, POSTER_OTHER_WALLET)).body.error.code).toBe('OWN_AGENT_PICK');
  });

  it("refuses to pick an agent of the judge's own owner", async () => {
    sameOwner.mockImplementation(async (judge: string, agent: string) => judge === VERIFIER && agent.toLowerCase() === AGENT);
    const res = await select(VERIFIER, AGENT);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OWN_AGENT_PICK');
    expect(builders.buildSelectWinnerByVerifierOn).not.toHaveBeenCalled();
  });
});

describe("submit-open and the verifier's own agents", () => {
  it("refuses an agent with the same owner as the task's verifier: it reads every result", async () => {
    sameOwner.mockImplementation(async (judge: string, agent: string) => judge === VERIFIER && agent === AGENT);
    const res = await submit(AGENT);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('VERIFIER_SAME_OWNER');
  });

  it("refuses a caller whose account holds the verifier's or the poster's wallet", async () => {
    const fromLinked = (linked: string) => request(app()).post(`/api/v1/a2a/tasks/${HASH}/submit-open`).set(as(AGENT, linked)).send({ resultData: { output: 'x' }, rootHash: null });
    expect((await fromLinked(VERIFIER)).body.error.code).toBe('IS_VERIFIER');
    expect((await fromLinked(POSTER)).body.error.code).toBe('SELF_SUBMIT');
  });

  it("refuses when another wallet of the caller's account is the verifier's or a hosted poster's owner", async () => {
    const fromLinked = (linked: string) => request(app()).post(`/api/v1/a2a/tasks/${HASH}/submit-open`).set(as(AGENT, linked)).send({ resultData: { output: 'x' }, rootHash: null });
    const OWNER = '0x' + 'd'.repeat(40);
    ownAgent.mockImplementation(async (agent: string, owners: Iterable<string>) => agent === OWNER && [...owners].includes(VERIFIER));
    expect((await fromLinked(OWNER)).body.error.code).toBe('VERIFIER_SAME_OWNER');
    ownAgent.mockResolvedValue(false);
    sameOwner.mockImplementation(async (poster: string, wallet: string) => poster === POSTER && wallet === OWNER);
    expect((await fromLinked(OWNER)).body.error.code).toBe('SAME_OWNER');
  });

  it("refuses a person verifier's own agent too", async () => {
    ownAgent.mockImplementation(async (agent: string, owners: Iterable<string>) => agent === AGENT && [...owners].includes(VERIFIER));
    expect((await submit(AGENT)).body.error.code).toBe('VERIFIER_SAME_OWNER');
  });
});

describe('scorecards', () => {
  const pick = (who: string, body: Record<string, unknown>) =>
    request(app()).post(`/api/v1/a2a/tasks/${HASH}/select`).set(as(who)).send({ winner: AGENT, ...body });
  const scorecard = { winner: AGENT, scores: [{ submitter: AGENT, score: 9, reasons: 'complete' }] };
  const pendingKey = `a2a:open:scorecard-pending:${REF}:task_verifier`;
  const getCard = (who = AGENT2) => request(app()).get(`/api/v1/a2a/tasks/${HASH}/scorecard`).set(as(who));
  const postCard = (card: Record<string, unknown>) => request(app()).post(`/api/v1/a2a/tasks/${HASH}/scorecard`).set(as(AGENT2)).send({ scorecard: card });

  beforeEach(() => {
    a2a.getMeta.mockResolvedValue(openMeta({ openPick: { mode: 'agent', creatorWindow: 0 } }));
    escrow.openPhase.mockResolvedValue(2n);
    escrow.submissionOf.mockImplementation(async (_id: number, who: string) => (who.toLowerCase() === AGENT ? '0x' + '11'.repeat(32) : ethers.ZeroHash));
  });

  it("anchors the scorecard's hash in the pick and holds the scorecard, through the longest pick window", async () => {
    const res = await pick(VERIFIER, { scorecard });
    const hash = scorecardHashOf(scorecard);
    expect(res.status).toBe(200);
    expect(res.body.data.scorecardHash).toBe(hash);
    expect(res.body.data.unsignedSelectWinnerByVerifier.data).toBe(`selectWinnerByVerifier(7,${ethers.getAddress(AGENT)},${hash})`);
    expect(JSON.parse(mem.kv.get(pendingKey)!)).toEqual({ scorecardHash: hash, scorecard });
    expect(mem.ttl.get(pendingKey)).toBe(store.PENDING_SCORECARD_TTL_SEC);
    expect(store.PENDING_SCORECARD_TTL_SEC).toBeGreaterThanOrEqual(7 * 86_400 + 48 * 3600);
  });

  it('holds one per judge: a later pick request replaces it', async () => {
    for (let i = 0; i < 25; i++) await pick(VERIFIER, { scorecard: { ...scorecard, n: i } });
    expect([...mem.kv.keys()].filter((k) => k.includes('scorecard'))).toEqual([pendingKey]);
    expect(JSON.parse(mem.kv.get(pendingKey)!).scorecard.n).toBe(24);
  });

  it('refuses a scorecardHash that is not the scorecard sent, and an oversized scorecard', async () => {
    const mismatch = await pick(VERIFIER, { scorecard, scorecardHash: '0x' + '44'.repeat(32) });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe('SCORECARD_MISMATCH');
    const big = await pick(VERIFIER, { scorecard: { reasons: 'x'.repeat(MAX_SCORECARD_BYTES) } });
    expect(big.status).toBe(413);
    expect([...mem.kv.keys()].some((k) => k.includes('scorecard'))).toBe(false);
  });

  it('holds nothing for a pick that is refused', async () => {
    escrow.openPhase.mockResolvedValueOnce(3n);
    expect((await pick(VERIFIER, { scorecard })).status).toBe(409);
    expect([...mem.kv.keys()].some((k) => k.includes('scorecard'))).toBe(false);
  });

  it('serves the scorecard the escrow anchored once the indexer kept it, and says why when it cannot', async () => {
    expect((await getCard()).body.error.code).toBe('NOT_CLOSED');
    await pick(VERIFIER, { scorecard });
    const hash = scorecardHashOf(scorecard);
    await store.saveOutcome(REF, { kind: 'winner', winner: AGENT, judge: 'task_verifier', scorecardHash: hash });
    expect((await getCard()).body.error.code).toBe('SCORECARD_NOT_SENT');
    expect(await store.keepScorecard(REF, 'task_verifier', hash)).toBe(true);
    const res = await getCard();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ outcome: 'winner', judge: 'task_verifier', winner: AGENT, scorecardHash: hash.toLowerCase(), scorecard });
    expect(mem.ttl.get(`a2a:open:scorecard:${REF}`)).toBe(store.RESULTS_TTL_SEC);
    expect(mem.kv.has(pendingKey)).toBe(false);
  });

  it('says no scorecard was anchored when the pick carried none', async () => {
    await store.saveOutcome(REF, { kind: 'void', judge: 'backup', scorecardHash: ethers.ZeroHash });
    expect((await getCard()).body.error.code).toBe('NO_SCORECARD');
  });

  it('keeps nothing for a hash the held scorecard does not have', async () => {
    await pick(VERIFIER, { scorecard });
    expect(await store.keepScorecard(REF, 'task_verifier', '0x' + '55'.repeat(32))).toBe(false);
    expect(await store.getScorecard(REF)).toBeNull();
  });

  it("takes back a lapsed or a backup judge's scorecard from anyone, checked against the anchored hash", async () => {
    const hash = scorecardHashOf(scorecard);
    expect((await postCard(scorecard)).body.error.code).toBe('NOT_ANCHORED');
    await store.saveOutcome(REF, { kind: 'void', judge: 'backup', scorecardHash: hash });
    const wrong = await postCard({ ...scorecard, forged: true });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('SCORECARD_MISMATCH');
    const ok = await postCard(scorecard);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ scorecardHash: hash, kept: true });
    expect((await getCard()).body.data).toMatchObject({ outcome: 'void', judge: 'backup', scorecard });
    // Kept once: a second send changes nothing.
    expect((await postCard(scorecard)).body.data.kept).toBe(false);
  });
});

describe('GET /open-verifications', () => {
  const listed = (taskId: string, over: Record<string, unknown> = {}, status = 'collecting') => ({
    meta: openMeta({ taskId, openPick: { mode: 'agent', creatorWindow: 0 }, deadline: NOW - 60, verificationCriteria: { min_length: 50, expected_answer: '42' }, ...over }),
    state: { taskId, status },
  });
  const get = (who: string, extra?: string) => request(app()).get('/api/v1/a2a/open-verifications').set(as(who, extra));

  it("lists the caller's tasks in their window, with the full criteria the judge needs", async () => {
    a2a.getVerifierTasks.mockResolvedValue([
      listed('0xmine'),
      listed('0xsingle', { submissionMode: undefined }),
      listed('0xother', { verifierAddress: AGENT2 }),
      listed('0xnotyet', { deadline: NOW + 600 }),
      listed('0xposterfirst', { openPick: { mode: 'creator', creatorWindow: 3600 } }),
      listed('0xlongago', { deadline: NOW - 60 * 86_400 }),
      listed('0xdone', {}, 'completed'),
      listed('0xothernet', { chainId: 1 }),
    ]);
    const res = await get(VERIFIER);
    expect(res.status).toBe(200);
    expect(a2a.getVerifierTasks).toHaveBeenCalledWith(VERIFIER);
    expect(res.body.data.tasks.map((t: any) => t.meta.taskId)).toEqual(['0xmine']);
    const [t] = res.body.data.tasks;
    expect(t.meta.verificationCriteria).toEqual({ min_length: 50, expected_answer: '42' });
    expect(t.onChainTaskId).toBe('7');
    expect(t.window).toEqual({ opensAt: NOW - 60, closesAt: NOW - 60 + 48 * 3600 });
  });

  it('puts live windows first, soonest close first, so the cap never hides one behind a lapsed task', async () => {
    const lapsed = Array.from({ length: 60 }, (_, i) => listed(`0xold${i}`, { deadline: NOW - 3 * 86_400 - i }));
    a2a.getVerifierTasks.mockResolvedValue([...lapsed, listed('0xlater', { deadline: NOW - 60 }), listed('0xsooner', { deadline: NOW - 3600 })]);
    const ids = (await get(VERIFIER)).body.data.tasks.map((t: any) => t.meta.taskId);
    expect(ids).toHaveLength(50);
    expect(ids.slice(0, 3)).toEqual(['0xsooner', '0xlater', '0xold0']);
  });

  it('reads every linked wallet, once per task', async () => {
    a2a.getVerifierTasks.mockImplementation(async (w: string) => (w === VERIFIER ? [listed('0xmine'), listed('0xboth')] : [listed('0xboth')]));
    const res = await get(AGENT2, VERIFIER);
    expect(a2a.getVerifierTasks.mock.calls.map(([w]) => w).sort()).toEqual([AGENT2, VERIFIER].sort());
    expect(res.body.data.tasks.map((t: any) => t.meta.taskId).sort()).toEqual(['0xboth', '0xmine']);
  });

  it('pages: offset, with the total', async () => {
    a2a.getVerifierTasks.mockResolvedValue(Array.from({ length: 60 }, (_, i) => listed(`0x${i}`, { deadline: NOW - 60 - i })));
    const first = (await get(VERIFIER)).body.data;
    const second = (await request(app()).get('/api/v1/a2a/open-verifications?offset=50').set(as(VERIFIER))).body.data;
    expect(first).toMatchObject({ total: 60, offset: 0, limit: 50 });
    const small = (await request(app()).get('/api/v1/a2a/open-verifications?limit=5&offset=55').set(as(VERIFIER))).body.data;
    expect(small).toMatchObject({ offset: 55, limit: 5 });
    expect(small.tasks).toHaveLength(5);
    expect(first.tasks).toHaveLength(50);
    expect(second.tasks).toHaveLength(10);
    expect(new Set([...first.tasks, ...second.tasks].map((t: any) => t.meta.taskId)).size).toBe(60);
  });

  it('lists nothing for an agent that verifies nothing', async () => {
    a2a.getVerifierTasks.mockResolvedValue([listed('0xmine')]);
    expect((await get(AGENT)).body.data.tasks).toEqual([]);
  });

  it('is not there while open submission is off, and needs a signed-in caller', async () => {
    expect((await request(app()).get('/api/v1/a2a/open-verifications')).status).toBe(401);
    flag.on = false;
    expect((await get(VERIFIER)).status).toBe(404);
  });
});
