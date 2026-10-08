import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { z } from 'zod';
import { createHash } from 'node:crypto';

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

import {
  judgeableSubmissions, checkRanking, judgeInRounds, buildScorecard, checkUnsignedSelect, scorecardHashOf,
  sendPick, confirmScorecard, openJudgePassCore, createJudgeState, JUDGE_BATCH, JUDGE_MAX_SUBMISSIONS,
  verifyOpenResults, openEvidenceHash, readCommitments, storedBytesMatch, rankWithModel, isProviderFailure,
  // @ts-expect-error — plain-JS worker, no d.ts
} from './worker.js';

/**
 * Part 4b of open submission (docs/OPEN-SUBMISSION-TASKS.md section 17): a
 * verifier agent judges the open tasks it was named for, in its pick window,
 * and signs selectWinnerByVerifier with an anchored scorecard. These cover
 * what is judged, how a ranking is trusted (fail closed), what is signed, and
 * what happens to a pick the server or the chain turns away.
 */

const iface = new ethers.Interface(JSON.parse(readFileSync(new URL('../src/abi/BlindEscrow.json', import.meta.url), 'utf-8')));
const ESCROW = '0x' + 'e5'.repeat(20);
const JUDGE = ethers.getAddress('0x' + 'a1'.repeat(20));
const SELF = JUDGE.toLowerCase();
const HASH = '0x' + '11'.repeat(32);
const ROOT = '0x' + 'ab'.repeat(32);
const A = '0x' + '01'.repeat(20);
const B = '0x' + '02'.repeat(20);
const C = '0x' + '03'.repeat(20);
const NOW_MS = 1_800_000_000_000;

const sub = (submitter: string, ordinal: number, resultData: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  submitter, ordinal, evidenceHash: '0x01', recordedAt: '', result: resultData === null ? null : { resultData, rootHash: null }, ...extra,
});
const out = (text: string) => ({ output: text });

describe('judgeableSubmissions', () => {
  it('labels readable results in the order given, leaving out unreadable ones with the reason', () => {
    const { candidates, excluded } = judgeableSubmissions([sub(A, 1, out('first')), sub(B, 2, out('second')), sub(C, 3, null)], null);
    expect(candidates.map((c: any) => [c.id, c.submitter, c.output])).toEqual([['S1', A, 'first'], ['S2', B, 'second']]);
    expect(excluded).toEqual([{ submitter: C, why: 'its result could not be read' }]);
  });

  it('reads a result in any shape: its output, else its resultData as JSON, and prefers the stored full result', () => {
    const { candidates } = judgeableSubmissions([
      sub(A, 1, { answer: 'better', confidence: 0.9 }),
      sub(B, 2, out('short'), { storedText: 'the full stored result' }),
    ], null);
    expect(candidates.map((c: any) => c.output)).toEqual(['{"answer":"better","confidence":0.9}', 'the full stored result']);
  });

  it('leaves out a result that does not match its on-chain commitment', () => {
    const { candidates, excluded } = judgeableSubmissions([sub(A, 1, out('swapped'), { mismatch: true }), sub(B, 2, out('fine'))], null);
    expect(candidates.map((c: any) => c.submitter)).toEqual([B]);
    expect(excluded[0]).toEqual({ submitter: A, why: 'its result does not match its on-chain commitment' });
  });

  it("leaves out results that fail the task's checks, unless none pass", () => {
    const criteria = { min_length: 10 };
    const some = judgeableSubmissions([sub(A, 1, out('short')), sub(B, 2, out('long enough here'))], criteria);
    expect(some.candidates.map((c: any) => c.submitter)).toEqual([B]);
    expect(some.excluded[0]).toMatchObject({ submitter: A, why: expect.stringMatching(/failed the task's checks/) });
    expect(judgeableSubmissions([sub(A, 1, out('short')), sub(B, 2, out('tiny'))], criteria).candidates).toHaveLength(2);
  });

  it('cuts a long result and says so to the judge', () => {
    const [c] = judgeableSubmissions([sub(A, 1, out('x'.repeat(10_000)))], null).candidates;
    expect(c.output.length).toBeLessThan(7000);
    expect(c.output).toMatch(/the rest of this submission is not shown/);
  });
});

describe('checkRanking: the judge fails closed', () => {
  const ids = ['S1', 'S2'];
  const scores = [{ id: 'S1', score: 8, reason: 'good' }, { id: 'S2', score: 3, reason: 'thin' }];

  it('accepts every candidate scored once, and the best scored as winner, or none', () => {
    expect(checkRanking({ scores, winner: 'S1' }, ids)).toMatchObject({ winner: 'S1' });
    expect(checkRanking({ scores, winner: null }, ids)).toMatchObject({ winner: null });
    expect(checkRanking({ scores, winner: 'none' }, ids)).toMatchObject({ winner: null });
    expect(checkRanking({ scores: [scores[0], { ...scores[1], score: 8 }], winner: 'S2' }, ids)).toMatchObject({ winner: 'S2' });
  });

  it.each([
    ['a missing candidate', { scores: [scores[0]], winner: 'S1' }],
    ['an extra id', { scores: [...scores, { id: 'S9', score: 1, reason: '' }], winner: 'S1' }],
    ['a duplicate', { scores: [scores[0], scores[0]], winner: 'S1' }],
    ['a score out of range', { scores: [{ ...scores[0], score: 11 }, scores[1]], winner: 'S1' }],
    ['a winner not judged', { scores, winner: 'S3' }],
    ['a winner scored below another', { scores, winner: 'S2' }],
    ['no scores at all', { winner: 'S1' }],
  ])('refuses %s', (_name, object) => {
    expect(checkRanking(object, ids)).toBeNull();
  });
});

describe('judgeInRounds', () => {
  const cands = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `S${i + 1}`, submitter: `0x${i}`, output: `o${i}` }));
  // Picks the last candidate in each batch.
  const rankLast = vi.fn(async (batch: any[]) => ({ winner: batch[batch.length - 1].id, scores: batch.map((c, i) => ({ id: c.id, score: i, reason: '' })) }));
  beforeEach(() => { rankLast.mockClear(); });

  it('ranks one batch once', async () => {
    const res = await judgeInRounds(cands(3), rankLast);
    expect(res.winner.id).toBe('S3');
    expect(rankLast).toHaveBeenCalledTimes(1);
    expect(res.scores).toHaveLength(3);
    expect(res.laterRounds).toEqual([]);
  });

  it('ranks batch winners in batches again: no call ever sees more than a batch', async () => {
    const res = await judgeInRounds(cands(JUDGE_MAX_SUBMISSIONS), rankLast);
    for (const [batch] of rankLast.mock.calls) expect(batch.length).toBeLessThanOrEqual(JUDGE_BATCH);
    // 60 → 10 batch winners → 2 → 1.
    expect(rankLast).toHaveBeenCalledTimes(10 + 2 + 1);
    expect(res.winner.id).toBe(`S${JUDGE_MAX_SUBMISSIONS}`);
    expect(res.scores).toHaveLength(JUDGE_MAX_SUBMISSIONS);
    expect(res.laterRounds.map((r: any[]) => r.length)).toEqual([10, 2]);
  });

  it('fails closed when any ranking fails', async () => {
    const failing = vi.fn(async (batch: any[]) => (batch[0].id === 'S1' ? null : { winner: batch[0].id, scores: [] }));
    expect(await judgeInRounds(cands(JUDGE_BATCH + 1), failing)).toBeNull();
  });

  it('names no winner when a later round finds none acceptable: a decline, not a failure', async () => {
    // Round 1: [S1..S6] → S1, [S7] → S7. Round 2: [S1, S7] → none.
    const noneInFinal = vi.fn(async (batch: any[]) => ({ winner: batch.length === 2 ? null : batch[0].id, scores: [] }));
    const res = await judgeInRounds(cands(JUDGE_BATCH + 1), noneInFinal);
    expect(res).toMatchObject({ winner: null });
    expect(noneInFinal).toHaveBeenCalledTimes(3);
  });

  it('names no winner when no first-round batch has one', async () => {
    const none = vi.fn(async (batch: any[]) => ({ winner: null, scores: batch.map((c) => ({ id: c.id, score: 1, reason: '' })) }));
    expect(await judgeInRounds(cands(JUDGE_BATCH + 1), none)).toMatchObject({ winner: null });
  });
});

describe('buildScorecard', () => {
  const candidates = [{ id: 'S1', submitter: A, output: '' }, { id: 'S2', submitter: B, output: '' }];
  const base = {
    taskHash: HASH, judge: SELF, model: 'm', judgedAt: '2026-10-08T00:00:00.000Z', winner: A, total: 3, candidates,
    scores: [{ id: 'S1', score: 9, reason: 'complete' }, { id: 'S2', score: 4, reason: 'partial' }],
    excluded: [{ submitter: C, why: 'its result could not be read' }],
  };

  it('names every judged submitter by address, the later rounds, and those not judged by reason', () => {
    const card = buildScorecard({ ...base, laterRounds: [[{ id: 'S1', score: 8, reason: 'best overall' }]] });
    expect(card).toMatchObject({ version: 1, task: HASH, winner: A, submissions: 3, judged: 2 });
    expect(card.scores).toEqual([{ submitter: A, score: 9, reason: 'complete' }, { submitter: B, score: 4, reason: 'partial' }]);
    expect(card.laterRounds).toEqual([[{ submitter: A, score: 8, reason: 'best overall' }]]);
    expect(card.notJudged).toEqual([{ why: 'its result could not be read', count: 1, submitters: [C] }]);
  });

  it("hashes the same after the server's parse (JSON, then zod's record)", () => {
    const card = buildScorecard(base);
    expect(scorecardHashOf(z.record(z.unknown()).parse(JSON.parse(JSON.stringify(card))))).toBe(scorecardHashOf(card));
  });

  it('always stays under the 32 KB a scorecard may be, however many were not judged', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `S${i + 1}`, submitter: `0x${String(i).padStart(40, '0')}`, output: '' }));
    // Even 2,000 distinct reasons can't overflow it.
    const excluded = Array.from({ length: 2000 }, (_, i) => ({ submitter: `0x${String(i).padStart(40, '9')}`, why: i % 2 ? 'only the first 60 submissions are judged' : `a reason of its own: ${'z'.repeat(150)} ${i}` }));
    const card = buildScorecard({ ...base, candidates: many, scores: many.map((c) => ({ id: c.id, score: 5, reason: 'r'.repeat(300) })), excluded });
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(30 * 1024);
    expect(card.scores).toHaveLength(60);
    expect(card.notJudged.reduce((n: number, g: any) => n + g.count, 0)).toBe(2000);
  });

  it('never publishes the expected answer in a reason, whatever its case', () => {
    const card = buildScorecard({ ...base, scores: [{ id: 'S1', score: 9, reason: 'says Paris (1.5)' }, { id: 'S2', score: 1, reason: 'said PARIS (1.5) too late' }], expectedAnswer: 'paris (1.5)' });
    expect(JSON.stringify(card).toLowerCase()).not.toContain('paris (1.5)');
  });
});

const SCORECARD = { version: 1, task: HASH, winner: A };
const SC_HASH = scorecardHashOf(SCORECARD);
const unsignedSelect = (over: Record<string, unknown> = {}, args: [bigint, string, string] = [41n, A, SC_HASH]) => ({
  to: ESCROW, data: iface.encodeFunctionData('selectWinnerByVerifier', args), from: JUDGE, chainId: 5042, ...over,
});
const expectSelect = { from: JUDGE, chainId: 5042, escrow: ESCROW, onChainTaskId: '41', winner: A, scorecardHash: SC_HASH };

describe('checkUnsignedSelect', () => {
  it('accepts the pick of this winner with this scorecard, from this wallet', () => {
    expect(checkUnsignedSelect(unsignedSelect(), expectSelect, iface)).toBeNull();
  });

  it.each([
    ['another wallet', unsignedSelect({ from: B }), /not this wallet/],
    ['another chain', unsignedSelect({ chainId: 1 }), /chain 1/],
    ['another contract', unsignedSelect({ to: B }), /not the escrow/],
    ['value', unsignedSelect({ value: '1' }), /sends value/],
    ["the poster's pick", unsignedSelect({ data: iface.encodeFunctionData('selectWinner', [41n, A, SC_HASH]) }), /not a selectWinnerByVerifier/],
    ['another task', unsignedSelect({}, [42n, A, SC_HASH]), /task 42/],
    ['another winner', unsignedSelect({}, [41n, B, SC_HASH]), /not the judged winner/],
    ['another scorecard', unsignedSelect({}, [41n, A, '0x' + '66'.repeat(32)]), /another scorecard/],
  ])('refuses %s', (_name, tx, why) => {
    expect(checkUnsignedSelect(tx, expectSelect, iface)).toMatch(why);
  });

  it('signs nothing when it does not know what to expect', () => {
    expect(checkUnsignedSelect(unsignedSelect(), { ...expectSelect, scorecardHash: undefined }, iface)).toMatch(/does not know/);
  });
});

const task = (over: Record<string, unknown> = {}) => ({
  meta: { taskId: HASH, chain: 'arc', rootHash: ROOT, privacy: 'public', submissionMode: 'open', verificationCriteria: null, ...over },
  onChainTaskId: '41',
});

describe('sendPick', () => {
  const pick = { winner: A, scorecard: SCORECARD };
  let state: any;
  let send: ReturnType<typeof vi.fn>;
  const okSelect = (data: Record<string, unknown> = {}) => vi.fn(async () => ({ status: 200, ok: true, json: { data: { scorecardHash: SC_HASH, unsignedSelectWinnerByVerifier: unsignedSelect(), ...data } } }));
  const io = (over: Record<string, unknown> = {}) => ({
    signer: { address: JUDGE },
    chainId: 5042,
    escrow: ESCROW,
    preflight: vi.fn(async () => null),
    txStatus: vi.fn(async () => 'unknown'),
    send,
    postSelect: okSelect(),
    ...over,
  });
  const refused = (status: number, code: string) => vi.fn(async () => ({ status, ok: false, json: { error: { code } } }));

  beforeEach(() => {
    state = createJudgeState();
    send = vi.fn(async () => ({ hash: '0x' + '77'.repeat(32), wait: async () => ({ blockNumber: 9 }) }));
  });

  it('posts the pick with its scorecard, signs the call rebuilt, and confirms the scorecard next', async () => {
    const deps = io();
    expect(await sendPick(task(), pick, deps, state)).toBe(true);
    expect(deps.postSelect).toHaveBeenCalledWith(HASH, { winner: A, scorecard: SCORECARD });
    expect(send).toHaveBeenCalledWith({ to: ESCROW, data: unsignedSelect().data, chainId: 5042 });
    expect(state.done.get(HASH)).toBe('picked');
    expect(state.confirm.get(HASH)).toEqual({ scorecard: SCORECARD, tries: 0 });
  });

  it("anchors only its own scorecard's hash, whatever the server says it is", async () => {
    const other = '0x' + '66'.repeat(32);
    const deps = io({ postSelect: okSelect({ scorecardHash: other, unsignedSelectWinnerByVerifier: unsignedSelect({}, [41n, A, other]) }) });
    expect(await sendPick(task(), pick, deps, state)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(state.done.get(HASH)).toMatch(/another scorecard/);
  });

  it('never signs a pick that pays someone else', async () => {
    const deps = io({ postSelect: okSelect({ unsignedSelectWinnerByVerifier: unsignedSelect({}, [41n, B, SC_HASH]) }) });
    expect(await sendPick(task(), pick, deps, state)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('stops on a refusal that will stand, and keeps the pick for one that can clear', async () => {
    expect(await sendPick(task(), pick, io({ postSelect: refused(409, 'NOT_PICK_WINDOW') }), state)).toBe(false);
    expect(state.done.get(HASH)).toMatch(/NOT_PICK_WINDOW/);
    const again = createJudgeState();
    expect(await sendPick(task(), pick, io({ postSelect: refused(409, 'ESCROW_PAUSED') }), again)).toBe(false);
    expect(again.picked.get(HASH)).toMatchObject({ winner: A });
    expect(send).not.toHaveBeenCalled();
  });

  it('judges again without a winner the server refuses for this judge (own agent), spending an attempt', async () => {
    expect(await sendPick(task(), pick, io({ postSelect: refused(409, 'OWN_AGENT_PICK') }), state)).toBe(false);
    expect(state.done.has(HASH)).toBe(false);
    expect(state.picked.has(HASH)).toBe(false);
    expect([...state.excluded.get(HASH)]).toEqual([A]);
    expect(state.attempts.get(HASH)).toBe(1);
  });

  it('holds the pick on NOT_A_SUBMITTER: it read the commitment itself, so the server read is stale', async () => {
    expect(await sendPick(task(), pick, io({ postSelect: refused(409, 'NOT_A_SUBMITTER') }), state)).toBe(false);
    expect(state.picked.get(HASH)).toMatchObject({ winner: A });
    expect(state.excluded.has(HASH)).toBe(false);
  });

  it('still confirms the scorecard when a pick it sent closed the window', async () => {
    expect(await sendPick(task(), { ...pick, txHash: '0x88' }, io({ postSelect: refused(409, 'NOT_PICK_WINDOW') }), state)).toBe(false);
    expect(state.done.get(HASH)).toMatch(/NOT_PICK_WINDOW/);
    expect(state.confirm.get(HASH)).toEqual({ scorecard: SCORECARD, tries: 0 });
  });

  it('holds the pick while the wallet cannot pay gas, without posting', async () => {
    const deps = io({ preflight: vi.fn(async () => 'wallet holds 0 USDC') });
    expect(await sendPick(task(), pick, deps, state)).toBe(false);
    expect(deps.postSelect).not.toHaveBeenCalled();
    expect(state.picked.has(HASH)).toBe(true);
  });

  it('looks up a pick sent earlier: pending (or an unreadable lookup) waits, mined is done', async () => {
    const pending = io({ txStatus: vi.fn(async () => 'pending') });
    expect(await sendPick(task(), { ...pick, txHash: '0x88' }, pending, state)).toBe(false);
    expect(pending.postSelect).not.toHaveBeenCalled();
    const broken = io({ txStatus: vi.fn(async () => { throw new Error('rpc down'); }) });
    expect(await sendPick(task(), { ...pick, txHash: '0x88' }, broken, createJudgeState())).toBe(false);
    expect(broken.postSelect).not.toHaveBeenCalled();
    const mined = io({ txStatus: vi.fn(async () => 'mined') });
    const s2 = createJudgeState();
    expect(await sendPick(task(), { ...pick, txHash: '0x88' }, mined, s2)).toBe(true);
    expect(s2.confirm.has(HASH)).toBe(true);
  });

  it('still confirms the scorecard when a re-send reverts because an earlier pick closed the window', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('reverted'), { data: iface.encodeErrorResult('WrongPhase', [5]) }));
    expect(await sendPick(task(), { ...pick, txHash: '0x88' }, io(), state)).toBe(false);
    expect(state.done.get(HASH)).toMatch(/WrongPhase/);
    expect(state.confirm.has(HASH)).toBe(true);
  });

  it('stops on a final revert and keeps the hash of one that may still land', async () => {
    send.mockRejectedValueOnce(Object.assign(new Error('reverted'), { data: iface.encodeErrorResult('WrongPhase', [3]) }));
    expect(await sendPick(task(), pick, io(), state)).toBe(false);
    expect(state.done.get(HASH)).toMatch(/WrongPhase/);
    const s2 = createJudgeState();
    send.mockRejectedValueOnce(Object.assign(new Error('connection reset'), { txHash: '0x' + '99'.repeat(32) }));
    expect(await sendPick(task(), pick, io(), s2)).toBe(false);
    expect(s2.picked.get(HASH).txHash).toBe('0x' + '99'.repeat(32));
  });
});

describe('confirmScorecard', () => {
  const card = { version: 1 };
  it('is done once the server serves it, sends it when the server does not hold it, and waits for the indexer', async () => {
    expect(await confirmScorecard(HASH, card, { getScorecard: async () => ({ ok: true }) })).toBe('kept');
    const post = vi.fn(async () => ({ ok: true }));
    expect(await confirmScorecard(HASH, card, { getScorecard: async () => ({ ok: false, json: { error: { code: 'SCORECARD_NOT_SENT' } } }), postScorecard: post })).toBe('kept');
    expect(post).toHaveBeenCalledWith(HASH, card);
    const lag = vi.fn();
    expect(await confirmScorecard(HASH, card, { getScorecard: async () => ({ ok: false, json: { error: { code: 'NOT_CLOSED' } } }), postScorecard: lag })).toBe('retry');
    expect(lag).not.toHaveBeenCalled();
  });
});

describe('openJudgePassCore', () => {
  const subs = [sub(A, 1, out('answer A')), sub(B, 2, out('answer B'))];
  const chain = (over: Record<string, unknown> = {}) => vi.fn(async () => ({ taskHash: HASH, verifier: JUDGE, phase: 2n, submissionCount: 2n, ...over }));
  const deps = (over: Record<string, unknown> = {}) => ({
    fetchList: vi.fn(async () => [task()]),
    confirmScorecard: vi.fn(async () => 'kept'),
    busy: () => false,
    chainProblem: () => null,
    readOnChain: chain(),
    sendPick: vi.fn(async () => true),
    decline: vi.fn(async () => {}),
    inferenceBlocker: () => null,
    preflight: vi.fn(async () => null),
    crashCheck: () => null,
    fetchSubmissions: vi.fn(async () => subs),
    readCommitments: vi.fn(async (_t: unknown, list: any[]) => list.map((x) => ({ ...x, committed: '0x' + 'c0'.repeat(32) }))),
    verifyResults: vi.fn(async (_t: unknown, list: any[]) => list),
    readBrief: vi.fn(async () => 'the brief'),
    rank: vi.fn(async (_ctx: unknown, batch: any[]) => ({ winner: batch[batch.length - 1].id, scores: batch.map((c, i) => ({ id: c.id, score: i, reason: 'ok' })) })),
    inFlight: vi.fn(),
    self: SELF,
    model: 'm',
    nowMs: () => NOW_MS,
    ...over,
  });

  it('judges a task in its window and sends the pick with its scorecard', async () => {
    const d = deps();
    const state = createJudgeState();
    expect(await openJudgePassCore(d, state)).toBe('judged');
    expect(d.verifyResults).toHaveBeenCalled();
    expect(d.rank).toHaveBeenCalledWith({ brief: 'the brief', criteria: null }, expect.any(Array));
    const [, pick] = d.sendPick.mock.calls[0];
    expect(pick.winner).toBe(B);
    expect(pick.scorecard).toMatchObject({ task: HASH, judge: SELF, winner: B, submissions: 2, judged: 2 });
    expect(d.inFlight.mock.calls).toEqual([['task-started', HASH], ['task-finished', HASH, true]]);
  });

  it("won't judge when the listed id is another task, or this agent isn't its on-chain verifier", async () => {
    const wrongTask = createJudgeState();
    await openJudgePassCore(deps({ readOnChain: chain({ taskHash: '0x' + '22'.repeat(32) }) }), wrongTask);
    expect(wrongTask.done.get(HASH)).toMatch(/another task/);
    const notMine = createJudgeState();
    const d = deps({ readOnChain: chain({ verifier: B }) });
    await openJudgePassCore(d, notMine);
    expect(notMine.done.get(HASH)).toMatch(/not its on-chain verifier/);
    expect(d.rank).not.toHaveBeenCalled();
  });

  it('does nothing before its window and is done after it, unless a sent pick may have landed', async () => {
    const early = deps({ readOnChain: chain({ phase: 1n }) });
    expect(await openJudgePassCore(early, createJudgeState())).toBe('none');
    expect(early.fetchSubmissions).not.toHaveBeenCalled();
    const after = createJudgeState();
    after.picked.set(HASH, { task: task(), winner: A, scorecard: {} });
    await openJudgePassCore(deps({ readOnChain: chain({ phase: 5n }) }), after);
    expect(after.done.get(HASH)).toMatch(/window has passed/);
    const sentLate = createJudgeState();
    sentLate.picked.set(HASH, { task: task(), winner: A, scorecard: {}, txHash: '0x88' });
    const d = deps({ readOnChain: chain({ phase: 5n }) });
    await openJudgePassCore(d, sentLate);
    expect(d.sendPick).toHaveBeenCalledWith(task(), expect.objectContaining({ txHash: '0x88' }));
  });

  it('sends a pick it already judged, with no new model run', async () => {
    const state = createJudgeState();
    const held = { task: task(), winner: A, scorecard: SCORECARD };
    state.picked.set(HASH, held);
    const d = deps();
    expect(await openJudgePassCore(d, state)).toBe('sent');
    expect(d.sendPick).toHaveBeenCalledWith(task(), expect.objectContaining({ winner: A, scorecard: SCORECARD, lastTriedAt: NOW_MS }));
    expect(d.rank).not.toHaveBeenCalled();
  });

  it('sends held picks while the model is down or paid work waits: they need no model call', async () => {
    const other = '0x' + '44'.repeat(32);
    const both = () => vi.fn(async () => [task({ taskId: other }), task()]);
    const onChainOf = vi.fn(async (t: any) => ({ taskHash: t.meta.taskId, verifier: JUDGE, phase: 2n, submissionCount: 2n }));
    for (const blocked of [{ inferenceBlocker: () => 'quota spent' }, { busy: () => true }]) {
      const state = createJudgeState();
      state.picked.set(HASH, { task: task(), winner: A, scorecard: SCORECARD });
      const d = deps({ fetchList: both(), readOnChain: onChainOf, ...blocked });
      await openJudgePassCore(d, state);
      expect(d.sendPick).toHaveBeenCalledWith(task(), expect.objectContaining({ winner: A }));
      expect(d.rank).not.toHaveBeenCalled();
    }
  });

  it('sends at most 8 held picks a pass, the longest waiting first', async () => {
    const hashes = Array.from({ length: 10 }, (_, i) => `0x${String(i).padStart(2, '0').repeat(32)}`);
    const state = createJudgeState();
    hashes.forEach((h, i) => state.picked.set(h, { task: task({ taskId: h }), winner: A, scorecard: {}, lastTriedAt: 1000 - i }));
    const d = deps({
      fetchList: vi.fn(async () => hashes.map((h) => task({ taskId: h }))),
      readOnChain: vi.fn(async (t: any) => ({ taskHash: t.meta.taskId, verifier: JUDGE, phase: 2n, submissionCount: 1n })),
    });
    await openJudgePassCore(d, state);
    const sentIds = d.sendPick.mock.calls.map(([t]: any[]) => t.meta.taskId);
    expect(sentIds).toHaveLength(8);
    expect(sentIds[0]).toBe(hashes[9]); // tried longest ago
    expect(sentIds).not.toContain(hashes[0]);
    expect(sentIds).not.toContain(hashes[1]);
  });

  it('takes a list far longer than the escrow count for padding, and waits', async () => {
    const padded = Array.from({ length: 60 }, (_, i) => sub(`0x${String(i + 1).padStart(40, '0')}`, i + 1, out('x')));
    const d = deps({ fetchSubmissions: vi.fn(async () => padded), readOnChain: chain({ submissionCount: 2n }) });
    const state = createJudgeState();
    await openJudgePassCore(d, state);
    expect(d.readCommitments).not.toHaveBeenCalled();
    expect(state.retryAt.get(HASH)).toBeGreaterThan(NOW_MS);
  });

  it('waits a few passes on storage that keeps failing, then judges without that result', async () => {
    const state = createJudgeState();
    const verifyResults = vi.fn(async (_t: unknown, list: any[], opts: any) => {
      if (!opts.giveUpOnStorage) throw new Error('storage download 503');
      return list;
    });
    const d = deps({ verifyResults });
    for (let i = 0; i < 3; i++) {
      state.retryAt.clear();
      await openJudgePassCore(d, state);
    }
    expect(d.rank).not.toHaveBeenCalled();
    expect(state.storageWaits.get(HASH)).toBe(3);
    state.retryAt.clear();
    expect(await openJudgePassCore(d, state)).toBe('judged');
    expect(verifyResults.mock.calls[3][2]).toEqual({ giveUpOnStorage: true });
    expect(d.rank).toHaveBeenCalled();
  });

  it('judges a task through once it has yielded to paid work three times in a row', async () => {
    const many = Array.from({ length: JUDGE_BATCH + 2 }, (_, i) => sub(`0x${String(i + 1).padStart(40, '0')}`, i + 1, out(`w${i}`)));
    const state = createJudgeState();
    state.yields.set(HASH, 3);
    let calls = 0;
    const d = deps({ fetchSubmissions: vi.fn(async () => many), readOnChain: chain({ submissionCount: BigInt(many.length) }), busy: () => calls++ > 0 });
    expect(await openJudgePassCore(d, state)).toBe('judged');
    expect(state.yields.has(HASH)).toBe(false);
  });

  it('never lets a held pick block the other tasks: it sends it and judges the next', async () => {
    const other = '0x' + '44'.repeat(32);
    const state = createJudgeState();
    state.picked.set(HASH, { task: task(), winner: A, scorecard: SCORECARD });
    const d = deps({
      fetchList: vi.fn(async () => [task(), task({ taskId: other })]),
      readOnChain: vi.fn(async (t: any) => ({ taskHash: t.meta.taskId, verifier: JUDGE, phase: 2n, submissionCount: 2n })),
    });
    expect(await openJudgePassCore(d, state)).toBe('judged');
    expect(d.sendPick.mock.calls.map(([t]: any[]) => t.meta.taskId)).toEqual([HASH, other]);
    expect(d.rank).toHaveBeenCalled();
  });

  it('drops a made-up submission (no on-chain commitment) and waits when the real ones fall short', async () => {
    const padded = [...subs, sub(C, 3, null)];
    const d = deps({
      fetchSubmissions: vi.fn(async () => padded),
      readOnChain: chain({ submissionCount: 3n }),
      readCommitments: vi.fn(async (_t: unknown, list: any[]) => list.map((x) => ({ ...x, committed: x.submitter === C ? ethers.ZeroHash : '0x' + 'c0'.repeat(32) }))),
    });
    const state = createJudgeState();
    await openJudgePassCore(d, state);
    expect(d.rank).not.toHaveBeenCalled();
    expect(state.retryAt.get(HASH)).toBeGreaterThan(NOW_MS);
  });

  it('waits rather than judge on a summary when a stored result cannot be read', async () => {
    const d = deps({ verifyResults: vi.fn(async () => { throw new Error('storage 503'); }) });
    const state = createJudgeState();
    await openJudgePassCore(d, state);
    expect(d.rank).not.toHaveBeenCalled();
    expect(state.retryAt.get(HASH)).toBeGreaterThan(NOW_MS);
    expect(state.attempts.has(HASH)).toBe(false);
  });

  it('charges a crash to the task from the moment it reads its submissions', async () => {
    const d = deps({ fetchSubmissions: vi.fn(async () => null) });
    await openJudgePassCore(d, createJudgeState());
    expect(d.inFlight.mock.calls).toEqual([['task-started', HASH], ['task-finished', HASH, false]]);
  });

  it('stops judging for paid work that arrives mid-way, without spending an attempt (counted as a yield)', async () => {
    let calls = 0;
    const many = Array.from({ length: JUDGE_BATCH + 2 }, (_, i) => sub(`0x${String(i + 1).padStart(40, '0')}`, i + 1, out(`w${i}`)));
    const d = deps({
      fetchSubmissions: vi.fn(async () => many),
      readOnChain: chain({ submissionCount: BigInt(many.length) }),
      busy: () => calls++ > 0, // free at the start, busy once judging began
    });
    const state = createJudgeState();
    expect(await openJudgePassCore(d, state)).toBe('busy');
    expect(state.attempts.has(HASH)).toBe(false);
    expect(state.yields.get(HASH)).toBe(1);
    expect(d.sendPick).not.toHaveBeenCalled();
    expect(d.inFlight).toHaveBeenLastCalledWith('task-finished', HASH, false);
  });

  it('lets a sent pick of a settled task go after its lookups, and forgets gone tasks on a full list', async () => {
    const state = createJudgeState();
    const gone = '0x' + '55'.repeat(32);
    state.picked.set(gone, { task: task({ taskId: gone }), winner: A, scorecard: {}, txHash: '0x88', lookups: 24 });
    state.done.set('0xold', 'picked');
    await openJudgePassCore(deps({ fetchList: vi.fn(async () => ({ tasks: [], complete: true })) }), state);
    expect(state.picked.has(gone)).toBe(false);
    expect(state.done.has('0xold')).toBe(false);
    const partial = createJudgeState();
    partial.done.set('0xold', 'picked');
    await openJudgePassCore(deps({ fetchList: vi.fn(async () => ({ tasks: [], complete: false })) }), partial);
    expect(partial.done.has('0xold')).toBe(true);
  });

  it('looks up a sent pick whose task left the list, and forgets one never sent', async () => {
    const state = createJudgeState();
    const other = '0x' + '33'.repeat(32);
    state.picked.set(other, { task: task({ taskId: other }), winner: A, scorecard: {}, txHash: '0x88' });
    state.picked.set('0xunsent', { task: task({ taskId: '0xunsent' }), winner: A, scorecard: {} });
    const d = deps({ fetchList: vi.fn(async () => []) });
    await openJudgePassCore(d, state);
    expect(d.sendPick).toHaveBeenCalledWith(task({ taskId: other }), expect.objectContaining({ txHash: '0x88' }));
    expect(state.picked.has('0xunsent')).toBe(false);
  });

  it('records a decline when no submission is acceptable, so a restart does not judge again', async () => {
    const d = deps({ rank: vi.fn(async (_c: unknown, batch: any[]) => ({ winner: null, scores: batch.map((c) => ({ id: c.id, score: 1, reason: 'off-topic' })) })) });
    const state = createJudgeState();
    expect(await openJudgePassCore(d, state)).toBe('judged');
    expect(d.sendPick).not.toHaveBeenCalled();
    expect(d.decline).toHaveBeenCalledWith(task(), expect.objectContaining({ winner: null, judged: 2 }));
    expect(state.done.get(HASH)).toMatch(/no submission is acceptable/);
  });

  it('fails closed on a failed ranking, and stops after its attempts', async () => {
    const d = deps({ rank: vi.fn(async () => null) });
    const state = createJudgeState();
    for (let i = 0; i < 3; i++) expect(await openJudgePassCore(d, state)).toBe('judged');
    expect(d.sendPick).not.toHaveBeenCalled();
    expect(await openJudgePassCore(d, state)).toBe('none');
    expect(d.rank).toHaveBeenCalledTimes(3);
    expect(d.inFlight).toHaveBeenLastCalledWith('task-finished', HASH, false);
  });

  it('is done when the escrow counts no submission, and waits for a list the server has not fully recorded', async () => {
    const nobody = createJudgeState();
    await openJudgePassCore(deps({ readOnChain: chain({ submissionCount: 0n }) }), nobody);
    expect(nobody.done.get(HASH)).toBe('nobody submitted');
    const partial = createJudgeState();
    const d = deps({ readOnChain: chain({ submissionCount: 3n }) });
    await openJudgePassCore(d, partial);
    expect(d.rank).not.toHaveBeenCalled();
    expect(partial.retryAt.get(HASH)).toBeGreaterThan(NOW_MS);
    expect(partial.attempts.has(HASH)).toBe(false);
  });

  it('retries failed reads later without spending an attempt, and counts unreadable results', async () => {
    const down = createJudgeState();
    await openJudgePassCore(deps({ fetchSubmissions: vi.fn(async () => null) }), down);
    expect(down.retryAt.get(HASH)).toBeGreaterThan(NOW_MS);
    expect(down.attempts.has(HASH)).toBe(false);
    const unread = createJudgeState();
    await openJudgePassCore(deps({ fetchSubmissions: vi.fn(async () => [sub(A, 1, null), sub(B, 2, null)]) }), unread);
    expect(unread.attempts.get(HASH)).toBe(1);
  });

  it('judges without a submitter the server refused as winner, and lists the overflow as not judged', async () => {
    const many = Array.from({ length: JUDGE_MAX_SUBMISSIONS + 2 }, (_, i) => sub(`0x${String(i + 1).padStart(40, '0')}`, i + 1, out(`work ${i}`)));
    const state = createJudgeState();
    state.excluded.set(HASH, new Set([many[0].submitter]));
    const d = deps({ fetchSubmissions: vi.fn(async () => many), readOnChain: chain({ submissionCount: BigInt(many.length) }) });
    await openJudgePassCore(d, state);
    const judged = d.verifyResults.mock.calls[0][1];
    expect(judged).toHaveLength(JUDGE_MAX_SUBMISSIONS);
    expect(judged.some((s: any) => s.submitter === many[0].submitter)).toBe(false);
    const [, pick] = d.sendPick.mock.calls[0];
    expect(pick.scorecard.notJudged).toEqual(expect.arrayContaining([
      expect.objectContaining({ why: 'the server refused it as a winner for this judge', count: 1 }),
      expect.objectContaining({ why: `only the first ${JUDGE_MAX_SUBMISSIONS} submissions are judged`, count: 1 }),
    ]));
  });

  it('yields to paid work waiting, the model check, an empty wallet, and the crash guard', async () => {
    expect(await openJudgePassCore(deps({ busy: () => true }), createJudgeState())).toBe('busy');
    expect(await openJudgePassCore(deps({ inferenceBlocker: () => 'key revoked' }), createJudgeState())).toBe('none');
    const broke = deps({ preflight: vi.fn(async () => 'wallet holds 0 USDC') });
    expect(await openJudgePassCore(broke, createJudgeState())).toBe('none');
    expect(broke.fetchSubmissions).not.toHaveBeenCalled();
    const crashed = createJudgeState();
    await openJudgePassCore(deps({ crashCheck: () => ({ reason: 'crashed twice on it', final: true }) }), crashed);
    expect(crashed.done.get(HASH)).toMatch(/crashed twice/);
  });

  it('confirms scorecards of landed picks first, and stops trying after its cap', async () => {
    const state = createJudgeState();
    state.confirm.set('0xkept', { scorecard: {}, tries: 0 });
    state.confirm.set('0xlag', { scorecard: {}, tries: 10 });
    state.confirm.set('0xlast', { scorecard: {}, tries: 11 });
    const d = deps({ fetchList: vi.fn(async () => []), confirmScorecard: vi.fn(async (h: string) => (h === '0xkept' ? 'kept' : 'retry')) });
    expect(await openJudgePassCore(d, state)).toBe('none');
    expect([...state.confirm.keys()]).toEqual(['0xlag']);
    expect(state.confirm.get('0xlag').tries).toBe(11);
  });

  it('does nothing when the list cannot be read', async () => {
    expect(await openJudgePassCore(deps({ fetchList: vi.fn(async () => null) }), createJudgeState())).toBe('off');
  });
});

describe('readCommitments', () => {
  it('reads every listed submitter’s commitment from the escrow', async () => {
    const read = vi.fn(async (_t: unknown, fn: string, [id, who]: [bigint, string]) => {
      expect([fn, id]).toEqual(['submissionOf', 41n]);
      return [who === A ? '0x' + 'aa'.repeat(32) : ethers.ZeroHash];
    });
    const res = await readCommitments({ meta: { taskId: HASH, chain: 'arc' }, onChainTaskId: '41' }, [sub(A, 1, null), sub(B, 2, null)], read);
    expect(res.map((x: any) => x.committed)).toEqual(['0x' + 'aa'.repeat(32), ethers.ZeroHash]);
  });
});

describe('verifyOpenResults: each result against its commitment and its storage id', () => {
  const t = { meta: { taskId: HASH, chain: 'arc' }, onChainTaskId: '41' };
  const rdA = { output: 'A wrote this' };
  const rdB = { output: 'B wrote this' };
  const withCommit = (x: any, rd: any, root: string | null = null) => ({ ...x, committed: openEvidenceHash(rd, root) });
  const noDownload = async () => { throw new Error('not expected'); };

  it('keeps a result that matches, and marks one a server swapped', async () => {
    const res = await verifyOpenResults(t, [withCommit(sub(A, 1, rdB), rdA), withCommit(sub(B, 2, rdB), rdB)], noDownload, async () => true);
    expect(res.map((x: any) => !!x.mismatch)).toEqual([true, false]);
  });

  it('reads a stored full result only when its bytes are the stored content', async () => {
    const stored = { ...sub(C, 3, { output: 'stub' }), result: { resultData: { output: 'stub' }, rootHash: ROOT } };
    const good = await verifyOpenResults(t, [withCommit(stored, { output: 'stub' }, ROOT)], async () => Buffer.from('the whole result'), async () => true);
    expect(good[0].storedText).toBe('the whole result');
    const forged = await verifyOpenResults(t, [withCommit(stored, { output: 'stub' }, ROOT)], async () => Buffer.from('server-chosen text'), async () => false);
    expect(forged[0]).toMatchObject({ mismatch: true });
    expect(forged[0].storedText).toBeUndefined();
  });

  it('marks a stored result too large to judge', async () => {
    const stored = { ...sub(C, 3, { output: 'stub' }), result: { resultData: { output: 'stub' }, rootHash: ROOT } };
    const big = await verifyOpenResults(t, [withCommit(stored, { output: 'stub' }, ROOT)], async () => Buffer.alloc(300 * 1024), async () => true);
    expect(big[0]).toMatchObject({ mismatch: true, why: 'its stored result is too large to judge' });
  });

  it('leaves out a stored result storage does not have (4xx), and waits on one it fails to serve (5xx) unless told to give up', async () => {
    const stored = withCommit({ ...sub(C, 3, { output: 'stub' }), result: { resultData: { output: 'stub' }, rootHash: ROOT } }, { output: 'stub' }, ROOT);
    const missing = await verifyOpenResults(t, [stored], async () => { throw new Error('storage download 404'); }, async () => true);
    expect(missing[0]).toMatchObject({ mismatch: true, why: 'its stored result could not be read' });
    await expect(verifyOpenResults(t, [stored], async () => { throw new Error('storage download 503'); }, async () => true)).rejects.toThrow('503');
    const gaveUp = await verifyOpenResults(t, [stored], async () => { throw new Error('storage download 503'); }, async () => true, { giveUpOnStorage: true });
    expect(gaveUp[0]).toMatchObject({ mismatch: true, why: 'its stored result could not be read' });
  });

  it('does not judge a stored result in a store it cannot check', async () => {
    const walrus = 'walrus-style-id-abcdefghijklmnopqrstuvwxyz012345';
    const stored = withCommit({ ...sub(C, 3, { output: 'stub' }), result: { resultData: { output: 'stub' }, rootHash: walrus } }, { output: 'stub' }, walrus);
    const [res] = await verifyOpenResults(t, [stored], noDownload, async () => true);
    expect(res).toMatchObject({ mismatch: true, why: 'its stored result is in a store the judge cannot check' });
  });

  it('leaves a result-less submission as it is', async () => {
    const [res] = await verifyOpenResults(t, [sub(A, 1, null)], noDownload, async () => true);
    expect(res.result).toBeNull();
  });
});

describe('storedBytesMatch', () => {
  const bytes = Buffer.from('a stored result');
  it('matches the sha256 id of the local store and the 0G merkle root of 0G storage', async () => {
    expect(await storedBytesMatch(bytes, '0x' + createHash('sha256').update(bytes).digest('hex'))).toBe(true);
    expect(await storedBytesMatch(bytes, createHash('sha256').update(bytes).digest('hex'))).toBe(true);
    const { MemData } = await import('@0gfoundation/0g-storage-ts-sdk');
    const [tree] = await new MemData(new Uint8Array(bytes)).merkleTree();
    expect(await storedBytesMatch(bytes, tree!.rootHash() as string)).toBe(true);
  });
  it('refuses other bytes, and ids it cannot check', async () => {
    expect(await storedBytesMatch(Buffer.from('other bytes'), '0x' + createHash('sha256').update(bytes).digest('hex'))).toBe(false);
    expect(await storedBytesMatch(bytes, 'walrus-style-id-abcdefghijklmnopqrstuvwxyz012345')).toBe(false);
  });
});

describe('rankWithModel', () => {
  const batch = [{ id: 'S1', submitter: A, output: 'one' }, { id: 'S2', submitter: B, output: 'two' }];
  const answer = { object: { scores: [{ id: 'S1', score: 8, reason: 'r' }, { id: 'S2', score: 2, reason: 'r' }], winner: 'S1' } };

  it('tags every header with a fresh random tag, so a submission cannot forge one', async () => {
    const generate = vi.fn(async () => answer);
    await rankWithModel({ brief: 'b', criteria: null }, batch, { generate });
    await rankWithModel({ brief: 'b', criteria: null }, batch, { generate });
    const tags = generate.mock.calls.map(([o]: any[]) => /SUBMISSION S1 #([0-9a-f]+) ===/.exec(o.prompt)?.[1]);
    expect(tags[0]).toMatch(/^[0-9a-f]{12}$/);
    expect(tags[0]).not.toBe(tags[1]);
    const [{ system, prompt }] = generate.mock.calls[0] as any[];
    expect(system).toContain(`#${tags[0]}`);
    expect(prompt).toContain(`SUBMISSION S2 #${tags[0]} ===`);
  });

  it('returns the checked ranking, and null for an inconsistent one', async () => {
    expect(await rankWithModel({ brief: 'b', criteria: null }, batch, { generate: vi.fn(async () => answer) })).toMatchObject({ winner: 'S1' });
    const lowWinner = { object: { ...answer.object, winner: 'S2' } };
    expect(await rankWithModel({ brief: 'b', criteria: null }, batch, { generate: vi.fn(async () => lowWinner) })).toBeNull();
  });

  it('tells the inference gate about a provider failure, not about a malformed answer', async () => {
    const onProviderFailure = vi.fn();
    const outage = Object.assign(new Error('Unauthorized'), { name: 'AI_APICallError' });
    expect(await rankWithModel({ brief: 'b', criteria: null }, batch, { generate: vi.fn(async () => { throw outage; }), onProviderFailure })).toBeNull();
    expect(onProviderFailure).toHaveBeenCalledTimes(1);
    const malformed = Object.assign(new Error('No object generated: response did not match schema'), { name: 'AI_NoObjectGeneratedError' });
    expect(await rankWithModel({ brief: 'b', criteria: null }, batch, { generate: vi.fn(async () => { throw malformed; }), onProviderFailure })).toBeNull();
    expect(onProviderFailure).toHaveBeenCalledTimes(1);
  });

  it('classifies provider failures', () => {
    const apiError = (statusCode: number) => Object.assign(new Error(`status ${statusCode}`), { name: 'AI_APICallError', statusCode });
    expect(isProviderFailure(apiError(401))).toBe(true);
    expect(isProviderFailure(apiError(429))).toBe(true);
    expect(isProviderFailure(apiError(503))).toBe(true);
    // A context too long or a content policy: a submission can cause it.
    expect(isProviderFailure(apiError(400))).toBe(false);
    expect(isProviderFailure(Object.assign(new Error('x'), { name: 'AI_RetryError' }))).toBe(true);
    expect(isProviderFailure(Object.assign(new Error('no such model'), { name: 'AI_NoSuchModelError' }))).toBe(true);
    expect(isProviderFailure(Object.assign(new Error('empty'), { name: 'AI_EmptyResponseBodyError' }))).toBe(true);
    expect(isProviderFailure(new Error('open-task judge run timed out after 600000ms'))).toBe(true);
    expect(isProviderFailure(new Error('fetch failed'))).toBe(true);
    expect(isProviderFailure(Object.assign(new Error('Type validation failed'), { name: 'AI_TypeValidationError' }))).toBe(false);
    expect(isProviderFailure(new Error('Unexpected token in JSON at position 4291'))).toBe(false);
  });
});
