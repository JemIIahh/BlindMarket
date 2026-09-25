import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, JsonRpcProvider, Transaction, Wallet, getAddress } from 'ethers';

/**
 * A quote authorizes exactly the spend it quoted (security audit run 1, C20).
 *
 * Before, consumeQuote checked only the quote's kind and expiry, and each
 * spend tool rebuilt what it spent on the confirm call from that call's own
 * arguments and freshly fetched backend state. So a provider who re-priced
 * its listing between a renter's quote and confirm was paid the new price,
 * and a post_task / cancel_task / claim_timeout quote confirmed a different
 * amount or task. Now a confirm that does not match its quote is refused with
 * QUOTE_MISMATCH before anything is uploaded, approved or sent.
 *
 * Same harness as local-erc20-arc.test.mjs: production's /health/bridge
 * (Arc, local signing), a stub Arc RPC, a real ethers Wallet, and each test
 * decodes the raw transactions the wallet would broadcast.
 */

process.env.BLINDMARKET_STATE_DIR = mkdtempSync(join(tmpdir(), 'bm-mcp-state-'));
delete process.env.BLINDMARKET_SETTLEMENT;
delete process.env.BLINDMARKET_USDC_ADDRESS;

const { registerRentTools } = await import('../dist/rent.js');

const PROD_BRIDGE = JSON.parse(readFileSync(new URL('../../fixtures/prod/health-bridge.json', import.meta.url), 'utf-8'));
const PROD_SETTLEMENT = JSON.parse(readFileSync(new URL('../../fixtures/prod/health-settlement.json', import.meta.url), 'utf-8'));
const ARC = PROD_BRIDGE.data.chains.find((c) => c.chain === 'arc');
const ESCROW = getAddress(ARC.escrowAddress);
const USDC = getAddress(ARC.token.address);
const ARC_ID = ARC.chainId;

const OWNER = Wallet.createRandom();
const PROVIDER = Wallet.createRandom();
const ERC20 = new Interface([
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);
const ESCROW_ABI = new Interface([
  'function getTask(uint256) view returns (tuple(address agent,address worker,address token,uint256 amount,bytes32 taskHash,bytes32 evidenceHash,uint8 status,string category,string locationZone,uint256 createdAt,uint256 deadline,uint8 submissionAttempts))',
  'function createTask(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration)',
  'function cancelTask(uint256 taskId)',
  'function claimTimeout(uint256 taskId)',
]);
const NOW = Math.floor(Date.now() / 1000);

let chain;
let services;
function reset() {
  chain = {
    allowance: 0n,
    // 7, 8: Funded (cancel). 9, 10: Assigned and past their deadline (timeout).
    tasks: {
      7: { status: 0, amount: 4_000_000n, deadline: BigInt(NOW + 3600) },
      8: { status: 0, amount: 2_500_000n, deadline: BigInt(NOW + 3600) },
      9: { status: 1, amount: 3_000_000n, deadline: BigInt(NOW - 60) },
      10: { status: 1, amount: 9_000_000n, deadline: BigInt(NOW - 60) },
    },
    sent: [],
  };
  services = {
    7: { id: 7, name: 'summarise', agent_address: PROVIDER.address.toLowerCase(), agent_public_key: PROVIDER.signingKey.publicKey.slice(2), price_raw: '10000' },
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
      const one = ({ id, method, params }) => {
        let result;
        switch (method) {
          case 'eth_chainId': result = '0x' + ARC_ID.toString(16); break;
          case 'eth_blockNumber': result = '0x10'; break;
          case 'eth_getBlockByNumber': result = { number: '0x10', hash: '0x' + '0b'.repeat(32), parentHash: '0x' + '0a'.repeat(32), timestamp: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x3b9aca00', miner: '0x' + '00'.repeat(20), extraData: '0x', difficulty: '0x0', nonce: '0x0000000000000000', transactions: [] }; break;
          case 'eth_maxPriorityFeePerGas': result = '0x1'; break;
          case 'eth_gasPrice': result = '0x3b9aca00'; break;
          case 'eth_getTransactionCount': result = '0x' + chain.sent.length.toString(16); break;
          case 'eth_estimateGas': result = '0x30000'; break;
          case 'eth_call': {
            const { to, data } = params[0];
            if (to.toLowerCase() === ESCROW.toLowerCase()) {
              const taskId = Number(ESCROW_ABI.decodeFunctionData('getTask', data)[0]);
              const t = chain.tasks[taskId];
              result = ESCROW_ABI.encodeFunctionResult('getTask', [[
                OWNER.address, t.status === 0 ? '0x' + '00'.repeat(20) : PROVIDER.address, USDC, t.amount,
                '0x' + taskId.toString(16).padStart(64, '0'), '0x' + '00'.repeat(32),
                t.status, 'general', 'global', 1n, t.deadline, 0,
              ]]);
            } else {
              const fn = ERC20.parseTransaction({ data }).name;
              result = ERC20.encodeFunctionResult(fn, [fn === 'allowance' ? chain.allowance : 1_000_000_000n]);
            }
            break;
          }
          case 'eth_sendRawTransaction': {
            const tx = Transaction.from(params[0]);
            chain.sent.push(tx);
            if (tx.to.toLowerCase() === USDC.toLowerCase()) chain.allowance = ERC20.decodeFunctionData('approve', tx.data)[1];
            else {
              const call = ESCROW_ABI.parseTransaction({ data: tx.data });
              if (call.name === 'cancelTask' || call.name === 'claimTimeout') chain.tasks[Number(call.args[0])].status = 5;
            }
            result = tx.hash;
            break;
          }
          case 'eth_getTransactionReceipt':
            result = {
              transactionHash: params[0], transactionIndex: '0x0', blockHash: '0x' + 'b'.repeat(64), blockNumber: '0x10',
              from: OWNER.address, to: ESCROW, contractAddress: null, cumulativeGasUsed: '0x5208', gasUsed: '0x5208',
              effectiveGasPrice: '0x1', logs: [], logsBloom: '0x' + '0'.repeat(512), status: '0x1', type: '0x2',
            };
            break;
          default: throw new Error(`stub RPC: unexpected ${method}`);
        }
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

let backendCalls;
beforeEach(() => {
  reset();
  backendCalls = [];
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (rpcUrl && u.startsWith(rpcUrl)) return realFetch(url, init);
  const path = u.replace(/^https?:\/\/[^/]+/, '');
  const body = init.body ? JSON.parse(init.body) : undefined;
  backendCalls.push({ method: init.method ?? 'GET', path, body });
  const json = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
  if (path === '/health/bridge') return json(PROD_BRIDGE.data);
  if (path === '/health/settlement') return json(PROD_SETTLEMENT.data);
  if (path === '/api/v1/api-keys/whoami') return json({ address: OWNER.address.toLowerCase() });
  const service = path.match(/^\/api\/v1\/marketplace\/services\/(\d+)$/);
  if (service) return json(services[service[1]]);
  if (path.startsWith('/api/v1/a2a/executors')) return json({ executors: [] });
  if (path === '/api/v1/storage/upload') return json({ rootHash: '0x' + 'cd'.repeat(32) });
  if (path === '/api/v1/tasks') {
    // What the real backend builds (backend/src/services/escrow.ts buildCreateTaskOn).
    const data = ESCROW_ABI.encodeFunctionData('createTask', [body.taskHash, body.token, body.amount, 'general', body.locationZone, body.duration]);
    return json({ unsignedTx: { to: ESCROW, data, from: OWNER.address }, chain: 'arc', chainId: ARC_ID });
  }
  const refund = path.match(/^\/api\/v1\/tasks\/(\d+)\/(cancel|timeout)$/);
  if (refund) {
    const data = ESCROW_ABI.encodeFunctionData(refund[2] === 'cancel' ? 'cancelTask' : 'claimTimeout', [BigInt(refund[1])]);
    return json({ unsignedTx: { to: ESCROW, data, from: OWNER.address }, chain: 'arc', chainId: ARC_ID });
  }
  if (/^\/api\/v1\/tasks\/\d+\/confirm-tx$/.test(path)) return json({ confirmed: 1 });
  if (path === '/api/v1/a2a/tasks/index') return json({ indexed: true });
  if (path === '/api/v1/a2a/tasks/posted') return json({ tasks: [] });
  throw new Error('unexpected backend call ' + path);
};

function tools() {
  const handlers = {};
  const server = { registerTool: (name, _def, handler) => { handlers[name] = handler; } };
  const provider = new JsonRpcProvider(`${rpcUrl}/0g`, 16661, { staticNetwork: true });
  const walletCtx = { wallet: new Wallet(OWNER.privateKey, provider), provider, rpcUrl: `${rpcUrl}/0g`, chainId: 16661 };
  registerRentTools(server, { apiKey: 'sk_test', apiBase: 'https://backend.test', authenticated: true }, walletCtx);
  return handlers;
}

const parse = (res) => {
  assert.notEqual(res.isError, true, res.content[0].text);
  return JSON.parse(res.content[0].text);
};
const errorOf = (res) => {
  assert.equal(res.isError, true, res.content[0].text);
  return JSON.parse(res.content[0].text).error;
};
/** Nothing left the wallet and nothing was uploaded, built or listed. */
function nothingSpent() {
  assert.equal(chain.sent.length, 0, 'nothing signed');
  for (const p of ['/api/v1/storage/upload', '/api/v1/tasks', '/api/v1/a2a/tasks/index']) {
    assert.equal(backendCalls.some((c) => c.method === 'POST' && c.path === p), false, `no POST ${p}`);
  }
  assert.equal(backendCalls.some((c) => /\/(cancel|timeout)$/.test(c.path)), false, 'no refund built');
}
const createTaskOf = (tx) => ESCROW_ABI.decodeFunctionData('createTask', tx.data);

// ── rent_service ────────────────────────────────────────────────────────────

test('rent_service: a listing re-priced after the quote is refused, and nothing is uploaded, approved or sent', async () => {
  const t = tools();
  const args = { serviceId: 7, prompt: 'Summarise this paragraph in one sentence.', idempotencyKey: 'rent-reprice-1', waitSeconds: 0 };
  const { quote } = parse(await t.rent_service(args));
  assert.equal(quote.price, '0.01');

  // The provider raises its price (PATCH /agents/:id/services/7) before the renter confirms.
  services[7].price_raw = '250000000';
  const error = errorOf(await t.rent_service({ ...args, confirm: true, quoteId: quote.quoteId }));
  assert.equal(error.code, 'QUOTE_MISMATCH');
  assert.match(error.message, /price changed from 0\.01 USDC to 250\.0 USDC/);
  assert.match(error.message, /Nothing was sent/);
  assert.match(error.message, /new quote/);
  nothingSpent();

  // The quote is used up: it cannot be replayed after the provider changes the price back.
  services[7].price_raw = '10000';
  assert.equal(errorOf(await t.rent_service({ ...args, confirm: true, quoteId: quote.quoteId })).code, 'QUOTE_REQUIRED');
  nothingSpent();
});

test('rent_service: a fresh quote at the new price confirms, and escrows exactly that price', async () => {
  services[7].price_raw = '250000000';
  const t = tools();
  const args = { serviceId: 7, prompt: 'Summarise this paragraph in one sentence.', idempotencyKey: 'rent-requote-1', waitSeconds: 0 };
  const { quote } = parse(await t.rent_service(args));
  assert.equal(quote.price, '250.0');
  const done = parse(await t.rent_service({ ...args, confirm: true, quoteId: quote.quoteId }));
  const [approve, create] = chain.sent;
  assert.deepEqual(ERC20.decodeFunctionData('approve', approve.data).map(String), [ESCROW, '250000000']);
  assert.equal(createTaskOf(create).amount, 250_000_000n);
  assert.deepEqual(done.escrowed, { amount: '250.0', amountRaw: '250000000', currency: 'USDC' });
});

test('rent_service: an unchanged listing escrows the quoted price, and the confirm says how much', async () => {
  const t = tools();
  const args = { serviceId: 7, prompt: 'Summarise this paragraph in one sentence.', idempotencyKey: 'rent-baseline-1', waitSeconds: 0 };
  const { quote } = parse(await t.rent_service(args));
  const done = parse(await t.rent_service({ ...args, confirm: true, quoteId: quote.quoteId }));
  assert.deepEqual(ERC20.decodeFunctionData('approve', chain.sent[0].data).map(String), [ESCROW, '10000']);
  assert.equal(createTaskOf(chain.sent[1]).amount, 10_000n);
  assert.equal(backendCalls.find((c) => c.method === 'POST' && c.path === '/api/v1/tasks').body.amount, '10000');
  assert.deepEqual(done.escrowed, { amount: '0.01', amountRaw: '10000', currency: 'USDC' });
});

test('rent_service: another prompt, privacy or idempotencyKey on confirm is not what was quoted', async () => {
  const t = tools();
  const args = { serviceId: 7, prompt: 'Summarise this paragraph in one sentence.', idempotencyKey: 'rent-args-1', waitSeconds: 0 };
  for (const change of [{ prompt: 'Something else entirely, please.' }, { privacy: 'public' }, { idempotencyKey: 'rent-args-2' }]) {
    const { quote } = parse(await t.rent_service(args));
    const error = errorOf(await t.rent_service({ ...args, ...change, confirm: true, quoteId: quote.quoteId }));
    assert.equal(error.code, 'QUOTE_MISMATCH', JSON.stringify(change));
    assert.match(error.message, new RegExp(`changed: .*${Object.keys(change)[0]}`));
  }
  nothingSpent();
});

// ── post_task ───────────────────────────────────────────────────────────────

test('post_task: a confirm with a larger amount than quoted is refused with nothing sent', async () => {
  const t = tools();
  const args = { instructions: 'Dummy public brief for the audit harness.', amount: '1', idempotencyKey: 'post-amount-1', privacy: 'public' };
  const { quote } = parse(await t.post_task(args));
  assert.equal(quote.escrow, '1');
  const error = errorOf(await t.post_task({ ...args, amount: '500', confirm: true, quoteId: quote.quoteId }));
  assert.equal(error.code, 'QUOTE_MISMATCH');
  assert.match(error.message, /changed: amountRaw/);
  nothingSpent();
});

test('post_task: other instructions, capabilities or duration on confirm are refused', async () => {
  const t = tools();
  const args = { instructions: 'Dummy public brief for the audit harness.', amount: '1', idempotencyKey: 'post-args-1', privacy: 'public' };
  for (const change of [{ instructions: 'A different brief altogether.' }, { capabilities: ['data_processing'] }, { durationSeconds: 7200 }]) {
    const { quote } = parse(await t.post_task(args));
    assert.equal(errorOf(await t.post_task({ ...args, ...change, confirm: true, quoteId: quote.quoteId })).code, 'QUOTE_MISMATCH', JSON.stringify(change));
  }
  nothingSpent();
});

test('post_task: the same spend written differently still confirms ("2.50" is "2.5"), and reports the escrow', async () => {
  const t = tools();
  const args = { instructions: 'Dummy public brief for the audit harness.', amount: '2.5', idempotencyKey: 'post-same-1', privacy: 'public' };
  const { quote } = parse(await t.post_task(args));
  const done = parse(await t.post_task({ ...args, amount: '2.50', confirm: true, quoteId: quote.quoteId }));
  assert.equal(createTaskOf(chain.sent[1]).amount, 2_500_000n);
  assert.deepEqual(done.escrowed, { amount: '2.5', amountRaw: '2500000', currency: 'USDC' });
});

test('a quote of another kind is not a quote for this spend', async () => {
  const t = tools();
  const { quote } = parse(await t.rent_service({ serviceId: 7, prompt: 'Summarise this paragraph in one sentence.', idempotencyKey: 'kind-1' }));
  const error = errorOf(await t.post_task({ instructions: 'Dummy public brief.', amount: '1', idempotencyKey: 'kind-1', privacy: 'public', confirm: true, quoteId: quote.quoteId }));
  assert.equal(error.code, 'QUOTE_REQUIRED');
  nothingSpent();
});

// ── cancel_task / claim_timeout ─────────────────────────────────────────────

test('cancel_task: a confirm naming another task than the quote is refused, and neither is refunded', async () => {
  const t = tools();
  const { quote } = parse(await t.cancel_task({ task: '8', idempotencyKey: 'cancel-other-1' }));
  assert.equal(quote.taskId, '8');
  const error = errorOf(await t.cancel_task({ task: '7', idempotencyKey: 'cancel-other-1', confirm: true, quoteId: quote.quoteId }));
  assert.equal(error.code, 'QUOTE_MISMATCH');
  assert.match(error.message, /changed: amountRaw, taskHash, taskId/);
  nothingSpent();
  assert.equal(chain.tasks[7].status, 0);
  assert.equal(chain.tasks[8].status, 0);

  // The quoted task, with a fresh quote, refunds as before.
  const again = parse(await t.cancel_task({ task: '8', idempotencyKey: 'cancel-other-2' }));
  const done = parse(await t.cancel_task({ task: '8', idempotencyKey: 'cancel-other-2', confirm: true, quoteId: again.quote.quoteId }));
  assert.equal(done.taskId, 8);
  assert.deepEqual(chain.sent.map((tx) => ESCROW_ABI.parseTransaction({ data: tx.data }).name), ['cancelTask']);
  assert.equal(chain.tasks[8].status, 5);
});

test('claim_timeout: a confirm naming another task than the quote is refused', async () => {
  const t = tools();
  const { quote } = parse(await t.claim_timeout({ task: '9', idempotencyKey: 'timeout-other-1' }));
  const error = errorOf(await t.claim_timeout({ task: '10', idempotencyKey: 'timeout-other-1', confirm: true, quoteId: quote.quoteId }));
  assert.equal(error.code, 'QUOTE_MISMATCH');
  nothingSpent();
  assert.equal(chain.tasks[10].status, 1);

  const again = parse(await t.claim_timeout({ task: '9', idempotencyKey: 'timeout-other-2' }));
  parse(await t.claim_timeout({ task: '9', idempotencyKey: 'timeout-other-2', confirm: true, quoteId: again.quote.quoteId }));
  assert.deepEqual(chain.sent.map((tx) => ESCROW_ABI.decodeFunctionData('claimTimeout', tx.data)[0]), [9n]);
});
