import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * fundingState: whether a funding transaction the CLI sent can still land,
 * from raw JSON-RPC answers. Only proof that it never will (a revert, or its
 * nonce used by another transaction) frees a funded row to be posted again.
 */
const { fundingState } = await import('../dist/funding.js');

const HASH = '0x' + 'ab'.repeat(32);
const FROM = '0x' + '11'.repeat(20);

/** A node that answers from `state`, recording the calls. */
function node(state) {
  const calls = [];
  let receiptReads = 0;
  return {
    calls,
    send: async (method, params) => {
      calls.push(method);
      if (state.fails) throw new Error('rpc down');
      switch (method) {
        case 'eth_getTransactionCount':
          assert.deepEqual(params, [FROM, 'latest']);
          return '0x' + state.confirmed.toString(16);
        case 'eth_getTransactionReceipt':
          receiptReads++;
          return (receiptReads > 1 && state.receiptLater) || state.receipt || null;
        case 'eth_getTransactionByHash':
          return state.inMempool ? { hash: HASH } : null;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
}
const sent = { txHash: HASH, nonce: 5, from: FROM };

test('mined: a receipt with status 1', async () => {
  assert.equal(await fundingState(node({ confirmed: 6, receipt: { status: '0x1' } }), sent), 'mined');
});

test('reverted: a receipt with status 0 means nothing was escrowed', async () => {
  assert.equal(await fundingState(node({ confirmed: 6, receipt: { status: '0x0' } }), sent), 'reverted');
});

test('pending: still in the mempool, even with its nonce passed', async () => {
  assert.equal(await fundingState(node({ confirmed: 9, inMempool: true }), sent), 'pending');
});

test('pending: nowhere to be seen, but its nonce is not used yet, so it could still be sent', async () => {
  assert.equal(await fundingState(node({ confirmed: 5 }), sent), 'pending');
  assert.equal(await fundingState(node({ confirmed: 2 }), sent), 'pending');
});

test('dropped: no receipt, unknown to the node, and another transaction used its nonce', async () => {
  const n = node({ confirmed: 6 });
  assert.equal(await fundingState(n, sent, { recheckMs: 0 }), 'dropped');
  // The nonce is read before the receipt, and the receipt is read twice before giving up on it.
  assert.deepEqual(n.calls, ['eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);
});

test('a receipt that appears on the second read is not dropped', async () => {
  assert.equal(await fundingState(node({ confirmed: 6, receiptLater: { status: '0x1' } }), sent, { recheckMs: 0 }), 'mined');
});

test('unknown: no nonce saved, or the RPC fails: never treated as dropped', async () => {
  assert.equal(await fundingState(node({ confirmed: 99 }), { txHash: HASH }), 'unknown');
  assert.equal(await fundingState(node({ fails: true }), sent), 'unknown');
  assert.equal(await fundingState(node({ confirmed: 6, receipt: {} }), sent), 'unknown');
});

// ── re-broadcasting a funding no node has, while its nonce is unused ────────

const { Wallet, keccak256 } = await import('ethers');
const signer = Wallet.createRandom();
const RAW = await signer.signTransaction({ to: '0x' + '22'.repeat(20), nonce: 5, gasLimit: 21000n, gasPrice: 1n, chainId: 5042002n, value: 0n });
const RAW_HASH = keccak256(RAW);

/** A node where the transaction is nowhere; eth_sendRawTransaction answers as `send` says. */
function emptyNode({ confirmed = 5, send = 'ok', confirmedAfterReject = confirmed, landsAfterSend = true }) {
  const calls = [];
  let sent = false;
  let rejected = false;
  return {
    calls,
    send: async (method, params) => {
      calls.push(method);
      switch (method) {
        case 'eth_getTransactionCount': return '0x' + (rejected ? confirmedAfterReject : confirmed).toString(16);
        case 'eth_getTransactionReceipt': return sent && landsAfterSend ? { status: '0x1' } : null;
        case 'eth_getTransactionByHash': return null;
        case 'eth_sendRawTransaction':
          assert.equal(params[0], RAW);
          if (send === 'ok') { sent = true; return RAW_HASH; }
          rejected = true;
          throw new Error(send);
        default: throw new Error(`unexpected ${method}`);
      }
    },
  };
}
const saved = { txHash: RAW_HASH, nonce: 5, from: FROM, raw: RAW };

test('a funding no node has, with its nonce unused, is sent again as is and lands once', async () => {
  const n = emptyNode({});
  let rebroadcast = false;
  assert.equal(await fundingState(n, saved, { pollMs: 0, onRebroadcast: () => { rebroadcast = true; } }), 'mined');
  assert.equal(rebroadcast, true);
  assert.equal(n.calls.filter((c) => c === 'eth_sendRawTransaction').length, 1);
});

test('a re-sent funding that has not landed within the wait stays pending', async () => {
  assert.equal(await fundingState(emptyNode({ landsAfterSend: false }), saved, { waitMs: 0, pollMs: 0 }), 'pending');
});

test('refused because something else took the nonce meanwhile: dropped, as before', async () => {
  assert.equal(await fundingState(emptyNode({ send: 'nonce too low', confirmedAfterReject: 6 }), saved, { recheckMs: 0 }), 'dropped');
});

test('refused with the nonce still unused: pending, never freed', async () => {
  assert.equal(await fundingState(emptyNode({ send: 'insufficient funds' }), saved, { recheckMs: 0 }), 'pending');
});

test('never re-sent: a raw transaction that is not the saved hash, no raw, or a nonce gap before it', async () => {
  const other = await signer.signTransaction({ to: '0x' + '33'.repeat(20), nonce: 5, gasLimit: 21000n, gasPrice: 1n, chainId: 5042002n, value: 0n });
  for (const [f, confirmed] of [[{ ...saved, raw: other }, 5], [{ ...saved, raw: undefined }, 5], [saved, 3]]) {
    const n = emptyNode({ confirmed });
    assert.equal(await fundingState(n, f, { pollMs: 0 }), 'pending');
    assert.equal(n.calls.includes('eth_sendRawTransaction'), false);
  }
});
