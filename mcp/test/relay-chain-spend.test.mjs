import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress, Interface } from 'ethers';

/**
 * The send paths branch on HOW a spend is paid (`payment`), not on the chain's
 * name. This drives a whole post_task on a relay chain that is not called
 * "base" — the way a chain added later arrives — against a stub backend and a
 * stub JSON-RPC node: approve, createTask and index must all go through the
 * relay, in the token and to the escrow the backend named.
 */

process.env.BLINDMARKET_STATE_DIR = mkdtempSync(join(tmpdir(), 'bm-mcp-state-'));
delete process.env.BLINDMARKET_SETTLEMENT;
delete process.env.BLINDMARKET_USDC_ADDRESS;

const { registerRentTools } = await import('../dist/rent.js');

const PRIVY_WALLET = '0x2afd3a7Dd4377097f5220d34fb4E577963FdB6a4';
const ESCROW = getAddress('0x' + 'a7'.repeat(20));
const TOKEN = '0x3600000000000000000000000000000000000000';
const ERC20 = new Interface([
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);

const chain = { allowance: 0n, calls: [] };
let rpc;
let rpcUrl;

before(async () => {
  // A JSON-RPC node for chain 5042002 that knows one ERC-20 and mines every tx.
  rpc = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const one = ({ id, method, params }) => {
        chain.calls.push(method);
        let result;
        if (method === 'eth_chainId') result = '0x4cef52';
        else if (method === 'eth_blockNumber') result = '0x10';
        else if (method === 'eth_call') {
          const { to, data } = params[0];
          assert.equal(to.toLowerCase(), TOKEN.toLowerCase(), 'reads go to the backend-named token');
          const fn = ERC20.parseTransaction({ data }).name;
          const value = fn === 'allowance' ? chain.allowance : 10_000_000n;
          result = ERC20.encodeFunctionResult(fn, [value]);
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
});

after(() => rpc.close());

const backendCalls = [];
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
        { chain: 'arc', configured: true, chainId: 5042002, escrowAddress: ESCROW.toLowerCase(), token: { kind: 'erc20', address: TOKEN, symbol: 'USDC', decimals: 6 }, relayChain: 'arc', gasSymbol: 'USDC', postable: true },
      ],
    });
  }
  if (path === '/api/v1/api-keys/whoami') return json({ address: PRIVY_WALLET.toLowerCase() });
  if (path.startsWith('/api/v1/a2a/executors')) return json({ executors: [] });
  if (path === '/api/v1/storage/upload') return json({ rootHash: '0x' + 'cd'.repeat(32) });
  if (path === '/api/v1/tasks') return json({ unsignedTx: { to: ESCROW, data: '0xc0ffee' } });
  if (path === '/api/v1/tx/relay-tx') {
    if (body.to.toLowerCase() === TOKEN.toLowerCase()) chain.allowance = ERC20.decodeFunctionData('approve', body.data)[1];
    return json({ hash: '0x' + String(backendCalls.length).padStart(64, '0'), isUserOp: false, gas: 'user-pays' });
  }
  if (path === '/api/v1/a2a/tasks/index') return json({ indexed: true });
  throw new Error('unexpected backend call ' + path);
};

function tools() {
  const handlers = {};
  const server = { registerTool: (name, _def, handler) => { handlers[name] = handler; } };
  // No local wallet: a relay chain needs none.
  registerRentTools(server, { apiKey: 'sk_test', apiBase: 'https://backend.test', authenticated: true }, null);
  return handlers;
}

const parse = (res) => {
  assert.notEqual(res.isError, true, res.content[0].text);
  return JSON.parse(res.content[0].text);
};

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

  const relayed = backendCalls.filter((c) => c.path === '/api/v1/tx/relay-tx').map((c) => c.body);
  assert.deepEqual(relayed.map((b) => [b.to.toLowerCase(), b.chain, b.walletAddress]), [
    [TOKEN.toLowerCase(), 'arc', PRIVY_WALLET],
    [ESCROW.toLowerCase(), 'arc', PRIVY_WALLET],
  ]);
  assert.deepEqual(ERC20.decodeFunctionData('approve', relayed[0].data).map(String), [ESCROW, '2500000']);

  const create = backendCalls.find((c) => c.method === 'POST' && c.path === '/api/v1/tasks').body;
  assert.equal(create.token, TOKEN, 'POST /tasks names the backend\'s settlement token');
  assert.equal(create.amount, '2500000', '6 decimals');
  assert.ok(backendCalls.some((c) => c.path === '/api/v1/a2a/tasks/index'));
});
