import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';

/**
 * register_as_executor and create_agent declare the chain this process
 * settles on only if index.ts hands them the settlement resolver. That wiring
 * is invisible to unit tests, so this launches the built server over stdio,
 * as a client does, against a stub backend and records what /a2a/register
 * receives.
 */

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const PK = '0x' + '22'.repeat(32);
const OWNER = new Wallet(PK);
const PUB = OWNER.signingKey.publicKey.slice(2);

const BRIDGES = {
  // This branch's backend: posts on Base.
  chainAware: {
    configured: false, escrowAddress: '0x037529B296a89E6Dd1abAF84D413cb2dD70C5be5', chainId: 16602, base: null, postingChain: 'base',
    chains: [
      { chain: '0g', chainId: 16602, escrowAddress: '0x037529B296a89E6Dd1abAF84D413cb2dD70C5be5', token: { kind: 'native', address: '0x' + '0'.repeat(40), symbol: '0G', decimals: 18 }, relayChain: null, postable: false },
      { chain: 'base', chainId: 84532, escrowAddress: '0xa1F75b5eC92f4485d4EeFa339DC2B8aF25Df0eC5', token: { kind: 'erc20', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', symbol: 'USDC', decimals: 6 }, relayChain: 'base-sepolia', postable: true },
    ],
  },
  down: null,
};

let kind;
let registered;
let srv;
let apiBase;

before(async () => {
  srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const ok = (data) => res.end(JSON.stringify({ success: true, data }));
      if (req.url === '/health/bridge') {
        if (!BRIDGES[kind]) { res.statusCode = 503; return res.end(JSON.stringify({ success: false, error: { code: 'DOWN', message: 'down' } })); }
        return ok(BRIDGES[kind]);
      }
      if (req.url === '/api/v1/api-keys/whoami') return ok({ address: OWNER.address.toLowerCase() });
      if (req.url === '/api/v1/a2a/register') {
        registered.push(JSON.parse(body));
        return ok({ agent: { address: OWNER.address.toLowerCase(), displayName: 'x' } });
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: req.url } }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${srv.address().port}`;
});

after(() => srv.close());

/** Launch the server, call both tools, and return their replies by id. */
function callBoth() {
  return new Promise((resolve, reject) => {
    const home = mkdtempSync(join(tmpdir(), 'bm-mcp-home-'));
    const child = spawn('node', [ENTRY], {
      env: { PATH: process.env.PATH, HOME: home, BLINDMARKET_API_BASE: apiBase, BLINDMARKET_API_KEY: 'sk_test', BLINDMARKET_STATE_DIR: home, BLINDMARKET_PRIVATE_KEY: PK },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const replies = {};
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no replies in time; got ${JSON.stringify(replies)}`)); }, 20_000);
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n').filter(Boolean)) {
        try { const m = JSON.parse(line); if (m.id) replies[m.id] = m; } catch { /* partial line */ }
      }
      if (replies[2] && replies[3]) { clearTimeout(timer); child.kill(); resolve(replies); }
    });
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'register_as_executor', arguments: { displayName: 'x', capabilities: 'code_review', publicKey: PUB } } });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_agent', arguments: { displayName: 'y', capabilities: 'code_review' } } });
  });
}

test('both registration tools declare the settlement chain in the real process', async () => {
  kind = 'chainAware';
  registered = [];
  const replies = await callBoth();
  assert.notEqual(replies[2].result.isError, true, replies[2].result.content[0].text);
  assert.notEqual(replies[3].result.isError, true, replies[3].result.content[0].text);
  assert.deepEqual(registered.map((b) => b.supportedChains), [['base'], ['base']]);
});

test('with the settlement unknown, nothing is registered', async () => {
  kind = 'down';
  registered = [];
  const replies = await callBoth();
  for (const id of [2, 3]) {
    assert.equal(replies[id].result.isError, true);
    assert.equal(JSON.parse(replies[id].result.content[0].text).error.code, 'SETTLEMENT_UNKNOWN');
  }
  assert.deepEqual(registered, []);
});
