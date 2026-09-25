import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { BlindMarket } from '../src/index.js';
import { evidenceHashOf } from '../src/escrowCalls.js';

/**
 * deliverResult() signs the submitEvidence the backend builds, with the
 * executor key (WorkerRuntime does this for every task it accepts, and so does
 * the submit_result tool). It used to hand the backend's object straight to
 * Wallet.sendTransaction: whoever answered /submit could have the executor
 * sign a native transfer or any call on any chain it had an RPC for. Now only
 * a zero-value submitEvidence on the named chain's escrow, committing the
 * result just sent, is signed, and only its to and data (security audit run 1,
 * C41). The settlement fixture is production's /health/settlement.
 */

const SETTLEMENT = JSON.parse(readFileSync(new URL('../../fixtures/prod/health-settlement.json', import.meta.url), 'utf-8')).data;
const ARC = SETTLEMENT.chains.find((c: { chain: string }) => c.chain === 'arc');
const ESCROW = ARC.escrowAddress as string;
const USDC = ARC.token.address as string;
const CHAIN_ID = ARC.chainId as number;

const TASK = `0x${'ab'.repeat(32)}`;
const KEY = `0x${'1'.repeat(64)}`;
const RESULT = { output: 'A one-sentence summary of the paragraph, as asked.' };
const DEAD = '0x000000000000000000000000000000000000dEaD';
const SENT_HASH = `0x${'11'.repeat(32)}`;

const escrow = new ethers.Interface([
  'function submitEvidence(uint256 taskId, bytes32 evidenceHash)',
  'function cancelTask(uint256 taskId)',
]);
const erc20 = new ethers.Interface(['function approve(address,uint256)']);
const submitData = (taskId: bigint, result: Record<string, unknown> = RESULT) =>
  escrow.encodeFunctionData('submitEvidence', [taskId, evidenceHashOf(result)]);

const ok = (data: unknown) => ({ status: 200, json: async () => ({ success: true, data }) }) as unknown as Response;
const fail = (status: number, code: string) => ({ status, json: async () => ({ success: false, error: { code, message: code } }) }) as unknown as Response;

let sent: ethers.TransactionRequest[];
let rpcChainId: bigint;
beforeEach(() => {
  sent = [];
  rpcChainId = BigInt(CHAIN_ID);
  vi.spyOn(ethers.Wallet.prototype, 'sendTransaction').mockImplementation(async (tx) => {
    sent.push(tx);
    return { hash: SENT_HASH, wait: async () => ({ status: 1 }) } as unknown as ethers.TransactionResponse;
  });
  vi.spyOn(ethers.JsonRpcProvider.prototype, 'getNetwork').mockImplementation(async () => new ethers.Network('stub', rpcChainId));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Answers { submit?: Response; rebroadcast?: Record<string, unknown> }

function backend(a: Answers) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? 'GET'} ${u.replace(/^https?:\/\/[^/]+/, '')}`);
    if (u.endsWith('/health/settlement')) return ok(SETTLEMENT);
    if (u.endsWith('/submit')) return a.submit ?? fail(500, 'NO_SUBMIT_STUB');
    if (u.endsWith('/rebroadcast')) return ok(a.rebroadcast);
    if (u.endsWith('/finalize')) return ok({ taskId: TASK, status: 'verified', verificationResult: { passed: true } });
    throw new Error(`unhandled fetch ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}
const built = (unsignedSubmitEvidence: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ok({ taskId: TASK, onChainTaskId: '7', status: 'submitted', chain: 'arc', evidenceHash: evidenceHashOf(RESULT), unsignedSubmitEvidence, ...extra });

const deliver = () => new BlindMarket({ apiKey: 'k', executor: { privateKey: KEY, rpcUrls: { arc: 'http://arc.invalid' } } })
  .deliverResult(TASK, RESULT);

describe('BlindMarket.deliverResult — what the backend may have the executor sign', () => {
  it('signs a correct submitEvidence with only its to and data, then finalizes', async () => {
    const calls = backend({ submit: built({ to: ESCROW, data: submitData(7n), from: DEAD, chainId: CHAIN_ID, gasLimit: '21000', maxFeePerGas: '1', nonce: 99, type: 0 }) });
    await expect(deliver()).resolves.toMatchObject({ status: 'verified', submitTxHash: SENT_HASH });
    expect(sent).toEqual([{ to: ESCROW, data: submitData(7n) }]);
    // The settlement table is read before /submit records the result.
    expect(calls.findIndex((c) => c.endsWith('/health/settlement'))).toBeLessThan(calls.findIndex((c) => c.endsWith('/submit')));
  });

  it('refuses a native transfer to another address (the recorded attack), with nothing sent', async () => {
    backend({ submit: built({ to: DEAD, value: '5000000000000000000', data: '0x', chainId: CHAIN_ID }) });
    await expect(deliver()).rejects.toMatchObject({ code: 'ESCROW_MISMATCH' });
    expect(sent).toHaveLength(0);
  });

  it('refuses a value, an approve, another task or another evidence hash on the escrow', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['value', { to: ESCROW, data: submitData(7n), value: '1' }],
      ['approve', { to: ESCROW, data: erc20.encodeFunctionData('approve', [DEAD, 2n ** 256n - 1n]) }],
      ['other function', { to: ESCROW, data: escrow.encodeFunctionData('cancelTask', [7n]) }],
      ['other task', { to: ESCROW, data: submitData(8n) }],
      ['other result', { to: ESCROW, data: submitData(7n, { output: 'something the executor never sent' }) }],
    ];
    for (const [name, tx] of cases) {
      backend({ submit: built(tx) });
      await expect(deliver(), name).rejects.toMatchObject({ code: 'TX_MISMATCH' });
    }
    expect(sent).toHaveLength(0);
  });

  it('refuses a transaction on the token instead of the escrow', async () => {
    backend({ submit: built({ to: USDC, data: erc20.encodeFunctionData('approve', [DEAD, 1n]) }) });
    await expect(deliver()).rejects.toMatchObject({ code: 'ESCROW_MISMATCH' });
    expect(sent).toHaveLength(0);
  });

  it('refuses a chain id that is not the named chain\'s, a chain with no listed escrow, and a signer on another chain', async () => {
    backend({ submit: built({ to: ESCROW, data: submitData(7n), chainId: 8453 }) });
    await expect(deliver()).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' });

    backend({ submit: built({ to: ESCROW, data: submitData(7n) }, { chain: 'solana' }) });
    const onSolana = new BlindMarket({ apiKey: 'k', executor: { privateKey: KEY, rpcUrls: { solana: 'http://sol.invalid' } } });
    await expect(onSolana.deliverResult(TASK, RESULT)).rejects.toMatchObject({ code: 'CHAIN_UNKNOWN' });

    rpcChainId = 84532n;
    backend({ submit: built({ to: ESCROW, data: submitData(7n) }) });
    await expect(deliver()).rejects.toMatchObject({ code: 'WRONG_CHAIN' });
    expect(sent).toHaveLength(0);
  });

  it('heals a stranded task through /rebroadcast, which re-sends the FIRST stored result', async () => {
    const first = { output: 'the output the first, interrupted call submitted' };
    backend({
      submit: fail(409, 'INVALID_STATE'),
      rebroadcast: { taskId: TASK, onChainTaskId: '7', chain: 'arc', unsignedSubmitEvidence: { to: ESCROW, data: submitData(7n, first) } },
    });
    await expect(deliver()).resolves.toMatchObject({ submitTxHash: SENT_HASH });
    expect(sent).toEqual([{ to: ESCROW, data: submitData(7n, first) }]);
  });

  it('refuses a /rebroadcast that is not a submitEvidence on the escrow', async () => {
    backend({
      submit: fail(409, 'INVALID_STATE'),
      rebroadcast: { taskId: TASK, onChainTaskId: '7', chain: 'arc', unsignedSubmitEvidence: { to: ESCROW, data: erc20.encodeFunctionData('approve', [DEAD, 1n]) } },
    });
    await expect(deliver()).rejects.toMatchObject({ code: 'TX_MISMATCH' });
    expect(sent).toHaveLength(0);
  });
});
