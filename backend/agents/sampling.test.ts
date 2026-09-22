import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * temperature 0 is sent on task runs only off Anthropic. It was added because
 * open-weight models (Groq gpt-oss) malform tool-call syntax less often with
 * deterministic output; newer Claude models reject sampling parameters, and
 * the tool-syntax failures were never a Claude problem.
 */

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

const ORIGINAL = { ...process.env };
const KEY = '0x' + '11'.repeat(32);

async function samplingFor(env: Record<string, string>) {
  vi.resetModules();
  process.env = { ...ORIGINAL, AGENT_PRIVATE_KEY: KEY, AGENT_ID: 'test-agent', SETTLEMENT_CHAINS_JSON: '', ...env };
  // @ts-expect-error — plain-JS worker, no d.ts
  const { RUN_SAMPLING } = await import('./worker.js');
  return RUN_SAMPLING;
}

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('RUN_SAMPLING', () => {
  it('sends no sampling parameters to Anthropic', async () => {
    expect(await samplingFor({ AGENT_PROVIDER: 'anthropic', AGENT_API_KEY: 'sk-ant-test' })).toEqual({});
  });

  it.each(['groq', 'openai', 'gemini'])('keeps temperature 0 on %s', async (provider) => {
    expect(await samplingFor({ AGENT_PROVIDER: provider, AGENT_API_KEY: 'k' })).toEqual({ temperature: 0 });
  });

  it('keeps temperature 0 on the 0G compute router (no API key), whatever the provider field says', async () => {
    expect(await samplingFor({ AGENT_PROVIDER: 'anthropic', AGENT_API_KEY: '' })).toEqual({ temperature: 0 });
  });
});
