import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, JsonRpcProvider, Transaction, Wallet, getAddress, keccak256, toUtf8Bytes } from 'ethers';

/**
 * Production posts every new task on Arc: a USDC (ERC-20) escrow the backend
 * relay does not serve (relayChain null), with gas paid in USDC. Every spend
 * here failed with UNSUPPORTED_SETTLEMENT: post_task, rent_service,
 * cancel_task, claim_timeout and complete_task, and registration with them.
 * The local wallet (BLINDMARKET_PRIVATE_KEY) now signs on Arc itself: the
 * 'local-erc20' payment path.
 *
 * Discovery reads production's real /health/bridge body (fixtures/prod). The
 * RPC is a stub node that answers as Arc, and a real ethers Wallet signs, so
 * each test decodes the raw transactions it would broadcast (chain id, nonce,
 * value, calldata).
 */

process.env.BLINDMARKET_STATE_DIR = mkdtempSync(join(tmpdir(), 'bm-mcp-state-'));
delete process.env.BLINDMARKET_SETTLEMENT;
delete process.env.BLINDMARKET_USDC_ADDRESS;

const { registerRentTools } = await import('../dist/rent.js');
const { registerWalletTools } = await import('../dist/wallet.js');
const { registerMarketTools } = await import('../dist/tools.js');
const { discoverSettlement } = await import('../dist/settlement.js');

const PROD_BRIDGE = JSON.parse(readFileSync(new URL('../../fixtures/prod/health-bridge.json', import.meta.url), 'utf-8'));
const PROD_SETTLEMENT = JSON.parse(readFileSync(new URL('../../fixtures/prod/health-settlement.json', import.meta.url), 'utf-8'));
const ARC = PROD_BRIDGE.data.chains.find((c) => c.chain === 'arc');
assert.equal(ARC.relayChain, null, 'the fixture is production: Arc has no relay');
const ESCROW = getAddress(ARC.escrowAddress);
const USDC = getAddress(ARC.token.address);
const ARC_ID = ARC.chainId;

const OWNER = Wallet.createRandom();
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

/** What the real backend builds (backend/src/services/escrow.ts, routes/a2a.ts): the MCP signs nothing else. */
const ESCROW_CALLS = new Interface([
  'function createTask(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration)',
  'function submitEvidence(uint256 taskId, bytes32 evidenceHash)',
  'function cancelTask(uint256 taskId)',
  'function claimTimeout(uint256 taskId)',
]);
const createTaskData = (b) => ESCROW_CALLS.encodeFunctionData('createTask', [b.taskHash, b.token, b.amount, 'general', b.locationZone, b.duration]);
const cancelData = (id) => ESCROW_CALLS.encodeFunctionData('cancelTask', [BigInt(id)]);
const submitData = (id, resultData) => ESCROW_CALLS.encodeFunctionData('submitEvidence', [BigInt(id), keccak256(toUtf8Bytes(JSON.stringify(resultData)))]);
const callName = (data) => { try { return ESCROW_CALLS.parseTransaction({ data }).name; } catch { return null; } };

/** What the stub chain holds, and every raw transaction it was sent. */
let chain;
function resetChain() {
  chain = {
    served: ARC_ID,
    allowance: 0n,
    // Task 8: Funded, to cancel. Task 9: Assigned to OWNER, to deliver.
    tasks: { 8: 0, 9: 1 },
    sent: [],
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
        if (req.url === '/0g') {
          // The 0G wallet's own RPC: only wallet_status reads it.
          result = method === 'eth_chainId' ? '0x4115' : '0x0';
          return { jsonrpc: '2.0', id, result };
        }
        switch (method) {
          case 'eth_chainId': result = '0x' + chain.served.toString(16); break;
          case 'eth_blockNumber': result = '0x10'; break;
          case 'eth_getBlockByNumber': result = { number: '0x10', hash: '0x' + '0b'.repeat(32), parentHash: '0x' + '0a'.repeat(32), timestamp: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x3b9aca00', miner: '0x' + '00'.repeat(20), extraData: '0x', difficulty: '0x0', nonce: '0x0000000000000000', transactions: [] }; break;
          case 'eth_maxPriorityFeePerGas': result = '0x1'; break;
          case 'eth_gasPrice': result = '0x3b9aca00'; break;
          case 'eth_getTransactionCount': result = '0x' + chain.sent.length.toString(16); break;
          case 'eth_estimateGas': result = '0x30000'; break;
          case 'eth_call': {
            const { to, data } = params[0];
            if (to.toLowerCase() === ESCROW.toLowerCase()) {
              const taskId = Number(ESCROW_READ.decodeFunctionData('getTask', data)[0]);
              result = ESCROW_READ.encodeFunctionResult('getTask', [[
                OWNER.address, OWNER.address, USDC, 2_500_000n, HASH, '0x' + '00'.repeat(32),
                chain.tasks[taskId] ?? 0, 'delegated', 'global', 1n, chain.deadlines?.[taskId] ?? FUTURE, 0,
              ]]);
            } else {
              assert.equal(to.toLowerCase(), USDC.toLowerCase(), 'reads go to the backend-named token or escrow');
              const fn = ERC20.parseTransaction({ data }).name;
              result = ERC20.encodeFunctionResult(fn, [fn === 'allowance' ? chain.allowance : 10_000_000n]);
            }
            break;
          }
          case 'eth_sendRawTransaction': {
            const tx = Transaction.from(params[0]);
            chain.sent.push(tx);
            if (tx.to.toLowerCase() === USDC.toLowerCase()) chain.allowance = ERC20.decodeFunctionData('approve', tx.data)[1];
            if (callName(tx.data) === 'cancelTask') chain.tasks[8] = 5;
            if (callName(tx.data) === 'submitEvidence') chain.tasks[9] = 2;
            // An upgraded escrow sends a Submitted task for review (Disputed).
            if (callName(tx.data) === 'claimTimeout') {
              const id = Number(ESCROW_CALLS.decodeFunctionData('claimTimeout', tx.data)[0]);
              chain.tasks[id] = chain.tasks[id] === 2 ? 6 : 5;
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

/** How the stub backend answers, per test. */
let backendCalls;
let whoami;
let bridgeDown;
let indexAnswers;
/** path → (body) => the backend's answer, in place of the default. */
let overrides;
beforeEach(() => {
  overrides = {};
  resetChain();
  backendCalls = [];
  whoami = OWNER.address.toLowerCase();
  bridgeDown = false;
  indexAnswers = [];
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
  if (overrides[path]) return json(overrides[path](body));
  if (path === '/health/bridge') {
    if (bridgeDown) throw new TypeError('fetch failed');
    return json(PROD_BRIDGE.data);
  }
  if (path === '/health/settlement') return json(PROD_SETTLEMENT.data);
  if (path === '/api/v1/api-keys/whoami') return json({ address: whoami, addresses: [whoami] });
  if (path.startsWith('/api/v1/a2a/executors')) return json({ executors: [] });
  if (path === '/api/v1/a2a/register') return json({ agent: { address: whoami, supportedChains: body.supportedChains } });
  if (path === '/api/v1/storage/upload') return json({ rootHash: '0x' + 'cd'.repeat(32) });
  if (path === '/api/v1/tasks') return json({ unsignedTx: { to: ESCROW, data: createTaskData(body), from: OWNER.address }, chain: 'arc', chainId: ARC_ID });
  if (path === `/api/v1/tasks/${HASH}`) return json({ taskId: '9', chain: 'arc' });
  if (path === '/api/v1/tasks/8/cancel') return json({ unsignedTx: { to: ESCROW, data: cancelData(8) }, chain: 'arc', chainId: ARC_ID });
  if (path === '/api/v1/tasks/8/confirm-tx') return json({ confirmed: 1 });
  if (path === `/api/v1/a2a/tasks/${HASH}/submit`) return json({ onChainTaskId: 9, evidenceHash: '0x01', chain: 'arc', unsignedSubmitEvidence: { to: ESCROW, data: submitData(9, body.resultData), from: OWNER.address, chainId: ARC_ID } });
  if (path === `/api/v1/a2a/tasks/${HASH}/finalize`) { chain.tasks[9] = 4; return json({ status: 'verified', verificationResult: { passed: true } }); }
  if (path === '/api/v1/a2a/tasks/index') return indexAnswers.shift() ?? json({ indexed: true });
  throw new Error('unexpected backend call ' + path);
};
const failWith = (status, code) => ({ ok: false, status, json: async () => ({ success: false, error: { code, message: code } }) });

function walletCtx() {
  const provider = new JsonRpcProvider(`${rpcUrl}/0g`, 16661, { staticNetwork: true });
  return { wallet: new Wallet(OWNER.privateKey, provider), provider, rpcUrl: `${rpcUrl}/0g`, chainId: 16661 };
}

function tools({ withWallet = true } = {}) {
  const handlers = {};
  const server = { registerTool: (name, _def, handler) => { handlers[name] = handler; } };
  const ctx = withWallet ? walletCtx() : null;
  const cfg = { apiKey: 'sk_test', apiBase: 'https://backend.test', authenticated: true };
  const { settlement } = registerRentTools(server, cfg, ctx);
  registerWalletTools(server, ctx, settlement);
  const bb = { registerExecutor: async (p) => { backendCalls.push({ method: 'POST', path: '/api/v1/a2a/register', body: p }); return { agent: { supportedChains: p.supportedChains } }; } };
  registerMarketTools(server, bb, ctx, settlement);
  return handlers;
}

const parse = (res) => {
  assert.notEqual(res.isError, true, res.content[0].text);
  return JSON.parse(res.content[0].text);
};
const errorOf = (res) => {
  assert.equal(res.isError, true, res.content[0].text);
  const out = JSON.parse(res.content[0].text);
  return out.error;
};
const discover = (env, localWallet) => discoverSettlement({
  apiBase: 'https://backend.test',
  api: async (_m, path) => { assert.equal(path, '/api/v1/api-keys/whoami'); return { address: whoami }; },
  env,
  localWallet,
});

// ── Discovery on production's /health/bridge ────────────────────────────────

test('without a local key it refuses, and says which key to set', async () => {
  await assert.rejects(discover({}, undefined), (e) => e.code === 'UNSUPPORTED_SETTLEMENT' && /BLINDMARKET_PRIVATE_KEY/.test(e.message) && /relay/.test(e.message));
});

test('with the API key owner\'s key it signs locally on Arc, over the Arc RPC', async () => {
  const s = await discover({ BLINDMARKET_ARC_RPC_URL: rpcUrl }, OWNER.address);
  assert.equal(s.payment, 'local-erc20');
  assert.equal(s.mode, 'arc');
  assert.equal(s.chainId, ARC_ID);
  assert.equal(s.escrowAddress, ESCROW);
  assert.equal(s.token.address, USDC);
  assert.equal(s.payFrom, OWNER.address);
  assert.equal(s.rpcUrl, rpcUrl);
  assert.equal(s.postingChain, 'arc');
});

test('a key that is not the API key\'s owner is refused before anything is sent', async () => {
  whoami = '0x' + 'e1'.repeat(20);
  await assert.rejects(discover({ BLINDMARKET_ARC_RPC_URL: rpcUrl }, OWNER.address), (e) => e.code === 'OWNER_MISMATCH' && /NOT_TASK_AGENT/.test(e.message));
});

test('an RPC on another chain is refused', async () => {
  chain.served = 84532;
  await assert.rejects(discover({ BLINDMARKET_ARC_RPC_URL: rpcUrl }, OWNER.address), (e) => e.code === 'WRONG_RPC' && /BLINDMARKET_ARC_RPC_URL/.test(e.message));
});

// ── Spending on Arc ─────────────────────────────────────────────────────────

test('post_task: quote in USDC, then approve + createTask signed locally for Arc', async () => {
  const t = tools();
  const args = { instructions: 'Summarise this paragraph in one sentence.', amount: '2.5', idempotencyKey: 'arc-post-1', privacy: 'public' };
  const { quote } = parse(await t.post_task(args));
  assert.equal(quote.settlement, 'arc');
  assert.equal(quote.currency, 'USDC');
  assert.equal(quote.payFrom, OWNER.address);
  assert.equal(quote.walletBalance, '10.0');
  assert.equal(chain.sent.length, 0, 'a quote sends nothing');

  const done = parse(await t.post_task({ ...args, confirm: true, quoteId: quote.quoteId }));
  const [approve, create] = chain.sent;
  assert.equal(chain.sent.length, 2);
  for (const tx of chain.sent) {
    assert.equal(tx.chainId, BigInt(ARC_ID), 'signed for Arc');
    assert.equal(tx.value, 0n, 'an ERC-20 escrow takes no native value');
    assert.equal(tx.from, OWNER.address);
  }
  assert.equal(approve.to, USDC);
  assert.deepEqual(ERC20.decodeFunctionData('approve', approve.data).map(String), [ESCROW, '2500000']);
  assert.equal(create.to, ESCROW);
  assert.equal(create.data, createTaskData(backendCalls.find((c) => c.method === 'POST' && c.path === '/api/v1/tasks').body));
  assert.equal(create.nonce, approve.nonce + 1, 'createTask pinned to the nonce after the approve');

  const posted = backendCalls.find((c) => c.method === 'POST' && c.path === '/api/v1/tasks').body;
  assert.equal(posted.token, USDC);
  assert.equal(posted.amount, '2500000');
  const index = backendCalls.find((c) => c.path === '/api/v1/a2a/tasks/index').body;
  assert.equal(index.txHash, create.hash);
  assert.equal(index.isUserOp, false);
  assert.equal(done.txHash, create.hash);
});

test('post_task skips the approve when the allowance already covers the escrow', async () => {
  chain.allowance = 5_000_000n;
  const t = tools();
  const args = { instructions: 'Summarise this paragraph in one sentence.', amount: '2.5', idempotencyKey: 'arc-post-2', privacy: 'public' };
  const { quote } = parse(await t.post_task(args));
  parse(await t.post_task({ ...args, confirm: true, quoteId: quote.quoteId }));
  assert.deepEqual(chain.sent.map((tx) => tx.to), [ESCROW]);
});

test('a funded post finishes its listing even while settlement cannot be discovered', async () => {
  const t = tools();
  const args = { instructions: 'Summarise this paragraph in one sentence.', amount: '2.5', idempotencyKey: 'arc-post-3', privacy: 'public' };
  const { quote } = parse(await t.post_task(args));
  indexAnswers = [failWith(500, 'INTERNAL_ERROR')];
  errorOf(await t.post_task({ ...args, confirm: true, quoteId: quote.quoteId }));
  assert.equal(chain.sent.length, 2, 'funded');

  bridgeDown = true;
  const t2 = tools(); // a fresh process: nothing cached
  const done = parse(await t2.post_task(args));
  assert.equal(done.resumed, true);
  assert.equal(chain.sent.length, 2, 'nothing paid twice');
  assert.equal(backendCalls.filter((c) => c.path === '/api/v1/a2a/tasks/index').length, 2);
});

test('cancel_task reads the task from Arc and refunds with a local signature', async () => {
  const t = tools();
  const { quote } = parse(await t.cancel_task({ task: '8', idempotencyKey: 'arc-cancel-1' }));
  assert.equal(quote.status, 'Funded');
  assert.equal(quote.refund, '2.5');
  assert.equal(quote.settlement, 'arc');
  const done = parse(await t.cancel_task({ task: '8', idempotencyKey: 'arc-cancel-1', confirm: true, quoteId: quote.quoteId }));
  assert.equal(done.taskId, 8);
  assert.deepEqual(chain.sent.map((tx) => [tx.to, tx.data, tx.chainId]), [[ESCROW, cancelData(8), BigInt(ARC_ID)]]);
  assert.equal(chain.tasks[8], 5);
  // Built for this chain, and taken off the market once it landed.
  assert.deepEqual(backendCalls.find((c) => c.path === '/api/v1/tasks/8/cancel').body, { chain: 'arc' });
  assert.deepEqual(backendCalls.find((c) => c.path === '/api/v1/tasks/8/confirm-tx').body, { txHash: chain.sent[0].hash, chain: 'arc' });
  assert.equal(done.listingClosed, true);
});

// On an upgraded escrow, claimTimeout on delivered, never-judged work sends
// it for review: the task ends Disputed, not Cancelled, and nothing is
// refunded (security audit run 1, C18). The tool used to wait 90s for
// Cancelled and fail REFUND_PENDING, on every retry.
test('claim_timeout on delivered work reports it sent for review, not refunded', async () => {
  chain.tasks[10] = 2;
  chain.deadlines = { 10: 1n };
  overrides['/api/v1/tasks/10/timeout'] = () => ({
    unsignedTx: { to: ESCROW, data: ESCROW_CALLS.encodeFunctionData('claimTimeout', [10n]) }, chain: 'arc', chainId: ARC_ID, outcome: 'escalate',
  });
  const t = tools();
  const { quote } = parse(await t.claim_timeout({ task: '10', idempotencyKey: 'arc-timeout-review-1' }));
  assert.equal(quote.status, 'Submitted');
  assert.match(quote.note, /sends it for review instead of refunding you/);
  const done = parse(await t.claim_timeout({ task: '10', idempotencyKey: 'arc-timeout-review-1', confirm: true, quoteId: quote.quoteId }));
  assert.equal(done.outcome, 'escalate');
  assert.equal(done.listingClosed, false);
  assert.equal(done.refunded, undefined);
  assert.match(done.hint, /nothing was refunded/);
  assert.equal(chain.tasks[10], 6);
  assert.equal(backendCalls.some((c) => c.path === '/api/v1/tasks/10/confirm-tx'), false, 'no refund to confirm');
  // A retry with the same key reports the same outcome without sending again.
  const again = parse(await t.claim_timeout({ task: '10', idempotencyKey: 'arc-timeout-review-1' }));
  assert.equal(again.outcome, 'escalate');
  assert.equal(chain.sent.length, 1);
});

test('complete_task delivers on Arc with a local signature and reports the payout in USDC', async () => {
  const t = tools();
  const done = parse(await t.complete_task({ task: HASH, output: 'A one-sentence summary of the paragraph, as asked.' }));
  assert.equal(done.onChainStatus, 'Completed');
  assert.equal(done.paidTo, OWNER.address);
  assert.match(done.hint, /2\.5 USDC/);
  assert.deepEqual(chain.sent.map((tx) => [tx.to, tx.data, tx.chainId]), [[ESCROW, submitData(9, { output: 'A one-sentence summary of the paragraph, as asked.' }), BigInt(ARC_ID)]]);
});

test('wallet_status reports the local wallet signing on Arc', async () => {
  const { settlement } = parse(await tools().wallet_status({}));
  assert.equal(settlement.mode, 'arc');
  assert.equal(settlement.payment, 'local-erc20');
  assert.equal(settlement.payFrom, OWNER.address);
  assert.equal(settlement.token.address, USDC);
  assert.match(settlement.signs, /local wallet/);
});

test('register_as_executor declares Arc, where this process can deliver', async () => {
  const t = tools();
  parse(await t.register_as_executor({ displayName: 'arc-exec', capabilities: 'data_processing', publicKey: OWNER.signingKey.publicKey.slice(2) }));
  const reg = backendCalls.find((c) => c.path === '/api/v1/a2a/register').body;
  assert.deepEqual(reg.supportedChains, ['arc']);
});

test('without a local key, spends and registration say to set BLINDMARKET_PRIVATE_KEY', async () => {
  const t = tools({ withWallet: false });
  const post = errorOf(await t.post_task({ instructions: 'Anything at all, really.', amount: '1', idempotencyKey: 'arc-nokey-1' }));
  assert.equal(post.code, 'UNSUPPORTED_SETTLEMENT');
  assert.match(post.message, /BLINDMARKET_PRIVATE_KEY/);
  const reg = errorOf(await t.register_as_executor({ displayName: 'x', capabilities: 'data_processing', publicKey: OWNER.signingKey.publicKey.slice(2) }));
  assert.match(reg.message, /BLINDMARKET_PRIVATE_KEY/);
  assert.equal(chain.sent.length, 0);
});

test('forced to 0G against a backend that posts on Arc, post_task refuses before the quote', async () => {
  process.env.BLINDMARKET_SETTLEMENT = '0g';
  const t = tools();
  const error = errorOf(await t.post_task({ instructions: 'Anything at all, really.', amount: '1', idempotencyKey: 'arc-forced-0g-1' }));
  assert.equal(error.code, 'NOT_POSTING_CHAIN');
  assert.match(error.message, /posts new tasks on arc/);
  assert.equal(backendCalls.some((c) => c.path === '/api/v1/storage/upload'), false, 'nothing uploaded, no hash claimed');
});

// ── Security audit run 1, C41: only the escrow call asked for is signed ─────

const DEAD = '0x000000000000000000000000000000000000dEaD';
const MAX = 2n ** 256n - 1n;

test('cancel_task refuses a backend "refund" that is an approve or another task\'s cancel, with nothing signed', async () => {
  const t = tools();
  const cases = [
    ['approve on the escrow', { to: ESCROW, data: ERC20.encodeFunctionData('approve', [DEAD, MAX]) }, 'TX_MISMATCH'],
    ['another task', { to: ESCROW, data: cancelData(7) }, 'TX_MISMATCH'],
    ['approve on the token', { to: USDC, data: ERC20.encodeFunctionData('approve', [DEAD, MAX]) }, 'ESCROW_MISMATCH'],
  ];
  for (const [i, [name, unsignedTx, code]] of cases.entries()) {
    overrides['/api/v1/tasks/8/cancel'] = () => ({ unsignedTx, chain: 'arc', chainId: ARC_ID });
    const key = `arc-c41-cancel-${i}`;
    const { quote } = parse(await t.cancel_task({ task: '8', idempotencyKey: key }));
    const error = errorOf(await t.cancel_task({ task: '8', idempotencyKey: key, confirm: true, quoteId: quote.quoteId }));
    assert.equal(error.code, code, name);
    assert.match(error.message, /Nothing was sent|expecting escrow/, name);
  }
  assert.equal(chain.sent.length, 0);
  assert.equal(chain.tasks[8], 0);
});

test('post_task refuses a createTask for another amount than the one quoted and approved', async () => {
  overrides['/api/v1/tasks'] = (body) => ({ unsignedTx: { to: ESCROW, data: createTaskData({ ...body, amount: '250000000' }) }, chain: 'arc', chainId: ARC_ID });
  const t = tools();
  const args = { instructions: 'Summarise this paragraph in one sentence.', amount: '2.5', idempotencyKey: 'arc-c41-post-1', privacy: 'public' };
  const { quote } = parse(await t.post_task(args));
  const error = errorOf(await t.post_task({ ...args, confirm: true, quoteId: quote.quoteId }));
  assert.equal(error.code, 'TX_MISMATCH');
  // Only the approve of the quoted 2.5 USDC went out (it precedes the build); no createTask.
  assert.deepEqual(chain.sent.map((tx) => tx.to), [USDC]);
  assert.deepEqual(ERC20.decodeFunctionData('approve', chain.sent[0].data).map(String), [ESCROW, '2500000']);
  assert.equal(backendCalls.some((c) => c.path === '/api/v1/a2a/tasks/index'), false);
});

test('complete_task refuses a submitEvidence for another result, a native transfer, or another chain', async () => {
  const submitPath = `/api/v1/a2a/tasks/${HASH}/submit`;
  const output = 'A one-sentence summary of the paragraph, as asked.';
  const cases = [
    ['other result', { to: ESCROW, data: submitData(9, { output: 'not what this call delivered' }) }, 'TX_MISMATCH'],
    ['other task', { to: ESCROW, data: submitData(8, { output }) }, 'TX_MISMATCH'],
    ['native transfer', { to: DEAD, data: '0x', value: '5000000000000000000' }, 'ESCROW_MISMATCH'],
    ['other chain', { to: ESCROW, data: submitData(9, { output }), chainId: 84532 }, 'CHAIN_MISMATCH'],
  ];
  for (const [name, unsignedSubmitEvidence, code] of cases) {
    overrides[submitPath] = () => ({ onChainTaskId: 9, chain: 'arc', unsignedSubmitEvidence });
    const error = errorOf(await tools().complete_task({ task: HASH, output }));
    assert.equal(error.code, code, name);
  }
  assert.equal(chain.sent.length, 0);
  assert.equal(chain.tasks[9], 1);
});
