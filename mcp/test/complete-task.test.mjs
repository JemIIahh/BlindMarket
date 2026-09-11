import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerRentTools } from '../dist/rent.js';

/**
 * complete_task was Base-only and refused a Verified(3) task outright. These
 * pin the two behaviours added: a 0G path that signs locally, and a resubmit
 * after a FAILED verification round — allowed by the contract up to 3
 * attempts before the deadline. A fake backend + fake wallet, no network.
 */
process.env.BLINDMARKET_SETTLEMENT = '0g';   // discovery short-circuits, no /health/bridge fetch

const ESCROW = '0x' + 'e5'.repeat(20);
const HASH = '0x' + 'ab'.repeat(32);
const FUTURE = String(Math.floor(Date.now() / 1000) + 3600);
const PAST = String(Math.floor(Date.now() / 1000) - 60);

function harness({ status, attempts = 0, deadline = FUTURE, afterStatus = 4, verify = { passed: true, reasons: [] }, submitFrom } = {}) {
  const calls = [];
  const sentTxs = [];
  // on-chain status advances: loadTask reads it before submit, waitStatus after
  let onChain = status;
  const task = () => ({ taskId: '7', taskHash: HASH, status: onChain, amount: '1000000000000000000', deadline, token: '0x' + '0'.repeat(40), decimals: 18, submissionAttempts: attempts });

  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    calls.push({ method: init.method ?? 'GET', path });
    const json = (data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
    if (path.startsWith('/api/v1/tasks/')) return json(task());
    if (path.endsWith('/submit')) { return json({ onChainTaskId: 7, evidenceHash: '0x01', chain: '0g', unsignedSubmitEvidence: { to: ESCROW, data: '0xdead', chainId: 16602, ...(submitFrom ? { from: submitFrom } : {}) } }); }
    if (path.startsWith('/api/v1/storage/')) return json({ blob: Buffer.from('plain brief').toString('base64') });
    if (path.endsWith('/finalize')) { onChain = afterStatus; attempts += 1; return json({ status: verify.passed ? 'verified' : 'failed', verificationResult: verify }); }
    throw new Error('unexpected fetch ' + path);
  };

  const walletCtx = {
    wallet: {
      address: '0x' + '11'.repeat(20),
      privateKey: '0x' + '22'.repeat(32),
      sendTransaction: async (tx) => { sentTxs.push(tx); onChain = 2; return { hash: '0xsent', wait: async () => ({ status: 1 }) }; },
    },
    provider: { getCode: async () => '0x6001', getBalance: async () => 10n ** 18n, waitForTransaction: async () => ({}) },
    rpcUrl: 'http://rpc.test', chainId: 16602,
  };

  const tools = {};
  const server = { registerTool: (name, _schema, handler) => { tools[name] = handler; } };
  registerRentTools(server, { apiKey: 'sk_test', apiBase: 'https://backend.test', authenticated: true }, walletCtx);
  return { tools, calls, sentTxs };
}

const parse = (r) => JSON.parse(r.content[0].text);

describe('complete_task on 0G', () => {
  test('signs submitEvidence locally, then finalizes — no relay involved', async () => {
    const h = harness({ status: 1 });
    const out = parse(await h.tools.complete_task({ task: HASH, output: 'done' }));
    assert.equal(h.sentTxs.length, 1, 'exactly one local broadcast');
    assert.equal(h.sentTxs[0].to, ESCROW);
    assert.equal(h.sentTxs[0].chainId, 16602, 'chainId pinned through to the signer');
    assert.ok(!h.calls.some((c) => c.path.includes('relay-tx')), 'never touches the Privy relay on 0G');
    assert.ok(h.calls.some((c) => c.path.endsWith('/finalize')));
    assert.equal(out.onChainStatus, 'Completed');
    assert.equal(out.submitTxHash, '0xsent');
  });

  test('a task already Submitted skips straight to finalize', async () => {
    const h = harness({ status: 2 });
    parse(await h.tools.complete_task({ task: HASH, output: 'done' }));
    assert.equal(h.sentTxs.length, 0);
    assert.ok(h.calls.some((c) => c.path.endsWith('/finalize')));
  });
});

describe('complete_task after a FAILED verification round (on-chain Verified=3)', () => {
  test('resubmits — the contract permits it while attempts remain', async () => {
    const h = harness({ status: 3, attempts: 1 });
    const out = parse(await h.tools.complete_task({ task: HASH, output: 'revised' }));
    assert.ok(h.calls.some((c) => c.path.endsWith('/submit')), 'POSTed a fresh /submit');
    assert.equal(h.sentTxs.length, 1, 'broadcast a fresh submitEvidence');
    assert.equal(out.onChainStatus, 'Completed');
  });

  test('refuses when all 3 attempts are used, naming the count', async () => {
    const h = harness({ status: 3, attempts: 3 });
    const out = parse(await h.tools.complete_task({ task: HASH, output: 'again' }));
    assert.equal(out.error.code, 'MAX_ATTEMPTS_REACHED');
    assert.match(out.error.message, /3\/3/);
    assert.equal(h.sentTxs.length, 0, 'nothing broadcast');
  });

  test('refuses past the deadline before spending gas', async () => {
    const h = harness({ status: 3, attempts: 1, deadline: PAST });
    const out = parse(await h.tools.complete_task({ task: HASH, output: 'late' }));
    assert.equal(out.error.code, 'DEADLINE_REACHED');
    assert.equal(h.sentTxs.length, 0);
  });

  test('tells the caller how many attempts remain when a round fails', async () => {
    const h = harness({ status: 1, attempts: 0, afterStatus: 3, verify: { passed: false, reasons: ['too short'] } });
    const out = parse(await h.tools.complete_task({ task: HASH, output: 'x' }));
    assert.equal(out.onChainStatus, 'Verified');
    assert.match(out.hint, /too short/);
    assert.match(out.hint, /attempt\(s\) left/);
  });
});

// Review of #63: two predictable on-chain reverts that would have been mined
// and paid for (explicit gasLimit skips estimateGas), plus a silent hex parse.
describe('complete_task refuses predictable reverts before spending gas', () => {
  test('Assigned task past its deadline → DEADLINE_REACHED, no /submit, no broadcast', async () => {
    const h = harness({ status: 1, deadline: PAST });
    const out = parse(await h.tools.complete_task({ task: HASH, output: 'late' }));
    assert.equal(out.error?.code ?? out.code, 'DEADLINE_REACHED');
    assert.ok(!h.calls.some((c) => c.path.endsWith('/submit')), 'never asks the backend to build the tx');
    assert.equal(h.sentTxs.length, 0);
  });

  test('0G: backend built the tx for a different wallet → WALLET_MISMATCH, nothing sent', async () => {
    const h = harness({ status: 1, submitFrom: '0x' + '99'.repeat(20) });
    const out = parse(await h.tools.complete_task({ task: HASH, output: 'done' }));
    assert.equal(out.error?.code ?? out.code, 'WALLET_MISMATCH');
    assert.equal(h.sentTxs.length, 0, 'the onlyWorker revert is refused locally');
  });

  test('0G: matching from address still signs locally', async () => {
    const h = harness({ status: 1, submitFrom: '0x' + '11'.repeat(20) });
    const out = parse(await h.tools.complete_task({ task: HASH, output: 'done' }));
    assert.equal(h.sentTxs.length, 1);
    assert.equal(out.onChainStatus ?? out.data?.onChainStatus, 'Completed');
  });
});

describe('fetch_brief validates the wrapped key before any round-trip', () => {
  test('0x-prefixed but truncated blob → INVALID_WRAPPED_KEY, storage never fetched', async () => {
    const h = harness({ status: 1 });
    const out = parse(await h.tools.fetch_brief({ rootHash: '0x' + 'cd'.repeat(32), wrappedKey: '0x04abcd' }));
    assert.equal(out.error?.code ?? out.code, 'INVALID_WRAPPED_KEY');
    assert.ok(!h.calls.some((c) => c.path.startsWith('/api/v1/storage/')), 'rejected before the storage GET');
  });

  test('non-hex characters → INVALID_WRAPPED_KEY', async () => {
    const h = harness({ status: 1 });
    const out = parse(await h.tools.fetch_brief({ rootHash: '0x' + 'cd'.repeat(32), wrappedKey: 'zz'.repeat(100) }));
    assert.equal(out.error?.code ?? out.code, 'INVALID_WRAPPED_KEY');
  });
});
