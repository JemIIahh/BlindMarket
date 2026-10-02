import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';

/**
 * An xai agent runs Grok through xAI's Responses API with store: false, so
 * xAI keeps no copy of a brief or a result, and a tool loop still works
 * statelessly: the encrypted reasoning comes back on the next step. fetch is
 * stubbed; nothing here reaches xAI.
 */

vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

// Shaped like docs.x.ai's Responses API: a reasoning item carrying its
// encrypted content, then a function call; then the final message.
const CALL = {
  id: 'resp_1', object: 'response', model: 'grok-4.7', status: 'completed',
  output: [
    { type: 'reasoning', id: 'rs_1', summary: [], status: 'completed', encrypted_content: 'enc-reasoning-1' },
    { type: 'function_call', name: 'lookup', arguments: '{"q":"weather"}', call_id: 'call_1', id: 'fc_1' },
  ],
  usage: { input_tokens: 12, output_tokens: 6 },
};
const ANSWER = {
  id: 'resp_2', object: 'response', model: 'grok-4.7', status: 'completed',
  output: [{ type: 'message', role: 'assistant', id: 'msg_1', status: 'completed', content: [{ type: 'output_text', text: 'It is sunny.' }] }],
  usage: { input_tokens: 20, output_tokens: 4 },
};

type Call = { url: string; headers: Record<string, string>; body: Record<string, any> };

function stubXai(...responses: unknown[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return json(responses[calls.length - 1]);
  }));
  return calls;
}

async function loadWorker(env: Record<string, string>) {
  vi.resetModules();
  process.env = { ...ORIGINAL, AGENT_PRIVATE_KEY: '0x' + '11'.repeat(32), AGENT_ID: 'test-agent', SETTLEMENT_CHAINS_JSON: '', ...env };
  // @ts-expect-error — plain-JS worker, no d.ts
  return import('./worker.js');
}

describe('xai model', () => {
  it('getModel() sends an xai agent to api.x.ai/v1/responses with its own key and model, store: false', async () => {
    const { getModel, RUN_SAMPLING } = await loadWorker({ AGENT_PROVIDER: 'xai', AGENT_API_KEY: 'xai-test-key', AGENT_MODEL: 'grok-4.7' });
    const calls = stubXai(ANSWER);
    const { text } = await generateText({ model: getModel(), prompt: 'hi', ...RUN_SAMPLING });
    expect(text).toBe('It is sunny.');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.x.ai/v1/responses');
    expect(calls[0].headers.authorization ?? calls[0].headers.Authorization).toBe('Bearer xai-test-key');
    expect(calls[0].body.model).toBe('grok-4.7');
    expect(calls[0].body.store).toBe(false);
    expect(calls[0].body.include).toContain('reasoning.encrypted_content');
  });

  it('a tool loop carries the encrypted reasoning back, still with store: false', async () => {
    const { xaiModel } = await loadWorker({ AGENT_PROVIDER: 'xai', AGENT_API_KEY: 'xai-test-key', AGENT_MODEL: 'grok-4.7' });
    const calls = stubXai(CALL, ANSWER);
    const lookup = vi.fn(async () => 'sunny');
    const { text } = await generateText({
      model: xaiModel('xai-test-key', 'grok-4.7'),
      prompt: 'weather?',
      tools: { lookup: tool({ description: 'look something up', inputSchema: z.object({ q: z.string() }), execute: lookup }) },
      stopWhen: stepCountIs(3),
    });
    expect(text).toBe('It is sunny.');
    expect(lookup).toHaveBeenCalledWith({ q: 'weather' }, expect.anything());
    expect(calls).toHaveLength(2);
    expect(calls[0].body.tools).toEqual([expect.objectContaining({ type: 'function', name: 'lookup' })]);
    expect(calls[1].body.store).toBe(false);
    expect(calls[1].body.previous_response_id).toBeUndefined();
    expect(calls[1].body.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning', encrypted_content: 'enc-reasoning-1' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
    ]));
  });

  it('keeps the other providers where they were', async () => {
    const { getModel } = await loadWorker({ AGENT_PROVIDER: 'groq', AGENT_API_KEY: 'gsk-test', AGENT_MODEL: 'openai/gpt-oss-120b' });
    expect(getModel().provider).toMatch(/^groq/);
  });
});
