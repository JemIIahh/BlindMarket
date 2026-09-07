/**
 * Regression + wiring tests for the `js` agent-tool branch in worker.js.
 *
 * Plan 012 replaced `vm.runInNewContext` (Node explicitly documents `vm` as
 * NOT a security boundary — the standard constructor.constructor escape
 * reaches the real `process`) with routing through the existing Railway
 * sandbox transport (`POST /api/v1/sandbox/exec`) — the same transport the
 * `sandbox` tool type already uses.
 *
 * These tests stub `fetch` and prove the WIRING and the ENCODING: no shell
 * interpolation of user code/input, the old `{ result } / { error }` return
 * shape is preserved, and the sandbox-unavailable case surfaces an
 * actionable message. They do NOT and CANNOT prove a real Railway container
 * runs the code — no RAILWAY_API_TOKEN is configured in this environment.
 * End-to-end execution is NOT VERIFIED by this file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing worker internals (mirrors tools.test.ts)
vi.mock('ai', () => ({
  tool: (def) => def,
  generateText: vi.fn(),
  generateObject: vi.fn(),
  stepCountIs: (n) => n,
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => () => 'mock-model',
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => () => 'mock-model',
}));

vi.mock('@ai-sdk/groq', () => ({
  createGroq: () => () => 'mock-model',
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: () => () => 'mock-model',
}));

vi.mock('../src/services/crypto.js', () => ({
  decryptSensitive: (val) => val,
}));

// Set env vars the worker expects. NODE_ENV=test keeps the imported module
// from auto-starting its poll loop (see worker.js's `if (process.env.NODE_ENV
// !== 'test')` guard).
//
// worker.js parses AGENT_TOOLS into its module-level `agentTools` array ONCE
// at import time (`let agentTools = []; try { agentTools = JSON.parse(...) }`)
// — buildTools() just re-reads that array, it does not re-parse
// process.env.AGENT_TOOLS on every call. So every js-tool this file needs
// must be registered here, before the dynamic import below; mutating
// process.env.AGENT_TOOLS from inside a test has no effect on buildTools().
process.env.AGENT_ID = 'test-agent';
process.env.AGENT_API_KEY = 'test-key';
process.env.AGENT_MODEL = 'gpt-4o';
process.env.AGENT_PROVIDER = 'openai';
process.env.AGENT_PRIVATE_KEY = '0x' + '11'.repeat(32);
process.env.AGENT_INSTRUCTIONS = 'You are a test agent.';
process.env.NODE_ENV = 'test';
process.env.AGENT_CAPABILITIES = '[]';
process.env.BACKEND_URL = 'http://backend.test';
process.env.AGENT_PLATFORM_TOKEN = 'test-platform-token';

const DANGEROUS_INPUT = "'; rm -rf /; echo '";
const DANGEROUS_CODE = "return input + '; rm -rf /; echo done';";

process.env.AGENT_TOOLS = JSON.stringify([
  { type: 'js', name: 'echo_upper', description: 'Uppercase the input', code: 'return input.toUpperCase();' },
  { type: 'js', name: 'danger_tool', description: 'shell-metachar tool', code: DANGEROUS_CODE },
  { type: 'js', name: 'throws_tool', description: 'always throws', code: "throw new Error('boom');" },
]);

// Dynamic import so env vars are set before module loads (mirrors tools.test.ts)
const { buildTools, JS_TOOL_SENTINEL } = await import('./worker.js');

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

/** Simulates what the sandbox wrapper script itself would write to stdout,
 *  given the SAME code/input the real worker.js branch would have
 *  base64-encoded and shipped to the sandbox. Independent of worker.js's own
 *  parsing logic (which is what these tests actually exercise), so it
 *  doubles as a reference implementation of the wrapper's documented
 *  contract: `SENTINEL + JSON.stringify({ ok, result | error })`. */
function simulateWrapperStdout(code, input, { prelude = '' } = {}) {
  let payload;
  try {
    const fn = new Function('input', code);
    const result = fn(input);
    payload = JSON.stringify({ ok: true, result });
  } catch (e) {
    payload = JSON.stringify({ ok: false, error: e.message });
  }
  return prelude + JS_TOOL_SENTINEL + payload;
}

describe('js tool branch (routed through the Railway sandbox)', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. regression: invoking a js tool no longer evals in-process — it POSTs to /api/v1/sandbox/exec (fails on main, which never calls fetch for `js`)', async () => {
    const tools = buildTools();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { stdout: simulateWrapperStdout('return input.toUpperCase();', 'hello'), stderr: '', exitCode: 0 },
      }),
    );

    const result = await tools.echo_upper.execute({ input: 'hello' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://backend.test/api/v1/sandbox/exec');
    expect(opts.method).toBe('POST');
    expect(result).toEqual({ result: 'HELLO' });
  });

  it('2. shell metacharacters in code and input round-trip intact via base64 — never interpolated raw into the shell string', async () => {
    const tools = buildTools();

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { stdout: simulateWrapperStdout(DANGEROUS_CODE, DANGEROUS_INPUT), stderr: '', exitCode: 0 },
      }),
    );

    const result = await tools.danger_tool.execute({ input: DANGEROUS_INPUT });

    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);

    // The raw dangerous substrings must never appear directly in the shell
    // string sent as `setup`/`command` — only their base64 encodings should.
    expect(body.setup).not.toContain(DANGEROUS_INPUT);
    expect(body.setup).not.toContain('rm -rf /');
    expect(body.command).not.toContain(DANGEROUS_INPUT);
    expect(body.command).not.toContain('rm -rf /');
    expect(body.setup).toContain(Buffer.from(DANGEROUS_CODE, 'utf8').toString('base64'));
    expect(body.setup).toContain(Buffer.from(DANGEROUS_INPUT, 'utf8').toString('base64'));

    // And the value still round-trips correctly end-to-end (simulated sandbox).
    expect(result).toEqual({ result: DANGEROUS_INPUT + '; rm -rf /; echo done' });
  });

  it('3. a clean success response yields { result } matching the old shape (no costMicroUnits/durationSeconds leaking through)', async () => {
    const tools = buildTools();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          stdout: simulateWrapperStdout('return input.toUpperCase();', 'abc'),
          stderr: '',
          exitCode: 0,
          durationSeconds: 3,
          costMicroUnits: 42,
        },
      }),
    );

    const result = await tools.echo_upper.execute({ input: 'abc' });
    expect(result).toEqual({ result: 'ABC' });
    expect(result).not.toHaveProperty('costMicroUnits');
    expect(result).not.toHaveProperty('durationSeconds');
  });

  it('4. a non-zero exitCode yields { error }, not a thrown exception', async () => {
    const tools = buildTools();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { stdout: '', stderr: 'node: command not found', exitCode: 127 },
      }),
    );

    const result = await tools.echo_upper.execute({ input: 'abc' });
    expect(result).toEqual({ error: 'node: command not found' });
  });

  it('5. a 503 SANDBOX_UNAVAILABLE response yields the actionable error message', async () => {
    const tools = buildTools();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({
        success: false,
        error: { code: 'SANDBOX_UNAVAILABLE', message: 'Railway sandboxes not configured' },
      }),
    });

    const result = await tools.echo_upper.execute({ input: 'abc' });
    expect(result).toEqual({ error: 'js tools require the sandbox; it is not configured' });
  });

  it('6. user code that console.log()s AND returns a value still parses correctly (sentinel case)', async () => {
    const tools = buildTools();
    const stdout = simulateWrapperStdout('return input.toUpperCase();', 'noisy', {
      prelude: 'some debug output\nmore debug output\n',
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { stdout, stderr: '', exitCode: 0 } }),
    );

    const result = await tools.echo_upper.execute({ input: 'noisy' });
    expect(result).toEqual({ result: 'NOISY' });
  });

  it('7. a thrown error inside the user code surfaces as { error } via the sentinel, not the exit code', async () => {
    const tools = buildTools();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { stdout: simulateWrapperStdout("throw new Error('boom');", 'x'), stderr: '', exitCode: 0 },
      }),
    );

    const result = await tools.throws_tool.execute({ input: 'x' });
    expect(result).toEqual({ error: 'boom' });
  });

  it('8. the js tool uses t.timeout ?? 30 (NOT the sandbox branch\'s 300s default) as timeoutSeconds', async () => {
    const tools = buildTools();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { stdout: simulateWrapperStdout('return input.toUpperCase();', 'abc'), stderr: '', exitCode: 0 },
      }),
    );

    await tools.echo_upper.execute({ input: 'abc' });

    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.timeoutSeconds).toBe(30);
  });
});
