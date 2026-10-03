import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, Transaction, Wallet, getAddress } from 'ethers';

/**
 * The `blind` commands, driven through the same program the binary runs,
 * against production's recorded /health/settlement and /deploy-fee bodies
 * (fixtures/prod) and a stub JSON-RPC node that answers as Arc. The wallet
 * signs for real, and each test decodes the raw transactions it broadcast.
 *
 * 0.3 could not complete any of this: `register` discarded the only key that
 * could sign, and every command printed an unsigned transaction.
 */

const OWNER = Wallet.createRandom();
process.env.BLIND_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'blind-cli-'));
process.env.BLINDMARKET_API_BASE = 'https://backend.test';
process.env.BLINDMARKET_API_KEY = 'sk_test';
process.env.BLINDMARKET_PRIVATE_KEY = OWNER.privateKey;
delete process.env.BLINDMARKET_KEYSTORE_PASSWORD;
process.env.OPENAI_API_KEY = 'sk-openai-test';

const { buildProgram } = await import('../dist/program.js');

const SETTLEMENT = JSON.parse(readFileSync(new URL('../../fixtures/prod/health-settlement.json', import.meta.url), 'utf-8')).data;
const FEE_TERMS = { ...JSON.parse(readFileSync(new URL('../../fixtures/prod/deploy-fee.json', import.meta.url), 'utf-8')).data, chainId: 5042002 };
const ARC = SETTLEMENT.chains.find((c) => c.chain === 'arc');
/** Arc mainnet: a backend with ARC_CHAIN_ID=5042 names it 'arc' too, with the same USDC address. */
const ARC_MAINNET_ID = 5042;
/** Arc mainnet's own escrow (contracts/deployments/arc-mainnet.json): the SDK funds only a pinned deployment. */
const MAINNET_ESCROW = getAddress('0xd2B819B57a9568Cb6bFc98C687F9a851EC8330C4');
const escrowNow = () => getAddress(settlement.chains.find((c) => c.chain === 'arc').escrowAddress);
const ESCROW = getAddress(ARC.escrowAddress);
const USDC = getAddress(ARC.token.address);
const TREASURY = getAddress(FEE_TERMS.recipient);

const ERC20 = new Interface([
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
]);
// What the real backend builds (backend/src/services/escrow.ts): the SDK signs nothing else.
const ESCROW_CALLS = new Interface([
  'function createTask(bytes32 taskHash, address token, uint256 amount, string category, string locationZone, uint256 duration)',
  'function cancelTask(uint256 taskId)',
  'function claimTimeout(uint256 taskId)',
]);
const createTaskData = (b) => ESCROW_CALLS.encodeFunctionData('createTask', [b.taskHash, b.token, b.amount, 'general', b.locationZone, b.duration]);
// An escrow with createTasks (docs/BULK-POSTING.md), as the backend builds it for POST /tasks/batch.
const BATCH_CALLS = new Interface([
  'function createTasks(address token, tuple(bytes32 taskHash, uint256 amount, string category, string locationZone, uint256 duration, address verifierAgent)[] tasks)',
]);
const createTasksData = (b) => BATCH_CALLS.encodeFunctionData('createTasks', [b.token, b.tasks.map((t) => [t.taskHash, t.amount, 'general', t.locationZone, t.duration, '0x' + '00'.repeat(20)])]);
const cancelData = (id) => ESCROW_CALLS.encodeFunctionData('cancelTask', [BigInt(id)]);
const claimData = (id) => ESCROW_CALLS.encodeFunctionData('claimTimeout', [BigInt(id)]);

let chain;
let rpc;
before(async () => {
  rpc = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const one = ({ id, method, params }) => {
        let result;
        chain.rpcCalls.push(method);
        switch (method) {
          case 'eth_chainId': result = '0x' + chain.served.toString(16); break;
          case 'eth_blockNumber': result = '0x10'; break;
          case 'eth_getBlockByNumber': result = { number: '0x10', hash: '0x' + '0b'.repeat(32), parentHash: '0x' + '0a'.repeat(32), timestamp: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x3b9aca00', miner: '0x' + '00'.repeat(20), extraData: '0x', difficulty: '0x0', nonce: '0x0000000000000000', transactions: [] }; break;
          case 'eth_maxPriorityFeePerGas': result = '0x1'; break;
          case 'eth_gasPrice': result = '0x3b9aca00'; break;
          case 'eth_getTransactionCount': result = '0x' + chain.sent.length.toString(16); break;
          case 'eth_estimateGas': result = '0x30000'; break;
          case 'eth_call': {
            const fn = ERC20.parseTransaction({ data: params[0].data }).name;
            result = ERC20.encodeFunctionResult(fn, [fn === 'allowance' ? chain.allowance : 10_000_000n]);
            break;
          }
          case 'eth_sendRawTransaction': {
            const tx = Transaction.from(params[0]);
            chain.sent.push(tx);
            if (tx.to === USDC && tx.data.startsWith(ERC20.getFunction('approve').selector)) chain.allowance = ERC20.decodeFunctionData('approve', tx.data)[1];
            result = tx.hash;
            break;
          }
          case 'eth_getTransactionByHash': {
            // Known while sent here or waiting in the mempool; a dropped transaction is unknown.
            const known = chain.sent.some((t) => t.hash === params[0]) || chain.mempool.has(params[0]);
            result = known ? { hash: params[0] } : null;
            break;
          }
          case 'eth_getTransactionReceipt': {
            // Only for a transaction this node has: one sent to it, or one a test mined.
            const status = chain.mined.has(params[0]) ? chain.mined.get(params[0]) : chain.sent.some((t) => t.hash === params[0]) ? '0x1' : undefined;
            result = status === undefined ? null : {
              transactionHash: params[0], transactionIndex: '0x0', blockHash: '0x' + 'b'.repeat(64), blockNumber: '0x10',
              from: OWNER.address, to: ESCROW, contractAddress: null, cumulativeGasUsed: '0x5208', gasUsed: '0x5208',
              effectiveGasPrice: '0x1', logs: [], logsBloom: '0x' + '0'.repeat(512), status, type: '0x2',
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
  process.env.BLINDMARKET_ARC_RPC_URL = `http://127.0.0.1:${rpc.address().port}`;
});
after(() => rpc.close());

let calls;
let answers;
let whoami;
/** Task hashes the backend knows on-chain (GET /api/v1/tasks/:hash). */
let onChain;
/** What /health/settlement and /deploy-fee answer: production's, unless a test moves the backend. */
let settlement;
let feeTerms;
/** GET /agents/capacity, /health/bridge, and how many agents the stub has created. */
let capacity;
let bridge;
let agentsMade;
beforeEach(() => {
  chain = { served: ARC.chainId, allowance: 0n, sent: [], mined: new Map(), mempool: new Set(), rpcCalls: [] };
  onChain = new Set();
  calls = [];
  answers = {};
  whoami = OWNER.address;
  settlement = SETTLEMENT;
  feeTerms = FEE_TERMS;
  capacity = { poolMax: 10, poolFree: 10, ownerMax: 10, ownerFree: 10, canStart: true, scope: 'process' };
  bridge = { gasSponsor: { enabled: false } };
  agentsMade = 0;
  for (const f of ['state.json', 'config.json', 'keystore.json']) rmSync(join(process.env.BLIND_CONFIG_DIR, f), { force: true });
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, init);
  const path = u.replace(/^https?:\/\/[^/]+/, '');
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method ?? 'GET', path, body, auth: init.headers?.Authorization });
  const json = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
  const queued = answers[path]?.shift();
  if (queued) return queued;
  if (path === '/health/settlement') return json(settlement);
  if (path === '/api/v1/api-keys/whoami') return json({ address: whoami, addresses: [whoami] });
  if (path.startsWith('/api/v1/a2a/executors')) return json({ executors: [] });
  if (path === '/api/v1/storage/upload') return json({ rootHash: '0x' + 'cd'.repeat(32) });
  if (path === '/api/v1/tasks') return json({ unsignedTx: { to: escrowNow(), data: createTaskData(body), from: OWNER.address }, chain: 'arc', chainId: settlement.chains.find((c) => c.chain === 'arc').chainId });
  if (path === '/api/v1/tasks/8/cancel') return json({ unsignedTx: { to: ESCROW, data: cancelData(8) }, chain: 'arc', chainId: ARC.chainId });
  if (/^\/api\/v1\/tasks\/0x[0-9a-f]{64}$/.test(path)) {
    const hash = path.split('/').pop();
    return onChain.has(hash) ? json({ taskId: '77', chain: 'arc' }) : failWith(404, 'TASK_NOT_FOUND');
  }
  if (path === '/api/v1/tasks/8/confirm-tx') return json({ confirmed: 1 });
  if (path === '/api/v1/a2a/tasks/index') return json({ taskHash: body.taskHash, onChainTaskId: '51', indexed: true });
  if (path === '/api/v1/storage/upload-batch') return json({ results: body.items.map((_, k) => ({ rootHash: '0x' + (k + 1).toString(16).padStart(64, '0') })) });
  if (path === '/api/v1/tasks/batch') return json({ unsignedTx: { to: escrowNow(), data: createTasksData(body) }, chain: 'arc', chainId: settlement.chains.find((c) => c.chain === 'arc').chainId });
  if (path === '/api/v1/a2a/tasks/index-batch') return json({ results: body.tasks.map((t, k) => ({ taskHash: t.taskHash, onChainTaskId: String(60 + k), indexed: true })) });
  if (path === '/api/v1/agents/deploy-fee') return json(feeTerms);
  if (path === '/api/v1/agents/deploy/validate') return json({ valid: true });
  if (path === '/api/v1/agents/deploy') {
    if (!body.feeTxHash) return failWith(402, 'NO_DEPLOY_CREDIT');
    const n = agentsMade++;
    return json({ id: `agent-${7 + n}`, name: body.name, walletAddress: agentWallet(n), publicKey: '04ab', status: 'running', started: true });
  }
  if (path === '/api/v1/agents/capacity') return json(capacity);
  if (path === '/health/bridge') return json(bridge);
  if (path === '/api/v1/registration/session') return failWith(503, 'REGISTRATION_DISABLED');
  throw new Error('unexpected backend call ' + path);
};
/** The nth agent's wallet (0-based): the first is 0x4444…, as single deploys always got. */
const agentWallet = (n) => getAddress('0x' + (0x44 + n).toString(16).repeat(20));
const failWith = (status, code, extra = {}) => ({ ok: false, status, json: async () => ({ success: false, error: { code, message: code, ...extra } }) });
const answer = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });

/** Run `blind <args>`: resolves with stdout lines, rejects with the thrown error. */
async function blind(...args) {
  const lines = [];
  const log = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    await buildProgram().exitOverride().parseAsync(['node', 'blind', ...args]);
    return lines.join('\n');
  } finally {
    console.log = log;
  }
}
const state = () => JSON.parse(readFileSync(join(process.env.BLIND_CONFIG_DIR, 'state.json'), 'utf-8'));
const writeState = (s) => writeFileSync(join(process.env.BLIND_CONFIG_DIR, 'state.json'), JSON.stringify(s));
const posted = (path) => calls.filter((c) => c.path === path);

// ── post-task ────────────────────────────────────────────────────────────────

test('post-task --reward funds the escrow on Arc from the owner wallet and lists the task', async () => {
  const text = await blind('post-task', '--instructions', 'Summarise this paragraph in one sentence.', '--reward', '2.5', '--public', '--yes');
  assert.equal(chain.sent.length, 2);
  const [approve, create] = chain.sent;
  assert.equal(approve.to, USDC);
  assert.deepEqual(ERC20.decodeFunctionData('approve', approve.data).map(String), [ESCROW, '2500000']);
  assert.equal(create.to, ESCROW);
  assert.equal(create.chainId, BigInt(ARC.chainId));
  assert.equal(create.nonce, approve.nonce + 1);
  assert.equal(posted('/api/v1/tasks')[0].body.amount, '2500000', '2.5 USDC in 6 decimals');
  assert.equal(posted('/api/v1/tasks')[0].auth, 'Bearer sk_test');
  assert.equal(posted('/api/v1/a2a/tasks/index')[0].body.txHash, create.hash);
  assert.match(text, /Posted public task on arc/);
  assert.match(text, /task id:\s+51/);
  assert.deepEqual(state().pendingPosts, {}, 'nothing left pending');
});

test('post-task --amount keeps its old meaning: the smallest unit', async () => {
  await blind('post-task', '--instructions', 'Summarise this paragraph in one sentence.', '--amount', '2500000', '--public', '--yes', '--category', 'research');
  assert.equal(posted('/api/v1/tasks')[0].body.amount, '2500000');
});

test('post-task asks before spending, and without a terminal refuses unless --yes', async () => {
  await assert.rejects(
    blind('post-task', '--instructions', 'Summarise this paragraph in one sentence.', '--reward', '2.5', '--public'),
    (e) => e.code === 'CONFIRM_REQUIRED' && /--yes/.test(e.message),
  );
  assert.equal(chain.sent.length, 0);
  assert.equal(posted('/api/v1/storage/upload').length, 0);
});

test('post-task refuses a bad amount or a token that is not the settlement token, before anything is sent', async () => {
  await assert.rejects(blind('post-task', '--instructions', 'x y z', '--amount', '1.5', '--yes'), (e) => e.code === 'INVALID_AMOUNT');
  await assert.rejects(blind('post-task', '--instructions', 'x y z', '--reward', '1.1234567', '--yes'), (e) => e.code === 'INVALID_AMOUNT');
  await assert.rejects(blind('post-task', '--instructions', 'x y z', '--reward', '1', '--token', '0x' + '12'.repeat(20), '--yes'), (e) => e.code === 'TOKEN_NOT_SETTLEMENT');
  await assert.rejects(blind('post-task', '--instructions', 'x y z', '--yes'), (e) => e.code === 'AMOUNT_REQUIRED');
  assert.equal(chain.sent.length, 0);
});

test('a post whose listing fails is saved, and finish-posts lists it without paying again', async () => {
  answers['/api/v1/a2a/tasks/index'] = [failWith(403, 'NOT_TASK_AGENT')];
  await assert.rejects(
    blind('post-task', '--instructions', 'Summarise this paragraph in one sentence.', '--reward', '2.5', '--public', '--yes'),
    (e) => e.code === 'NOT_TASK_AGENT',
  );
  const pending = Object.values(state().pendingPosts);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].txHash, chain.sent[1].hash, 'saved with the full listing body');
  assert.ok(pending[0].rootHash);

  const text = await blind('finish-posts');
  assert.match(text, /Listed 0x[0-9a-f]{64} \(task id 51\)/);
  assert.equal(chain.sent.length, 2, 'nothing paid again');
  assert.deepEqual(state().pendingPosts, {});
});

// ── deploy-agent ─────────────────────────────────────────────────────────────

test('deploy-agent checks the request, pays the fee on Arc, and deploys with the owner key', async () => {
  const text = await blind('deploy-agent', '--name', 'research-agent', '--instructions', 'Research and cite.', '--provider', 'openai', '--model', 'gpt-4o-mini', '--yes');
  assert.equal(posted('/api/v1/agents/deploy/validate').length, 1);
  assert.equal(chain.sent.length, 1);
  const [pay] = chain.sent;
  assert.equal(pay.to, USDC);
  assert.equal(pay.chainId, BigInt(ARC.chainId));
  assert.deepEqual(ERC20.decodeFunctionData('transfer', pay.data).map(String), [TREASURY, '1000000']);
  const deploy = posted('/api/v1/agents/deploy').at(-1).body;
  assert.equal(deploy.feeTxHash, pay.hash);
  assert.equal(deploy.apiKey, 'sk-openai-test', 'the provider key comes from the environment');
  assert.equal(deploy.ownerPublicKey, OWNER.signingKey.publicKey.slice(2));
  assert.match(text, /Deployed agent agent-7/);
  assert.deepEqual(state().pendingFees, {});
});

test('a deploy that fails after paying keeps the payment, and the retry pays nothing', async () => {
  answers['/api/v1/agents/deploy'] = [failWith(402, 'NO_DEPLOY_CREDIT'), failWith(500, 'INTERNAL_ERROR')];
  await assert.rejects(
    blind('deploy-agent', '--name', 'a', '--instructions', 'Research and cite.', '--provider', 'openai', '--model', 'gpt-4o-mini', '--yes'),
    (e) => e.code === 'INTERNAL_ERROR',
  );
  assert.equal(chain.sent.length, 1);
  const saved = Object.values(state().pendingFees);
  assert.deepEqual(saved, [chain.sent[0].hash]);

  const text = await blind('deploy-agent', '--name', 'a', '--instructions', 'Research and cite.', '--provider', 'openai', '--model', 'gpt-4o-mini');
  assert.match(text, /already paid/);
  assert.equal(chain.sent.length, 1, 'paid once');
  assert.equal(posted('/api/v1/agents/deploy').at(-1).body.feeTxHash, chain.sent[0].hash);
  assert.deepEqual(state().pendingFees, {});
});

// ── deploy-agent --count ─────────────────────────────────────────────────────

const MANY = ['deploy-agent', '--name', 'scout', '--instructions', 'Research and cite.', '--provider', 'openai', '--model', 'gpt-4o-mini'];
/** What each USDC transfer on the stub chain paid, and to whom. */
const transfers = () => chain.sent.map((t) => ERC20.decodeFunctionData('transfer', t.data)).map(([to, amount]) => [getAddress(to), amount]);
/** stderr while `fn` runs, as lines. */
async function stderrOf(fn) {
  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return typeof rest.at(-1) === 'function' ? (rest.at(-1)(), true) : true; };
  try {
    return { value: await fn(), lines: lines.join('').split('\n').filter(Boolean) };
  } catch (e) {
    e.stderr = lines.join('');
    throw e;
  } finally {
    process.stderr.write = write;
  }
}

test('deploy-agent --count 3 checks once, pays one fee per agent, deploys each in turn and lists them', async () => {
  const resultsPath = join(process.env.BLIND_CONFIG_DIR, 'agents.json');
  const { value: text, lines } = await stderrOf(() => blind(...MANY, '--count', '3', '--results', resultsPath, '--yes'));
  assert.equal(posted('/api/v1/agents/deploy/validate').length, 1, 'the request is checked once');
  assert.match(posted('/api/v1/agents/deploy/validate')[0].body.name, /^scout [123]$/, 'with one of the names, all the same length');
  assert.deepEqual(transfers(), [[TREASURY, 1_000_000n], [TREASURY, 1_000_000n], [TREASURY, 1_000_000n]]);
  const named = posted('/api/v1/agents/deploy').filter((c) => c.body.feeTxHash).map((c) => [c.body.name, c.body.feeTxHash]);
  assert.deepEqual(named, [['scout 1', chain.sent[0].hash], ['scout 2', chain.sent[1].hash], ['scout 3', chain.sent[2].hash]]);
  assert.match(text, /Deploy 3 agents: scout 1, scout 2, scout 3/);
  assert.match(text, /1 USDC each on arc, 3 USDC for 3/);
  assert.match(text, /all 3 agents call openai with your one API key, so they share its rate limits and its bill/);
  assert.match(text, /1\s+scout 1\s+deployed\s+agent-7/);
  assert.match(text, /3\s+scout 3\s+deployed\s+agent-9/);
  assert.ok(lines.some((l) => /\[2\/3\] scout 2: deployed agent-8/.test(l)));
  const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
  assert.equal(results.deployed, 3);
  assert.deepEqual(results.agents.map((a) => [a.name, a.status, a.agentId, a.walletAddress, a.feeTxHash]), [
    ['scout 1', 'deployed', 'agent-7', agentWallet(0), chain.sent[0].hash],
    ['scout 2', 'deployed', 'agent-8', agentWallet(1), chain.sent[1].hash],
    ['scout 3', 'deployed', 'agent-9', agentWallet(2), chain.sent[2].hash],
  ]);
  assert.deepEqual(state().pendingFees, {}, 'every fee was used');
});

test('deploy-agent --count names agents with {n} and carries on from --start-at', async () => {
  await stderrOf(() => blind(...MANY.map((a) => (a === 'scout' ? 'scout-{n}-eu' : a)), '--count', '2', '--start-at', '4', '--yes'));
  assert.deepEqual(posted('/api/v1/agents/deploy').filter((c) => c.body.feeTxHash).map((c) => c.body.name), ['scout-4-eu', 'scout-5-eu']);
});

test('deploy-agent --count past the free slots says how many can start, and deploys and pays nothing', async () => {
  capacity = { ...capacity, poolFree: 2 };
  await assert.rejects(
    stderrOf(() => blind(...MANY, '--count', '3', '--yes')),
    (e) => e.code === 'AGENT_CAPACITY' && /Only 2 of the 3 agents can start now/.test(e.message) && /--count 2/.test(e.message),
  );
  capacity = { ...capacity, poolFree: 0, canStart: false };
  await assert.rejects(stderrOf(() => blind(...MANY, '--count', '1', '--yes')), (e) => e.code === 'AGENT_CAPACITY');
  assert.equal(chain.sent.length, 0);
  assert.equal(posted('/api/v1/agents/deploy').length, 0);
});

test('deploy-agent --count counts what the server\'s memory allows, and refuses past it', async () => {
  capacity = { ...capacity, memory: { availableMb: 2500, reserveMb: 2048, workerMb: 150, slotsFree: 2, source: 'os' } };
  await assert.rejects(
    stderrOf(() => blind(...MANY, '--count', '3', '--yes')),
    (e) => e.code === 'AGENT_CAPACITY' && /Only 2 of the 3 agents can start now \(10 free slots on the server, 10 left of your 10, memory for 2 more\)/.test(e.message),
  );
  assert.equal(chain.sent.length, 0);
  assert.equal(posted('/api/v1/agents/deploy').length, 0);
  const { value: text } = await stderrOf(() => blind(...MANY, '--count', '2', '--yes'));
  assert.match(text, /room:\s+2 can start now on this server \(10 free slots on the server, 10 left of your 10, memory for 2 more\)/);
});

test('deploy-agent --count asks once before spending, and without a terminal refuses unless --yes', async () => {
  await assert.rejects(stderrOf(() => blind(...MANY, '--count', '2')), (e) => e.code === 'CONFIRM_REQUIRED');
  assert.equal(chain.sent.length, 0);
  assert.equal(posted('/api/v1/agents/deploy').length, 0);
});

test('a 429 mid-run waits and asks again for the same agent, naming the fee it already paid', async () => {
  process.env.BLINDMARKET_DEPLOY_BACKOFF_MS = '1';
  try {
    // scout 1: credit check (402), pays, then 429 twice before the deploy goes through.
    answers['/api/v1/agents/deploy'] = [failWith(402, 'NO_DEPLOY_CREDIT'), failWith(429, 'RATE_LIMIT'), failWith(429, 'RATE_LIMIT')];
    const { lines } = await stderrOf(() => blind(...MANY, '--count', '2', '--yes'));
    assert.equal(transfers().length, 2, 'one fee per agent, none twice');
    const first = posted('/api/v1/agents/deploy').filter((c) => c.body.name === 'scout 1').map((c) => c.body.feeTxHash ?? null);
    assert.deepEqual(first, [null, chain.sent[0].hash, chain.sent[0].hash, chain.sent[0].hash]);
    assert.equal(lines.filter((l) => /scout 1: the backend is busy \(429\)/.test(l)).length, 2);
  } finally {
    delete process.env.BLINDMARKET_DEPLOY_BACKOFF_MS;
  }
});

test('a failure partway stops the run, keeps what deployed, saves the paid fee, and the next run spends it first', async () => {
  const resultsPath = join(process.env.BLIND_CONFIG_DIR, 'stopped.json');
  // scout 1 deploys; scout 2 pays, then the deploy fails.
  answers['/api/v1/agents/deploy'] = [failWith(402, 'NO_DEPLOY_CREDIT'), answer({ id: 'agent-1', name: 'scout 1', walletAddress: agentWallet(0), publicKey: '04ab', status: 'running', started: true }), failWith(402, 'NO_DEPLOY_CREDIT'), failWith(500, 'INTERNAL_ERROR')];
  const err = await stderrOf(() => blind(...MANY, '--count', '3', '--results', resultsPath, '--yes')).catch((e) => e);
  assert.equal(err.code, 'NOT_ALL_DEPLOYED');
  assert.match(err.message, /Deployed 1 of 3; stopped at scout 2/);
  assert.match(err.message, /deploy the rest with --count 2 --start-at 2/);
  assert.equal(transfers().length, 2);
  const paidForScout2 = chain.sent[1].hash;
  assert.deepEqual(Object.values(state().pendingFees), [paidForScout2]);
  const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
  assert.deepEqual(results.agents.map((a) => a.status), ['deployed', 'failed', 'skipped']);
  assert.equal(results.agents[1].feeTxHash, paidForScout2);
  assert.equal(results.stopped.index, 1);

  const { value: text } = await stderrOf(() => blind(...MANY, '--count', '2', '--start-at', '2', '--yes'));
  assert.match(text, /the first uses 0x[0-9a-f]{64}, already paid/);
  assert.equal(transfers().length, 3, 'scout 2 used its saved fee; only scout 3 paid');
  const named = posted('/api/v1/agents/deploy').filter((c) => c.body.feeTxHash).map((c) => [c.body.name, c.body.feeTxHash]).slice(-2);
  assert.deepEqual(named, [['scout 2', paidForScout2], ['scout 3', chain.sent[2].hash]]);
  assert.deepEqual(state().pendingFees, {});
});

test('a fee the backend says is spent is forgotten when the run stops there', async () => {
  answers['/api/v1/agents/deploy'] = [failWith(402, 'NO_DEPLOY_CREDIT'), failWith(409, 'DEPLOY_FEE_ALREADY_USED')];
  await assert.rejects(stderrOf(() => blind(...MANY, '--count', '2', '--yes')), (e) => e.code === 'NOT_ALL_DEPLOYED');
  assert.deepEqual(state().pendingFees, {});
});

test('deploy-agent --count --fund sends each wallet its gas right after its agent deploys', async () => {
  const { value: text } = await stderrOf(() => blind(...MANY, '--count', '2', '--fund', '0.05', '--yes'));
  assert.deepEqual(transfers(), [[TREASURY, 1_000_000n], [agentWallet(0), 50_000n], [TREASURY, 1_000_000n], [agentWallet(1), 50_000n]]);
  assert.ok(chain.sent.every((t) => t.to === USDC && t.chainId === BigInt(ARC.chainId)));
  assert.match(text, /0\.05 USDC to each agent's wallet on arc once it runs, 0\.1 USDC in all/);
  assert.match(text, /0\.05 \(0x/);
});

test('deploy-agent --count --fund funds no wallet whose agent did not deploy', async () => {
  answers['/api/v1/agents/deploy'] = [failWith(402, 'NO_DEPLOY_CREDIT'), failWith(500, 'INTERNAL_ERROR')];
  await assert.rejects(stderrOf(() => blind(...MANY, '--count', '2', '--fund', '0.05', '--yes')), (e) => e.code === 'NOT_ALL_DEPLOYED');
  assert.deepEqual(transfers(), [[TREASURY, 1_000_000n]], 'the fee only: no gas for an agent that does not exist');
});

test('deploy-agent --count with sponsored gas says who qualifies, and still funds only when asked', async () => {
  bridge = { gasSponsor: { enabled: true, paused: false, killed: false } };
  const { value: text } = await stderrOf(() => blind(...MANY, '--count', '1', '--fund', '0.05', '--yes'));
  assert.match(text, /One deployed with an API key qualifies after you open it there signed in/);
  assert.equal(transfers().length, 2);
});

test('deploy-agent --count warns that each 0g-compute agent needs its own 0G', async () => {
  const { value: text } = await stderrOf(() => blind('deploy-agent', '--name', 'og', '--instructions', 'x', '--provider', '0g-compute', '--model', 'glm-5', '--count', '2', '--yes'));
  assert.match(text, /each 0g-compute agent pays for its own inference: send each wallet about 3\.1 0G/);
  assert.doesNotMatch(text, /share its rate limits/);
});

test('deploy-agent refuses a bad --count, and --fund or --results without --count, before anything', async () => {
  await assert.rejects(blind(...MANY, '--count', '11', '--yes'), (e) => e.code === 'INVALID_COUNT' && /1 to 10/.test(e.message));
  await assert.rejects(blind(...MANY, '--count', '0', '--yes'), (e) => e.code === 'INVALID_COUNT');
  await assert.rejects(blind(...MANY, '--count', '2', '--start-at', '0', '--yes'), (e) => e.code === 'INVALID_COUNT');
  await assert.rejects(blind(...MANY, '--fund', '0.05', '--yes'), (e) => e.code === 'COUNT_REQUIRED');
  await assert.rejects(blind(...MANY, '--results', 'x.json', '--yes'), (e) => e.code === 'COUNT_REQUIRED');
  await assert.rejects(blind(...MANY, '--count', '2', '--fund', '0.0000001', '--yes'), (e) => e.code === 'INVALID_AMOUNT');
  assert.equal(chain.sent.length, 0);
  assert.equal(posted('/api/v1/agents/deploy').length, 0);
});

/** The backend (and the stub node) on Arc mainnet from here on: same key and USDC, another chain id. */
function onMainnet() {
  chain.served = ARC_MAINNET_ID;
  settlement = { ...SETTLEMENT, chains: SETTLEMENT.chains.map((c) => (c.chain === 'arc' ? { ...c, chainId: ARC_MAINNET_ID, tier: 'mainnet', escrowAddress: MAINNET_ESCROW } : c)) };
  feeTerms = { ...FEE_TERMS, chainId: ARC_MAINNET_ID };
}

test('post-task on Arc mainnet funds the escrow there', async () => {
  onMainnet();
  const text = await blind('post-task', '--instructions', 'Summarise this paragraph in one sentence.', '--reward', '2.5', '--public', '--yes');
  assert.deepEqual(chain.sent.map((t) => [t.to, t.chainId]), [[USDC, BigInt(ARC_MAINNET_ID)], [MAINNET_ESCROW, BigInt(ARC_MAINNET_ID)]]);
  assert.match(text, /Posted public task on arc/);
});

test('a fee saved on Arc Testnet is not offered to Arc mainnet: the deploy there pays there', async () => {
  answers['/api/v1/agents/deploy'] = [failWith(402, 'NO_DEPLOY_CREDIT'), failWith(500, 'INTERNAL_ERROR')];
  await assert.rejects(
    blind('deploy-agent', '--name', 'a', '--instructions', 'Research and cite.', '--provider', 'openai', '--model', 'gpt-4o-mini', '--yes'),
    (e) => e.code === 'INTERNAL_ERROR',
  );
  const testnetFee = chain.sent[0].hash;

  onMainnet();
  const text = await blind('deploy-agent', '--name', 'a', '--instructions', 'Research and cite.', '--provider', 'openai', '--model', 'gpt-4o-mini', '--yes');
  assert.doesNotMatch(text, /already paid/);
  assert.equal(chain.sent.length, 2);
  assert.equal(chain.sent[1].chainId, BigInt(ARC_MAINNET_ID));
  assert.equal(posted('/api/v1/agents/deploy').at(-1).body.feeTxHash, chain.sent[1].hash);
  assert.deepEqual(Object.values(state().pendingFees), [testnetFee], 'still saved for Arc Testnet');
});

test('with no BLINDMARKET_ARC_RPC_URL, post-task on Arc mainnet signs over https://rpc.mainnet.arc.io', async () => {
  // The SDK's ethers sends every RPC request through FetchRequest: note where
  // each one goes, and answer it from the stub node, so none leaves this machine.
  const { ethers: sdkEthers } = await import('@blindmarket/sdk');
  const stub = process.env.BLINDMARKET_ARC_RPC_URL;
  delete process.env.BLINDMARKET_ARC_RPC_URL;
  const urls = new Set();
  sdkEthers.FetchRequest.registerGetUrl(async (req) => {
    urls.add(req.url);
    const res = await realFetch(stub, { method: 'POST', headers: { 'content-type': 'application/json' }, body: req.body });
    return { statusCode: res.status, statusMessage: res.statusText, headers: Object.fromEntries(res.headers), body: new Uint8Array(await res.arrayBuffer()) };
  });
  try {
    onMainnet();
    await blind('post-task', '--instructions', 'Summarise this paragraph in one sentence.', '--reward', '2.5', '--public', '--yes');
    assert.deepEqual([...urls], ['https://rpc.mainnet.arc.io']);
    assert.deepEqual(chain.sent.map((t) => [t.to, t.chainId]), [[USDC, BigInt(ARC_MAINNET_ID)], [MAINNET_ESCROW, BigInt(ARC_MAINNET_ID)]]);
  } finally {
    sdkEthers.FetchRequest.registerGetUrl(sdkEthers.FetchRequest.createGetUrlFunc());
    process.env.BLINDMARKET_ARC_RPC_URL = stub;
  }
});

// ── a deploy fee 0.4 saved without its chain ─────────────────────────────────

/** Where 0.4 kept a paid-but-unused deploy fee: backend and wallet, no chain id. */
const UNKEYED = `https://backend.test|${OWNER.address.toLowerCase()}`;
const DEPLOY = ['deploy-agent', '--name', 'a', '--instructions', 'Research and cite.', '--provider', 'openai', '--model', 'gpt-4o-mini', '--yes'];

test('a fee 0.4 saved is used once its receipt is on the fee chain, and kept under its chain id', async () => {
  const hash = '0x' + '5a'.repeat(32);
  chain.mined.set(hash, '0x1');
  writeState({ pendingFees: { [UNKEYED]: hash } });
  answers['/api/v1/agents/deploy'] = [failWith(500, 'INTERNAL_ERROR')];
  await assert.rejects(blind(...DEPLOY), (e) => e.code === 'INTERNAL_ERROR');
  assert.deepEqual(state().pendingFees, { [`${UNKEYED}|${FEE_TERMS.chainId}`]: hash });

  const text = await blind(...DEPLOY);
  assert.match(text, new RegExp(`already paid in ${hash}`));
  assert.equal(chain.sent.length, 0, 'nothing paid');
  assert.deepEqual(posted('/api/v1/agents/deploy').map((c) => c.body.feeTxHash), [hash, hash]);
  assert.deepEqual(state().pendingFees, {});
});

test('a fee 0.4 saved that the fee chain does not have is dropped, and the deploy pays there', async () => {
  onMainnet();
  const hash = '0x' + '5b'.repeat(32); // paid on Arc Testnet
  writeState({ pendingFees: { [UNKEYED]: hash } });
  const text = await blind(...DEPLOY);
  assert.match(text, new RegExp(`earlier version saved \\(${hash}\\) is not on arc \\(chain ${ARC_MAINNET_ID}\\)`));
  assert.equal(chain.sent.length, 1);
  assert.equal(chain.sent[0].chainId, BigInt(ARC_MAINNET_ID));
  assert.equal(posted('/api/v1/agents/deploy').at(-1).body.feeTxHash, chain.sent[0].hash);
  assert.deepEqual(state().pendingFees, {});
});

test('a fee 0.4 saved that reverted is dropped, and the deploy pays', async () => {
  const hash = '0x' + '5d'.repeat(32);
  chain.mined.set(hash, '0x0');
  writeState({ pendingFees: { [UNKEYED]: hash } });
  await blind(...DEPLOY);
  assert.equal(chain.sent.length, 1);
  assert.equal(posted('/api/v1/agents/deploy').at(-1).body.feeTxHash, chain.sent[0].hash);
  assert.deepEqual(state().pendingFees, {});
});

test('a fee 0.4 saved that cannot be checked stops the deploy before paying, and stays saved', async () => {
  const hash = '0x' + '5c'.repeat(32);
  writeState({ pendingFees: { [UNKEYED]: hash } });
  chain.served = 84532; // BLINDMARKET_ARC_RPC_URL is on another chain
  await assert.rejects(blind(...DEPLOY), (e) => e.code === 'FEE_UNCHECKED' && /serves chain 84532/.test(e.message));
  assert.equal(chain.sent.length, 0);
  assert.deepEqual(state().pendingFees, { [UNKEYED]: hash });
});

test('an SDK older than 0.8 is refused, and 0.8 is named', async () => {
  const { assertSdk, sdkVersion } = await import('../dist/client.js');
  const installed = JSON.parse(readFileSync(new URL('../node_modules/@blindmarket/sdk/package.json', import.meta.url), 'utf-8')).version;
  assert.equal(sdkVersion(), installed);
  const bb = { postTask() {} };
  assert.throws(() => assertSdk(bb, '0.7.0'), (e) => e.code === 'SDK_TOO_OLD' && /0\.8 or later/.test(e.message) && /@\^0\.8\.0/.test(e.message));
  assert.throws(() => assertSdk({}, '0.8.0'), (e) => e.code === 'SDK_TOO_OLD');
  assert.doesNotThrow(() => assertSdk(bb, '0.8.0'));
});

test('reclaim reports what the claim did, and never calls an unreported outcome a refund', async () => {
  const built = (extra) => [answer({ unsignedTx: { to: ESCROW, data: claimData(8) }, chain: 'arc', chainId: ARC.chainId, ...extra })];
  const reclaim = () => blind('reclaim', '--task', '8', '--chain', 'arc', '--yes');
  answers['/api/v1/tasks/8/timeout'] = built({ outcome: 'refund' });
  assert.match(await reclaim(), /Reclaimed the escrow of task 8 on arc/);
  answers['/api/v1/tasks/8/timeout'] = built({ outcome: 'escalate' });
  assert.match(await reclaim(), /Sent task 8 on arc for review/);
  answers['/api/v1/tasks/8/timeout'] = built({});
  const text = await reclaim();
  assert.match(text, /did not say whether it refunded the escrow or sent delivered work for review/);
  assert.doesNotMatch(text, /Reclaimed/);
  assert.equal(chain.sent.length, 3);
});

test('deploy-agent needs the provider key in the environment, and never pays for a refused request', async () => {
  await assert.rejects(
    blind('deploy-agent', '--name', 'a', '--instructions', 'x', '--provider', 'anthropic', '--model', 'claude', '--yes'),
    (e) => e.code === 'PROVIDER_KEY_MISSING',
  );
  answers['/api/v1/agents/deploy/validate'] = [failWith(404, 'SKILL_NOT_FOUND')];
  await assert.rejects(
    blind('deploy-agent', '--name', 'a', '--instructions', 'x', '--provider', 'openai', '--model', 'm', '--skill', 'nope', '--yes'),
    (e) => e.code === 'SKILL_NOT_FOUND',
  );
  assert.equal(chain.sent.length, 0);
});

test('deploy-agent --provider xai sends XAI_API_KEY, and a model the key cannot use pays nothing', async () => {
  await assert.rejects(
    blind('deploy-agent', '--name', 'a', '--instructions', 'x', '--provider', 'xai', '--model', 'grok-4.7', '--yes'),
    (e) => e.code === 'PROVIDER_KEY_MISSING' && /XAI_API_KEY/.test(e.message),
  );
  process.env.XAI_API_KEY = 'xai-test-key';
  try {
    answers['/api/v1/agents/deploy/validate'] = [failWith(400, 'MODEL_NOT_AVAILABLE')];
    await assert.rejects(
      blind('deploy-agent', '--name', 'a', '--instructions', 'x', '--provider', 'xai', '--model', 'grok-9', '--yes'),
      (e) => e.code === 'MODEL_NOT_AVAILABLE',
    );
    const checked = posted('/api/v1/agents/deploy/validate').at(-1).body;
    assert.equal(checked.provider, 'xai');
    assert.equal(checked.model, 'grok-9');
    assert.equal(checked.apiKey, 'xai-test-key');
    assert.equal(chain.sent.length, 0);
  } finally {
    delete process.env.XAI_API_KEY;
  }
  await assert.rejects(
    blind('deploy-agent', '--name', 'a', '--instructions', 'x', '--provider', 'grok', '--model', 'grok-4.7', '--yes'),
    (e) => e.code === 'BAD_PROVIDER' && /xai/.test(e.message),
  );
});

test('a key that is not the API key owner\'s pays nothing', async () => {
  whoami = '0x' + 'e1'.repeat(20);
  await assert.rejects(
    blind('deploy-agent', '--name', 'a', '--instructions', 'x', '--provider', 'openai', '--model', 'm', '--yes'),
    (e) => e.code === 'OWNER_MISMATCH',
  );
  await assert.rejects(
    blind('post-task', '--instructions', 'Summarise this paragraph in one sentence.', '--reward', '1', '--public', '--yes'),
    (e) => e.code === 'OWNER_MISMATCH',
  );
  assert.equal(chain.sent.length, 0);
});

// ── refunds, login, and what 0.3 left behind ─────────────────────────────────

test('cancel signs the refund on the task\'s chain, then takes it off the market', async () => {
  const text = await blind('cancel', '--task', '8', '--chain', 'arc', '--yes');
  assert.deepEqual(chain.sent.map((t) => [t.to, t.data, t.chainId]), [[ESCROW, cancelData(8), BigInt(ARC.chainId)]]);
  assert.deepEqual(posted('/api/v1/tasks/8/cancel')[0].body, { chain: 'arc' });
  assert.deepEqual(posted('/api/v1/tasks/8/confirm-tx')[0].body, { txHash: chain.sent[0].hash, chain: 'arc' });
  assert.match(text, /Cancelled task 8 on arc.*It is off the market/);
});

test('cancel refuses a backend "refund" that is not cancelTask on the escrow, and signs nothing (security audit run 1, C41)', async () => {
  const MAX = 2n ** 256n - 1n;
  for (const [unsignedTx, code] of [
    [{ to: USDC, data: ERC20.encodeFunctionData('approve', ['0x000000000000000000000000000000000000dEaD', MAX]) }, 'ESCROW_MISMATCH'],
    [{ to: ESCROW, data: ERC20.encodeFunctionData('approve', ['0x000000000000000000000000000000000000dEaD', MAX]) }, 'TX_MISMATCH'],
    [{ to: ESCROW, data: cancelData(9) }, 'TX_MISMATCH'],
  ]) {
    answers['/api/v1/tasks/8/cancel'] = [{ ok: true, status: 200, json: async () => ({ success: true, data: { unsignedTx, chain: 'arc', chainId: ARC.chainId } }) }];
    await assert.rejects(blind('cancel', '--task', '8', '--chain', 'arc', '--yes'), (e) => e.code === code);
  }
  assert.equal(chain.sent.length, 0);
  assert.equal(posted('/api/v1/tasks/8/confirm-tx').length, 0);
});

test('login stores the key encrypted, only for the API key\'s own wallet, in owner-only files', async () => {
  process.env.BLINDMARKET_KEYSTORE_PASSWORD = 'correct horse battery';
  try {
    whoami = '0x' + 'e1'.repeat(20);
    await assert.rejects(blind('login', '--api-key', 'sk_other', '--import-key'), (e) => e.code === 'OWNER_MISMATCH');
    assert.equal(existsSync(join(process.env.BLIND_CONFIG_DIR, 'keystore.json')), false, 'nothing saved');

    whoami = OWNER.address;
    const text = await blind('login', '--api-key', 'sk_test', '--import-key');
    assert.match(text, new RegExp(`Signed in as ${OWNER.address}`));
    for (const f of ['config.json', 'keystore.json']) {
      assert.equal(statSync(join(process.env.BLIND_CONFIG_DIR, f)).mode & 0o777, 0o600, `${f} is owner-only`);
    }
    // With no key in the environment, the keystore signs.
    const key = process.env.BLINDMARKET_PRIVATE_KEY;
    delete process.env.BLINDMARKET_PRIVATE_KEY;
    try {
      await blind('cancel', '--task', '8', '--yes');
      assert.equal(chain.sent[0].from, OWNER.address);
    } finally {
      process.env.BLINDMARKET_PRIVATE_KEY = key;
    }
  } finally {
    delete process.env.BLINDMARKET_KEYSTORE_PASSWORD;
  }
});

test('register explains what to do where browser registration is off, and keeps no key', async () => {
  await assert.rejects(blind('register', '--name', 'x'), (e) => e.code === 'REGISTRATION_DISABLED' && /blind login --import-key/.test(e.message));
  assert.equal(existsSync(join(process.env.BLIND_CONFIG_DIR, 'keystore.json')), false);
});

test('assign and validator say they are not available, instead of printing an unusable transaction', async () => {
  await assert.rejects(blind('assign', '--task', '1', '--worker', '0x' + '11'.repeat(20)), (e) => e.code === 'NOT_AVAILABLE');
  await assert.rejects(blind('validator', 'stake', '--amount', '100'), (e) => e.code === 'NOT_AVAILABLE');
  assert.equal(calls.length, 0);
});

test('--version reports the package version', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  const writes = [];
  const write = process.stdout.write;
  process.stdout.write = (s) => { writes.push(String(s)); return true; };
  try {
    await assert.rejects(blind('--version'), (e) => e.code === 'commander.version');
  } finally {
    process.stdout.write = write;
  }
  assert.equal(writes.join('').trim(), pkg.version);
});

// ── post-tasks ───────────────────────────────────────────────────────────────

const TASK_DIR = mkdtempSync(join(tmpdir(), 'blind-tasks-'));
const taskFile = (name, content) => { const p = join(TASK_DIR, name); writeFileSync(p, content); return p; };
const THREE = 'instructions,reward,privacy\nFirst task: summarise the paper.,1,public\nSecond task: translate the page.,2,public\nThird task: review the code.,3.5,public\n';
/** The same backend once its escrow has createTasks. */
const batchSettlement = (maxBatch = 50) => ({
  ...SETTLEMENT,
  chains: SETTLEMENT.chains.map((c) => (c.chain === 'arc' ? { ...c, batchCreate: { supported: true, maxBatch } } : c)),
});
const { parseCsv } = await import('../dist/rows.js');
const resultRows = (path) => parseCsv(readFileSync(path, 'utf-8')).slice(1).map((r) => r.fields);
const PAID_NOT_LISTED = 'paid, not listed: run `blind finish-posts`';
const UNCONFIRMED = 'funded, unconfirmed: not paid again';
const SENT_STATUS = 'funded, not listed yet: run this again or `blind finish-posts`';

test('post-tasks posts every row of a CSV: one approve for the total, one createTask each, then the results file', async () => {
  const file = taskFile('three.csv', THREE);
  const text = await blind('post-tasks', '--file', file, '--yes');
  assert.equal(chain.sent.length, 4);
  const [approve, ...creates] = chain.sent;
  assert.equal(approve.to, USDC);
  assert.deepEqual(ERC20.decodeFunctionData('approve', approve.data).map(String), [ESCROW, '6500000'], '1 + 2 + 3.5 USDC, approved once');
  assert.deepEqual(creates.map((t) => t.to), [ESCROW, ESCROW, ESCROW]);
  assert.deepEqual(creates.map((t) => t.nonce), [approve.nonce + 1, approve.nonce + 2, approve.nonce + 3]);
  assert.equal(posted('/api/v1/a2a/tasks/index').length, 3);
  assert.match(text, /3 task\(s\) to post .* on arc \(chain 5042002\)/);
  assert.match(text, /6\.5 USDC in total/);
  assert.match(text, /up to 1 approve, then 3 createTask \(one per task\)/);
  assert.match(text, /\[3\/3\] line 4: posted task 51/);
  assert.match(text, /Posted 3 of 3 new task\(s\) on arc\./);
  assert.match(text, /3 of 3 row\(s\) posted/);
  const rows = resultRows(`${file}.results.csv`);
  assert.deepEqual(rows.map((r) => [r[0], r[1], r[2], r[3]]), [['2', 'posted', '1.0 USDC', '51'], ['3', 'posted', '2.0 USDC', '51'], ['4', 'posted', '3.5 USDC', '51']]);
  assert.deepEqual(state().pendingPosts, {}, 'nothing left pending');
});

test('post-tasks run again on the same file skips every row already funded from it', async () => {
  const file = taskFile('again.csv', THREE);
  await blind('post-tasks', '--file', file, '--yes');
  const sent = chain.sent.length;
  const text = await blind('post-tasks', '--file', file, '--yes');
  assert.match(text, /Nothing new to post/);
  assert.match(text, /already posted: 3 row\(s\)/);
  assert.equal(chain.sent.length, sent, 'nothing paid again');
  assert.deepEqual(resultRows(`${file}.results.csv`).map((r) => r[1]), ['already posted', 'already posted', 'already posted']);

  // A new row in the file is the only one posted.
  writeFileSync(file, `${THREE}Fourth task: write the tests.,4,public\n`);
  const more = await blind('post-tasks', '--file', file, '--yes');
  assert.match(more, /1 task\(s\) to post/);
  assert.match(more, /already posted: 3 row\(s\)/);
  assert.equal(chain.sent.filter((t) => t.to === ESCROW).length, 4);
});

test('post-tasks --dry-run checks the file and shows the total, and sends nothing', async () => {
  const file = taskFile('dry.csv', THREE);
  const text = await blind('post-tasks', '--file', file, '--dry-run');
  assert.match(text, /6\.5 USDC in total/);
  assert.match(text, /Dry run: nothing was sent/);
  assert.equal(chain.sent.length, 0);
  assert.equal(posted('/api/v1/storage/upload').length, 0);
  assert.equal(existsSync(`${file}.results.csv`), false);
});

test('post-tasks names every bad row by line, and sends nothing', async () => {
  const file = taskFile('bad.csv', 'instructions,reward\nGood row here.,1\n,2\nAnother good row.,1.1234567\n');
  await assert.rejects(blind('post-tasks', '--file', file, '--yes'), (e) => e.code === 'INVALID_ROWS' && /line 3: has no instructions/.test(e.message) && /line 4: reward/.test(e.message));
  assert.equal(chain.sent.length, 0);
  assert.equal(posted('/api/v1/storage/upload').length, 0);
});

test("post-tasks names the row the SDK refuses (a target that is not registered), by line, and sends nothing", async () => {
  const file = taskFile('target.csv', `instructions,reward,privacy,target\nPublic row.,1,public,\nPrivate row for one agent.,1,private,0x${'ee'.repeat(20)}\n`);
  await assert.rejects(blind('post-tasks', '--file', file, '--yes'), (e) => e.code === 'INVALID_ROWS' && /line 3: 0x/.test(e.message));
  assert.equal(chain.sent.length, 0);
});

test('post-tasks asks before spending, and without a terminal refuses unless --yes', async () => {
  const file = taskFile('ask.csv', THREE);
  await assert.rejects(blind('post-tasks', '--file', file), (e) => e.code === 'CONFIRM_REQUIRED');
  assert.equal(chain.sent.length, 0);
  assert.equal(posted('/api/v1/storage/upload').length, 0);
});

test('post-tasks on an escrow with createTasks funds several rows per transaction', async () => {
  settlement = batchSettlement();
  const file = taskFile('batch.csv', THREE);
  const text = await blind('post-tasks', '--file', file, '--chunk', '2', '--yes');
  assert.match(text, /up to 1 approve, then 2 createTasks \(up to 2 tasks each\)/);
  // approve, createTasks(rows 1-2), createTask(row 3): a last single row goes alone
  assert.equal(chain.sent.length, 3);
  const [, batch, single] = chain.sent;
  const [, tasks] = BATCH_CALLS.decodeFunctionData('createTasks', batch.data);
  assert.deepEqual(tasks.map((t) => t[1]), [1_000_000n, 2_000_000n]);
  assert.equal(batch.gasLimit, (0x30000n * 120n) / 100n, 'the local estimate plus a fifth');
  assert.equal(single.data.slice(0, 10), ESCROW_CALLS.getFunction('createTask').selector);
  assert.equal(posted('/api/v1/a2a/tasks/index-batch').length, 1);
  assert.equal(posted('/api/v1/a2a/tasks/index-batch')[0].body.txHash, batch.hash);
  assert.match(text, /Posted 3 of 3 new task\(s\) on arc \(several per transaction\)/);
  assert.deepEqual(resultRows(`${file}.results.csv`).map((r) => r[3]), ['60', '61', '51']);
});

test('rows funded together but not listed are saved, and finish-posts lists them together without paying again', async () => {
  settlement = batchSettlement();
  answers['/api/v1/a2a/tasks/index-batch'] = [failWith(403, 'NOT_TASK_AGENT')];
  const file = taskFile('unlisted.csv', 'instructions,reward,privacy\nOne.,1,public\nTwo.,2,public\n');
  await assert.rejects(blind('post-tasks', '--file', file, '--yes'), (e) => e.code === 'NOT_ALL_POSTED' && /finish-posts/.test(e.message));
  assert.equal(chain.sent.length, 2, 'the approve and one createTasks');
  const pending = Object.values(state().pendingPosts);
  assert.equal(pending.length, 2);
  assert.ok(pending.every((p) => p.batch === true && p.txHash === chain.sent[1].hash));
  assert.deepEqual(resultRows(`${file}.results.csv`).map((r) => r[1]), [PAID_NOT_LISTED, PAID_NOT_LISTED]);

  const text = await blind('finish-posts');
  const listed = posted('/api/v1/a2a/tasks/index-batch');
  assert.equal(listed.length, 2, 'the failed listing, then one call for both');
  assert.equal(listed[1].body.txHash, chain.sent[1].hash);
  assert.equal(listed[1].body.tasks.length, 2);
  assert.ok(listed[1].body.tasks.every((t) => !('batch' in t) && !('txHash' in t)));
  assert.match(text, /Listed 0x[0-9a-f]{64} \(task id 60\)/);
  assert.deepEqual(state().pendingPosts, {});
  assert.equal(chain.sent.length, 2, 'nothing paid again');

  // And a re-run of the file funds neither row again, and its results show them posted (D2).
  const again = await blind('post-tasks', '--file', file, '--yes');
  assert.match(again, /Nothing new to post/);
  assert.match(again, /2 of 2 row\(s\) posted/);
  assert.equal(chain.sent.length, 2);
  assert.deepEqual(resultRows(`${file}.results.csv`).map((r) => [r[1], r[3]]), [['already posted', '60'], ['already posted', '61']]);
});

// ── post-tasks: resuming after a crash (D1-D3) ──────────────────────────────

const escrowSends = () => chain.sent.filter((t) => t.to === ESCROW);
/** Run `blind <args>` and keep what it printed whether it succeeds or not: { text, err }. */
async function blindAll(...args) {
  const lines = [];
  const log = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    await buildProgram().exitOverride().parseAsync(['node', 'blind', ...args]);
    return { text: lines.join('\n'), err: undefined };
  } catch (err) {
    return { text: lines.join('\n'), err };
  } finally {
    console.log = log;
  }
}
/** Post a file whose first listing fails: its first row is paid but not listed, the rest not started. */
async function paidNotListed(name, content = THREE) {
  const file = taskFile(name, content);
  answers['/api/v1/a2a/tasks/index'] = [failWith(403, 'NOT_TASK_AGENT')];
  const { text, err } = await blindAll('post-tasks', '--file', file, '--yes');
  assert.equal(err?.code, 'NOT_ALL_POSTED');
  assert.match(err.message, /finish-posts/);
  return { file, text };
}

test('a stopped run names file lines, not SDK rows, and says the approval left over is used next time', async () => {
  const file = taskFile('stopped-words.csv', THREE);
  answers['/api/v1/a2a/tasks/index'] = [failWith(403, 'NOT_TASK_AGENT')];
  const { text, err } = await blindAll('post-tasks', '--file', file, '--yes');
  assert.equal(err?.code, 'NOT_ALL_POSTED');
  assert.match(text, /\[1\/3\] line 2: PAID but not listed/);
  assert.match(text, /\[2\/3\] line 3: not started \(stopped at line 2: /);
  assert.match(text, /Stopped at line 2: NOT_TASK_AGENT/);
  assert.match(text, /The unused part of this run's USDC approval stays in place for the escrow; running this again uses it/);
  assert.doesNotMatch(text, /rows\[/);
  assert.deepEqual(resultRows(`${file}.results.csv`).map((r) => r[1]), [PAID_NOT_LISTED, 'not started', 'not started']);
});

test('run again, it lists the rows paid earlier first, paying nothing, then posts the rest (D1)', async () => {
  const { file } = await paidNotListed('resume-list.csv');
  assert.equal(escrowSends().length, 1);
  const text = await blind('post-tasks', '--file', file, '--yes');
  assert.match(text, /listed now:\s+1 row\(s\) paid earlier, listed without paying again/);
  assert.match(text, /2 task\(s\) to post/);
  assert.match(text, /3 of 3 row\(s\) posted/);
  assert.equal(escrowSends().length, 3, 'the paid row was not funded again');
  assert.deepEqual(resultRows(`${file}.results.csv`).map((r) => [r[1], r[3]]), [['posted', '51'], ['posted', '51'], ['posted', '51']]);
  assert.deepEqual(state().pendingPosts, {});
});

test('run again while the listing still fails: the paid row is named, never paid again, and the exit is not zero (D1)', async () => {
  const { file } = await paidNotListed('resume-still.csv');
  answers['/api/v1/a2a/tasks/index'] = [failWith(403, 'NOT_TASK_AGENT')]; // the re-listing fails again
  const { text, err } = await blindAll('post-tasks', '--file', file, '--yes');
  assert.equal(err?.code, 'NOT_ALL_POSTED');
  assert.match(err.message, /blind finish-posts/);
  assert.match(text, /paid, not listed: 1 row\(s\): the listing still fails; run `blind finish-posts`/);
  assert.match(text, /2 of 3 row\(s\) posted; 1 paid, not listed \(run `blind finish-posts`\)/);
  assert.equal(escrowSends().length, 3, 'the paid row was not funded again; the other two were posted');
  const rows = resultRows(`${file}.results.csv`);
  assert.deepEqual(rows.map((r) => r[1]), [PAID_NOT_LISTED, 'posted', 'posted']);
  assert.match(rows[0][6], /NOT_TASK_AGENT|not the agent|NOT/);
  assert.equal(Object.keys(state().pendingPosts).length, 1, 'still pending for finish-posts');
});

test('finish-posts marks the rows it lists in their file, so the next results show them posted (D2)', async () => {
  const { file } = await paidNotListed('finish-marks.csv', 'instructions,reward,privacy\nOnly task: summarise this.,1,public\n');
  const listed = await blind('finish-posts');
  assert.match(listed, /Listed 0x[0-9a-f]{64} \(task id 51\)/);
  const text = await blind('post-tasks', '--file', file, '--yes');
  assert.match(text, /Nothing new to post/);
  assert.deepEqual(resultRows(`${file}.results.csv`).map((r) => [r[1], r[3]]), [['already posted', '51']]);
  assert.equal(escrowSends().length, 1);
});

const ONE = 'instructions,reward,privacy\nOnly task: summarise this.,1,public\n';

test('a funding that never landed (another transaction used its nonce) frees the row: the re-run posts it (D3 dropped)', async () => {
  const { file } = await paidNotListed('dropped.csv', ONE);
  const funding = escrowSends()[0];
  // The chain never kept it, and something else took its nonce.
  chain.sent = chain.sent.filter((t) => t !== funding);
  chain.sent.push({ hash: '0x' + 'dd'.repeat(32) });
  const text = await blind('post-tasks', '--file', file, '--yes');
  assert.match(text, /posted again:\s+1 row\(s\) whose funding never landed \(nothing was paid\)/);
  assert.equal(escrowSends().length, 1, 'funded once: the first never landed');
  assert.notEqual(escrowSends()[0].hash, funding.hash);
  assert.deepEqual(resultRows(`${file}.results.csv`).map((r) => r[1]), ['posted']);
  assert.deepEqual(state().pendingPosts, {});
});

test('a funding that reverted frees the row too: the re-run posts it (D3 reverted)', async () => {
  const { file } = await paidNotListed('reverted.csv', ONE);
  const funding = escrowSends()[0];
  chain.sent = chain.sent.filter((t) => t !== funding);
  chain.sent.push({ hash: '0x' + 'dd'.repeat(32) });
  chain.mined.set(funding.hash, '0x0');
  const text = await blind('post-tasks', '--file', file, '--yes');
  assert.match(text, /posted again:\s+1 row\(s\)/);
  assert.equal(escrowSends().length, 1);
  assert.deepEqual(resultRows(`${file}.results.csv`).map((r) => r[1]), ['posted']);
});

test('a funding still in the mempool is left alone: never paid again, named as unconfirmed, and the exit is not zero (D3 pending)', async () => {
  const { file } = await paidNotListed('pending.csv', ONE);
  const funding = escrowSends()[0];
  chain.sent = chain.sent.filter((t) => t !== funding);
  chain.mempool.add(funding.hash);
  const { text, err } = await blindAll('post-tasks', '--file', file, '--yes');
  assert.equal(err?.code, 'NOT_ALL_POSTED');
  assert.match(err.message, /checked again next time/);
  assert.match(text, /unconfirmed:\s+1 row\(s\) whose funding may still land: not paid again/);
  assert.match(text, /0 of 1 row\(s\) posted; 1 funded, unconfirmed/);
  assert.equal(escrowSends().length, 0, 'nothing sent: the first funding may still land');
  assert.deepEqual(resultRows(`${file}.results.csv`).map((r) => r[1]), [UNCONFIRMED]);

  // finish-posts neither lists it (it would wait for a receipt) nor drops it.
  const indexCalls = posted('/api/v1/a2a/tasks/index').length;
  await assert.rejects(blind('finish-posts'), (e) => e.code === 'NOT_CONFIRMED');
  assert.equal(posted('/api/v1/a2a/tasks/index').length, indexCalls);
  assert.equal(Object.keys(state().pendingPosts).length, 1);
});

test('a funding that looks dropped but that the backend knows on-chain is never funded again (D3)', async () => {
  const { file } = await paidNotListed('known.csv', ONE);
  const funding = escrowSends()[0];
  const taskHash = Object.keys(state().pendingPosts)[0];
  chain.sent = chain.sent.filter((t) => t !== funding);
  chain.sent.push({ hash: '0x' + 'dd'.repeat(32) });
  onChain.add(taskHash); // another transaction funded the same task
  await blind('post-tasks', '--file', file, '--yes');
  assert.equal(escrowSends().length, 0, 'not funded again');
});

test('finish-posts drops a funding that never landed, without asking the backend to list it (D3)', async () => {
  const { file } = await paidNotListed('finish-dropped.csv', ONE);
  const funding = escrowSends()[0];
  chain.sent = chain.sent.filter((t) => t !== funding);
  chain.sent.push({ hash: '0x' + 'dd'.repeat(32) });
  const indexCalls = posted('/api/v1/a2a/tasks/index').length;
  const text = await blind('finish-posts');
  assert.match(text, /Not funded: 0x[0-9a-f]{64}: its funding never landed/);
  assert.equal(posted('/api/v1/a2a/tasks/index').length, indexCalls, 'no listing attempt');
  assert.deepEqual(state().pendingPosts, {});
  // And the file's next run posts the row.
  await blind('post-tasks', '--file', file, '--yes');
  assert.equal(escrowSends().length, 1);
});

test('a refusal the SDK words by row is shown by file line', async () => {
  const file = taskFile('dup.csv', 'instructions,reward,privacy\nSame public brief.,1,public\nSame public brief.,2,public\n');
  await assert.rejects(blind('post-tasks', '--file', file, '--yes'), (e) => e.code === 'INVALID_ROWS' && /line 3: the same public brief as line 2/.test(e.message) && !/rows\[/.test(e.message));
  assert.equal(chain.sent.length, 0);
});

// ── only a known escrow is funded ───────────────────────────────────────────

test('post-tasks refuses an escrow that is not a known deployment, and BLINDMARKET_TRUSTED_ESCROWS admits a local one', async () => {
  const LOCAL = getAddress('0x' + 'a1'.repeat(20));
  settlement = { ...SETTLEMENT, chains: SETTLEMENT.chains.map((c) => (c.chain === 'arc' ? { ...c, escrowAddress: LOCAL } : c)) };
  const file = taskFile('local-escrow.csv', ONE);
  await assert.rejects(blind('post-tasks', '--file', file, '--yes'), (e) => e.code === 'ESCROW_NOT_PINNED' && /BlindMarketConfig.trustedEscrows/.test(e.message));
  assert.equal(chain.sent.length, 0);

  process.env.BLINDMARKET_TRUSTED_ESCROWS = `${ARC.chainId}:${LOCAL}:${USDC}`;
  try {
    await blind('post-tasks', '--file', file, '--yes');
    assert.deepEqual(chain.sent.map((t) => t.to), [USDC, LOCAL]);
    process.env.BLINDMARKET_TRUSTED_ESCROWS = 'not-an-entry';
    await assert.rejects(blind('post-tasks', '--file', taskFile('bad-env.csv', ONE), '--yes'), (e) => e.code === 'BAD_TRUSTED_ESCROWS');
  } finally {
    delete process.env.BLINDMARKET_TRUSTED_ESCROWS;
  }
});


// ── re-sending a dropped funding; results always current; one check per funding ──

test('a funding no node has, with its nonce unused, is re-sent as is by the re-run: funded once, then listed', async () => {
  const { file } = await paidNotListed('resend.csv', ONE);
  const funding = escrowSends()[0];
  chain.sent = chain.sent.filter((t) => t !== funding); // dropped, and nothing has used its nonce
  const builds = posted('/api/v1/tasks').length;
  const { text, err } = await blindAll('post-tasks', '--file', file, '--yes');
  assert.equal(err, undefined, err?.message);
  assert.match(text, /Re-sent funding 0x[0-9a-f]{64} \(1 row\)/);
  assert.match(text, /listed now:\s+1 row\(s\) paid earlier/);
  assert.deepEqual(escrowSends().map((t) => t.hash), [funding.hash], 'the same transaction, landing once');
  assert.equal(posted('/api/v1/tasks').length, builds, 'nothing built or paid again');
  assert.deepEqual(resultRows(`${file}.results.csv`).map((r) => r[1]), ['posted']);
  assert.deepEqual(state().pendingPosts, {});
  assert.deepEqual(state().fundingRaw, {}, 'the saved transaction is let go once listed');
});

test('finish-posts re-sends such a funding too, and lists it', async () => {
  const { file } = await paidNotListed('resend-finish.csv', ONE);
  const funding = escrowSends()[0];
  chain.sent = chain.sent.filter((t) => t !== funding);
  const text = await blind('finish-posts');
  assert.match(text, /Re-sent funding/);
  assert.match(text, /Listed 0x[0-9a-f]{64}/);
  assert.deepEqual(escrowSends().map((t) => t.hash), [funding.hash]);
  // finish-posts rewrote the file's results.
  assert.deepEqual(resultRows(`${file}.results.csv`).map((r) => [r[1], r[3]]), [['posted', '51']]);
});

test('the results file exists before anything is sent, and says a row is funded before its listing answers', async () => {
  const file = taskFile('results-early.csv', ONE);
  await assert.rejects(blind('post-tasks', '--file', file), (e) => e.code === 'CONFIRM_REQUIRED');
  assert.deepEqual(resultRows(`${file}.results.csv`).map((r) => r[1]), ['pending'], 'written at the start of the run');

  let during;
  answers['/api/v1/a2a/tasks/index'] = [{
    ok: true,
    status: 200,
    json: async () => {
      during = resultRows(`${file}.results.csv`);
      return { success: true, data: { taskHash: 'x', onChainTaskId: '51', indexed: true } };
    },
  }];
  await blind('post-tasks', '--file', file, '--yes');
  assert.equal(during[0][1], SENT_STATUS, 'funded, listing not answered yet');
  assert.equal(during[0][5], escrowSends()[0].hash);
  assert.deepEqual(resultRows(`${file}.results.csv`).map((r) => r[1]), ['posted']);
});

test('rows funded together are checked once, not once per row', async () => {
  settlement = batchSettlement();
  answers['/api/v1/a2a/tasks/index-batch'] = [failWith(403, 'NOT_TASK_AGENT')];
  const file = taskFile('check-once.csv', 'instructions,reward,privacy\nOne.,1,public\nTwo.,2,public\nThree.,3,public\n');
  await blindAll('post-tasks', '--file', file, '--chunk', '3', '--yes');
  const funding = escrowSends()[0];
  chain.sent = chain.sent.filter((t) => t !== funding);
  chain.sent.push({ hash: '0x' + 'dd'.repeat(32) }); // its nonce used by another transaction
  chain.rpcCalls = [];
  await blindAll('post-tasks', '--file', file, '--chunk', '3', '--yes');
  assert.equal(chain.rpcCalls.filter((m) => m === 'eth_getTransactionByHash').length, 1, 'one check for the three rows');
  assert.equal(chain.rpcCalls.filter((m) => m === 'eth_getTransactionReceipt').length >= 2, true);
});
