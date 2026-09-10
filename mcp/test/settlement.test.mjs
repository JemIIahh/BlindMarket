import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_USDC,
  createSettlementResolver,
  discoverSettlement,
  relayChainFor,
  usdcFor,
} from '../dist/settlement.js';

/**
 * Settlement discovery decides which of two very different payment paths a
 * spend takes — local private key on 0G, or the Privy relay on Base. Getting
 * it wrong is not a cosmetic bug: it means sending native value into a USDC
 * transferFrom, or signing a Base tx on the 0G RPC. So the decision logic is
 * pinned here against fake backends, with no network.
 */

const SEPOLIA_ESCROW = '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf';
const PRIVY_WALLET = '0x2afd3a7Dd4377097f5220d34fb4E577963FdB6a4';

/** A fake /health/bridge + whoami backend. Counts calls so memoisation is testable. */
function fakeBackend({ base, whoami = { address: PRIVY_WALLET } } = {}) {
  const calls = { bridge: 0, whoami: 0 };
  const fetchImpl = async (url) => {
    assert.match(String(url), /\/health\/bridge$/);
    calls.bridge++;
    return { json: async () => ({ success: true, data: { base } }) };
  };
  const api = async (method, path) => {
    assert.equal(method, 'GET');
    assert.equal(path, '/api/v1/api-keys/whoami');
    calls.whoami++;
    return whoami;
  };
  return { fetchImpl, api, calls, apiBase: 'https://backend.test' };
}

test('relayChainFor maps the two Base chain ids the relay accepts, nothing else', () => {
  assert.equal(relayChainFor(8453), 'base-mainnet');
  assert.equal(relayChainFor(84532), 'base-sepolia');
  assert.equal(relayChainFor(16661), null); // 0G is not a relay target
  assert.equal(relayChainFor(1), null);
});

test('usdcFor knows the canonical addresses and honours an explicit override', () => {
  assert.equal(usdcFor(84532), BASE_USDC[84532]);
  assert.equal(usdcFor(8453), BASE_USDC[8453]);
  assert.equal(usdcFor(1), null);
  assert.equal(usdcFor(1, '0x' + '1'.repeat(40)), '0x' + '1'.repeat(40));
  // a malformed override is ignored, not trusted
  assert.equal(usdcFor(84532, 'not-an-address'), BASE_USDC[84532]);
});

test('BLINDMARKET_SETTLEMENT=0g skips discovery entirely', async () => {
  const be = fakeBackend({ base: { configured: true, chainId: 84532, escrowAddress: SEPOLIA_ESCROW } });
  const s = await discoverSettlement({ ...be, env: { BLINDMARKET_SETTLEMENT: '0g' } });
  assert.equal(s.mode, '0g');
  assert.equal(s.decimals, 18);
  assert.equal(be.calls.bridge, 0, 'must not touch the network when forced to 0g');
  assert.equal(be.calls.whoami, 0);
});

test('backend without a Base escrow → 0G, and whoami is not needed', async () => {
  const be = fakeBackend({ base: null });
  const s = await discoverSettlement({ ...be, env: {} });
  assert.equal(s.mode, '0g');
  assert.equal(be.calls.whoami, 0);
});

test('backend in Base mode → relay settlement derived from its chain id', async () => {
  const be = fakeBackend({ base: { configured: true, chainId: 84532, escrowAddress: SEPOLIA_ESCROW } });
  const s = await discoverSettlement({ ...be, env: {} });
  assert.equal(s.mode, 'base');
  assert.equal(s.chainId, 84532);
  assert.equal(s.relayChain, 'base-sepolia');
  assert.equal(s.escrowAddress, SEPOLIA_ESCROW);
  assert.equal(s.usdcAddress, BASE_USDC[84532]);
  assert.equal(s.decimals, 6);
  assert.equal(s.symbol, 'USDC');
  assert.equal(s.payFrom, PRIVY_WALLET, 'the relay signs from the API key owner');
  assert.equal(s.rpcUrl, 'https://sepolia.base.org');
  assert.equal(be.calls.whoami, 1);
});

test('forcing base against a backend that is not in Base mode fails loudly', async () => {
  const be = fakeBackend({ base: { configured: false } });
  await assert.rejects(
    discoverSettlement({ ...be, env: { BLINDMARKET_SETTLEMENT: 'base' } }),
    (e) => e.code === 'SETTLEMENT_MISMATCH',
  );
});

test('the legacy "agent" principal cannot be a relay wallet', async () => {
  const be = fakeBackend({
    base: { configured: true, chainId: 84532, escrowAddress: SEPOLIA_ESCROW },
    whoami: { address: 'agent' },
  });
  await assert.rejects(discoverSettlement({ ...be, env: {} }), (e) => e.code === 'RELAY_WALLET_UNKNOWN');
});

test('a Base chain the relay does not support is refused, not guessed', async () => {
  const be = fakeBackend({ base: { configured: true, chainId: 1, escrowAddress: SEPOLIA_ESCROW } });
  await assert.rejects(discoverSettlement({ ...be, env: {} }), (e) => e.code === 'UNSUPPORTED_BASE_CHAIN');
});

test('an unreachable backend is an error, never a silent fallback to 0G', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(
    discoverSettlement({ apiBase: 'https://backend.test', api: async () => ({}), fetchImpl, env: {} }),
    (e) => e.code === 'SETTLEMENT_UNKNOWN' && /BLINDMARKET_SETTLEMENT=0g/.test(e.message),
  );
});

test('a bad BLINDMARKET_SETTLEMENT value is rejected up front', async () => {
  const be = fakeBackend({ base: null });
  await assert.rejects(
    discoverSettlement({ ...be, env: { BLINDMARKET_SETTLEMENT: 'polygon' } }),
    (e) => e.code === 'BAD_SETTLEMENT',
  );
});

test('the resolver discovers once and then serves the cached answer', async () => {
  const be = fakeBackend({ base: { configured: true, chainId: 84532, escrowAddress: SEPOLIA_ESCROW } });
  const resolve = createSettlementResolver({ ...be, env: {} });
  const a = await resolve();
  const b = await resolve();
  assert.equal(a, b);
  assert.equal(be.calls.bridge, 1);
  assert.equal(be.calls.whoami, 1);
});

test('the resolver does not cache a failure, so a transient outage can be retried', async () => {
  let fail = true;
  const be = fakeBackend({ base: { configured: true, chainId: 84532, escrowAddress: SEPOLIA_ESCROW } });
  const flaky = async (url) => {
    if (fail) { fail = false; throw new Error('timeout'); }
    return be.fetchImpl(url);
  };
  const resolve = createSettlementResolver({ ...be, fetchImpl: flaky, env: {} });
  await assert.rejects(resolve(), (e) => e.code === 'SETTLEMENT_UNKNOWN');
  const s = await resolve();
  assert.equal(s.mode, 'base');
});
