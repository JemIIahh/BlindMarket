import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverSettlement } from '../dist/settlement.js';

/**
 * Backends that name their posting chain (`postingChain` + `chains[]` on
 * /health/bridge) are read directly: the posting chain is where
 * POST /api/v1/tasks builds, and its token decides how a spend is paid.
 * Older backends keep the `base`-block discovery, unchanged — pinned first,
 * against production's real /health/bridge body.
 */

const PRIVY_WALLET = '0x2afd3a7Dd4377097f5220d34fb4E577963FdB6a4';
const USDC_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

// GET https://api.blindmarket.xyz/health/bridge on 2026-09-18: master, which
// predates postingChain.
const PROD_BRIDGE = {
  configured: true, signerAddress: '0xF0c75D55C7c88F5247FE6bB0f681D42F4232151E',
  escrowAddress: '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff', chainId: 16661,
  onChainVerifier: '0xF0c75D55C7c88F5247FE6bB0f681D42F4232151E', verifierMatches: true,
  escrowReadError: null, signerBalanceOg: '1.997909383996341422', signerGasLow: false,
  signerBalanceError: null, rotateCommand: null,
  base: {
    configured: true, signerAddress: '0xF0c75D55C7c88F5247FE6bB0f681D42F4232151E',
    escrowAddress: '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf', chainId: 84532,
    onChainVerifier: '0xF0c75D55C7c88F5247FE6bB0f681D42F4232151E', verifierMatches: true,
    escrowReadError: null, signerUsdcBalance: '0', signerEthBalance: '0.000274294789922831',
    signerEthLow: true, signerBalanceError: null, rotateCommand: null,
  },
};

// GET /health/bridge from this branch's backend booted with no signer keys
// (2026-09-18). Base posts (it has an escrow) but is not `configured` — the
// case the `base` block reported as "0G" while POST /tasks built on Base.
const chainsFixture = () => [
  {
    chain: '0g', configured: false, chainId: 16602, tier: 'testnet',
    escrowAddress: '0x037529B296a89E6Dd1abAF84D413cb2dD70C5be5',
    token: { kind: 'native', address: '0x0000000000000000000000000000000000000000', symbol: '0G', decimals: 18 },
    relayChain: null, gasSymbol: '0G', postable: false, reason: 'MARKETPLACE_SIGNER_PRIVATE_KEY not set',
  },
  {
    chain: 'base', configured: false, chainId: 84532, tier: 'testnet',
    escrowAddress: '0xa1F75b5eC92f4485d4EeFa339DC2B8aF25Df0eC5',
    token: { kind: 'erc20', address: USDC_SEPOLIA, symbol: 'USDC', decimals: 6 },
    relayChain: 'base-sepolia', gasSymbol: 'ETH', postable: true, reason: 'BASE_MARKETPLACE_SIGNER_PRIVATE_KEY not set',
  },
];
const newBridge = (over = {}) => ({
  configured: false, escrowAddress: '0x037529B296a89E6Dd1abAF84D413cb2dD70C5be5', chainId: 16602,
  base: null, chains: chainsFixture(), postingChain: 'base', settlementTier: 'testnet', tierSource: 'chains',
  ...over,
});

function backend(data) {
  const calls = { bridge: 0, whoami: 0 };
  return {
    apiBase: 'https://backend.test',
    calls,
    fetchImpl: async () => { calls.bridge++; return { json: async () => ({ success: true, data }) }; },
    api: async (method, path) => {
      assert.equal(`${method} ${path}`, 'GET /api/v1/api-keys/whoami');
      calls.whoami++;
      return { address: PRIVY_WALLET };
    },
  };
}

/** The fields a spend reads, without the live provider object. */
function facts(s) {
  const { provider, ...rest } = s;
  return rest;
}

// ── An older backend (production today) ─────────────────────────────────────

test("production's /health/bridge (no postingChain) settles exactly as before", async () => {
  const s = await discoverSettlement({ ...backend(PROD_BRIDGE), env: {} });
  assert.deepEqual(facts(s), {
    payment: 'relay-erc20', mode: 'base', chain: 'base', chainId: 84532,
    escrowAddress: '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf',
    token: { kind: 'erc20', address: USDC_SEPOLIA, symbol: 'USDC', decimals: 6 },
    usdcAddress: USDC_SEPOLIA, decimals: 6, symbol: 'USDC', relayChain: 'base-sepolia',
    rpcUrl: 'https://sepolia.base.org', payFrom: PRIVY_WALLET,
  });
});

test('on an older backend only "0g" and "base" can be forced', async () => {
  await assert.rejects(
    discoverSettlement({ ...backend(PROD_BRIDGE), env: { BLINDMARKET_SETTLEMENT: 'arc' } }),
    (e) => e.code === 'BAD_SETTLEMENT' && /predates chain keys/.test(e.message),
  );
});

// ── A backend that names its posting chain ─────────────────────────────────

test('posting on Base pays through the relay, even with no Base signer configured', async () => {
  const be = backend(newBridge());
  const s = await discoverSettlement({ ...be, env: {} });
  assert.deepEqual(facts(s), {
    payment: 'relay-erc20', mode: 'base', chain: 'base', chainId: 84532,
    escrowAddress: '0xa1F75b5eC92f4485d4EeFa339DC2B8aF25Df0eC5',
    token: { kind: 'erc20', address: USDC_SEPOLIA, symbol: 'USDC', decimals: 6 },
    usdcAddress: USDC_SEPOLIA, decimals: 6, symbol: 'USDC', relayChain: 'base-sepolia',
    rpcUrl: 'https://sepolia.base.org', payFrom: PRIVY_WALLET,
    postingChain: 'base', escrowChains: ['0g', 'base'],
  });
  assert.equal(be.calls.whoami, 1);
});

test("the escrow, token and relay label are the backend's, not this package's tables", async () => {
  const TOKEN = '0x' + '7a'.repeat(20);
  const chains = chainsFixture();
  chains[1] = { ...chains[1], escrowAddress: '0x' + 'e1'.repeat(20), token: { kind: 'erc20', address: TOKEN, symbol: 'USDC', decimals: 6 }, relayChain: 'base' };
  const s = await discoverSettlement({ ...backend(newBridge({ chains })), env: {} });
  assert.equal(s.escrowAddress.toLowerCase(), '0x' + 'e1'.repeat(20));
  assert.equal(s.token.address.toLowerCase(), TOKEN);
  assert.equal(s.usdcAddress, s.token.address);
  assert.equal(s.relayChain, 'base');
});

test('posting on 0G pays natively from the local wallet, with the escrow the backend names', async () => {
  const chains = chainsFixture();
  chains[0] = { ...chains[0], postable: true };
  chains[1] = { ...chains[1], postable: false };
  const be = backend(newBridge({ postingChain: '0g', chains }));
  const s = await discoverSettlement({ ...be, env: {} });
  assert.deepEqual(facts(s), {
    payment: 'local-native', mode: '0g', chain: '0g', chainId: 16602,
    token: { kind: 'native', address: '0x0000000000000000000000000000000000000000', symbol: '0G', decimals: 18 },
    decimals: 18, symbol: '0G', escrowAddress: '0x037529B296a89E6Dd1abAF84D413cb2dD70C5be5',
    postingChain: '0g', escrowChains: ['0g', 'base'],
  });
  assert.equal(be.calls.whoami, 0, 'the local wallet pays; no relay wallet needed');
});

test('a chain added later is paid through the relay once the backend describes it', async () => {
  const arc = {
    chain: 'arc', configured: true, chainId: 5042002, tier: 'testnet', escrowAddress: '0x' + 'a7'.repeat(20),
    token: { kind: 'erc20', address: '0x3600000000000000000000000000000000000000', symbol: 'USDC', decimals: 6 },
    relayChain: 'arc', gasSymbol: 'USDC', postable: true,
  };
  const data = newBridge({ postingChain: 'arc', chains: [...chainsFixture().map((c) => ({ ...c, postable: false })), arc] });
  // A chain id with no public RPC known here needs its env var: no guessing.
  const unknown = newBridge({ postingChain: 'zeta', chains: [...chainsFixture().map((c) => ({ ...c, postable: false })), { ...arc, chain: 'zeta', chainId: 999_999, relayChain: 'zeta' }] });
  await assert.rejects(
    discoverSettlement({ ...backend(unknown), env: {} }),
    (e) => e.code === 'RPC_UNKNOWN' && /BLINDMARKET_ZETA_RPC_URL/.test(e.message),
  );
  // Arc testnet has a public RPC, keyed by the chain id the backend names.
  assert.equal((await discoverSettlement({ ...backend(data), env: {} })).rpcUrl, 'https://rpc.testnet.arc.io');
  const s = await discoverSettlement({ ...backend(data), env: { BLINDMARKET_ARC_RPC_URL: 'http://127.0.0.1:9' } });
  assert.equal(s.payment, 'relay-erc20');
  assert.equal(s.mode, 'arc');
  assert.equal(s.chainId, 5042002);
  assert.equal(s.relayChain, 'arc');
  assert.equal(s.rpcUrl, 'http://127.0.0.1:9');
});

test('an ERC-20 chain the relay does not serve is refused, not guessed', async () => {
  const chains = chainsFixture();
  chains[1] = { ...chains[1], relayChain: null };
  await assert.rejects(
    discoverSettlement({ ...backend(newBridge({ chains })), env: {} }),
    (e) => e.code === 'UNSUPPORTED_SETTLEMENT' && /relay/.test(e.message),
  );
});

test('a native coin anywhere but 0G is refused', async () => {
  const chains = chainsFixture();
  chains[1] = { ...chains[1], token: { kind: 'native', address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', decimals: 18 } };
  await assert.rejects(
    discoverSettlement({ ...backend(newBridge({ chains })), env: {} }),
    (e) => e.code === 'UNSUPPORTED_SETTLEMENT' && /native ETH/.test(e.message),
  );
});

test('an unknown token kind is refused', async () => {
  const chains = chainsFixture();
  chains[1] = { ...chains[1], token: { kind: 'erc721', address: USDC_SEPOLIA, symbol: 'X', decimals: 0 } };
  await assert.rejects(discoverSettlement({ ...backend(newBridge({ chains })), env: {} }), (e) => e.code === 'UNSUPPORTED_SETTLEMENT');
});

test('a posting chain with no escrow is refused before anything is signed', async () => {
  const chains = chainsFixture();
  chains[1] = { ...chains[1], postable: false };
  await assert.rejects(
    discoverSettlement({ ...backend(newBridge({ chains })), env: {} }),
    (e) => e.code === 'SETTLEMENT_NOT_POSTABLE',
  );
});

test('an unusable POSTING_CHAIN on the backend is an error, never a fallback', async () => {
  const data = newBridge({ postingChain: null, postingChainError: 'POSTING_CHAIN="solana" is not a settlement chain' });
  await assert.rejects(
    discoverSettlement({ ...backend(data), env: {} }),
    (e) => e.code === 'SETTLEMENT_UNKNOWN' && /POSTING_CHAIN="solana"/.test(e.message),
  );
});

test('a posting chain missing from chains[] is an error', async () => {
  await assert.rejects(
    discoverSettlement({ ...backend(newBridge({ postingChain: 'arc' })), env: {} }),
    (e) => e.code === 'SETTLEMENT_UNKNOWN' && /arc/.test(e.message),
  );
});

test('BLINDMARKET_SETTLEMENT may name any chain with an escrow, and the posting chain stays known', async () => {
  // The backend moved to posting on 0G; a task (or an executor's assignment)
  // is still on Base. Forcing base reaches it; post_task refuses there.
  const chains = chainsFixture().map((c) => ({ ...c, postable: c.chain === '0g' }));
  const s = await discoverSettlement({ ...backend(newBridge({ postingChain: '0g', chains })), env: { BLINDMARKET_SETTLEMENT: 'base' } });
  assert.equal(s.payment, 'relay-erc20');
  assert.equal(s.mode, 'base');
  assert.equal(s.escrowAddress, '0xa1F75b5eC92f4485d4EeFa339DC2B8aF25Df0eC5');
  assert.equal(s.postingChain, '0g');
  assert.deepEqual(s.escrowChains, ['0g', 'base']);

  const posting = await discoverSettlement({ ...backend(newBridge()), env: { BLINDMARKET_SETTLEMENT: 'base' } });
  assert.equal(posting.postingChain, 'base');

  await assert.rejects(
    discoverSettlement({ ...backend(newBridge()), env: { BLINDMARKET_SETTLEMENT: 'polygon' } }),
    (e) => e.code === 'BAD_SETTLEMENT' && /has an escrow on \(0g, base\)/.test(e.message),
  );
  const noBaseEscrow = chainsFixture();
  noBaseEscrow[1] = { ...noBaseEscrow[1], escrowAddress: null, postable: false };
  await assert.rejects(
    discoverSettlement({ ...backend(newBridge({ postingChain: '0g', chains: noBaseEscrow.map((c) => ({ ...c, postable: c.chain === '0g' })) })), env: { BLINDMARKET_SETTLEMENT: 'base' } }),
    (e) => e.code === 'BAD_SETTLEMENT' && /\(0g\)/.test(e.message),
  );
});

test('a zero ERC-20 token address is refused', async () => {
  const chains = chainsFixture();
  chains[1] = { ...chains[1], token: { ...chains[1].token, address: '0x0000000000000000000000000000000000000000' } };
  await assert.rejects(discoverSettlement({ ...backend(newBridge({ chains })), env: {} }), (e) => e.code === 'SETTLEMENT_UNKNOWN');
});

test('an address served with a bad checksum is compared lowercased, as the backend does', async () => {
  const chains = chainsFixture();
  const badCase = (a) => '0x' + a.slice(2).split('').map((ch, i) => (i % 2 ? ch.toUpperCase() : ch.toLowerCase())).join('');
  chains[1] = { ...chains[1], escrowAddress: badCase(chains[1].escrowAddress), token: { ...chains[1].token, address: badCase(USDC_SEPOLIA) } };
  const s = await discoverSettlement({ ...backend(newBridge({ chains })), env: {} });
  assert.equal(s.escrowAddress, '0xa1F75b5eC92f4485d4EeFa339DC2B8aF25Df0eC5');
  assert.equal(s.token.address, USDC_SEPOLIA);
});

test('a chain listed with no chain id is refused', async () => {
  const chains = chainsFixture();
  delete chains[1].chainId;
  await assert.rejects(discoverSettlement({ ...backend(newBridge({ chains })), env: {} }), (e) => e.code === 'SETTLEMENT_UNKNOWN' && /chain id/.test(e.message));
});

test('BLINDMARKET_SETTLEMENT=0g still skips discovery on any backend', async () => {
  const be = backend(newBridge());
  const s = await discoverSettlement({ ...be, env: { BLINDMARKET_SETTLEMENT: '0g' } });
  assert.equal(s.payment, 'local-native');
  assert.equal(be.calls.bridge, 0);
});

test('a BLINDMARKET_SETTLEMENT that is not a chain key is refused without a request', async () => {
  const be = backend(newBridge());
  await assert.rejects(discoverSettlement({ ...be, env: { BLINDMARKET_SETTLEMENT: 'Base Sepolia' } }), (e) => e.code === 'BAD_SETTLEMENT');
  assert.equal(be.calls.bridge, 0);
});

test("BLINDMARKET_USDC_ADDRESS may not contradict the backend's settlement token", async () => {
  await assert.rejects(
    discoverSettlement({ ...backend(newBridge()), env: { BLINDMARKET_USDC_ADDRESS: '0x' + '1'.repeat(40) } }),
    (e) => e.code === 'TOKEN_MISMATCH',
  );
  const s = await discoverSettlement({ ...backend(newBridge()), env: { BLINDMARKET_USDC_ADDRESS: USDC_SEPOLIA.toLowerCase() } });
  assert.equal(s.token.address, USDC_SEPOLIA);
});
