import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { z } from 'zod';

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

import {
  judgeableSubmissions, checkRanking, judgeInRounds, buildScorecard, checkUnsignedSelect,
  sendPick, confirmScorecard, openJudgePassCore, createJudgeState, JUDGE_BATCH, JUDGE_MAX_SUBMISSIONS,
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
const HASH = '0x' + '11'.repeat(32);
const ROOT = '0x' + 'ab'.repeat(32);
const A = '0x' + '01'.repeat(20);
const B = '0x' + '02'.repeat(20);
const C = '0x' + '03'.repeat(20);
const SC_HASH = '0x' + '5c'.repeat(32);
const NOW_MS = 1_800_000_000_000;

const sub = (submitter: string, ordinal: number, output: string | null) => ({
  submitter, ordinal, evidenceHash: '0x01', recordedAt: '', result: output === null ? null : { resultData: { output }, rootHash: null },
});

describe('judgeableSubmissions', () => {
  it('labels readable results in submission order, leaving out unreadable ones with the reason', () => {
    const { candidates, excluded } = judgeableSubmissions([sub(B, 2, 'second'), sub(A, 1, 'first'), sub(C, 3, null)], null);
    expect(candidates.map((c: any) => [c.id, c.submitter, c.output])).toEqual([['S1', A, 'first'], ['S2', B, 'second']]);
    expect(excluded).toEqual([{ submitter: C, why: 'its result could not be read' }]);
  });

  it("leaves out results that fail the task's checks, unless none pass", () => {
    const criteria = { min_length: 10 };
    const some = judgeableSubmissions([sub(A, 1, 'short'), sub(B, 2, 'long enough here')], criteria);
    expect(some.candidates.map((c: any) => c.submitter)).toEqual([B]);
    expect(some.excluded[0]).toMatchObject({ submitter: A, why: expect.stringMatching(/failed the task's checks/) });
    const none = judgeableSubmissions([sub(A, 1, 'short'), sub(B, 2, 'tiny')], criteria);
    expect(none.candidates).toHaveLength(2);
  });

  it(`judges at most ${JUDGE_MAX_SUBMISSIONS}, earliest first, and cuts each output`, () => {
    const many = Array.from({ length: JUDGE_MAX_SUBMISSIONS + 3 }, (_, i) => sub(`0x${String(i).padStart(40, '0')}`, i + 1, 'x'.repeat(10_000)));
    const { candidates, excluded } = judgeableSubmissions(many, null);
    expect(candidates).toHaveLength(JUDGE_MAX_SUBMISSIONS);
    expect(candidates[0].output.length).toBeLessThan(10_000);
    expect(excluded).toHaveLength(3);
    expect(excluded[0].why).toMatch(/only the first/);
  });
});

describe('checkRanking: the judge fails closed', () => {
  const ids = ['S1', 'S2'];
  const scores = [{ id: 'S1', score: 8, reason: 'good' }, { id: 'S2', score: 3, reason: 'thin' }];

  it('accepts every candidate scored once, and a winner among them or none', () => {
    expect(checkRanking({ scores, winner: 'S1' }, ids)).toMatchObject({ winner: 'S1' });
    expect(checkRanking({ scores, winner: null }, ids)).toMatchObject({ winner: null });
  });

  it.each([
    ['a missing candidate', { scores: [scores[0]], winner: 'S1' }],
    ['an extra id', { scores: [...scores, { id: 'S9', score: 1, reason: '' }], winner: 'S1' }],
    ['a duplicate', { scores: [scores[0], scores[0]], winner: 'S1' }],
    ['a score out of range', { scores: [{ ...scores[0], score: 11 }, scores[1]], winner: 'S1' }],
    ['a winner not judged', { scores, winner: 'S3' }],
    ['no scores at all', { winner: 'S1' }],
  ])('refuses %s', (_name, object) => {
    expect(checkRanking(object, ids)).toBeNull();
  });
});

describe('judgeInRounds', () => {
  const cands = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `S${i + 1}`, submitter: `0x${i}`, output: `o${i}` }));
  // Picks the highest-numbered candidate in each batch.
  const rankLast = vi.fn(async (batch: any[]) => ({ winner: batch[batch.length - 1].id, scores: batch.map((c, i) => ({ id: c.id, score: i, reason: '' })) }));
  beforeEach(() => { rankLast.mockClear(); });

  it('ranks one batch once', async () => {
    const out = await judgeInRounds(cands(3), rankLast);
    expect(out.winner.id).toBe('S3');
    expect(rankLast).toHaveBeenCalledTimes(1);
    expect(out.scores).toHaveLength(3);
  });

  it('ranks the batch winners against each other when there are several batches', async () => {
    const out = await judgeInRounds(cands(JUDGE_BATCH * 2 + 1), rankLast);
    expect(rankLast).toHaveBeenCalledTimes(4); // 3 batches + the final
    expect(rankLast.mock.calls[3][0].map((c: any) => c.id)).toEqual([`S${JUDGE_BATCH}`, `S${JUDGE_BATCH * 2}`, `S${JUDGE_BATCH * 2 + 1}`]);
    expect(out.winner.id).toBe(`S${JUDGE_BATCH * 2 + 1}`);
    expect(out.scores).toHaveLength(JUDGE_BATCH * 2 + 1);
  });

  it('fails closed when any ranking fails, and names no winner when no batch has one', async () => {
    const failing = vi.fn(async (batch: any[]) => (batch[0].id === 'S1' ? null : { winner: batch[0].id, scores: [] }));
    expect(await judgeInRounds(cands(JUDGE_BATCH + 1), failing)).toBeNull();
    const none = vi.fn(async (batch: any[]) => ({ winner: null, scores: batch.map((c) => ({ id: c.id, score: 1, reason: '' })) }));
    expect(await judgeInRounds(cands(JUDGE_BATCH + 1), none)).toMatchObject({ winner: null });
  });
});

describe('buildScorecard', () => {
  const candidates = [{ id: 'S1', submitter: A, output: '' }, { id: 'S2', submitter: B, output: '' }];
  const base = {
    taskHash: HASH, judge: JUDGE.toLowerCase(), model: 'm', judgedAt: '2026-10-08T00:00:00.000Z', winner: A, total: 3, candidates,
    scores: [{ id: 'S1', score: 9, reason: 'complete' }, { id: 'S2', score: 4, reason: 'partial' }],
    excluded: [{ submitter: C, why: 'its result could not be read' }],
  };

  it('names every judged submitter by address, with the ones not judged', () => {
    const card = buildScorecard(base);
    expect(card).toMatchObject({ version: 1, task: HASH, winner: A, submissions: 3, judged: 2 });
    expect(card.scores).toEqual([{ submitter: A, score: 9, reason: 'complete' }, { submitter: B, score: 4, reason: 'partial' }]);
    expect(card.notJudged).toEqual([{ submitter: C, why: 'its result could not be read' }]);
  });

  it("hashes the same after the server's parse (JSON, then zod's record)", () => {
    const card = buildScorecard(base);
    const parsed = z.record(z.unknown()).parse(JSON.parse(JSON.stringify(card)));
    const hash = (v: unknown) => ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(v)));
    expect(hash(parsed)).toBe(hash(card));
  });

  it('stays under the 32 KB a scorecard may be, shortening then dropping reasons', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `S${i + 1}`, submitter: `0x${String(i).padStart(40, '0')}`, output: '' }));
    const card = buildScorecard({ ...base, candidates: many, scores: many.map((c) => ({ id: c.id, score: 5, reason: 'r'.repeat(300) })) });
    expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThanOrEqual(30 * 1024);
    expect(card.scores).toHaveLength(60);
  });
});

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
  const pick = { winner: A, scorecard: { version: 1 }, tries: 0 };
  let state: any;
  let send: ReturnType<typeof vi.fn>;
  const io = (over: Record<string, unknown> = {}) => ({
    signer: { address: JUDGE },
    chainId: 5042,
    escrow: ESCROW,
    preflight: vi.fn(async () => null),
    txStatus: vi.fn(async () => 'unknown'),
    send,
    postSelect: vi.fn(async () => ({ status: 200, ok: true, json: { data: { scorecardHash: SC_HASH, unsignedSelectWinnerByVerifier: unsignedSelect() } } })),
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
    expect(deps.postSelect).toHaveBeenCalledWith(HASH, { winner: A, scorecard: pick.scorecard });
    expect(send).toHaveBeenCalledWith({ to: ESCROW, data: unsignedSelect().data, chainId: 5042 });
    expect(state.done.get(HASH)).toBe('picked');
    expect(state.confirm.get(HASH)).toEqual({ scorecard: pick.scorecard, tries: 0 });
  });

  it('stops on a refusal that will stand, and keeps the pick for one that can clear', async () => {
    expect(await sendPick(task(), pick, io({ postSelect: refused(409, 'NOT_PICK_WINDOW') }), state)).toBe(false);
    expect(state.done.get(HASH)).toMatch(/NOT_PICK_WINDOW/);
    const again = createJudgeState();
    expect(await sendPick(task(), pick, io({ postSelect: refused(409, 'ESCROW_PAUSED') }), again)).toBe(false);
    expect(again.picked.get(HASH)).toMatchObject({ winner: A, tries: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it('never signs a pick that pays someone else or anchors another scorecard', async () => {
    const deps = io({ postSelect: vi.fn(async () => ({ status: 200, ok: true, json: { data: { scorecardHash: SC_HASH, unsignedSelectWinnerByVerifier: unsignedSelect({}, [41n, B, SC_HASH]) } } })) });
    expect(await sendPick(task(), pick, deps, state)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(state.done.get(HASH)).toMatch(/not sending the pick/);
  });

  it('holds the pick while the wallet cannot pay gas, without posting', async () => {
    const deps = io({ preflight: vi.fn(async () => 'wallet holds 0 USDC') });
    expect(await sendPick(task(), pick, deps, state)).toBe(false);
    expect(deps.postSelect).not.toHaveBeenCalled();
    expect(state.picked.has(HASH)).toBe(true);
  });

  it('looks up a pick sent earlier: pending waits, mined is done', async () => {
    const pending = io({ txStatus: vi.fn(async () => 'pending') });
    expect(await sendPick(task(), { ...pick, txHash: '0x88' }, pending, state)).toBe(false);
    expect(pending.postSelect).not.toHaveBeenCalled();
    const mined = io({ txStatus: vi.fn(async () => 'mined') });
    const s2 = createJudgeState();
    expect(await sendPick(task(), { ...pick, txHash: '0x88' }, mined, s2)).toBe(true);
    expect(s2.done.get(HASH)).toBe('picked');
    expect(s2.confirm.has(HASH)).toBe(true);
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

  it('gives a pick up after its last try', async () => {
    expect(await sendPick(task(), { ...pick, tries: 11 }, io({ postSelect: refused(503, 'INTERNAL') }), state)).toBe(false);
    expect(state.picked.size).toBe(0);
    expect(state.done.get(HASH)).toMatch(/not sent after 12 tries/);
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
  const subs = [sub(A, 1, 'answer A'), sub(B, 2, 'answer B')];
  const deps = (over: Record<string, unknown> = {}) => ({
    fetchList: vi.fn(async () => [task()]),
    confirmScorecard: vi.fn(async () => 'kept'),
    chainProblem: () => null,
    readPhase: vi.fn(async () => 2n),
    sendPick: vi.fn(async () => true),
    inferenceBlocker: () => null,
    preflight: vi.fn(async () => null),
    crashCheck: () => null,
    fetchSubmissions: vi.fn(async () => subs),
    readBrief: vi.fn(async () => 'the brief'),
    rank: vi.fn(async (_ctx: unknown, batch: any[]) => ({ winner: batch[1].id, scores: batch.map((c) => ({ id: c.id, score: 5, reason: 'ok' })) })),
    self: JUDGE.toLowerCase(),
    model: 'm',
    nowMs: () => NOW_MS,
    ...over,
  });

  it('judges a task in its window and sends the pick with an anchored scorecard', async () => {
    const d = deps();
    const state = createJudgeState();
    expect(await openJudgePassCore(d, state)).toBe('judged');
    expect(d.rank).toHaveBeenCalledWith({ brief: 'the brief', criteria: null }, expect.any(Array));
    const [, pick] = d.sendPick.mock.calls[0];
    expect(pick.winner).toBe(B);
    expect(pick.scorecard).toMatchObject({ task: HASH, judge: JUDGE.toLowerCase(), winner: B, submissions: 2, judged: 2 });
    expect(state.picked.get(HASH)).toBe(pick);
  });

  it('does nothing before its window and is done after it', async () => {
    const early = deps({ readPhase: vi.fn(async () => 1n) });
    expect(await openJudgePassCore(early, createJudgeState())).toBe('none');
    expect(early.fetchSubmissions).not.toHaveBeenCalled();
    const state = createJudgeState();
    state.picked.set(HASH, { winner: A, scorecard: {}, tries: 1 });
    expect(await openJudgePassCore(deps({ readPhase: vi.fn(async () => 3n) }), state)).toBe('none');
    expect(state.done.get(HASH)).toMatch(/window has passed/);
    expect(state.picked.size).toBe(0);
  });

  it('sends a pick it already judged, with no new model run', async () => {
    const state = createJudgeState();
    const held = { winner: A, scorecard: { version: 1 }, tries: 1 };
    state.picked.set(HASH, held);
    const d = deps();
    expect(await openJudgePassCore(d, state)).toBe('sent');
    expect(d.sendPick).toHaveBeenCalledWith(task(), held);
    expect(d.rank).not.toHaveBeenCalled();
  });

  it('picks nothing when no submission is acceptable: the backup judge decides', async () => {
    const d = deps({ rank: vi.fn(async (_c: unknown, batch: any[]) => ({ winner: null, scores: batch.map((c) => ({ id: c.id, score: 1, reason: 'off-topic' })) })) });
    const state = createJudgeState();
    expect(await openJudgePassCore(d, state)).toBe('judged');
    expect(d.sendPick).not.toHaveBeenCalled();
    expect(state.done.get(HASH)).toMatch(/no submission is acceptable/);
  });

  it('fails closed on a failed ranking, and stops after its attempts', async () => {
    const d = deps({ rank: vi.fn(async () => null) });
    const state = createJudgeState();
    for (let i = 0; i < 3; i++) expect(await openJudgePassCore(d, state)).toBe('judged');
    expect(d.sendPick).not.toHaveBeenCalled();
    expect(await openJudgePassCore(d, state)).toBe('none');
    expect(d.rank).toHaveBeenCalledTimes(3);
  });

  it('is done when nobody submitted, and retries when results cannot be read yet', async () => {
    const nobody = createJudgeState();
    await openJudgePassCore(deps({ fetchSubmissions: vi.fn(async () => []) }), nobody);
    expect(nobody.done.get(HASH)).toBe('nobody submitted');
    const unread = createJudgeState();
    await openJudgePassCore(deps({ fetchSubmissions: vi.fn(async () => [sub(A, 1, null)]) }), unread);
    expect(unread.done.has(HASH)).toBe(false);
    expect(unread.attempts.get(HASH)).toBe(1);
  });

  it('waits while the model check fails, or the wallet cannot pay, and honours the crash guard', async () => {
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
