import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  sendOpenResult, buildTools, OPEN_RESULT_DATA_MAX_BYTES,
  // @ts-expect-error — plain-JS worker, no d.ts
} from './worker.js';

/**
 * Part 3b of open submission (docs/OPEN-SUBMISSION-TASKS.md section 15): an
 * opted-in agent works open tasks and sends its result with a submitOpen from
 * its own wallet. These cover what decides whether a model run and the gas
 * are spent, and what happens to a result the server or the chain turns away.
 */

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
    expect(rd.output.startsWith(fit.output.split('\n\n[Truncated')[0])).toBe(true);
    expect(fit.output).toMatch(/full result is in storage/);
    // As long as it can be: one more character would not fit.
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeGreaterThan(OPEN_RESULT_DATA_MAX_BYTES - 8);
  });
});

describe('meetsOpenRewardFloor', () => {
  it('passes with no floor or no recorded reward', () => {
    expect(meetsOpenRewardFloor({ amount: '1', unit: USDC }, '', USDC)).toBe(true);
    expect(meetsOpenRewardFloor(undefined, '5000000', USDC)).toBe(true);
  });

  it('compares in the posting token', () => {
    expect(meetsOpenRewardFloor({ amount: '5000000', unit: USDC }, '5000000', USDC)).toBe(true);
    expect(meetsOpenRewardFloor({ amount: '4999999', unit: USDC }, '5000000', USDC)).toBe(false);
  });

  it('lets a reward in another unit through only a zero floor, like /accept', () => {
    const og = { amount: '10000000000000000000', unit: { symbol: '0G', decimals: 18 } };
    expect(meetsOpenRewardFloor(og, '1', USDC)).toBe(false);
    expect(meetsOpenRewardFloor(og, '0', USDC)).toBe(true);
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
    ['a reward under its minimum', entry({ reward: { amount: '999999', unit: USDC } }), /below this agent's minimum/],
  ])('skips %s', (_name, e, why) => {
    expect(openSkipReason(e, opts)).toMatch(why);
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

const evidence = openEvidenceHash({ output: 'x', agent: 'a' }, ROOT);
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
  it('gives the model no messaging tools and no delegation', () => {
    const tools = buildTools(HASH, { posterAddress: '0x' + 'b2'.repeat(20), messaging: false, delegation: false });
    expect(Object.keys(tools)).not.toEqual(expect.arrayContaining(['send_message']));
    expect(tools.wait_for_reply).toBeUndefined();
    expect(tools.delegate_to_agent).toBeUndefined();
  });
  it('still gives them to an assigned task', () => {
    const tools = buildTools(HASH, { posterAddress: '0x' + 'b2'.repeat(20) });
    expect(tools.send_message).toBeDefined();
    expect(tools.wait_for_reply).toBeDefined();
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
    postSubmitOpen: vi.fn(async () => ({ status: 200, ok: true, json: { data: { unsignedSubmitOpen: unsigned(), evidenceHash: evidence } } })),
    ...over,
  });
  const refused = (status: number, code: string) => vi.fn(async () => ({ status, ok: false, json: { success: false, error: { code, message: 'no' } } }));

  beforeEach(() => {
    state = createOpenState();
    sendTransaction = vi.fn(async () => ({ hash: '0x' + '77'.repeat(32), wait: async () => ({ blockNumber: 9 }) }));
  });

  it('posts the result, signs the submitOpen it checked, and is done once it lands', async () => {
    const deps = io();
    expect(await sendOpenResult(entry(), produced, deps, state)).toBe(true);
    expect(deps.postSubmitOpen).toHaveBeenCalledWith(HASH, { resultData: produced.resultData, rootHash: ROOT, teeAttestation: null });
    expect(sendTransaction).toHaveBeenCalledWith(unsigned());
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
      postSubmitOpen: vi.fn(async () => ({ status: 200, ok: true, json: { data: { unsignedSubmitOpen: unsigned({}, [41n, openEvidenceHash(sent, ROOT)]) } } })),
    });
    expect(await sendOpenResult(entry(), long, deps, state)).toBe(true);
    expect(deps.postSubmitOpen.mock.calls[0][1].resultData).toEqual(sent);
  });

  it('holds the result while the wallet cannot pay the gas', async () => {
    const deps = io({ preflight: vi.fn(async () => 'wallet holds 0 USDC on arc') });
    expect(await sendOpenResult(entry(), produced, deps, state)).toBe(false);
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(state.unsent.has(HASH)).toBe(true);
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
