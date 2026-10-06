import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { ApiError } from '../src/apiError.js';
import { BlindEscrowAbi } from '../src/chain/abi/index.js';
import { ESCROW_CALLS, checkEscrowCall } from '../src/escrowCalls.js';

/**
 * The open-submission calls the backend may hand a client to sign
 * (docs/OPEN-SUBMISSION-TASKS.md): each allowlisted fragment must be the
 * escrow's own function, and checkEscrowCall must refuse anything but the
 * exact call.
 */

const ESCROW = '0x00000000000000000000000000000000000e5c40';
const TOKEN = '0x3600000000000000000000000000000000000000';
const VERIFIER = '0x000000000000000000000000000000000000beef';
const WINNER = '0x000000000000000000000000000000000000c0de';
const OTHER = '0x000000000000000000000000000000000000dead';
const HASH = `0x${'ab'.repeat(32)}`;
const SCORECARD = `0x${'cd'.repeat(32)}`;
const escrowAbi = new ethers.Interface(BlindEscrowAbi as ethers.InterfaceAbi);

const refused = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe('the open-submission escrow calls', () => {
  it('are the escrow ABI functions, selector for selector', () => {
    for (const name of ['createTaskOpen', 'submitOpen', 'selectWinner', 'voidOpenTask']) {
      expect(ESCROW_CALLS.getFunction(name)!.selector, name).toBe(escrowAbi.getFunction(name)!.selector);
    }
  });

  it('pass checkEscrowCall when exactly the call asked for, with only to and data kept', () => {
    const data = ESCROW_CALLS.encodeFunctionData('submitOpen', [7n, HASH]);
    const out = checkEscrowCall(
      { to: ESCROW, data, value: 0, gasLimit: 1, nonce: 3 },
      { escrow: ESCROW, fn: 'submitOpen', args: (a) => a[0] === 7n && a[1] === HASH },
      'submitOpen',
    );
    expect(out).toEqual({ to: ethers.getAddress(ESCROW), data });

    const create = ESCROW_CALLS.encodeFunctionData('createTaskOpen', [HASH, TOKEN, 1_000_000n, 'general', 'global', 86_400n, VERIFIER, 1, 86_400n]);
    expect(
      checkEscrowCall(
        { to: ESCROW, data: create },
        { escrow: ESCROW, fn: 'createTaskOpen', args: (a) => a[6] === ethers.getAddress(VERIFIER) && a[7] === 1n && a[8] === 86_400n },
        'createTaskOpen',
      ).data,
    ).toBe(create);
  });

  it('refuse a pick for another winner, a void for another task, and any value', () => {
    const pick = ESCROW_CALLS.encodeFunctionData('selectWinner', [7n, OTHER, SCORECARD]);
    const expectPick = { escrow: ESCROW, fn: 'selectWinner' as const, args: (a: ethers.Result) => a[0] === 7n && a[1] === ethers.getAddress(WINNER) };
    refused(() => checkEscrowCall({ to: ESCROW, data: pick }, expectPick, 'selectWinner'), 'TX_MISMATCH');

    const voidOther = ESCROW_CALLS.encodeFunctionData('voidOpenTask', [8n, ethers.ZeroHash]);
    refused(() => checkEscrowCall({ to: ESCROW, data: voidOther }, { escrow: ESCROW, fn: 'voidOpenTask', args: (a) => a[0] === 7n }, 'voidOpenTask'), 'TX_MISMATCH');

    const submit = ESCROW_CALLS.encodeFunctionData('submitOpen', [7n, HASH]);
    refused(
      () => checkEscrowCall({ to: ESCROW, data: submit, value: 1 }, { escrow: ESCROW, fn: 'submitOpen', args: () => true }, 'submitOpen'),
      'TX_MISMATCH',
    );
    // A submitEvidence is not a submitOpen, even with the same arguments.
    const evidence = ESCROW_CALLS.encodeFunctionData('submitEvidence', [7n, HASH]);
    refused(() => checkEscrowCall({ to: ESCROW, data: evidence }, { escrow: ESCROW, fn: 'submitOpen', args: () => true }, 'submitOpen'), 'TX_MISMATCH');
  });
});
