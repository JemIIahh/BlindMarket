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
          case 'eth_getTransactionReceipt': {
            // Only for a transaction this node has: one sent to it, or one a test mined.
            const status = chain.sent.some((t) => t.hash === params[0]) ? '0x1' : chain.mined.get(params[0]);
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
/** What /health/settlement and /deploy-fee answer: production's, unless a test moves the backend. */
let settlement;
let feeTerms;
beforeEach(() => {
  chain = { served: ARC.chainId, allowance: 0n, sent: [], mined: new Map() };
  calls = [];
  answers = {};
  whoami = OWNER.address;
  settlement = SETTLEMENT;
  feeTerms = FEE_TERMS;
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
  if (path === '/api/v1/tasks') return json({ unsignedTx: { to: ESCROW, data: createTaskData(body), from: OWNER.address }, chain: 'arc', chainId: settlement.chains.find((c) => c.chain === 'arc').chainId });
  if (path === '/api/v1/tasks/8/cancel') return json({ unsignedTx: { to: ESCROW, data: cancelData(8) }, chain: 'arc', chainId: ARC.chainId });
  if (path === '/api/v1/tasks/8/confirm-tx') return json({ confirmed: 1 });
  if (path === '/api/v1/a2a/tasks/index') return json({ taskHash: body.taskHash, onChainTaskId: '51', indexed: true });
  if (path === '/api/v1/agents/deploy-fee') return json(feeTerms);
  if (path === '/api/v1/agents/deploy/validate') return json({ valid: true });
  if (path === '/api/v1/agents/deploy') {
    if (!body.feeTxHash) return failWith(402, 'NO_DEPLOY_CREDIT');
    return json({ id: 'agent-7', name: body.name, walletAddress: '0x' + '44'.repeat(20), publicKey: '04ab', status: 'running', started: true });
  }
  if (path === '/api/v1/registration/session') return failWith(503, 'REGISTRATION_DISABLED');
  throw new Error('unexpected backend call ' + path);
};
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

/** The backend (and the stub node) on Arc mainnet from here on: same key and USDC, another chain id. */
function onMainnet() {
  chain.served = ARC_MAINNET_ID;
  settlement = { ...SETTLEMENT, chains: SETTLEMENT.chains.map((c) => (c.chain === 'arc' ? { ...c, chainId: ARC_MAINNET_ID, tier: 'mainnet' } : c)) };
  feeTerms = { ...FEE_TERMS, chainId: ARC_MAINNET_ID };
}

test('post-task on Arc mainnet funds the escrow there', async () => {
  onMainnet();
  const text = await blind('post-task', '--instructions', 'Summarise this paragraph in one sentence.', '--reward', '2.5', '--public', '--yes');
  assert.deepEqual(chain.sent.map((t) => [t.to, t.chainId]), [[USDC, BigInt(ARC_MAINNET_ID)], [ESCROW, BigInt(ARC_MAINNET_ID)]]);
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

test('with no BLINDMARKET_ARC_RPC_URL, post-task on Arc mainnet signs over https://arc-rpc.publicnode.com', async () => {
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
    assert.deepEqual([...urls], ['https://arc-rpc.publicnode.com']);
    assert.deepEqual(chain.sent.map((t) => [t.to, t.chainId]), [[USDC, BigInt(ARC_MAINNET_ID)], [ESCROW, BigInt(ARC_MAINNET_ID)]]);
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
