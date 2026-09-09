import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Stdio smoke test — the failure mode that actually breaks MCP servers.
 *
 * This exists because of a real bug that shipped: loadConfig() called
 * process.exit(1) when BLINDMARKET_API_KEY was unset. That type-checks
 * perfectly, so CI (which only ran `tsc`) was green the whole time. MCP clients
 * launch a stdio server with a BARE ENVIRONMENT and do not surface its stderr,
 * so every user who added the server without setting a key first saw only:
 *
 *   ✘ Failed to connect — CONNECTION_CLOSED: Connection closed
 *
 * No unit test would have caught it either. What catches it is launching the
 * built server the way a client does and speaking the protocol at it.
 *
 * The stdout assertion matters as much as the handshake: stdout belongs to the
 * JSON-RPC transport, and a single stray console.log corrupts the stream and
 * breaks every client silently.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, '..', 'dist', 'index.js');
const PKG = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf-8'));

/** Launch the server, send requests, collect replies. `env` is the FULL env. */
function session(env, requests, settleMs = 1500) {
  return new Promise((resolve) => {
    const child = spawn('node', [ENTRY], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    requests.forEach((req, i) => {
      setTimeout(() => child.stdin.write(JSON.stringify(req) + '\n'), 120 * (i + 1));
    });

    setTimeout(() => {
      child.kill();
      const replies = [], junk = [];
      for (const line of out.split('\n').filter(Boolean)) {
        try { replies.push(JSON.parse(line)); } catch { junk.push(line); }
      }
      resolve({ replies, junk, err });
    }, settleMs);
  });
}

const HANDSHAKE = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'smoke', version: '1.0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
];

// A bare environment, as a client provides. PATH only, so node itself resolves.
const BARE = { PATH: process.env.PATH };

test('starts and completes the handshake with NO API key in the environment', async () => {
  const { replies } = await session(BARE, HANDSHAKE);
  const init = replies.find((m) => m.id === 1);
  assert.ok(init, 'server sent no initialize reply — it likely exited on startup');
  assert.ok(init.result, `initialize failed: ${JSON.stringify(init.error)}`);
});

test('lists its tools with NO API key', async () => {
  const { replies } = await session(BARE, HANDSHAKE);
  const list = replies.find((m) => m.id === 2);
  assert.ok(list?.result?.tools?.length > 0, 'tools/list returned nothing');
});

test('stdout carries ONLY JSON-RPC — a stray log corrupts the transport', async () => {
  const { junk } = await session(BARE, HANDSHAKE);
  assert.equal(junk.length, 0, `non-JSON on stdout would break every client: ${junk[0]}`);
});

test('explains the missing key on stderr, where it cannot corrupt the stream', async () => {
  const { err } = await session(BARE, HANDSHAKE);
  assert.match(err, /BLINDMARKET_API_KEY/, 'no explanation of the missing key');
});

test('still works when an API key IS provided', async () => {
  const { replies, junk } = await session(
    { ...BARE, BLINDMARKET_API_KEY: 'sk_smoke_test' }, HANDSHAKE);
  assert.ok(replies.find((m) => m.id === 1)?.result, 'handshake failed with a key set');
  assert.ok(replies.find((m) => m.id === 2)?.result?.tools?.length > 0, 'no tools with a key set');
  assert.equal(junk.length, 0, 'non-JSON on stdout with a key set');
});

test('reports the package version, not a hard-coded one', async () => {
  const { replies } = await session(BARE, HANDSHAKE);
  const info = replies.find((m) => m.id === 1)?.result?.serverInfo;
  assert.equal(info?.version, PKG.version,
    `serverInfo.version ${info?.version} != package.json ${PKG.version}`);
});

test('every tool schema is shaped for strict clients', async () => {
  const { replies } = await session(BARE, HANDSHAKE);
  const tools = replies.find((m) => m.id === 2).result.tools;
  // OpenAI/Codex reject names outside this set, and cannot resolve $ref.
  for (const t of tools) {
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/, `bad tool name: ${t.name}`);
    assert.ok(t.description, `${t.name} has no description`);
    assert.equal(t.inputSchema?.type, 'object', `${t.name} inputSchema is not an object`);
    const s = JSON.stringify(t.inputSchema);
    assert.ok(!s.includes('"$ref"'), `${t.name} uses $ref`);
    assert.ok(!/"(oneOf|anyOf|allOf)"/.test(s), `${t.name} uses oneOf/anyOf/allOf`);
  }
});
