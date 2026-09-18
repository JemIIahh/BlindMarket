import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, Interface } from 'ethers';

/**
 * The send paths branch on HOW a spend is paid (`payment`), not on the chain's
 * name. These drive whole tool calls on a relay chain that is not called
 * "base" — the way a chain added later arrives — against a stub backend and a
 * stub JSON-RPC node: every transaction must go through the relay, in the
 * token and to the escrow the backend named, and none may reach for a local
 * wallet (there is none here).
 */

process.env.BLINDMARKET_STATE_DIR = mkdtempSync(join(tmpdir(), 'bm-mcp-state-'));
delete process.env.BLINDMARKET_SETTLEMENT;
delete process.env.BLINDMARKET_USDC_ADDRESS;

const { registerRentTools } = await import('../dist/rent.js');
const { registerWalletTools } = await import('../dist/wallet.js');

const PRIVY_WALLET = '0x2afd3a7Dd4377097f5220d34fb4E577963FdB6a4';
const ESCROW = getAddress('0x' + 'a7'.repeat(20));
const TOKEN = '0x3600000000000000000000000000000000000000';
const BASE_ESCROW = getAddress('0x' + 'b5'.repeat(20));
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const HASH = '0x' + 'ee'.repeat(32);
const ERC20 = new Interface([
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
const ESCROW_READ = new Interface([
  'function getTask(uint256) view returns (tuple(address agent,address worker,address token,uint256 amount,bytes32 taskHash,bytes32 evidenceHash,uint8 status,string category,string locationZone,uint256 createdAt,uint256 deadline,uint8 submissionAttempts))',
]);
const FUTURE = BigInt(Math.floor(Date.now() / 1000) + 3600);

/** On-chain state the stub node serves, reset per test. */
let chain;
function resetChain() {
  chain = {
    allowance: 0n,
    // Task 8: Funded, to be cancelled. Task 9: Assigned to the relay wallet.
    tasks: { 8: 0, 9: 1 },
  };
}

let rpc;
let rpcUrl;

before(async () => {
  rpc = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      // One node, two chains: /base answers as Base Sepolia, anything else as Arc.
      const one = ({ id, method, params }) => {
        let result;
        if (method === 'eth_chainId') result = req.url === '/base' ? '0x14a34' : '0x4cef52';
        else if (method === 'eth_blockNumber') result = '0x10';
        else if (method === 'eth_call') {
          const { to, data } = params[0];
          if (to.toLowerCase() === ESCROW.toLowerCase()) {
            const taskId = Number(ESCROW_READ.decodeFunctionData('getTask', data)[0]);
            result = ESCROW_READ.encodeFunctionResult('getTask', [[
              PRIVY_WALLET, PRIVY_WALLET, TOKEN, 2_500_000n, HASH, '0x' + '00'.repeat(32),
              chain.tasks[taskId] ?? 0, 'delegated', 'global', 1n, FUTURE, 0,
            ]]);
          } else {
            assert.ok([TOKEN, BASE_USDC].some((t) => t.toLowerCase() === to.toLowerCase()), 'reads go to a backend-named token or escrow');
            const fn = ERC20.parseTransaction({ data }).name;
            result = ERC20.encodeFunctionResult(fn, [fn === 'allowance' ? chain.allowance : 10_000_000n]);
          }
        } else if (method === 'eth_getTransactionReceipt') {
          result = {
            transactionHash: params[0], transactionIndex: '0x0', blockHash: '0x' + 'b'.repeat(64), blockNumber: '0x10',
            from: PRIVY_WALLET, to: ESCROW, contractAddress: null, cumulativeGasUsed: '0x5208', gasUsed: '0x5208',
            effectiveGasPrice: '0x1', logs: [], logsBloom: '0x' + '0'.repeat(512), status: '0x1', type: '0x2',
          };
        } else throw new Error(`stub RPC: unexpected ${method}`);
        return { jsonrpc: '2.0', id, result };
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  rpcUrl = `http://127.0.0.1:${rpc.address().port}`;
  process.env.BLINDMARKET_ARC_RPC_URL = rpcUrl;
  process.env.BLINDMARKET_BASE_RPC_URL = `${rpcUrl}/base`;
});

after(() => rpc.close());

let backendCalls;
beforeEach(() => {
  resetChain();
  backendCalls = [];
  delete process.env.BLINDMARKET_SETTLEMENT;
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (rpcUrl && u.startsWith(rpcUrl)) return realFetch(url, init);
  const path = u.replace(/^https?:\/\/[^/]+/, '');
  const body = init.body ? JSON.parse(init.body) : undefined;
  backendCalls.push({ method: init.method ?? 'GET', path, body });
  const json = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
  if (path === '/health/bridge') {
    return json({
      configured: true, base: null, postingChain: 'arc',
      chains: [
        { chain: '0g', configured: false, chainId: 16602, escrowAddress: '0x' + '0a'.repeat(20), token: { kind: 'native', address: '0x' + '0'.repeat(40), symbol: '0G', decimals: 18 }, relayChain: null, postable: false },
        { chain: 'base', configured: true, chainId: 84532, escrowAddress: BASE_ESCROW, token: { kind: 'erc20', address: BASE_USDC, symbol: 'USDC', decimals: 6 }, relayChain: 'base-sepolia', postable: false },
        { chain: 'arc', configured: true, chainId: 5042002, escrowAddress: ESCROW.toLowerCase(), token: { kind: 'erc20', address: TOKEN, symbol: 'USDC', decimals: 6 }, relayChain: 'arc', gasSymbol: 'USDC', postable: true },
      ],
    });
  }
  if (path === '/api/v1/api-keys/whoami') return json({ address: PRIVY_WALLET.toLowerCase() });
  if (path.startsWith('/api/v1/a2a/executors')) return json({ executors: [] });
  if (path === '/api/v1/storage/upload') return json({ rootHash: '0x' + 'cd'.repeat(32) });
  if (path === '/api/v1/tasks') return json({ unsignedTx: { to: ESCROW, data: '0xc0ffee' }, chain: 'arc', chainId: 5042002 });
  if (path === `/api/v1/tasks/${HASH}`) return json({ taskId: '9', chain: 'arc' });
  if (path === '/api/v1/tasks/8/cancel') return json({ unsignedTx: { to: ESCROW, data: '0xca0ce1' } });
  if (path === `/api/v1/a2a/tasks/${HASH}/submit`) return json({ onChainTaskId: 9, evidenceHash: '0x01', chain: 'arc', unsignedSubmitEvidence: { to: ESCROW, data: '0x5b5b' } });
  if (path === `/api/v1/a2a/tasks/${HASH}/finalize`) { chain.tasks[9] = 4; return json({ status: 'verified', verificationResult: { passed: true } }); }
  if (path === '/api/v1/tx/relay-tx') {
    const to = body.to.toLowerCase();
    if (to === TOKEN.toLowerCase()) chain.allowance = ERC20.decodeFunctionData('approve', body.data)[1];
    if (to === ESCROW.toLowerCase() && body.data === '0xca0ce1') chain.tasks[8] = 5;
    if (to === ESCROW.toLowerCase() && body.data === '0x5b5b') chain.tasks[9] = 2;
    return json({ hash: '0x' + String(backendCalls.length).padStart(64, '0'), isUserOp: false, gas: 'user-pays' });
  }
  if (path === '/api/v1/a2a/tasks/index') return json({ indexed: true });
  throw new Error('unexpected backend call ' + path);
};

function tools() {
  const handlers = {};
  const server = { registerTool: (name, _def, handler) => { handlers[name] = handler; } };
  // No local wallet: a relay chain needs none.
  const { settlement } = registerRentTools(server, { apiKey: 'sk_test', apiBase: 'https://backend.test', authenticated: true }, null);
  registerWalletTools(server, null, settlement);
  return handlers;
}

const parse = (res) => {
  assert.notEqual(res.isError, true, res.content[0].text);
  return JSON.parse(res.content[0].text);
};
const relayed = () => backendCalls.filter((c) => c.path === '/api/v1/tx/relay-tx').map((c) => c.body);

test('post_task on a relay chain not named "base": quote, then approve + createTask through the relay', async () => {
  const t = tools();
  const args = { instructions: 'Summarise this paragraph in one sentence.', amount: '2.5', idempotencyKey: 'relay-chain-spend-1', privacy: 'public' };

  const { quote } = parse(await t.post_task(args));
  assert.equal(quote.settlement, 'arc');
  assert.equal(quote.currency, 'USDC');
  assert.equal(quote.payFrom, PRIVY_WALLET);
  assert.equal(quote.walletBalance, '10.0', 'balance read from the backend-named token over this chain\'s RPC');

  const done = parse(await t.post_task({ ...args, confirm: true, quoteId: quote.quoteId }));
  assert.match(done.taskHash, /^0x[0-9a-f]{64}$/);

  assert.deepEqual(relayed().map((b) => [b.to.toLowerCase(), b.chain, b.walletAddress]), [
    [TOKEN.toLowerCase(), 'arc', PRIVY_WALLET],
    [ESCROW.toLowerCase(), 'arc', PRIVY_WALLET],
  ]);
  assert.deepEqual(ERC20.decodeFunctionData('approve', relayed()[0].data).map(String), [ESCROW, '2500000']);

  const create = backendCalls.find((c) => c.method === 'POST' && c.path === '/api/v1/tasks').body;
  assert.equal(create.token, TOKEN, 'POST /tasks names the backend\'s settlement token');
  assert.equal(create.amount, '2500000', '6 decimals');
  assert.ok(backendCalls.some((c) => c.path === '/api/v1/a2a/tasks/index'));
});

test('cancel_task reads the task from this chain\'s escrow and refunds through the relay', async () => {
  const t = tools();
  const { quote } = parse(await t.cancel_task({ task: '8', idempotencyKey: 'relay-chain-cancel-1' }));
  assert.equal(quote.status, 'Funded');
  assert.equal(quote.refund, '2.5', 'formatted in the chain\'s 6 decimals');
  assert.equal(quote.settlement, 'arc');

  const done = parse(await t.cancel_task({ task: '8', idempotencyKey: 'relay-chain-cancel-1', confirm: true, quoteId: quote.quoteId }));
  assert.equal(done.taskId, 8);
  assert.deepEqual(relayed().map((b) => [b.to.toLowerCase(), b.data, b.chain]), [[ESCROW.toLowerCase(), '0xca0ce1', 'arc']]);
  assert.equal(chain.tasks[8], 5);
});

test('complete_task delivers through the relay and reports the payout in the chain\'s token', async () => {
  const t = tools();
  const done = parse(await t.complete_task({ task: HASH, output: 'A one-sentence summary of the paragraph, as asked.' }));
  assert.equal(done.onChainStatus, 'Completed');
  assert.equal(done.paidTo, PRIVY_WALLET);
  assert.match(done.hint, /2\.5 USDC/);
  assert.deepEqual(relayed().map((b) => [b.to.toLowerCase(), b.data, b.chain]), [[ESCROW.toLowerCase(), '0x5b5b', 'arc']]);
});

test('wallet_status reports the relay wallet and the chain\'s token', async () => {
  const t = tools();
  const { settlement } = parse(await t.wallet_status({}));
  assert.equal(settlement.mode, 'arc');
  assert.equal(settlement.payment, 'relay-erc20');
  assert.equal(settlement.payFrom, PRIVY_WALLET);
  assert.equal(settlement.relayChain, 'arc');
  assert.equal(settlement.token.address, TOKEN);
});

test('forced onto a chain the backend no longer posts on: refunds work, new posts are refused', async () => {
  process.env.BLINDMARKET_SETTLEMENT = 'base';
  const t = tools();
  const res = await t.post_task({ instructions: 'Anything at all, really.', amount: '1', idempotencyKey: 'relay-chain-offposting-1' });
  assert.equal(res.isError, true);
  const { error } = JSON.parse(res.content[0].text);
  assert.equal(error.code, 'NOT_POSTING_CHAIN');
  assert.match(error.message, /posts new tasks on arc/);
  assert.equal(relayed().length, 0, 'nothing sent');
});
