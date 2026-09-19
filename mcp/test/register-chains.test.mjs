import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { registerMarketTools } from '../dist/tools.js';

/**
 * An executor registered from this process delivers through complete_task,
 * which settles on one chain: the chain the backend posts new tasks on. So
 * register_as_executor and create_agent declare exactly that chain — more
 * would get it offered tasks it cannot deliver; nothing reads as the legacy
 * 0G+Base set.
 */

const PUBKEY = '04' + 'ab'.repeat(64);

function harness(settlement) {
  const handlers = {};
  const server = { registerTool: (name, _def, handler) => { handlers[name] = handler; } };
  const sent = [];
  const bb = {
    registerExecutor: async (params) => { sent.push(['registerExecutor', params]); return { agent: { address: '0xabc' } }; },
    deliverResult: () => {},
    createAgent: async (params) => {
      sent.push(['createAgent', params]);
      return { executor: { address: '0xabc' }, wallet: { address: '0xabc', publicKey: PUBKEY } };
    },
  };
  const walletCtx = { wallet: Wallet.createRandom() };
  registerMarketTools(server, bb, walletCtx, settlement);
  return { handlers, sent };
}

const register = (h) => h.handlers.register_as_executor({ displayName: 'x', capabilities: 'code_review', publicKey: PUBKEY });
const create = (h) => h.handlers.create_agent({ displayName: 'x', capabilities: 'code_review' });

for (const mode of ['base', '0g', 'arc']) {
  test(`register_as_executor and create_agent declare only "${mode}" when this process settles there`, async () => {
    const h = harness(async () => ({ mode }));
    await register(h);
    await create(h);
    assert.deepEqual(h.sent.map(([fn, p]) => [fn, p.supportedChains]), [
      ['registerExecutor', [mode]],
      ['createAgent', [mode]],
    ]);
  });
}

test('registration is refused, not sent without chains, when the settlement chain is unknown', async () => {
  const h = harness(async () => {
    const e = new Error('Could not reach https://backend.test/health/bridge');
    e.code = 'SETTLEMENT_UNKNOWN';
    throw e;
  });
  for (const [tool, call] of [['register_as_executor', register], ['create_agent', create]]) {
    const res = await call(h);
    assert.equal(res.isError, true, tool);
    const { error } = JSON.parse(res.content[0].text);
    assert.equal(error.code, 'SETTLEMENT_UNKNOWN');
    assert.match(error.message, new RegExp(`^${tool} declares`));
  }
  assert.deepEqual(h.sent, [], 'nothing registered');
});

test('without a resolver (embedders of registerMarketTools) the old request is sent unchanged', async () => {
  const h = harness(undefined);
  await register(h);
  assert.equal(h.sent[0][1].supportedChains, undefined);
});
