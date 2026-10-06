import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, Wallet } from 'ethers';

/**
 * deploy_agents: several hosted agents from one template. One quote covers
 * the list (checked once with the backend, refused whole when the agents do
 * not all fit the capacity); each agent then pays its own fee through
 * deploy_agent's path, recorded under `<idempotencyKey>#<n>`, so a fee is
 * never paid twice: not on a 429, not on a resume after a stop.
 */

process.env.BLINDMARKET_STATE_DIR = mkdtempSync(join(tmpdir(), 'bm-mcp-state-'));
process.env.BLINDMARKET_DEPLOY_POLL_MS = '0';
process.env.BLINDMARKET_DEPLOY_BACKOFF_MS = '1';
process.env.OPENAI_API_KEY = 'sk-openai-test';

const { registerRentTools } = await import('../dist/rent.js');
const { getSpend, updateSpend } = await import('../dist/state.js');

const OWNER_KEY = Wallet.createRandom();
const OWNER = OWNER_KEY.address;
const USDC = '0x3600000000000000000000000000000000000000';
const TREASURY = '0x2f8b1177c83623a560B26B38dE984e154b123D75';
const ERC20 = new Interface(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const TRANSFER_TERMS = { required: true, method: 'transfer', chain: 'arc', chainId: 5042002, token: USDC, recipient: TREASURY, amountRaw: '1000000', decimals: 6, factory: null };
const FREE = { poolMax: 5, poolFree: 5, ownerMax: 10, ownerFree: 10, canStart: true, scope: 'process' };

let rpc;
let rpcUrl;
before(async () => {
  rpc = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const one = ({ id, method }) => {
        let result;
        if (method === 'eth_chainId') result = '0x' + (5042002).toString(16);
        else if (method === 'eth_call') result = ERC20.encodeFunctionResult('balanceOf', [12_500_000n]);
        // Nothing the stub wallet sends is mined or pending; its nonce is `confirmedNonce`.
        else if (method === 'eth_getTransactionCount') result = '0x' + confirmedNonce.toString(16);
        else if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') result = null;
        else throw new Error(`stub RPC: unexpected ${method}`);
        return { jsonrpc: '2.0', id, result };
      };
      const parsed = JSON.parse(raw);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
    });
  });
  await new Promise((r) => rpc.listen(0, '127.0.0.1', r));
  rpcUrl = `http://127.0.0.1:${rpc.address().port}`;
  process.env.BLINDMARKET_ARC_RPC_URL = rpcUrl;
});
after(() => rpc.close());

let terms;
let capacity;
/** Answers for the next POST /agents/deploy calls, in order; then a success. */
let deployAnswers;
let calls;
let sent;
let agentsMade;
let confirmedNonce;
beforeEach(() => {
  confirmedNonce = 0;
  terms = TRANSFER_TERMS;
  capacity = () => json(FREE);
  deployAnswers = [];
  calls = [];
  sent = [];
  agentsMade = 0;
});

const json = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
const failWith = (status, code) => ({ ok: false, status, json: async () => ({ success: false, error: { code, message: code } }) });
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (rpcUrl && u.startsWith(rpcUrl)) return realFetch(url, init);
  const path = u.replace(/^https?:\/\/[^/]+/, '');
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method ?? 'GET', path, body });
  if (path === '/health/bridge') return json({ postingChain: 'arc', chains: [{ chain: 'arc', chainId: 5042002 }] });
  if (path === '/api/v1/agents/deploy-fee') return json(terms);
  if (path === '/api/v1/agents/deploy/validate') return json({ valid: true });
  if (path === '/api/v1/agents/capacity') return capacity();
  if (path === '/api/v1/api-keys/whoami') return json({ address: OWNER.toLowerCase() });
  if (path === '/api/v1/agents/deploy') {
    const next = deployAnswers.shift();
    if (next) return typeof next === 'function' ? next(body) : next;
    agentsMade++;
    return json({ id: `agent-${agentsMade}`, name: body.name, walletAddress: '0x' + String(agentsMade).padStart(2, '0').repeat(20), started: true });
  }
  throw new Error('unexpected backend call ' + path);
};

function tools() {
  const handlers = {};
  const server = { registerTool: (name, _def, handler) => { handlers[name] = handler; } };
  const walletCtx = {
    chainId: 16661,
    rpcUrl: 'http://127.0.0.1:9',
    provider: {},
    wallet: {
      address: OWNER,
      privateKey: OWNER_KEY.privateKey,
      connect: (provider) => ({
        address: OWNER,
        provider,
        getAddress: async () => OWNER,
        call: (tx) => provider.call(tx),
        sendTransaction: async (tx) => {
          sent.push(tx);
          return { hash: '0x' + sent.length.toString(16).padStart(64, '0'), wait: async () => ({ status: 1 }) };
        },
      }),
    },
  };
  registerRentTools(server, { apiKey: 'sk_test', apiBase: 'https://backend.test', authenticated: true }, walletCtx);
  return handlers;
}

const parse = (res) => {
  assert.notEqual(res.isError, true, res.content[0].text);
  return JSON.parse(res.content[0].text);
};
const failure = (res) => {
  assert.equal(res.isError, true, res.content[0].text);
  return JSON.parse(res.content[0].text);
};
const callsTo = (path) => calls.filter((c) => c.path === path);
const deploys = () => callsTo('/api/v1/agents/deploy');
const feeHash = (n) => '0x' + n.toString(16).padStart(64, '0');
const args = { name: 'scout', instructions: 'Research topics and cite sources.', provider: 'openai', model: 'gpt-4o-mini' };

/** Quote, then confirm that quote. */
async function run(t, a) {
  const { quote } = parse(await t.deploy_agents(a));
  return t.deploy_agents({ ...a, confirm: true, quoteId: quote.quoteId });
}

test('quotes the whole list: names, one check with the longest name, capacity, fee per agent and in total; pays nothing', async () => {
  const { quote, next } = parse(await tools().deploy_agents({ ...args, count: 3, idempotencyKey: 'agents-quote-1' }));
  assert.deepEqual(quote.agents, ['scout 1', 'scout 2', 'scout 3']);
  assert.equal(quote.toDeploy, 3);
  assert.equal(quote.alreadyDeployed, 0);
  assert.equal(quote.feePerAgent, '1 USDC');
  assert.equal(quote.totalFee, '3 USDC');
  assert.equal(quote.payTo, TREASURY);
  assert.equal(quote.walletBalance, '12.5');
  assert.deepEqual(quote.capacity, { free: 5, scope: 'process' });
  assert.match(quote.warnings[0], /All 3 agents call openai with your one API key, so they share its rate limits/);
  assert.match(next, /confirm=true/);
  const validated = callsTo('/api/v1/agents/deploy/validate');
  assert.equal(validated.length, 1, 'the request is checked once for the whole list');
  assert.equal(validated[0].body.name, 'scout 1');
  assert.equal(sent.length, 0);
  assert.equal(deploys().length, 0);

  // The one check runs with the longest name: the one closest to the 80-character limit.
  calls = [];
  capacity = () => json({ ...FREE, poolMax: 20, poolFree: 20 });
  parse(await tools().deploy_agents({ ...args, count: 10, idempotencyKey: 'agents-quote-2' }));
  assert.deepEqual(callsTo('/api/v1/agents/deploy/validate').map((c) => c.body.name), ['scout 10']);
});

test('names: {n} becomes each number; one agent keeps its name; a name past 80 characters is refused before anything', async () => {
  const t = tools();
  assert.deepEqual(parse(await t.deploy_agents({ ...args, name: ' bot-{n}-eu ', count: 2, idempotencyKey: 'agents-names-1' })).quote.agents, ['bot-1-eu', 'bot-2-eu']);
  assert.deepEqual(parse(await t.deploy_agents({ ...args, count: 1, idempotencyKey: 'agents-names-2' })).quote.agents, ['scout']);
  calls = [];
  const { error } = failure(await t.deploy_agents({ ...args, name: 'x'.repeat(78), count: 10, idempotencyKey: 'agents-names-3' }));
  assert.equal(error.code, 'INVALID_NAME');
  assert.match(error.message, /81 characters/);
  assert.equal(calls.length, 0, 'nothing was asked of the backend');
});

test('a list past the free capacity is refused whole at the quote, with how many can start; nothing quoted or paid', async () => {
  capacity = () => json({ ...FREE, poolFree: 2, ownerFree: 4, canStart: true });
  const { error } = failure(await tools().deploy_agents({ ...args, count: 3, idempotencyKey: 'agents-cap-1' }));
  assert.equal(error.code, 'AGENT_CAPACITY');
  assert.match(error.message, /Only 2 more agents can start now/);
  assert.match(error.message, /count=2/);
  assert.match(error.message, /Nothing was quoted or paid/);
  assert.equal(sent.length, 0);
  assert.equal(deploys().length, 0);

  capacity = () => json({ ...FREE, poolFree: 0, canStart: false });
  assert.match(failure(await tools().deploy_agents({ ...args, count: 1, idempotencyKey: 'agents-cap-2' })).error.message, /Stop one of your agents/);
});

test('what the server\'s memory allows counts too: a list past it is refused at the quote', async () => {
  capacity = () => json({ ...FREE, memory: { availableMb: 2400, reserveMb: 2048, workerMb: 150, slotsFree: 2, source: 'os' } });
  const { error } = failure(await tools().deploy_agents({ ...args, count: 3, idempotencyKey: 'agents-mem-1' }));
  assert.equal(error.code, 'AGENT_CAPACITY');
  assert.match(error.message, /Only 2 more agents can start now \(5 free on the server, 10 left of the 10 one owner may run, memory for 2 more\)/);
  assert.match(error.message, /count=2/);
  assert.equal(sent.length, 0);
  assert.equal(deploys().length, 0);
  const { quote } = parse(await tools().deploy_agents({ ...args, count: 2, idempotencyKey: 'agents-mem-2' }));
  assert.deepEqual(quote.capacity, { free: 2, scope: 'process' });
});

test('a backend without the capacity route is not checked here (its deploy refuses before taking a fee)', async () => {
  capacity = () => ({ ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  const done = parse(await run(tools(), { ...args, count: 2, idempotencyKey: 'agents-oldcap-1' }));
  assert.equal(done.deployed, 2);
});

test('the capacity is checked again on confirm, before the first payment', async () => {
  const t = tools();
  const { quote } = parse(await t.deploy_agents({ ...args, count: 3, idempotencyKey: 'agents-cap-3' }));
  capacity = () => json({ ...FREE, ownerFree: 1 });
  const { error } = failure(await t.deploy_agents({ ...args, count: 3, idempotencyKey: 'agents-cap-3', confirm: true, quoteId: quote.quoteId }));
  assert.equal(error.code, 'AGENT_CAPACITY');
  assert.match(error.message, /Nothing was paid/);
  assert.equal(sent.length, 0);
  assert.equal(deploys().length, 0);
});

test('on confirm: each agent pays its own fee exactly once and deploys with it; the same key again pays and deploys nothing', async () => {
  const t = tools();
  const done = parse(await run(t, { ...args, count: 3, idempotencyKey: 'agents-pay-1' }));
  assert.equal(done.deployed, 3);
  assert.deepEqual(done.results.map((r) => [r.index, r.name, r.status, r.agentId, r.feeTxHash]), [
    [1, 'scout 1', 'deployed', 'agent-1', feeHash(1)],
    [2, 'scout 2', 'deployed', 'agent-2', feeHash(2)],
    [3, 'scout 3', 'deployed', 'agent-3', feeHash(3)],
  ]);
  assert.equal(sent.length, 3, 'one fee per agent');
  for (const tx of sent) {
    assert.equal(tx.to, USDC);
    assert.deepEqual(ERC20.decodeFunctionData('transfer', tx.data).map(String), [TREASURY, '1000000']);
  }
  assert.deepEqual(deploys().map((d) => [d.body.name, d.body.feeTxHash]), [['scout 1', feeHash(1)], ['scout 2', feeHash(2)], ['scout 3', feeHash(3)]]);
  assert.equal(deploys()[0].body.ownerPublicKey, OWNER_KEY.signingKey.publicKey.slice(2));
  assert.equal(getSpend('agents-pay-1').kind, 'deploy-batch');
  assert.equal(getSpend('agents-pay-1#2').agentId, 'agent-2');
  assert.equal(callsTo('/api/v1/api-keys/whoami').length, 1, 'the owner is checked once for the list');

  const again = parse(await t.deploy_agents({ ...args, count: 3, idempotencyKey: 'agents-pay-1' }));
  assert.equal(again.resumed, true);
  assert.equal(again.deployed, 3);
  assert.equal(sent.length, 3);
  assert.equal(deploys().length, 3);
});

test('a failure partway stops the run and says what became of each agent; the resume skips deployed ones and reuses the paid fee', async () => {
  const t = tools();
  deployAnswers = [undefined, failWith(500, 'INTERNAL_ERROR')];
  const stopped = failure(await run(t, { ...args, count: 3, idempotencyKey: 'agents-stop-1' }));
  assert.equal(stopped.error.code, 'INTERNAL_ERROR');
  assert.match(stopped.error.message, /Stopped at agent 2 \(scout 2\)/);
  assert.match(stopped.error.message, /SAME idempotencyKey/);
  assert.deepEqual(stopped.results.map((r) => [r.index, r.status]), [[1, 'deployed'], [2, 'failed'], [3, 'not_started']]);
  assert.equal(stopped.results[1].feeTxHash, feeHash(2), 'the paid fee is reported');
  assert.equal(stopped.deployed, 1);
  assert.equal(stopped.failed, 1);
  assert.equal(stopped.notStarted, 1);
  assert.equal(sent.length, 2, 'nothing paid behind the failure');

  const { quote } = parse(await t.deploy_agents({ ...args, count: 3, idempotencyKey: 'agents-stop-1' }));
  assert.equal(quote.alreadyDeployed, 1);
  assert.equal(quote.toDeploy, 2);
  assert.equal(quote.feeAlreadyPaid, 1);
  assert.equal(quote.totalFee, '1 USDC', 'only agent 3 still pays');
  const done = parse(await t.deploy_agents({ ...args, count: 3, idempotencyKey: 'agents-stop-1', confirm: true, quoteId: quote.quoteId }));
  assert.equal(done.deployed, 3);
  assert.equal(done.results[0].resumed, true);
  assert.equal(sent.length, 3, 'agent 2 deployed with the fee it had paid');
  assert.deepEqual(deploys().slice(2).map((d) => [d.body.name, d.body.feeTxHash]), [['scout 2', feeHash(2)], ['scout 3', feeHash(3)]]);
});

test('a paid fee that never landed is paid again on the resume, not reused forever', async () => {
  const t = tools();
  deployAnswers = [undefined, failWith(500, 'INTERNAL_ERROR')];
  failure(await run(t, { ...args, count: 2, idempotencyKey: 'agents-dropped-1' }));
  // Agent 2's fee went out with nonce 1, and the wallet has used nonce 1 since.
  updateSpend('agents-dropped-1#2', { nonce: 1 });
  confirmedNonce = 2;

  const first = parse(await t.deploy_agents({ ...args, count: 2, idempotencyKey: 'agents-dropped-1' }));
  assert.equal(first.quote.feeAlreadyPaid, 1);
  deployAnswers = [1, 2, 3].map(() => failWith(409, 'DEPLOY_FEE_NOT_FOUND'));
  const stopped = failure(await t.deploy_agents({ ...args, count: 2, idempotencyKey: 'agents-dropped-1', confirm: true, quoteId: first.quote.quoteId }));
  assert.equal(stopped.error.code, 'FEE_NEVER_LANDED');
  assert.equal(stopped.results[1].feeTxHash, undefined, 'no fee is reported as paid');
  assert.equal(getSpend('agents-dropped-1#2').stage, 'created');

  const { quote } = parse(await t.deploy_agents({ ...args, count: 2, idempotencyKey: 'agents-dropped-1' }));
  assert.equal(quote.feeAlreadyPaid, undefined);
  assert.equal(quote.totalFee, '1 USDC', 'agent 2 pays again');
  const done = parse(await t.deploy_agents({ ...args, count: 2, idempotencyKey: 'agents-dropped-1', confirm: true, quoteId: quote.quoteId }));
  assert.equal(done.deployed, 2);
  assert.equal(sent.length, 3);
  assert.equal(deploys().at(-1).body.feeTxHash, feeHash(3));
});

test('a 429 is asked again for the same agent after a wait, with the same fee', async () => {
  const t = tools();
  const codeless429 = { ok: false, status: 429, json: async () => { throw new SyntaxError('not json'); } };
  deployAnswers = [failWith(429, 'RATE_LIMIT'), codeless429];
  const done = parse(await run(t, { ...args, count: 2, idempotencyKey: 'agents-429-1' }));
  assert.equal(done.deployed, 2);
  assert.equal(sent.length, 2, 'no second fee for the rate-limited agent');
  assert.deepEqual(deploys().map((d) => [d.body.name, d.body.feeTxHash]), [
    ['scout 1', feeHash(1)], ['scout 1', feeHash(1)], ['scout 1', feeHash(1)], ['scout 2', feeHash(2)],
  ]);
});

test('a 429 that never clears stops the run after six tries, the fee kept for the resume', async () => {
  deployAnswers = Array.from({ length: 6 }, () => failWith(429, 'RATE_LIMIT'));
  const stopped = failure(await run(tools(), { ...args, count: 2, idempotencyKey: 'agents-429-2' }));
  assert.equal(stopped.error.code, 'RATE_LIMIT');
  assert.equal(deploys().length, 6);
  assert.equal(sent.length, 1);
  assert.equal(stopped.results[0].feeTxHash, feeHash(1));
  assert.equal(stopped.results[1].status, 'not_started');
});

test('an agent deployed but not started stops the run', async () => {
  deployAnswers = [undefined, (body) => json({ id: 'agent-x', name: body.name, walletAddress: '0x' + '55'.repeat(20), started: false })];
  const stopped = failure(await run(tools(), { ...args, count: 3, idempotencyKey: 'agents-nostart-1' }));
  assert.equal(stopped.error.code, 'AGENT_NOT_STARTED');
  assert.deepEqual(stopped.results.map((r) => [r.status, r.started]), [['deployed', true], ['deployed', false], ['not_started', undefined]]);
  assert.equal(sent.length, 2);
});

test('a confirm for another count or another name than quoted is refused, with nothing paid', async () => {
  const t = tools();
  for (const [change, key] of [[{ count: 4 }, 'agents-mismatch-1'], [{ name: 'other' }, 'agents-mismatch-2']]) {
    const { quote } = parse(await t.deploy_agents({ ...args, count: 3, idempotencyKey: key }));
    const { error } = failure(await t.deploy_agents({ ...args, count: 3, ...change, idempotencyKey: key, confirm: true, quoteId: quote.quoteId }));
    assert.equal(error.code, 'QUOTE_MISMATCH');
  }
  assert.equal(sent.length, 0);
  assert.equal(deploys().length, 0);
});

test('a key belongs to one kind of spend, and one list of agents', async () => {
  const t = tools();
  parse(await run(t, { ...args, count: 2, idempotencyKey: 'agents-kind-1' }));
  const single = JSON.parse((await t.deploy_agent({ ...args, idempotencyKey: 'agents-kind-1' })).content[0].text).error;
  assert.equal(single.code, 'IDEMPOTENCY_KEY_IN_USE');

  const { quote } = parse(await t.deploy_agent({ ...args, idempotencyKey: 'agent-kind-2' }));
  parse(await t.deploy_agent({ ...args, idempotencyKey: 'agent-kind-2', confirm: true, quoteId: quote.quoteId }));
  assert.equal(failure(await t.deploy_agents({ ...args, count: 2, idempotencyKey: 'agent-kind-2' })).error.code, 'IDEMPOTENCY_KEY_IN_USE');

  // Another template under a key that deployed agents: refused, not resumed as if the same.
  assert.equal(failure(await t.deploy_agents({ ...args, model: 'gpt-4o', count: 3, idempotencyKey: 'agents-kind-1' })).error.code, 'IDEMPOTENCY_KEY_IN_USE');
  assert.equal(sent.length, 3);
});

test('0g-compute: no provider key, a warning that each agent funds its own 0G Compute account; no fee: nothing paid', async () => {
  terms = { required: false };
  const t = tools();
  const { quote } = parse(await t.deploy_agents({ ...args, provider: '0g-compute', model: 'glm-5', count: 2, idempotencyKey: 'agents-og-1' }));
  assert.match(quote.warnings[0], /Each agent pays its own inference from its own wallet: send each about 3\.1 0G/);
  assert.equal(quote.totalFee, 'none');
  const done = parse(await t.deploy_agents({ ...args, provider: '0g-compute', model: 'glm-5', count: 2, idempotencyKey: 'agents-og-1', confirm: true, quoteId: quote.quoteId }));
  assert.equal(done.deployed, 2);
  assert.equal(sent.length, 0);
  assert.equal(deploys()[0].body.apiKey, '');
  assert.equal(deploys()[0].body.feeTxHash, undefined);
  assert.equal(callsTo('/api/v1/api-keys/whoami').length, 0);
});
