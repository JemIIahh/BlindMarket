import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

import {
  openEvidenceHash, fitOpenResultData, meetsOpenRewardFloor, openSkipReason, pickOpenCandidates,
  openEligibility, checkUnsignedSubmitOpen, openRefusalIsFinal, openRunsLeft, createOpenState,
  sendOpenResult, buildTools, openRewardFloor, noteOpenFailure, openPassCore, produceResult, OPEN_MAX_BRIEF_CHARS,
  OPEN_RESULT_DATA_MAX_BYTES, OPEN_TOOL_OPTIONS, OPEN_DEADLINE_MARGIN_SEC,
  // @ts-expect-error — plain-JS worker, no d.ts
} from './worker.js';

/**
 * Part 3b of open submission (docs/OPEN-SUBMISSION-TASKS.md section 15): an
 * opted-in agent works open tasks and sends its result with a submitOpen from
 * its own wallet. These cover what decides whether a model run and the gas
 * are spent, and what happens to a result the server or the chain turns away.
 */

import { generateText } from 'ai';

const iface = new ethers.Interface(JSON.parse(readFileSync(new URL('../src/abi/BlindEscrow.json', import.meta.url), 'utf-8')));
const ESCROW = '0x' + 'e5'.repeat(20);
const WALLET = ethers.getAddress('0x' + 'a1'.repeat(20));
const NOW_SEC = 1_800_000_000;
const HASH = '0x' + '11'.repeat(32);
const ROOT = '0x' + 'ab'.repeat(32);
const USDC = { symbol: 'USDC', decimals: 6 };

describe('openEvidenceHash', () => {
  // The same vector is pinned in src/routes/openSubmission.test.ts: a drift
  // between the two copies would have the worker refuse every submitOpen.
  it('matches the server: keccak256 of the JSON of the resultData and the storage pointer', () => {
    const resultData = { output: 'Done: the summary — 3 points ✓', agent: 'agent-7' };
    expect(openEvidenceHash(resultData, ROOT)).toBe('0xf0c7c9b0b9ccb46409e4e35bc30f9aa94ecab88e24a57c256fff5535caa82839');
    expect(openEvidenceHash(resultData, null)).toBe('0x1b701a666ac7fbd05539f4c0fceac47f1793c207bca36cf5f85d514872767439');
  });
});

describe('fitOpenResultData', () => {
  it('leaves a result that fits untouched', () => {
    const rd = { output: 'short', agent: 'a' };
    expect(fitOpenResultData(rd)).toBe(rd);
  });

  it('cuts a long output to fit, says so, and keeps the start', () => {
    const rd = { output: 'é✓'.repeat(40_000), agent: 'a' };
    const fit = fitOpenResultData(rd);
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeLessThanOrEqual(OPEN_RESULT_DATA_MAX_BYTES);
    expect(fit.truncated).toBe(true);
    expect(fit.agent).toBe('a');
    expect(rd.output.startsWith(fit.output.split('\n\n[The result was cut')[0])).toBe(true);
    expect(fit.output).toMatch(/cut here to fit an open submission/);
    // As long as it can be: one more character would not fit.
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeGreaterThan(OPEN_RESULT_DATA_MAX_BYTES - 8);
  });
});

describe('the open-task reward floor', () => {
  it('is 0.5 USDC unless the owner asks for more', () => {
    expect(openRewardFloor('', USDC)).toBe(500_000n);
    expect(openRewardFloor('100000', USDC)).toBe(500_000n);
    expect(openRewardFloor('2000000', USDC)).toBe(2_000_000n);
    expect(openRewardFloor('abc', USDC)).toBe(500_000n);
    expect(openRewardFloor('', { symbol: 'USDC', decimals: 18 })).toBe(500_000_000_000_000_000n);
  });

  it('passes a reward at or over the floor, in the posting token', () => {
    expect(meetsOpenRewardFloor({ amount: '500000', unit: USDC }, '', USDC)).toBe(true);
    expect(meetsOpenRewardFloor({ amount: '499999', unit: USDC }, '', USDC)).toBe(false);
    expect(meetsOpenRewardFloor({ amount: '4999999', unit: USDC }, '5000000', USDC)).toBe(false);
  });

  it('turns away an unknown reward, or one in another unit', () => {
    expect(meetsOpenRewardFloor(undefined, '', USDC)).toBe(false);
    expect(meetsOpenRewardFloor({ amount: '10000000000000000000', unit: { symbol: '0G', decimals: 18 } }, '', USDC)).toBe(false);
  });

  it('has no platform minimum off USDC: the owner’s alone applies, as on /accept', () => {
    const OG = { symbol: '0G', decimals: 18 };
    expect(meetsOpenRewardFloor({ amount: '1', unit: OG }, '', OG)).toBe(true);
    expect(meetsOpenRewardFloor({ amount: '1', unit: OG }, '2', OG)).toBe(false);
  });
});

const entry = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  meta: {
    taskId: HASH, submissionMode: 'open', privacy: 'public', rootHash: ROOT, chain: 'arc',
    deadline: NOW_SEC + 7200, posterAddress: '0x' + 'b2'.repeat(20), verifierAddress: '0x' + 'c3'.repeat(20),
    reward: { amount: '2000000', unit: USDC }, ...over,
  },
  onChainTaskId: '41',
  ...top,
});
const opts = { nowSec: NOW_SEC, selfAddresses: [WALLET], ownerAddress: '0x' + 'd4'.repeat(20), minReward: '1000000', pricing: USDC, chainProblem: () => null, marginSec: 780 };

describe('openSkipReason', () => {
  it('lets a public open task with time left through', () => {
    expect(openSkipReason(entry(), opts)).toBeNull();
  });

  it.each([
    ['a single-assignee task', entry({ submissionMode: undefined }), /not an open task/],
    ['no public brief', entry({ rootHash: undefined }), /no public brief/],
    ['a private task', entry({ privacy: 'private' }), /no public brief/],
    ['an id not indexed yet', entry({}, { onChainTaskId: null }), /not indexed/],
    ['no deadline', entry({ deadline: undefined }), /no deadline/],
    ['too little time for a run', entry({ deadline: NOW_SEC + 600 }), /too soon/],
    ['its own task', entry({ posterAddress: WALLET.toLowerCase() }), /posted it/],
    ['a task it verifies', entry({ verifierAddress: WALLET }), /verifier/],
    ["its owner's task", entry({ posterAddress: '0x' + 'D4'.repeat(20) }), /owner posted/],
    ['a reward under its minimum', entry({ reward: { amount: '999999', unit: USDC } }), /below the open-task minimum/],
  ])('skips %s', (_name, e, why) => {
    expect(openSkipReason(e, opts)).toMatch(why);
  });

  it('skips a near-free task even with no owner minimum', () => {
    expect(openSkipReason(entry({ reward: { amount: '1', unit: USDC } }), { ...opts, minReward: '' })).toMatch(/0.5 USDC/);
  });

  it('leaves room for three model calls and the tx by default', () => {
    expect(OPEN_DEADLINE_MARGIN_SEC).toBeGreaterThanOrEqual(3 * 600 + 300);
  });

  it('skips a chain it cannot send a plain tx on', () => {
    expect(openSkipReason(entry(), { ...opts, chainProblem: () => 'no arc signer' })).toBe('no arc signer');
  });
});

describe('pickOpenCandidates', () => {
  it('orders by deadline and leaves out what this process is done with or waiting on', () => {
    const state = createOpenState();
    const at = (n: number, deadline: number) => entry({ taskId: `0x${String(n).repeat(64)}`, deadline });
    const entries = [at(1, NOW_SEC + 9000), at(2, NOW_SEC + 3000), at(3, NOW_SEC + 4000), at(4, NOW_SEC + 5000), at(5, NOW_SEC + 6000), at(6, NOW_SEC + 300)];
    state.done.set(entries[2].meta.taskId, 'submitted');
    state.unsent.set(entries[3].meta.taskId, {});
    state.retryAt.set(entries[4].meta.taskId, NOW_SEC * 1000 + 60_000);
    state.retryAt.set(entries[1].meta.taskId, NOW_SEC * 1000 - 1); // its wait is over
    const { candidates, skipped } = pickOpenCandidates(entries, { ...opts, nowMs: NOW_SEC * 1000, state });
    expect(candidates.map((e: any) => e.meta.taskId)).toEqual([entries[1].meta.taskId, entries[0].meta.taskId]);
    expect(skipped).toEqual([{ taskHash: entries[5].meta.taskId, reason: expect.stringMatching(/too soon/) }]);
  });
});

describe('pickOpenCandidates ranking', () => {
  it('puts the most reward per competitor first, then the soonest deadline', () => {
    const e = (n: number, amount: string, submissions: number, deadline = NOW_SEC + 7200) =>
      ({ ...entry({ taskId: `0x${String(n).repeat(64)}`, reward: { amount, unit: USDC }, deadline }), submissions });
    const entries = [e(1, '2000000', 3), e(2, '1000000', 0), e(3, '1000000', 0, NOW_SEC + 4000), e(4, '9000000', 8)];
    const { candidates } = pickOpenCandidates(entries, { ...opts, nowMs: NOW_SEC * 1000, state: createOpenState() });
    // Per competitor: 4 → 1.0, 3 → 1.0 (sooner), 2 → 1.0, 1 → 0.5.
    expect(candidates.map((c: any) => c.meta.taskId[2])).toEqual(['3', '2', '4', '1']);
  });
});

describe('openEligibility', () => {
  it('is clear while taking submissions, with none from this wallet', () => {
    expect(openEligibility({ submitted: ethers.ZeroHash, phase: 0n, paused: false })).toBeNull();
  });
  it('is final once this wallet submitted, or submissions closed', () => {
    expect(openEligibility({ submitted: '0x' + '22'.repeat(32), phase: 0n, paused: false })).toMatchObject({ final: true });
    expect(openEligibility({ submitted: ethers.ZeroHash, phase: 1n, paused: false })).toMatchObject({ final: true });
  });
  it('waits out a pause', () => {
    expect(openEligibility({ submitted: ethers.ZeroHash, phase: 0n, paused: true })).toMatchObject({ final: false });
  });
});

// Open results go inline: no storage pointer.
const evidence = openEvidenceHash({ output: 'x', agent: 'a' }, null);
const unsigned = (over: Record<string, unknown> = {}, args: [bigint, string] = [41n, evidence]) => ({
  to: ESCROW, data: iface.encodeFunctionData('submitOpen', args), from: WALLET, chainId: 5042, ...over,
});
const expected = { from: WALLET, chainId: 5042, escrow: ESCROW, onChainTaskId: '41', evidenceHash: evidence };

describe('checkUnsignedSubmitOpen', () => {
  it('accepts the submitOpen for this task and this result, from this wallet', () => {
    expect(checkUnsignedSubmitOpen(unsigned({ from: WALLET.toLowerCase() }), expected, iface)).toBeNull();
  });

  it.each([
    ['another wallet', unsigned({ from: '0x' + 'f6'.repeat(20) }), /not this wallet/],
    ['another chain', unsigned({ chainId: 5042002 }), /chain 5042002/],
    ['another contract', unsigned({ to: '0x' + '99'.repeat(20) }), /not the escrow/],
    ['value', unsigned({ value: '1' }), /sends value/],
    ['another call', unsigned({ data: iface.encodeFunctionData('submitEvidence', [41n, evidence]) }), /not a submitOpen/],
    ['another task', unsigned({}, [42n, evidence]), /task 42/],
    ['another result', unsigned({}, [41n, '0x' + '33'.repeat(32)]), /evidence hash/],
  ])('refuses %s', (_name, tx, why) => {
    expect(checkUnsignedSubmitOpen(tx, expected, iface)).toMatch(why);
  });

  it('refuses no transaction at all', () => {
    expect(checkUnsignedSubmitOpen(undefined, expected, iface)).toMatch(/no transaction/);
  });

  it('signs nothing when it does not know what to expect', () => {
    for (const missing of ['escrow', 'chainId', 'onChainTaskId'] as const) {
      expect(checkUnsignedSubmitOpen(unsigned(), { ...expected, [missing]: missing === 'escrow' ? '' : null }, iface)).toMatch(/does not know/);
    }
  });
});

describe('openRefusalIsFinal', () => {
  it('retries what can clear before the deadline', () => {
    expect(openRefusalIsFinal(429, 'TOO_MANY_HELD')).toBe(false);
    expect(openRefusalIsFinal(429, 'RATE_LIMIT')).toBe(false);
    expect(openRefusalIsFinal(503, 'NOT_INDEXED')).toBe(false);
    expect(openRefusalIsFinal(500, 'INTERNAL')).toBe(false);
    expect(openRefusalIsFinal(409, 'ESCROW_PAUSED')).toBe(false);
  });
  it('stops on what the server would say again', () => {
    for (const [status, code] of [[409, 'ALREADY_SUBMITTED'], [409, 'DEADLINE_REACHED'], [409, 'SUBMISSIONS_CLOSED'], [403, 'OWN_AGENT'], [403, 'SAME_OWNER'], [413, 'RESULT_TOO_LARGE'], [404, 'NOT_FOUND']] as const) {
      expect(openRefusalIsFinal(status, code)).toBe(true);
    }
  });
});

describe('openRunsLeft', () => {
  it('counts the runs of the last hour only', () => {
    const now = 10_000_000;
    const runs = [now - 3_600_000, now - 3_599_000, now - 60_000];
    expect(openRunsLeft(runs, now, 4)).toBe(2);
    expect(runs).toEqual([now - 3_599_000, now - 60_000]);
  });
});

describe('buildTools for an open run', () => {
  it('gives the model no messaging, no inbox and no delegation, even when the owner allows delegation', () => {
    const tools = buildTools(HASH, { posterAddress: '0x' + 'b2'.repeat(20), delegation: true, ...OPEN_TOOL_OPTIONS });
    expect(tools.send_message).toBeUndefined();
    expect(tools.read_inbox).toBeUndefined();
    expect(tools.wait_for_reply).toBeUndefined();
    expect(tools.delegate_to_agent).toBeUndefined();
  });
  it('still gives them to an assigned task', () => {
    const tools = buildTools(HASH, { posterAddress: '0x' + 'b2'.repeat(20), delegation: true });
    expect(tools.send_message).toBeDefined();
    expect(tools.read_inbox).toBeDefined();
    expect(tools.wait_for_reply).toBeDefined();
    expect(tools.delegate_to_agent).toBeDefined();
  });
});

describe('noteOpenFailure', () => {
  it('tries a failed run again later, then gives up', () => {
    const state = createOpenState();
    noteOpenFailure(state, HASH, 'the model produced no result');
    expect(state.retryAt.get(HASH)).toBeGreaterThan(Date.now());
    expect(state.done.has(HASH)).toBe(false);
    noteOpenFailure(state, HASH, 'the model produced no result');
    expect(state.done.get(HASH)).toMatch(/giving up after 2 runs/);
  });
  it('gives up at once on a final failure (a brief too long)', () => {
    const state = createOpenState();
    noteOpenFailure(state, HASH, 'its brief is over 20000 characters', { final: true });
    expect(state.done.get(HASH)).toMatch(/not trying it/);
  });
});

describe('sendOpenResult', () => {
  const produced = { resultData: { output: 'x', agent: 'a' }, rootHash: ROOT, teeAttestation: null };
  let state: any;
  let sendTransaction: ReturnType<typeof vi.fn>;
  const io = (over: Record<string, unknown> = {}) => ({
    signer: { address: WALLET, sendTransaction },
    chainId: 5042,
    escrow: ESCROW,
    nowSec: () => NOW_SEC,
    preflight: vi.fn(async () => null),
    txStatus: vi.fn(async (_hash: string) => 'unknown'),
    postSubmitOpen: vi.fn(async () => ({ status: 200, ok: true, json: { data: { unsignedSubmitOpen: unsigned(), evidenceHash: evidence } } })),
    ...over,
  });
  const refused = (status: number, code: string) => vi.fn(async () => ({ status, ok: false, json: { success: false, error: { code, message: 'no' } } }));

  beforeEach(() => {
    state = createOpenState();
    sendTransaction = vi.fn(async () => ({ hash: '0x' + '77'.repeat(32), wait: async () => ({ blockNumber: 9 }) }));
  });

  it('posts the result inline, sends the submitOpen it checked, rebuilt, and is done once it lands', async () => {
    const deps = io();
    expect(await sendOpenResult(entry(), produced, deps, state)).toBe(true);
    // No storage pointer, even when one was made: blobs are readable by anyone.
    expect(deps.postSubmitOpen).toHaveBeenCalledWith(HASH, { resultData: produced.resultData, rootHash: null, teeAttestation: null });
    // Only the call is taken from the server; gas and nonce come from this wallet's provider.
    expect(sendTransaction).toHaveBeenCalledWith({ to: ESCROW, data: unsigned().data, chainId: 5042 });
    expect(state.done.get(HASH)).toMatch(/submitted/);
    expect(state.unsent.size).toBe(0);
  });

  it('sends nothing once the deadline has passed', async () => {
    const deps = io({ nowSec: () => NOW_SEC + 7200 });
    expect(await sendOpenResult(entry(), produced, deps, state)).toBe(false);
    expect(deps.postSubmitOpen).not.toHaveBeenCalled();
    expect(state.done.get(HASH)).toMatch(/deadline passed/);
  });

  it('keeps the result for the next pass when the server says to wait, with no tx', async () => {
    expect(await sendOpenResult(entry(), produced, io({ postSubmitOpen: refused(429, 'TOO_MANY_HELD') }), state)).toBe(false);
    expect(state.unsent.get(HASH)).toEqual({ entry: entry(), produced });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('keeps it too when the server does not answer', async () => {
    const deps = io({ postSubmitOpen: vi.fn(async () => { throw new Error('socket hang up'); }) });
    expect(await sendOpenResult(entry(), produced, deps, state)).toBe(false);
    expect(state.unsent.has(HASH)).toBe(true);
  });

  it('stops on a refusal that will stand', async () => {
    expect(await sendOpenResult(entry(), produced, io({ postSubmitOpen: refused(403, 'OWN_AGENT') }), state)).toBe(false);
    expect(state.done.get(HASH)).toMatch(/403 OWN_AGENT/);
    expect(state.unsent.size).toBe(0);
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('is done with no tx when the submission is already on-chain', async () => {
    const deps = io({ postSubmitOpen: vi.fn(async () => ({ status: 200, ok: true, json: { data: { alreadyOnChain: true, kept: true } } })) });
    expect(await sendOpenResult(entry(), produced, deps, state)).toBe(true);
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(state.done.get(HASH)).toMatch(/already on-chain/);
  });

  it('never signs a submitOpen that commits another result', async () => {
    const other = unsigned({}, [41n, '0x' + '33'.repeat(32)]);
    const deps = io({ postSubmitOpen: vi.fn(async () => ({ status: 200, ok: true, json: { data: { unsignedSubmitOpen: other } } })) });
    expect(await sendOpenResult(entry(), produced, deps, state)).toBe(false);
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(state.done.get(HASH)).toMatch(/not sending the submitOpen/);
  });

  it('commits the cut resultData it sent when the output was too long', async () => {
    const long = { ...produced, resultData: { output: 'y'.repeat(OPEN_RESULT_DATA_MAX_BYTES + 10), agent: 'a' } };
    const sent = fitOpenResultData(long.resultData);
    const deps = io({
      postSubmitOpen: vi.fn(async () => ({ status: 200, ok: true, json: { data: { unsignedSubmitOpen: unsigned({}, [41n, openEvidenceHash(sent, null)]) } } })),
    });
    expect(await sendOpenResult(entry(), long, deps, state)).toBe(true);
    expect(deps.postSubmitOpen.mock.calls[0][1].resultData).toEqual(sent);
  });

  it('holds the result while the wallet cannot pay the gas, without posting it again', async () => {
    const deps = io({ preflight: vi.fn(async () => 'wallet holds 0 USDC on arc') });
    expect(await sendOpenResult(entry(), produced, deps, state)).toBe(false);
    expect(deps.postSubmitOpen).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(state.unsent.has(HASH)).toBe(true);
  });

  it('remembers a tx whose receipt it lost, and sends nothing while it is pending', async () => {
    sendTransaction.mockResolvedValueOnce({ hash: '0x' + '88'.repeat(32), wait: async () => { throw new Error('timeout'); } });
    expect(await sendOpenResult(entry(), produced, io(), state)).toBe(false);
    const kept = state.unsent.get(HASH);
    expect(kept.txHash).toBe('0x' + '88'.repeat(32));

    state = createOpenState();
    const pending = io({ txStatus: vi.fn(async () => 'pending') });
    expect(await sendOpenResult(entry(), produced, pending, state, { txHash: kept.txHash })).toBe(false);
    expect(pending.postSubmitOpen).not.toHaveBeenCalled();
    expect(state.unsent.get(HASH).txHash).toBe(kept.txHash);

    state = createOpenState();
    const mined = io({ txStatus: vi.fn(async () => 'mined') });
    expect(await sendOpenResult(entry(), produced, mined, state, { txHash: kept.txHash })).toBe(true);
    expect(mined.postSubmitOpen).not.toHaveBeenCalled();
    expect(state.done.get(HASH)).toMatch(/submitted/);

    state = createOpenState();
    const dropped = io({ txStatus: vi.fn(async () => 'unknown') });
    expect(await sendOpenResult(entry(), produced, dropped, state, { txHash: kept.txHash })).toBe(true);
    expect(dropped.postSubmitOpen).toHaveBeenCalled();
  });

  it('stops when the escrow refuses for good', async () => {
    sendTransaction.mockRejectedValueOnce(Object.assign(new Error('execution reverted'), { data: iface.encodeErrorResult('AlreadySubmitted', []) }));
    expect(await sendOpenResult(entry(), produced, io(), state)).toBe(false);
    expect(state.done.get(HASH)).toMatch(/AlreadySubmitted/);
  });

  it('keeps the result when the tx may still land (RPC error, pause)', async () => {
    sendTransaction.mockRejectedValueOnce(new Error('timeout'));
    expect(await sendOpenResult(entry(), produced, io(), state)).toBe(false);
    expect(state.unsent.has(HASH)).toBe(true);
    state = createOpenState();
    sendTransaction.mockRejectedValueOnce(Object.assign(new Error('execution reverted'), { data: iface.encodeErrorResult('EnforcedPause', []) }));
    expect(await sendOpenResult(entry(), produced, io(), state)).toBe(false);
    expect(state.unsent.has(HASH)).toBe(true);
  });
});

describe('openPassCore', () => {
  const board = (...entries: any[]) => vi.fn(async () => entries);
  const deps = (over: Record<string, unknown> = {}) => ({
    fetchBoard: board(entry()),
    send: vi.fn(async () => true),
    inferenceBlocker: () => null,
    nowMs: () => NOW_SEC * 1000,
    selfAddresses: [WALLET],
    ownerAddress: '',
    minReward: '',
    pricing: USDC,
    chainProblem: () => null,
    preflight: vi.fn(async () => null),
    crashCheck: () => null,
    readEligibility: vi.fn(async () => null),
    check: vi.fn(async () => null),
    run: vi.fn(async () => {}),
    ...over,
  });

  it('works the best task after the escrow says it may', async () => {
    const d = deps();
    expect(await openPassCore(d, createOpenState())).toBe('ran');
    expect(d.readEligibility).toHaveBeenCalledWith(entry());
    expect(d.run).toHaveBeenCalledWith(entry());
  });

  it('does nothing when the board cannot be read (or the feature is off)', async () => {
    const d = deps({ fetchBoard: vi.fn(async () => null) });
    expect(await openPassCore(d, createOpenState())).toBe('off');
    expect(d.run).not.toHaveBeenCalled();
  });

  it('sends an unsent result first, with no model run', async () => {
    const state = createOpenState();
    const unsent = { entry: entry(), produced: {}, txHash: '0x99' };
    state.unsent.set(HASH, unsent);
    const d = deps();
    expect(await openPassCore(d, state)).toBe('sent');
    expect(d.send).toHaveBeenCalledWith(unsent);
    expect(d.run).not.toHaveBeenCalled();
  });

  it('drops an unsent result whose task left the board, then works another', async () => {
    const state = createOpenState();
    state.unsent.set('0x' + 'ee'.repeat(32), { entry: entry({ taskId: '0x' + 'ee'.repeat(32) }), produced: {} });
    const d = deps();
    expect(await openPassCore(d, state)).toBe('ran');
    expect(state.unsent.size).toBe(0);
    expect(d.send).not.toHaveBeenCalled();
  });

  it('runs no model while the model check fails, or past the hourly cap', async () => {
    expect(await openPassCore(deps({ inferenceBlocker: () => 'key revoked' }), createOpenState())).toBe('blocked');
    const state = createOpenState();
    state.runs.push(...Array(4).fill(NOW_SEC * 1000 - 60_000));
    const d = deps();
    expect(await openPassCore(d, state)).toBe('capped');
    expect(d.run).not.toHaveBeenCalled();
  });

  it('skips a chain whose gas the wallet cannot pay', async () => {
    const d = deps({ preflight: vi.fn(async () => 'wallet holds 0 USDC') });
    expect(await openPassCore(d, createOpenState())).toBe('none');
    expect(d.readEligibility).not.toHaveBeenCalled();
  });

  it('is done with a task the escrow says it already submitted to, and waits out a pause', async () => {
    const state = createOpenState();
    expect(await openPassCore(deps({ readEligibility: vi.fn(async () => ({ reason: 'this agent already submitted to it', final: true })) }), state)).toBe('none');
    expect(state.done.has(HASH)).toBe(true);
    const paused = createOpenState();
    expect(await openPassCore(deps({ readEligibility: vi.fn(async () => ({ reason: 'the escrow is paused', final: false })) }), paused)).toBe('none');
    expect(paused.done.has(HASH)).toBe(false);
  });

  it('lets the next task through when one escrow read fails, and comes back to it later', async () => {
    const other = entry({ taskId: '0x' + '22'.repeat(32), reward: { amount: '1000000', unit: USDC } });
    const state = createOpenState();
    const d = deps({
      fetchBoard: board(entry(), other),
      readEligibility: vi.fn(async (e: any) => { if (e.meta.taskId === HASH) throw new Error('rpc down'); return null; }),
    });
    expect(await openPassCore(d, state)).toBe('ran');
    expect(d.run).toHaveBeenCalledWith(other);
    expect(state.retryAt.get(HASH)).toBeGreaterThan(NOW_SEC * 1000);
  });

  it("asks the server before the model run: a refusal that will stand ends the task, others wait", async () => {
    const owned = createOpenState();
    const d = deps({ check: vi.fn(async () => ({ reason: 'the server refuses it: 403 SAME_OWNER', final: true })) });
    expect(await openPassCore(d, owned)).toBe('none');
    expect(d.run).not.toHaveBeenCalled();
    expect(owned.done.get(HASH)).toMatch(/SAME_OWNER/);
    const busy = createOpenState();
    const b = deps({ check: vi.fn(async () => ({ reason: 'the server refuses it: 429 RATE_LIMIT', final: false })) });
    expect(await openPassCore(b, busy)).toBe('none');
    expect(busy.done.size).toBe(0);
    const down = createOpenState();
    const x = deps({ check: vi.fn(async () => { throw new Error('socket hang up'); }) });
    expect(await openPassCore(x, down)).toBe('none');
    expect(down.retryAt.get(HASH)).toBeGreaterThan(NOW_SEC * 1000);
  });

  it('never runs a task the worker crashed on, and stops when the crashes cannot be blamed', async () => {
    const state = createOpenState();
    const d = deps({ crashCheck: () => ({ reason: 'the worker crashed 2 times while running it', final: true }) });
    expect(await openPassCore(d, state)).toBe('none');
    expect(state.done.has(HASH)).toBe(true);
    const blanket = createOpenState();
    const b = deps({ crashCheck: () => ({ reason: 'the worker crashed 3 times in a row', final: false }) });
    expect(await openPassCore(b, blanket)).toBe('none');
    expect(blanket.done.size).toBe(0);
    expect(b.run).not.toHaveBeenCalled();
  });
});

describe('produceResult', () => {
  let brief = 'Write three facts about tides.';
  const calls: string[] = [];
  beforeEach(() => {
    brief = 'Write three facts about tides.';
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (String(url).includes('/api/v1/storage/upload')) return new Response(JSON.stringify({ data: { rootHash: ROOT } }), { status: 200 });
      if (String(url).includes('/api/v1/storage/')) return new Response(JSON.stringify({ data: { blob: Buffer.from(brief).toString('base64') } }), { status: 200 });
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }));
    vi.mocked(generateText).mockReset().mockResolvedValue({ text: 'Tides follow the moon.', steps: [], toolCalls: [], toolResults: [], content: [], finishReason: 'stop', usage: {} } as never);
  });
  afterEach(() => vi.unstubAllGlobals());
  const hooks = () => ({ giveUp: vi.fn(), onModelFailed: vi.fn() });

  it('on an open task: no messaging, inbox or delegation, no thread read, and nothing uploaded', async () => {
    const h = hooks();
    const out = await produceResult(HASH, { briefRootHash: ROOT, wrappedKey: null, privacy: 'public', meta: entry().meta, open: true }, h);
    expect(out).toMatchObject({ rootHash: null, resultData: { output: 'Tides follow the moon.' } });
    expect(calls.filter((c) => c.includes('/storage/upload'))).toEqual([]);
    expect(calls.filter((c) => c.includes('/messages/') || c.includes('/a2a/executions'))).toEqual([]);
    const opts = vi.mocked(generateText).mock.calls[0][0] as any;
    for (const name of ['send_message', 'read_inbox', 'wait_for_reply', 'delegate_to_agent']) expect(opts.tools[name]).toBeUndefined();
    expect(opts.system).toMatch(/cannot contact the poster/);
    expect(h.giveUp).not.toHaveBeenCalled();
  });

  it('does not work an open brief over the cap', async () => {
    brief = 'x'.repeat(OPEN_MAX_BRIEF_CHARS + 1);
    const h = hooks();
    expect(await produceResult(HASH, { briefRootHash: ROOT, wrappedKey: null, privacy: 'public', meta: entry().meta, open: true }, h)).toBeNull();
    expect(h.giveUp).toHaveBeenCalledWith(expect.stringMatching(/brief is over/), { final: true });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('on an assigned task, as before: reads its meta and thread, offers messaging, and uploads the result', async () => {
    const h = hooks();
    const out = await produceResult(HASH, { briefRootHash: ROOT, wrappedKey: null, privacy: 'public' }, h);
    expect(out).toMatchObject({ rootHash: ROOT });
    expect(calls.some((c) => c.includes('/a2a/executions'))).toBe(true);
    expect(calls.some((c) => c.includes('/messages/inbox'))).toBe(true);
    expect(calls.some((c) => c.startsWith('POST') && c.includes('/storage/upload'))).toBe(true);
    const opts = vi.mocked(generateText).mock.calls[0][0] as any;
    expect(opts.tools.send_message).toBeDefined();
    expect(opts.system).toMatch(/messaging tools describe how/);
  });
});

