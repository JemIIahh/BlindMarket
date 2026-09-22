import { describe, it, expect, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { aesDecrypt, eciesEncrypt, generateAesKey } from '../src/services/crypto.js';

/**
 * A finished result goes to 0G Storage, whose blobs anyone can fetch by root
 * hash (the task page shows it). The worker used to upload every result as
 * plaintext, so a private task's result was public. It is now sealed with the
 * task's own AES key, which only the poster and the assigned executor hold.
 */

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

const ORIGINAL = { ...process.env };
const executor = ethers.Wallet.createRandom();
const executorPubKey = executor.signingKey.publicKey.slice(2); // 04… uncompressed, no 0x

async function loadSeal() {
  vi.resetModules();
  process.env = { ...ORIGINAL, AGENT_PRIVATE_KEY: executor.privateKey, AGENT_ID: 'test-agent', SETTLEMENT_CHAINS_JSON: '' };
  // @ts-expect-error — plain-JS worker, no d.ts
  const { sealResultForStorage } = await import('./worker.js');
  return sealResultForStorage as (output: string, o: { isPublicTask: boolean; wrappedKeyHex?: string | null; privateKey?: string | null }) => Buffer | null;
}

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('sealResultForStorage', () => {
  it("seals a private task's result so only the task key opens it", async () => {
    const seal = await loadSeal();
    const taskKey = generateAesKey();
    const wrappedKeyHex = eciesEncrypt(taskKey, executorPubKey).toString('hex');

    const stored = seal('the private deliverable', { isPublicTask: false, wrappedKeyHex, privateKey: executor.privateKey });
    expect(stored).not.toBeNull();
    expect(stored!.toString('utf8')).not.toContain('private deliverable');
    expect(aesDecrypt(stored!, taskKey).toString('utf8')).toBe('the private deliverable');
    expect(() => aesDecrypt(stored!, generateAesKey())).toThrow();
  });

  it("stores a public task's result as-is", async () => {
    const seal = await loadSeal();
    expect(seal('public output', { isPublicTask: true })!.toString('utf8')).toBe('public output');
  });

  it('refuses to store a private result it has no task key to seal', async () => {
    const seal = await loadSeal();
    expect(seal('private output', { isPublicTask: false, wrappedKeyHex: null, privateKey: executor.privateKey })).toBeNull();
    expect(seal('private output', { isPublicTask: false, wrappedKeyHex: 'aa', privateKey: null })).toBeNull();
  });
});
