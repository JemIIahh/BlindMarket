import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface } from 'ethers';

/**
 * On 0G the local wallet pays, and the escrow ADDRESS is checked before every
 * send — but a testnet backend's escrow address, paid on the mainnet RPC, is
 * just some other account there. A backend that names its 0G chain id lets
 * this process refuse before anything is sent.
 */

process.env.BLINDMARKET_STATE_DIR = mkdtempSync(join(tmpdir(), 'bm-mcp-state-'));
delete process.env.BLINDMARKET_SETTLEMENT;

const { registerRentTools } = await import('../dist/rent.js');

const OG_ESCROW = '0x037529B296a89E6Dd1abAF84D413cb2dD70C5be5';
let builtChainId;
let sent;

beforeEach(() => {
  builtChainId = 16602;
  sent = [];
});

const ESCROW_CALLS = new Interface(['function createTask(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration)']);

globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace(/^https?:\/\/[^/]+/, '');
  const body = init.body ? JSON.parse(init.body) : undefined;
  const json = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
  if (path === '/health/bridge') {
    return json({
      configured: false, base: null, postingChain: '0g',
      chains: [{ chain: '0g', configured: true, chainId: 16602, escrowAddress: OG_ESCROW, token: { kind: 'native', address: '0x' + '0'.repeat(40), symbol: '0G', decimals: 18 }, relayChain: null, postable: true }],
    });
  }
  if (path === '/api/v1/storage/upload') return json({ rootHash: '0x' + 'cd'.repeat(32) });
  if (path === '/api/v1/tasks') {
    const data = ESCROW_CALLS.encodeFunctionData('createTask', [body.taskHash, body.token, body.amount, 'general', body.locationZone, body.duration]);
    return json({ unsignedTx: { to: OG_ESCROW, data, value: body.amount }, chain: '0g', chainId: builtChainId });
  }
  // A hash the backend resolves to a Base task.
  if (path === `/api/v1/tasks/${'0x' + 'ba'.repeat(32)}`) return json({ taskId: '5', taskHash: '0x' + 'ba'.repeat(32), status: 0, amount: '1000000', deadline: '9999999999', token: '0x' + '36'.repeat(20), decimals: 6, chain: 'base' });
  throw new Error('unexpected backend call ' + path);
};

function tools(walletChainId) {
  const handlers = {};
  const server = { registerTool: (name, _def, handler) => { handlers[name] = handler; } };
  const walletCtx = {
    chainId: walletChainId,
    rpcUrl: 'http://127.0.0.1:9',
    provider: { getBalance: async () => 10n ** 18n, getCode: async () => '0x6080' },
    wallet: {
      address: '0x' + '44'.repeat(20),
      sendTransaction: async (tx) => { sent.push(tx); throw new Error('stub wallet: not sending'); },
    },
  };
  registerRentTools(server, { apiKey: 'sk_test', apiBase: 'https://backend.test', authenticated: true }, walletCtx);
  return handlers;
}

const args = { instructions: 'Summarise this paragraph in one sentence.', amount: '0.01', privacy: 'public' };

test('a local wallet on another chain than the backend\'s 0G is refused before anything is sent', async () => {
  const t = tools(16661);
  const res = await t.post_task({ ...args, idempotencyKey: 'local-native-mismatch-1' });
  assert.equal(res.isError, true);
  const { error } = JSON.parse(res.content[0].text);
  assert.equal(error.code, 'CHAIN_MISMATCH');
  assert.match(error.message, /settles 0G on chain 16602, but BLINDMARKET_PRIVATE_KEY signs on chain 16661/);
  assert.equal(sent.length, 0);
});

test('on the right chain it quotes, and pins the chain id on the send', async () => {
  const t = tools(16602);
  const { quote } = JSON.parse((await t.post_task({ ...args, idempotencyKey: 'local-native-match-1' })).content[0].text);
  assert.equal(quote.settlement, '0g');
  const res = await t.post_task({ ...args, idempotencyKey: 'local-native-match-1', confirm: true, quoteId: quote.quoteId });
  // The stub wallet refuses to broadcast; what matters is what it was asked to send.
  assert.equal(res.isError, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, OG_ESCROW);
  assert.equal(sent[0].chainId, 16602);
});

test('a createTask the backend built for another chain id is refused before it is signed', async () => {
  builtChainId = 16661;
  const t = tools(16602);
  const { quote } = JSON.parse((await t.post_task({ ...args, idempotencyKey: 'local-native-built-1' })).content[0].text);
  const res = await t.post_task({ ...args, idempotencyKey: 'local-native-built-1', confirm: true, quoteId: quote.quoteId });
  assert.equal(res.isError, true);
  assert.equal(JSON.parse(res.content[0].text).error.code, 'ESCROW_MISMATCH');
  assert.equal(sent.length, 0);
});

test('on 0G, a hash the backend resolves to another chain\'s task is refused', async () => {
  const t = tools(16602);
  const res = await t.cancel_task({ task: '0x' + 'ba'.repeat(32), idempotencyKey: 'local-native-other-chain-1' });
  assert.equal(res.isError, true);
  const { error } = JSON.parse(res.content[0].text);
  assert.equal(error.code, 'TASK_NOT_ON_0G');
  assert.match(error.message, /is a base task.*BLINDMARKET_SETTLEMENT=base/);
  assert.equal(sent.length, 0);
});
