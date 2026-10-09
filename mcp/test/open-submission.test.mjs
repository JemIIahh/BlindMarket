import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, JsonRpcProvider, Transaction, Wallet, getAddress, keccak256, toUtf8Bytes } from 'ethers';

/**
 * Open submission (docs/OPEN-SUBMISSION-TASKS.md) from the MCP server, on
 * Arc with a local signature: posting a task many agents submit to,
 * submitting to one, picking its winner, and the cancel the escrow refuses
 * once anyone has submitted. Same harness as local-erc20-arc.test.mjs:
 * production's /health/bridge, a stub node answering as Arc, and a real
 * Wallet, so each test decodes the raw transactions it would broadcast.
 */

process.env.BLINDMARKET_STATE_DIR = mkdtempSync(join(tmpdir(), 'bm-mcp-state-'));
delete process.env.BLINDMARKET_SETTLEMENT;
delete process.env.BLINDMARKET_USDC_ADDRESS;

const { registerRentTools } = await import('../dist/rent.js');
const { registerWalletTools } = await import('../dist/wallet.js');
const { registerMarketTools } = await import('../dist/tools.js');

const PROD_BRIDGE = JSON.parse(readFileSync(new URL('../../fixtures/prod/health-bridge.json', import.meta.url), 'utf-8'));
const PROD_SETTLEMENT = JSON.parse(readFileSync(new URL('../../fixtures/prod/health-settlement.json', import.meta.url), 'utf-8'));
const ARC = PROD_BRIDGE.data.chains.find((c) => c.chain === 'arc');
assert.equal(ARC.relayChain, null, 'the fixture is production: Arc has no relay');
const ESCROW = getAddress(ARC.escrowAddress);
const USDC = getAddress(ARC.token.address);
const ARC_ID = ARC.chainId;
/** Arc mainnet (ARC_CHAIN_ID=5042): the same chain key and USDC address, its own escrow. */
const ARC_MAINNET_ID = 5042;
// Arc mainnet's own escrow (contracts/deployments/arc-mainnet.json): only a pinned escrow is funded.
const MAINNET_ESCROW = getAddress('0xd2B819B57a9568Cb6bFc98C687F9a851EC8330C4');

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
  'function createTaskOpen(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration, address verifierAgent, uint8 mode, uint256 creatorWindow)',
  'function submitOpen(uint256 taskId, bytes32 evidenceHash)',
  'function selectWinner(uint256 taskId, address winner, bytes32 scorecardHash)',
  'function selectWinnerByVerifier(uint256 taskId, address winner, bytes32 scorecardHash)',
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
            if ([ESCROW, MAINNET_ESCROW].some((a) => a.toLowerCase() === to.toLowerCase())) {
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
            // chain.loseCreateReply: the node takes the createTask, but its answer never comes back.
            if (chain.loseCreateReply && callName(tx.data) === 'createTask') {
              chain.loseCreateReply = false;
              return { jsonrpc: '2.0', id, error: { code: -32000, message: 'upstream connection reset' } };
            }
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
          case 'eth_getTransactionReceipt': {
            // chain.revertCreates: every createTask reverts (nothing escrowed).
            const tx = chain.sent.find((t) => t.hash === params[0]);
            const reverted = chain.revertCreates && tx && callName(tx.data) === 'createTask';
            result = {
              transactionHash: params[0], transactionIndex: '0x0', blockHash: '0x' + 'b'.repeat(64), blockNumber: '0x10',
              from: OWNER.address, to: ESCROW, contractAddress: null, cumulativeGasUsed: '0x5208', gasUsed: '0x5208',
              effectiveGasPrice: '0x1', logs: [], logsBloom: '0x' + '0'.repeat(512), status: reverted ? '0x0' : '0x1', type: '0x2',
            };
            break;
          }
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
let openConfig;
let openStatus;
beforeEach(() => {
  overrides = {};
  openConfig = { enabled: true, posting: true, pickModes: ['agent', 'creator'], windows: { creatorMinSec: 3600, creatorMaxSec: 604800, verifierSec: 172800, backupSec: 172800 }, maxResultBytes: 65536, maxScorecardBytes: 32768 };
  openStatus = { taskHash: HASH, onChainTaskId: '41', chain: 'arc', mode: 'creator', phase: 'submissions', paused: false, submissions: 2, windows: { submissionsEnd: Number(FUTURE), creatorPickEnd: null, verifierPickEnd: 0, backupPickEnd: 0 }, outcome: null, declined: null };
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
  if (path === '/api/v1/a2a/open-submission') return json(openConfig);
  if (path === `/api/v1/a2a/tasks/${HASH}/open-status`) return json(openStatus);
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

const VERIFIER = getAddress('0x' + 'c3'.repeat(20));
const WINNER = getAddress('0x' + '7e'.repeat(20));
const sentCalls = () => chain.sent.filter((tx) => tx.to.toLowerCase() === ESCROW.toLowerCase()).map((tx) => ESCROW_CALLS.parseTransaction({ data: tx.data }));
const openEvidence = (resultData, rootHash) => keccak256(toUtf8Bytes(JSON.stringify({ resultData, rootHash })));
const createOpenData = (b, over = {}) => ESCROW_CALLS.encodeFunctionData('createTaskOpen', [
  b.taskHash, b.token, b.amount, 'general', b.locationZone, b.duration, b.verifierAddress,
  over.mode ?? (b.open.mode === 'creator' ? 1 : 0), over.window ?? b.open.creatorWindow,
]);
const builtOpen = (over) => (b) => ({ unsignedTx: { to: ESCROW, data: createOpenData(b, over), from: OWNER.address }, chain: 'arc', chainId: ARC_ID });
const openPost = { instructions: 'Name three primary sources for the 1907 panic, with links.', amount: '2', open: true, verifierAddress: VERIFIER };

test('post_task open: quotes it, then funds exactly createTaskOpen, public and judged by its verifier', async () => {
  overrides['/api/v1/tasks'] = builtOpen();
  const t = tools();
  const { quote } = parse(await t.post_task({ ...openPost, pick: 'me', pickWindowSeconds: 7200, idempotencyKey: 'open-post-1' }));
  assert.deepEqual(quote.open, { submissions: 'many agents, one winner', verifier: VERIFIER, picksFirst: 'you', pickWindowSeconds: 7200 });
  assert.equal(quote.privacy, 'public');
  const done = parse(await t.post_task({ ...openPost, pick: 'me', pickWindowSeconds: 7200, idempotencyKey: 'open-post-1', confirm: true, quoteId: quote.quoteId }));
  const build = backendCalls.find((c) => c.path === '/api/v1/tasks').body;
  assert.equal(build.privacy, 'public');
  assert.equal(build.verificationMode, 'agent');
  assert.equal(build.verifierAddress, VERIFIER);
  assert.deepEqual(build.open, { mode: 'creator', creatorWindow: 7200 });
  assert.equal(build.wrappedKeys, undefined);
  const [create] = sentCalls();
  assert.equal(create.name, 'createTaskOpen');
  assert.deepEqual([create.args[6], create.args[7], create.args[8]], [VERIFIER, 1n, 7200n]);
  const index = backendCalls.find((c) => c.path === '/api/v1/a2a/tasks/index').body;
  assert.equal(index.privacy, 'public');
  assert.equal(index.verificationMode, 'agent');
  assert.equal(index.verifierAddress, VERIFIER);
  assert.deepEqual(done.open, { mode: 'creator', creatorWindow: 7200 });
});

test('post_task open lets the verifier pick by default, with no poster window', async () => {
  overrides['/api/v1/tasks'] = builtOpen();
  const t = tools();
  const { quote } = parse(await t.post_task({ ...openPost, idempotencyKey: 'open-post-2' }));
  parse(await t.post_task({ ...openPost, idempotencyKey: 'open-post-2', confirm: true, quoteId: quote.quoteId }));
  assert.deepEqual(backendCalls.find((c) => c.path === '/api/v1/tasks').body.open, { mode: 'agent', creatorWindow: 0 });
  const [create] = sentCalls();
  assert.deepEqual([create.args[7], create.args[8]], [0n, 0n]);
});

test('post_task open refuses what the escrow or the task board would refuse, before quoting', async () => {
  const cases = [
    [{ privacy: 'private' }, 'OPEN_TASK_MUST_BE_PUBLIC'],
    [{ verifierAddress: undefined }, 'OPEN_TASK_NEEDS_VERIFIER'],
    [{ verifierAddress: OWNER.address }, 'INVALID_VERIFIER'],
    [{ pickWindowSeconds: 7200 }, 'INVALID_PICK_WINDOW'],
    [{ open: undefined }, 'OPEN_REQUIRED'],
  ];
  for (const [over, code] of cases) {
    const t = tools();
    assert.equal(errorOf(await t.post_task({ ...openPost, ...over, idempotencyKey: `open-refuse-${code}` })).code, code);
  }
  openConfig.enabled = false;
  assert.equal(errorOf(await tools().post_task({ ...openPost, idempotencyKey: 'open-refuse-off' })).code, 'OPEN_SUBMISSION_DISABLED');
  openConfig.enabled = true;
  openConfig.posting = false;
  assert.equal(errorOf(await tools().post_task({ ...openPost, idempotencyKey: 'open-refuse-unsupported' })).code, 'OPEN_SUBMISSION_UNSUPPORTED');
  assert.equal(backendCalls.filter((c) => c.path === '/api/v1/tasks').length, 0);
  assert.equal(chain.sent.length, 0);
});

test('post_task open refuses a backend that builds another pick mode or a task one agent takes, with nothing funded', async () => {
  for (const [key, build] of [
    ['open-mismatch-1', builtOpen({ mode: 0 })],
    ['open-mismatch-2', builtOpen({ window: 3600 })],
    ['open-mismatch-3', (b) => ({ unsignedTx: { to: ESCROW, data: createTaskData(b), from: OWNER.address }, chain: 'arc', chainId: ARC_ID })],
  ]) {
    overrides['/api/v1/tasks'] = build;
    const t = tools();
    const { quote } = parse(await t.post_task({ ...openPost, pick: 'me', pickWindowSeconds: 7200, idempotencyKey: key }));
    assert.equal(errorOf(await t.post_task({ ...openPost, pick: 'me', pickWindowSeconds: 7200, idempotencyKey: key, confirm: true, quoteId: quote.quoteId })).code, 'TX_MISMATCH');
  }
  assert.equal(sentCalls().length, 0);
});

const submitted = (resultData, rootHash, over = {}) => {
  const evidenceHash = over.evidenceHash ?? openEvidence(resultData, rootHash);
  return {
    taskHash: HASH, onChainTaskId: over.onChainTaskId ?? '41', evidenceHash,
    unsignedSubmitOpen: { to: over.to ?? ESCROW, from: over.from ?? OWNER.address, chainId: ARC_ID, data: ESCROW_CALLS.encodeFunctionData('submitOpen', [BigInt(over.dataTaskId ?? 41), evidenceHash]) },
    resultHeldForSec: 3600,
  };
};

test('submit_open_result signs submitOpen for this task, committing this result', async () => {
  overrides[`/api/v1/a2a/tasks/${HASH}/submit-open`] = (b) => submitted(b.resultData, b.rootHash);
  const done = parse(await tools().submit_open_result({ task: HASH, output: 'Three sources: …' }));
  const body = backendCalls.find((c) => c.path.endsWith('/submit-open')).body;
  assert.deepEqual(body, { resultData: { output: 'Three sources: …' }, rootHash: null });
  const [call] = sentCalls();
  assert.equal(call.name, 'submitOpen');
  assert.deepEqual([call.args[0], call.args[1]], [41n, openEvidence({ output: 'Three sources: …' }, null)]);
  assert.equal(done.submitTxHash, chain.sent[0].hash);
  assert.equal(chain.sent[0].chainId, BigInt(ARC_ID));
});

test('submit_open_result sends nothing for a result already on-chain', async () => {
  overrides[`/api/v1/a2a/tasks/${HASH}/submit-open`] = (b) => ({ taskHash: HASH, onChainTaskId: '41', evidenceHash: openEvidence(b.resultData, b.rootHash), alreadyOnChain: true, kept: true });
  assert.equal(parse(await tools().submit_open_result({ task: HASH, output: 'Three sources: …' })).alreadyOnChain, true);
  assert.equal(chain.sent.length, 0);
});

test('submit_open_result refuses a submission built wrong, with nothing sent', async () => {
  for (const [over, code] of [
    [{ evidenceHash: '0x' + '99'.repeat(32) }, 'TX_MISMATCH'],
    [{ dataTaskId: 42 }, 'TX_MISMATCH'],
    [{ onChainTaskId: '42' }, 'TX_MISMATCH'],
    [{ from: WINNER }, 'WALLET_MISMATCH'],
    [{ to: USDC }, null],
  ]) {
    overrides[`/api/v1/a2a/tasks/${HASH}/submit-open`] = (b) => submitted(b.resultData, b.rootHash, over);
    const err = errorOf(await tools().submit_open_result({ task: HASH, output: 'Three sources: …' }));
    if (code) assert.equal(err.code, code);
  }
  assert.equal(chain.sent.length, 0);
});

test('submit_open_result refuses a task on another chain than this process settles', async () => {
  openStatus.chain = 'base';
  assert.equal(errorOf(await tools().submit_open_result({ task: HASH, output: 'x' })).code, 'CHAIN_MISMATCH');
  assert.equal(backendCalls.some((c) => c.path.endsWith('/submit-open')), false);
});

const ZERO = '0x' + '00'.repeat(32);
const picked = (fn, winner, card = ZERO) => ({ onChainTaskId: '41', winner: winner.toLowerCase(), scorecardHash: card,
  [fn === 'selectWinner' ? 'unsignedSelectWinner' : 'unsignedSelectWinnerByVerifier']: { to: ESCROW, from: OWNER.address, chainId: ARC_ID, data: ESCROW_CALLS.encodeFunctionData(fn, [41n, winner, card]) } });

test('pick_open_winner quotes the pick, then signs the poster\'s selectWinner for this winner and scorecard', async () => {
  const scorecard = { scores: [{ submitter: WINNER, score: 9 }] };
  const card = keccak256(toUtf8Bytes(JSON.stringify(scorecard)));
  overrides[`/api/v1/a2a/tasks/${HASH}/select`] = (b) => picked('selectWinner', b.winner, card);
  const t = tools();
  const { quote } = parse(await t.pick_open_winner({ task: HASH, winner: WINNER, scorecard }));
  assert.equal(chain.sent.length, 0);
  const done = parse(await t.pick_open_winner({ task: HASH, winner: WINNER, scorecard, confirm: true, quoteId: quote.quoteId }));
  const [call] = sentCalls();
  assert.equal(call.name, 'selectWinner');
  assert.deepEqual([call.args[0], call.args[1], call.args[2]], [41n, WINNER, card]);
  assert.equal(done.role, 'poster');
});

test('pick_open_winner signs selectWinnerByVerifier for the verifier, and refuses a confirm naming another winner', async () => {
  overrides[`/api/v1/a2a/tasks/${HASH}/select`] = (b) => picked('selectWinnerByVerifier', b.winner);
  const t = tools();
  const first = parse(await t.pick_open_winner({ task: HASH, winner: WINNER }));
  assert.equal(errorOf(await t.pick_open_winner({ task: HASH, winner: OWNER.address, confirm: true, quoteId: first.quote.quoteId })).code, 'QUOTE_MISMATCH');
  const { quote } = parse(await t.pick_open_winner({ task: HASH, winner: WINNER }));
  assert.equal(parse(await t.pick_open_winner({ task: HASH, winner: WINNER, confirm: true, quoteId: quote.quoteId })).role, 'verifier');
  assert.equal(sentCalls()[0].name, 'selectWinnerByVerifier');
});

test('pick_open_winner refuses a pick built for another winner or with both picks, with nothing sent', async () => {
  for (const build of [
    () => picked('selectWinner', OWNER.address),
    () => ({ ...picked('selectWinner', WINNER), ...picked('selectWinnerByVerifier', WINNER) }),
    () => ({ ...picked('selectWinner', WINNER), scorecardHash: '0x' + '55'.repeat(32) }),
  ]) {
    overrides[`/api/v1/a2a/tasks/${HASH}/select`] = build;
    const t = tools();
    const { quote } = parse(await t.pick_open_winner({ task: HASH, winner: WINNER }));
    assert.equal(errorOf(await t.pick_open_winner({ task: HASH, winner: WINNER, confirm: true, quoteId: quote.quoteId })).code, 'TX_MISMATCH');
  }
  assert.equal(chain.sent.length, 0);
});

test('cancel_task refuses an open task once anyone has submitted, and quotes it with none', async () => {
  openStatus.submissions = 3;
  assert.equal(errorOf(await tools().cancel_task({ task: '8', idempotencyKey: 'open-cancel-1' })).code, 'HAS_SUBMISSIONS');
  openStatus.submissions = 0;
  assert.ok(parse(await tools().cancel_task({ task: '8', idempotencyKey: 'open-cancel-2' })).quote.quoteId);
});
