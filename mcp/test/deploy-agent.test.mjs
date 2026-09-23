import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, Wallet } from 'ethers';

/**
 * deploy_agent: a hosted agent costs a deploy fee, paid as one USDC transfer
 * on Arc from the local wallet. Quote first, pay only on confirm, check the
 * wallet is the API key's owner before paying, and never pay twice for one
 * idempotencyKey. The provider key comes from the environment, not the call.
 */

process.env.BLINDMARKET_STATE_DIR = mkdtempSync(join(tmpdir(), 'bm-mcp-state-'));
process.env.BLINDMARKET_DEPLOY_POLL_MS = '0';
process.env.OPENAI_API_KEY = 'sk-openai-test';

const { registerRentTools } = await import('../dist/rent.js');

const OWNER_KEY = Wallet.createRandom();
const OWNER = OWNER_KEY.address;
const USDC = '0x3600000000000000000000000000000000000000';
const TREASURY = '0x2f8b1177c83623a560B26B38dE984e154b123D75';
const FEE_TX = '0x' + 'fe'.repeat(32);
const ERC20 = new Interface(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const TRANSFER_TERMS = { required: true, method: 'transfer', chain: 'arc', token: USDC, recipient: TREASURY, amountRaw: '1000000', decimals: 6, factory: null };

let rpc;
let rpcUrl;
let chainIdServed;
before(async () => {
  rpc = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const one = ({ id, method, params }) => {
        let result;
        if (method === 'eth_chainId') result = '0x' + chainIdServed.toString(16);
        else if (method === 'eth_call') result = ERC20.encodeFunctionResult('balanceOf', [12_500_000n]);
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
let owner;
let deployAnswers;
let calls;
let sent;
let waitResult;
let validateAnswer;
beforeEach(() => {
  terms = TRANSFER_TERMS;
  owner = OWNER;
  deployAnswers = [];
  calls = [];
  sent = [];
  waitResult = async () => ({ status: 1 });
  chainIdServed = 5042002;
  validateAnswer = null;
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (rpcUrl && u.startsWith(rpcUrl)) return realFetch(url, init);
  const path = u.replace(/^https?:\/\/[^/]+/, '');
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init.method ?? 'GET', path, body });
  const json = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
  if (path === '/health/bridge') return json({ postingChain: 'arc', chains: [{ chain: 'arc', chainId: 5042002 }] });
  if (path === '/api/v1/agents/deploy-fee') return json(terms);
  if (path === '/api/v1/agents/deploy/validate') return validateAnswer ?? json({ valid: true });
  if (path === '/api/v1/api-keys/whoami') return json({ address: owner.toLowerCase() });
  if (path === '/api/v1/agents/deploy') {
    const next = deployAnswers.shift();
    if (next) return next;
    return json({ id: 'agent-1', name: body.name, walletAddress: '0x' + '44'.repeat(20), started: true });
  }
  throw new Error('unexpected backend call ' + path);
};
const failWith = (status, code) => ({ ok: false, status, json: async () => ({ success: false, error: { code, message: code } }) });

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
        sendTransaction: async (tx) => { sent.push(tx); return { hash: FEE_TX, wait: waitResult }; },
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
const errorOf = (res) => {
  assert.equal(res.isError, true, res.content[0].text);
  return JSON.parse(res.content[0].text).error;
};
const deploys = () => calls.filter((c) => c.path === '/api/v1/agents/deploy');
const args = { name: 'research-agent', instructions: 'Research topics and cite sources.', provider: 'openai', model: 'gpt-4o-mini' };

test('quotes the fee, the payee and the wallet balance, and pays nothing', async () => {
  const { quote, next } = parse(await tools().deploy_agent({ ...args, idempotencyKey: 'deploy-quote-1' }));
  assert.equal(quote.fee, '1 USDC');
  assert.equal(quote.chain, 'arc');
  assert.equal(quote.payTo, TREASURY);
  assert.equal(quote.payFrom, OWNER);
  assert.equal(quote.walletBalance, '12.5');
  assert.match(next, /confirm=true/);
  assert.equal(sent.length, 0);
  assert.equal(deploys().length, 0);
});

test('on confirm: pays the treasury from the owner wallet, then deploys with that payment', async () => {
  const t = tools();
  const { quote } = parse(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-pay-1' }));
  const done = parse(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-pay-1', confirm: true, quoteId: quote.quoteId }));
  assert.equal(done.agentId, 'agent-1');
  assert.equal(done.feeTxHash, FEE_TX);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, USDC);
  assert.deepEqual(ERC20.decodeFunctionData('transfer', sent[0].data).map(String), [TREASURY, '1000000']);
  const body = deploys()[0].body;
  assert.equal(body.feeTxHash, FEE_TX);
  assert.equal(body.apiKey, 'sk-openai-test', 'the provider key comes from the environment');
  assert.equal(body.ownerPublicKey, OWNER_KEY.signingKey.publicKey.slice(2), 'the agent key is encrypted to the local wallet');

  // The same key again: nothing new is paid or deployed.
  const again = parse(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-pay-1' }));
  assert.equal(again.resumed, true);
  assert.equal(again.agentId, 'agent-1');
  assert.equal(sent.length, 1);
  assert.equal(deploys().length, 1);
});

test('a deploy that fails after paying resumes with the same payment', async () => {
  const t = tools();
  deployAnswers = [failWith(500, 'INTERNAL_ERROR')];
  const { quote } = parse(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-resume-1' }));
  const error = errorOf(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-resume-1', confirm: true, quoteId: quote.quoteId }));
  assert.match(error.message, new RegExp(`fee is paid \\(${FEE_TX}\\)`));

  const done = parse(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-resume-1' }));
  assert.equal(done.resumed, true);
  assert.equal(done.agentId, 'agent-1');
  assert.equal(sent.length, 1, 'paid once');
  assert.equal(deploys()[1].body.feeTxHash, FEE_TX);
});

test("refuses to pay from a wallet that is not the API key's owner", async () => {
  owner = '0x' + 'e1'.repeat(20);
  const t = tools();
  const { quote } = parse(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-owner-1' }));
  const error = errorOf(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-owner-1', confirm: true, quoteId: quote.quoteId }));
  assert.equal(error.code, 'OWNER_MISMATCH');
  assert.equal(sent.length, 0);
});

test('a reverted payment is reported as unpaid and the deploy is not attempted', async () => {
  waitResult = async () => { throw Object.assign(new Error('reverted'), { code: 'CALL_EXCEPTION' }); };
  const t = tools();
  const { quote } = parse(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-revert-1' }));
  const error = errorOf(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-revert-1', confirm: true, quoteId: quote.quoteId }));
  assert.equal(error.code, 'FEE_REVERTED');
  assert.equal(deploys().length, 0);
});

test('needs the provider key in the environment, except for 0g-compute', async () => {
  const t = tools();
  assert.equal(errorOf(await t.deploy_agent({ ...args, provider: 'anthropic', idempotencyKey: 'deploy-key-1' })).code, 'PROVIDER_KEY_MISSING');
  const { quote } = parse(await t.deploy_agent({ ...args, provider: '0g-compute', idempotencyKey: 'deploy-key-2' }));
  parse(await t.deploy_agent({ ...args, provider: '0g-compute', idempotencyKey: 'deploy-key-2', confirm: true, quoteId: quote.quoteId }));
  assert.equal(deploys()[0].body.apiKey, '');
});

test('refuses an RPC on another chain before paying', async () => {
  chainIdServed = 84532;
  const error = errorOf(await tools().deploy_agent({ ...args, idempotencyKey: 'deploy-rpc-1' }));
  assert.equal(error.code, 'WRONG_RPC');
  assert.equal(sent.length, 0);
});

test('a backend that takes the fee only through AgentFactory is refused, not half-paid', async () => {
  terms = { required: true, method: 'factory', chain: 'arc', factory: '0x' + 'fa'.repeat(20) };
  assert.equal(errorOf(await tools().deploy_agent({ ...args, idempotencyKey: 'deploy-factory-1' })).code, 'UNSUPPORTED_FEE_METHOD');
});

test('with no fee, confirm deploys without paying', async () => {
  terms = { required: false };
  const t = tools();
  const { quote } = parse(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-free-1' }));
  assert.equal(quote.fee, 'none');
  const done = parse(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-free-1', confirm: true, quoteId: quote.quoteId }));
  assert.equal(done.agentId, 'agent-1');
  assert.equal(sent.length, 0);
  assert.equal(deploys()[0].body.feeTxHash, undefined);
});

test('a request the deploy would refuse is refused at the quote, before anything is paid', async () => {
  validateAnswer = failWith(404, 'SKILL_NOT_FOUND');
  const error = errorOf(await tools().deploy_agent({ ...args, skillSlugs: ['nope'], idempotencyKey: 'deploy-invalid-1' }));
  assert.equal(error.code, 'SKILL_NOT_FOUND');
  assert.match(error.message, /Nothing was paid/);
  assert.equal(sent.length, 0);
  assert.equal(deploys().length, 0);
});

test('checks the request again on confirm, right before paying', async () => {
  const t = tools();
  const { quote } = parse(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-invalid-2' }));
  validateAnswer = failWith(400, 'INVALID_OWNER_PUBLIC_KEY');
  const error = errorOf(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-invalid-2', confirm: true, quoteId: quote.quoteId }));
  assert.equal(error.code, 'INVALID_OWNER_PUBLIC_KEY');
  assert.equal(sent.length, 0);
});

test('a backend without the validate route still deploys (its own checks run before it takes the fee)', async () => {
  validateAnswer = { ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected token <'); } };
  const t = tools();
  const { quote } = parse(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-oldbackend-1' }));
  const done = parse(await t.deploy_agent({ ...args, idempotencyKey: 'deploy-oldbackend-1', confirm: true, quoteId: quote.quoteId }));
  assert.equal(done.agentId, 'agent-1');
});

test("refuses a fee whose chain id is not the one the backend lists for that chain", async () => {
  terms = { ...TRANSFER_TERMS, chainId: 5042 };
  const error = errorOf(await tools().deploy_agent({ ...args, idempotencyKey: 'deploy-chainid-1' }));
  assert.equal(error.code, 'SETTLEMENT_UNKNOWN');
  assert.match(error.message, /chain 5042/);
  assert.equal(sent.length, 0);
});
