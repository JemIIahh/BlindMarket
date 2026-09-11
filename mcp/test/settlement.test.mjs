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

test('forcing base with no health confirmation and no override fails loudly', async () => {
  const be = fakeBackend({ base: { configured: false } });
  await assert.rejects(
    discoverSettlement({ ...be, env: { BLINDMARKET_SETTLEMENT: 'base' } }),
    (e) => e.code === 'SETTLEMENT_MISMATCH' && /BLINDMARKET_BASE_ESCROW_ADDRESS/.test(e.message),
  );
});

test('forcing base with an explicit escrow works when health cannot vouch for it', async () => {
  // The real default: config.baseEscrowAddress falls back to the generated
  // contractAddresses.ts, so a backend with an empty Base .env still builds
  // Base txs — while /health/bridge stays silent because it wants both
  // marketplace signers. Requiring health here would block that setup.
  const be = fakeBackend({ base: null });
  const s = await discoverSettlement({
    ...be,
    env: { BLINDMARKET_SETTLEMENT: 'base', BLINDMARKET_BASE_ESCROW_ADDRESS: SEPOLIA_ESCROW },
  });
  assert.equal(s.mode, 'base');
  assert.equal(s.chainId, 84532, 'defaults to Base Sepolia');
  assert.equal(s.escrowAddress, SEPOLIA_ESCROW);
  assert.equal(s.usdcAddress, BASE_USDC[84532]);
  assert.equal(s.payFrom, PRIVY_WALLET);
});

test('an explicit escrow override still validates the chain id', async () => {
  const be = fakeBackend({ base: null });
  await assert.rejects(
    discoverSettlement({
      ...be,
      env: { BLINDMARKET_SETTLEMENT: 'base', BLINDMARKET_BASE_ESCROW_ADDRESS: SEPOLIA_ESCROW, BLINDMARKET_BASE_CHAIN_ID: '1' },
    }),
    (e) => e.code === 'UNSUPPORTED_BASE_CHAIN',
  );
});

test('a malformed escrow override is refused, not silently ignored', async () => {
  const be = fakeBackend({ base: null });
  await assert.rejects(
    discoverSettlement({
      ...be,
      env: { BLINDMARKET_SETTLEMENT: 'base', BLINDMARKET_BASE_ESCROW_ADDRESS: 'not-an-address' },
    }),
    (e) => e.code === 'SETTLEMENT_MISMATCH',
  );
});

test('the override is ignored when discovery is NOT forced to base', async () => {
  // Safety: an override left in the environment must not flip a 0G backend.
  const be = fakeBackend({ base: null });
  const s = await discoverSettlement({ ...be, env: { BLINDMARKET_BASE_ESCROW_ADDRESS: SEPOLIA_ESCROW } });
  assert.equal(s.mode, '0g');
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

// ── Review-driven cases (PR #54 review) ──────────────────────────────────────

test('an error envelope from /health/bridge is refused, not read as "0G"', async () => {
  // The backend wraps every 4xx/5xx as { success:false, error } — the same
  // shape as a healthy reply minus `data`. Reading that as "no Base block,
  // therefore 0G" is how native value ends up sent to a Base address.
  const fetchImpl = async () => ({ json: async () => ({ success: false, error: { code: 'INTERNAL', message: 'boom' } }) });
  await assert.rejects(
    discoverSettlement({ apiBase: 'https://backend.test', api: async () => ({}), fetchImpl, env: {} }),
    (e) => e.code === 'SETTLEMENT_UNKNOWN' && /INTERNAL/.test(e.message),
  );
});

test('a 0G answer carries the 0G escrow address when the bridge reports it', async () => {
  // Used by verifyTarget: the only defence against a backend that says "0G"
  // on /health/bridge (bridge half-configured) but builds Base txs on /tasks.
  const OG_ESCROW = '0x3d0374963daad43e31d42373eb11156a8e8ce2ff'; // lowercased on purpose
  const fetchImpl = async () => ({ json: async () => ({ success: true, data: { configured: true, escrowAddress: OG_ESCROW, chainId: 16661 } }) });
  const s = await discoverSettlement({ apiBase: 'https://backend.test', api: async () => ({}), fetchImpl, env: {} });
  assert.equal(s.mode, '0g');
  assert.equal(s.escrowAddress, '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff', 'checksummed');
});

test('a 0G answer without an escrow address leaves the field unset rather than inventing one', async () => {
  const fetchImpl = async () => ({ json: async () => ({ success: true, data: { configured: false, reason: 'signer not set' } }) });
  const s = await discoverSettlement({ apiBase: 'https://backend.test', api: async () => ({}), fetchImpl, env: {} });
  assert.equal(s.mode, '0g');
  assert.equal(s.escrowAddress, undefined);
});

test('payFrom and addresses are checksummed even though the backend stores owners lowercased', async () => {
  const be = fakeBackend({
    base: { configured: true, chainId: 84532, escrowAddress: SEPOLIA_ESCROW.toLowerCase() },
    whoami: { address: PRIVY_WALLET.toLowerCase() },
  });
  const s = await discoverSettlement({ ...be, env: {} });
  assert.equal(s.payFrom, PRIVY_WALLET);
  assert.equal(s.escrowAddress, SEPOLIA_ESCROW);
});

test('the cached answer expires after the TTL, so a long-lived server notices a prod flip', async () => {
  let base = null; // starts 0G
  const fetchImpl = async () => ({ json: async () => ({ success: true, data: { configured: false, base } }) });
  const api = async () => ({ address: PRIVY_WALLET });
  let clock = 0;
  const resolve = createSettlementResolver({ apiBase: 'https://backend.test', api, fetchImpl, env: {} }, 1000, () => clock);
  assert.equal((await resolve()).mode, '0g');
  base = { configured: true, chainId: 84532, escrowAddress: SEPOLIA_ESCROW }; // prod flips
  clock = 500;
  assert.equal((await resolve()).mode, '0g', 'still inside the TTL — cached');
  clock = 1500;
  assert.equal((await resolve()).mode, 'base', 'TTL elapsed — re-asked');
});

test('invalidate() forces the next call to re-discover immediately', async () => {
  let base = null;
  const fetchImpl = async () => ({ json: async () => ({ success: true, data: { configured: false, base } }) });
  const api = async () => ({ address: PRIVY_WALLET });
  const resolve = createSettlementResolver({ apiBase: 'https://backend.test', api, fetchImpl, env: {} });
  assert.equal((await resolve()).mode, '0g');
  base = { configured: true, chainId: 84532, escrowAddress: SEPOLIA_ESCROW };
  assert.equal((await resolve()).mode, '0g', 'cached');
  resolve.invalidate();
  assert.equal((await resolve()).mode, 'base');
});
