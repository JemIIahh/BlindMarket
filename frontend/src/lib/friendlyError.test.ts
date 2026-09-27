import { describe, expect, it } from 'vitest';
import { id, makeError } from 'ethers';
import { REVERT_SELECTORS, UserFacingError, friendlyError, friendlyErrorText } from './friendlyError';
import { ApiError } from './api';
import { RelayError } from './txSigner';

const selector = (sig: string) => id(sig).slice(0, 10);
const word = (n: number) => n.toString(16).padStart(64, '0');

/** What a Privy embedded wallet's reject turns into once ethers wraps it. */
function walletReject() {
  return makeError('user rejected action', 'ACTION_REJECTED', {
    action: 'sendTransaction',
    reason: 'rejected',
    info: {
      error: { code: 4001, message: 'The user rejected the request' },
      payload: { method: 'eth_sendTransaction', params: [{ to: '0x3600000000000000000000000000000000000000', data: '0x095ea7b3' + word(1) }] },
    },
  });
}

describe('friendlyError: wallet cancels', () => {
  it('turns the ethers ACTION_REJECTED dump into a cancel', () => {
    const err = walletReject();
    expect(err.message).toContain('code=ACTION_REJECTED');
    expect(friendlyError(err)).toEqual({ kind: 'cancelled', title: 'Cancelled in your wallet', message: 'Nothing was sent.' });
  });

  it('knows the dump even as bare text (a message someone stored as a string)', () => {
    const text = 'user rejected action (action="sendTransaction", reason="rejected", info={ "error": { "code": 4001, "message": "The user rejected the request" } }, code=ACTION_REJECTED, version=6.17.0)';
    expect(friendlyError(new Error(text)).kind).toBe('cancelled');
    expect(friendlyError(text).kind).toBe('cancelled');
  });

  it('knows EIP-1193 4001, viem, Privy and this app\'s own wording', () => {
    expect(friendlyError({ code: 4001, message: 'User rejected the request.' }).kind).toBe('cancelled');
    expect(friendlyError(Object.assign(new Error('User rejected the request.\n\nDetails: x\nVersion: viem@2.21.0'), {
      name: 'UserRejectedRequestError', code: 4001, shortMessage: 'User rejected the request.',
    })).kind).toBe('cancelled');
    expect(friendlyError(Object.assign(new Error('User exited'), { privyErrorCode: 'exited_auth_flow' })).kind).toBe('cancelled');
    expect(friendlyError(new Error('MetaMask Tx Signature: User denied transaction signature.')).kind).toBe('cancelled');
    expect(friendlyError(new Error('You rejected the request in your wallet.')).kind).toBe('cancelled');
  });

  it('says a replaced payment was not made', () => {
    const f = friendlyError(new RelayError('TX_CANCELLED', `Transaction 0x${'ab'.repeat(32)} was cancelled or replaced in the wallet, so this payment was not made.`));
    expect(f.kind).toBe('cancelled');
    expect(f.message).not.toMatch(/0x[0-9a-f]{16}/i);
  });
});

describe('friendlyError: money and networks', () => {
  it('maps INSUFFICIENT_FUNDS and the ERC-20 balance revert to "Not enough USDC"', () => {
    const gas = makeError('insufficient funds for intrinsic transaction cost', 'INSUFFICIENT_FUNDS', { transaction: {} });
    expect(friendlyError(gas)).toMatchObject({ kind: 'funds', title: 'Not enough USDC', message: 'You need a little more USDC to cover this and the network fee.' });
    const balance = makeError('execution reverted (unknown custom error)', 'CALL_EXCEPTION', {
      action: 'estimateGas',
      data: selector('ERC20InsufficientBalance(address,uint256,uint256)') + word(1) + word(2) + word(3),
      reason: null, transaction: { to: '0x', data: '0x' }, invocation: null, revert: null,
    });
    expect(friendlyError(balance)).toMatchObject({ kind: 'funds', title: 'Not enough USDC' });
    expect(friendlyError(new Error('execution reverted: "ERC20: transfer amount exceeds balance"')).kind).toBe('funds');
  });

  it('names the coin that pays gas when it is not USDC', () => {
    const gas = makeError('insufficient funds for intrinsic transaction cost', 'INSUFFICIENT_FUNDS', { transaction: {} });
    expect(friendlyError(gas, { gasToken: 'ETH', network: 'Ethereum' }))
      .toMatchObject({ kind: 'funds', title: 'Not enough ETH', message: 'You need a little ETH on Ethereum to pay the network fee.' });
    // A USDC balance revert is about USDC wherever gas comes from.
    expect(friendlyError(new Error('execution reverted: "ERC20: transfer amount exceeds balance"'), { gasToken: 'ETH' }).title).toBe('Not enough USDC');
  });

  it('names the network the wallet should switch to', () => {
    const ours = new RelayError('WRONG_CHAIN', 'Your wallet is on chain 1, not arc (5042). Switch to arc and try again.');
    expect(friendlyError(ours)).toMatchObject({ kind: 'chain', title: 'Wrong network', message: 'Switch your wallet to Arc and try again.' });
    const direct = new Error('Your wallet is on chain 5042, not Ethereum (1). Switch networks in your wallet and try again.');
    expect(friendlyError(direct).message).toBe('Switch your wallet to Ethereum and try again.');
    const viem = Object.assign(new Error('x'), {
      name: 'ChainMismatchError',
      shortMessage: 'The current chain of the wallet (id: 1) does not match the target chain for the transaction (id: 8453 – Base).',
    });
    expect(friendlyError(viem).message).toBe('Switch your wallet to Base and try again.');
    expect(friendlyError({ code: 4902, message: 'Unrecognized chain ID' }).message).toBe('Switch your wallet to Arc and try again.');
    expect(friendlyError({ code: 4902, message: 'Unrecognized chain ID' }, { network: 'Polygon' }).message).toBe('Switch your wallet to Polygon and try again.');
  });

  it('maps fetch failures, ethers network errors and timeouts to a connection hint', () => {
    for (const err of [
      new TypeError('Failed to fetch'),
      new TypeError('NetworkError when attempting to fetch resource.'),
      new TypeError('Load failed'),
      makeError('could not detect network', 'NETWORK_ERROR', { event: 'noNetwork' }),
      Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }),
    ]) {
      expect(friendlyError(err)).toMatchObject({ kind: 'network', title: "Couldn't reach the network", message: 'Check your connection and try again.' });
    }
    expect(friendlyError(new ApiError('TIMEOUT', 'The server did not respond within 120s. It may be starting up — try again in a moment.')))
      .toMatchObject({ kind: 'network', title: "The server didn't answer" });
  });

  it('leaves an app sentence about waiting alone', () => {
    const text = 'Timed out waiting for the agent. It may still be running — check My tasks for the result and settlement.';
    expect(friendlyError(text)).toEqual({ kind: 'unknown', title: 'Something went wrong', message: text });
  });
});

describe('REVERT_SELECTORS', () => {
  it('matches the contracts\' error signatures', () => {
    const signatures = [
      'NotAgent()', 'NotWorker()', 'NotVerifier()', 'NotAdmin()', 'OwnableUnauthorizedAccount(address)',
      'InvalidStatus(uint8,uint8)', 'SelfAssignment()', 'DeadlineReached()', 'DeadlineNotReached()',
      'DisputeWindowActive()', 'AppealWindowActive()', 'EscalatedForAdjudication()', 'NotEscalated()',
      'MaxSubmissionAttemptsReached()', 'TokenNotAllowed()', 'InvalidDeadline()', 'ZeroAmount()', 'EmptyHash()',
      'InvalidTEESignature()', 'TEESignerNotSet()', 'EnforcedPause()', 'AgentFundingNotSupported()',
      'ERC20InsufficientBalance(address,uint256,uint256)', 'InsufficientUSDC()',
      'ERC20InsufficientAllowance(address,uint256,uint256)', 'SafeERC20FailedOperation(address)',
    ];
    expect(Object.keys(REVERT_SELECTORS)).toHaveLength(signatures.length);
    for (const sig of signatures) expect(REVERT_SELECTORS[selector(sig)]).toBe(sig.slice(0, sig.indexOf('(')));
  });
});

describe('friendlyError: contract reverts', () => {
  const revert = (data: string, extra: Record<string, unknown> = {}) => makeError('execution reverted (unknown custom error)', 'CALL_EXCEPTION', {
    action: 'estimateGas', data, reason: null, transaction: { to: '0x', data: '0x' }, invocation: null, revert: null, ...extra,
  });

  it('decodes escrow errors from raw revert data', () => {
    expect(friendlyError(revert(selector('NotAgent()')))).toMatchObject({ kind: 'revert', title: 'Not your task', message: 'Only the wallet that posted this task can do this.' });
    expect(friendlyError(revert(selector('DeadlineReached()')))).toMatchObject({ title: 'Deadline passed' });
    expect(friendlyError(revert(selector('SelfAssignment()'))).message).toMatch(/poster can't also work on it/);
    expect(friendlyError(revert(selector('NotVerifier()'))).title).toBe('Not the verifier');
  });

  it('reads the current status out of InvalidStatus', () => {
    const f = friendlyError(revert(selector('InvalidStatus(uint8,uint8)') + word(5) + word(0)));
    expect(f).toMatchObject({ kind: 'revert', title: 'Task has moved on' });
    expect(f.message).toContain('already cancelled');
  });

  it('uses a decoded name when an ABI supplied one', () => {
    const err = makeError('execution reverted: DeadlineNotReached()', 'CALL_EXCEPTION', {
      action: 'estimateGas', data: '0x', reason: null, transaction: { to: '0x', data: '0x' }, invocation: null,
      revert: { name: 'DeadlineNotReached', signature: 'DeadlineNotReached()', args: [] },
    });
    expect(friendlyError(err).title).toBe('Too early');
  });

  it('says nothing was sent for an unknown revert, and quotes a plain reason', () => {
    expect(friendlyError(revert('0xdeadbeef'))).toMatchObject({ kind: 'revert', title: 'Transaction would fail', message: 'The contract refused this transaction, so nothing was sent.' });
    const reasoned = makeError('execution reverted: "Ownable: caller is not the owner"', 'CALL_EXCEPTION', {
      action: 'estimateGas', data: '0x08c379a0', reason: 'Ownable: caller is not the owner', transaction: { to: '0x', data: '0x' }, invocation: null, revert: null,
    });
    expect(friendlyError(reasoned).message).toBe('The contract refused it ("Ownable: caller is not the owner"), so nothing was sent.');
  });

  it('says a mined revert changed nothing but the fee', () => {
    const f = friendlyError(new RelayError('TX_REVERTED', `Transaction 0x${'cd'.repeat(32)} reverted on-chain, so it had no effect (only its gas was spent).`));
    expect(f).toMatchObject({ kind: 'revert', title: 'Transaction failed' });
    expect(f.details).toContain('TX_REVERTED');
  });
});

describe('friendlyError: backend and unknown errors', () => {
  it('passes a clean backend message through with the caller\'s title', () => {
    expect(friendlyError(new ApiError('NOT_FOUND', 'Task not found', 404), { title: "Couldn't load the task" }))
      .toEqual({ kind: 'unknown', title: "Couldn't load the task", message: 'Task not found' });
  });

  it('hides raw server bodies and rate limits behind plain words', () => {
    expect(friendlyError(new ApiError('PARSE_ERROR', 'Invalid JSON from server: <!DOCTYPE html><html>', 502)))
      .toMatchObject({ kind: 'server', title: 'The server had a problem' });
    expect(friendlyError(new ApiError('RATE_LIMITED', 'Too many requests, please try again later.', 429)).title).toBe('Too many requests');
  });

  it('keeps raw text in details only', () => {
    const raw = new Error('{"code":-32000,"message":"header not found"}');
    const f = friendlyError(raw);
    expect(f.message).toBe('Try again. If it keeps happening, send the details below to support.');
    expect(f.details).toContain('header not found');
  });

  it('shortens long hex and keeps the full text in details', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const f = friendlyError(new Error(`Task ${hash} is not registered`));
    expect(f.message).toBe('Task 0xabab…abab is not registered');
    expect(f.details).toContain(hash);
  });

  it('keeps a 40-hex address whole, so an instruction naming it stays usable', () => {
    const addr = `0x${'ab'.repeat(20)}`;
    const text = `Send USDC to ${addr} from your wallet instead.`;
    expect(friendlyError(new Error(text)).message).toBe(text);
    expect(friendlyError(text).message).toBe(text);
  });

  it('copes with values that are not errors', () => {
    expect(friendlyError(undefined)).toEqual({ kind: 'unknown', title: 'Something went wrong', message: 'Try again in a moment.' });
    expect(friendlyError(null).kind).toBe('unknown');
    expect(friendlyError(42).kind).toBe('unknown');
  });

  it('never puts JSON, a stack or a long hex blob in the message', () => {
    const stacky = new Error('boom');
    const samples: unknown[] = [
      walletReject(),
      makeError('could not coalesce error', 'UNKNOWN_ERROR', { error: { code: -32603, message: 'Internal JSON-RPC error.' }, payload: {} }),
      new Error(`execution reverted, data="0x${'12'.repeat(40)}"`),
      new Error('Error: x\n    at foo (bar.js:1:1)'),
      stacky.stack ?? 'Error: boom\n    at x',
      { foo: 'bar' },
      new ApiError('UPSTREAM_ERROR', `{"error":"privy","hash":"0x${'ef'.repeat(32)}"}`, 502),
    ];
    for (const s of samples) {
      const { message } = friendlyError(s);
      expect(message).not.toMatch(/[{}]|\n\s*at\s|0x[0-9a-fA-F]{64,}/);
    }
  });
});

describe('UserFacingError', () => {
  it('reaches the page as written, with the wrapped failure in details', () => {
    const err = new UserFacingError('Your payment stays in escrow. Try again shortly.', { title: 'Listing still failed', cause: new TypeError('Failed to fetch') });
    expect(friendlyError(err)).toEqual({
      kind: 'unknown',
      title: 'Listing still failed',
      message: 'Your payment stays in escrow. Try again shortly.',
      details: 'Failed to fetch',
    });
  });

  it('can mark a still-running operation, so it is not shown as a failure to retry', () => {
    const err = new UserFacingError('Still bridging after 10 minutes. It may complete shortly.', { title: 'Still in progress', kind: 'maybeSent' });
    expect(friendlyError(err, { title: "Couldn't bridge USDC" })).toEqual({
      kind: 'maybeSent',
      title: 'Still in progress',
      message: 'Still bridging after 10 minutes. It may complete shortly.',
    });
  });
});

describe('friendlyErrorText', () => {
  it('joins title and message, or gives the bare message for an unknown error', () => {
    expect(friendlyErrorText(walletReject())).toBe('Cancelled in your wallet. Nothing was sent.');
    expect(friendlyErrorText(new Error('Agent is paused'))).toBe('Agent is paused');
    // No "details below" where no details are shown.
    expect(friendlyErrorText(new Error('{"code":-32000}'))).toBe('Something went wrong. Try again in a moment.');
  });
});

const SENT = `0x${'5e'.repeat(32)}`;

/** ethers v6 JsonRpcSigner.sendTransaction: the poll after eth_sendTransaction
 *  failed, so it rethrows with info.sendTransactionHash (provider-jsonrpc.js). */
function failedAfterBroadcast(code: 'NETWORK_ERROR' | 'BAD_DATA' | 'CANCELLED', message: string) {
  const err = makeError(message, code as 'NETWORK_ERROR');
  return Object.assign(err, { info: { sendTransactionHash: SENT } });
}

describe('friendlyError: sent, then the wait failed', () => {
  it('never tells someone to try again once the wallet has broadcast', () => {
    for (const err of [
      failedAfterBroadcast('NETWORK_ERROR', 'network changed: 5042 => 1'),
      failedAfterBroadcast('BAD_DATA', 'invalid transaction response'),
      failedAfterBroadcast('CANCELLED', 'operation was cancelled'),
    ]) {
      const f = friendlyError(err);
      expect(f).toMatchObject({
        kind: 'maybeSent',
        title: 'It may have gone through',
        message: "Your wallet sent it, but we couldn't confirm it. Check your balance or the task list before trying again.",
        txHash: SENT,
      });
      expect(f.details).toContain(SENT);
      expect(f.message).not.toMatch(/switch|network|try again\.$/i);
    }
  });

  it('finds the hash when a caller wrapped the ethers error', () => {
    const wrapped = Object.assign(new Error('Posting failed'), { cause: failedAfterBroadcast('NETWORK_ERROR', 'network changed: 5042 => 1') });
    expect(friendlyError(wrapped)).toMatchObject({ kind: 'maybeSent', txHash: SENT });
  });

  it('reads the hash out of viem\'s receipt-wait errors, and nothing else', () => {
    const timeout = Object.assign(new Error(`Timed out while waiting for transaction with hash "${SENT}" to be confirmed.`), {
      name: 'WaitForTransactionReceiptTimeoutError',
    });
    expect(friendlyError(timeout)).toMatchObject({ kind: 'maybeSent', txHash: SENT });
    const notFound = Object.assign(new Error(`Transaction receipt with hash "${SENT}" could not be found.`), {
      name: 'TransactionReceiptNotFoundError',
    });
    expect(friendlyError(notFound).kind).toBe('maybeSent');
    // A hash in some other error's text is not a broadcast.
    expect(friendlyError(new Error(`Transaction receipt with hash "${SENT}" could not be found.`)).kind).not.toBe('maybeSent');
    // No hash: an ordinary network change still says "switch".
    expect(friendlyError(makeError('network changed: 5042 => 1', 'NETWORK_ERROR')).kind).toBe('chain');
  });
});

describe('friendlyError: an outdated build', () => {
  it('asks for a reload when a lazy chunk fails, but a plain fetch failure stays a network error', () => {
    expect(friendlyError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/a.js'))).toMatchObject({
      kind: 'outdated',
      title: 'A new version is out',
      message: 'Reload the page to continue. Nothing was sent.',
    });
    expect(friendlyError(new TypeError('Importing a module script failed.')).kind).toBe('outdated');
    expect(friendlyError(new TypeError('Failed to fetch')).kind).toBe('network');
  });
});

describe('friendlyError: backend validation errors', () => {
  const zodMessage = (issues: unknown[]) => JSON.stringify(issues, null, 2);

  it('names each field the server refused instead of "try again"', () => {
    const err = new ApiError('VALIDATION_ERROR', zodMessage([
      { code: 'invalid_type', expected: 'string', received: 'undefined', path: ['name'], message: 'Required' },
      { code: 'invalid_type', expected: 'string', received: 'number', path: ['services', 0, 'price'], message: 'Expected string, received number' },
      { code: 'unrecognized_keys', keys: ['extra'], path: [], message: "Unrecognized key(s) in object: 'extra'" },
    ]), 400);
    const f = friendlyError(err, { title: "Couldn't deploy" });
    expect(f).toMatchObject({
      kind: 'server',
      title: 'Check the form',
      message: "name: Required; services.0.price: Expected string, received number; Unrecognized key(s) in object: 'extra'",
    });
    expect(f.details).toContain('invalid_type');
  });

  it('shows three issues and counts the rest', () => {
    const issues = ['a', 'b', 'c', 'd', 'e'].map((field) => ({ code: 'custom', path: [field], message: 'Required' }));
    expect(friendlyError(new ApiError('VALIDATION_ERROR', zodMessage(issues), 400)).message)
      .toBe('a: Required; b: Required; c: Required (and 2 more)');
  });

  it('passes a plain-text validation message through as before', () => {
    const f = friendlyError(new ApiError('VALIDATION_ERROR', 'Unknown skill slug: web-searcher', 400));
    expect(f).toMatchObject({ title: 'Something went wrong', message: 'Unknown skill slug: web-searcher' });
  });
});
