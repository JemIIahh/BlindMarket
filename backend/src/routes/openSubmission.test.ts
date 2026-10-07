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

const mem = vi.hoisted(() => ({ kv: new Map<string, string>(), hashes: new Map<string, Map<string, string>>(), zsets: new Map<string, Map<string, number>>() }));
vi.mock('../services/redis.js', () => {
  const h = (k: string) => {
    const m = mem.hashes.get(k) ?? new Map<string, string>();
    mem.hashes.set(k, m);
    return m;
  };
  return {
    redis: {
      get: async (k: string) => mem.kv.get(k) ?? null,
      set: async (k: string, v: string) => { mem.kv.set(k, v); return 'OK'; },
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

const a2a = vi.hoisted(() => ({ getMeta: vi.fn(), getState: vi.fn() }));
vi.mock('../services/a2aStore.js', () => a2a);
const agents = vi.hoisted(() => ({ getAgent: vi.fn() }));
vi.mock('../services/agentStore.js', () => agents);
const escrow = vi.hoisted(() => ({ openPhase: vi.fn(), submissionOf: vi.fn(), paused: vi.fn() }));
const builders = vi.hoisted(() => ({
  buildSubmitOpenOn: vi.fn(async (_c: string, from: string, taskId: number, evidenceHash: string) => ({ to: '0xescrow', from, data: `submitOpen(${taskId},${evidenceHash})` })),
  buildSelectWinnerOn: vi.fn(async (_c: string, from: string, taskId: number, winner: string, scorecard: string) => ({ to: '0xescrow', from, data: `selectWinner(${taskId},${winner},${scorecard})` })),
  getTaskOn: vi.fn(async () => ({ agent: POSTER }) as { agent: string }),
}));
vi.mock('../services/escrow.js', () => ({ escrowFor: () => escrow, ...builders }));
vi.mock('../services/taskChain.js', () => ({ resolveCachedTaskByHash: vi.fn(async () => ({ chain: 'arc', taskId: '7' })) }));
const sameOwner = vi.hoisted(() => vi.fn(async () => false));
const ownAgent = vi.hoisted(() => vi.fn(async (_agent: string, _owners: Iterable<string>) => false));
vi.mock('../services/delegationGuard.js', () => ({ sameOwnerSubtask: sameOwner, ownAgentOf: ownAgent }));
vi.mock('../services/openSubmissionSweep.js', () => ({
  PHASE: { Submissions: 0, CreatorPick: 1, VerifierPick: 2, BackupPick: 3, AdminResolve: 4, Closed: 5 },
}));

const { openSubmissionRouter, MAX_RESULT_BYTES } = await import('./openSubmission.js');
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
const evidence = (resultData: Record<string, unknown>) => ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(resultData)));
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
  sameOwner.mockResolvedValue(false);
  ownAgent.mockResolvedValue(false);
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

  it('refuses anyone but the poster', async () => {
    const res = await select(AGENT2, AGENT);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_POSTER');
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
