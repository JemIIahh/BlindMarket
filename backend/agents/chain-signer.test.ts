import { describe, it, expect, vi } from 'vitest';

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

// @ts-expect-error — plain-JS worker, no d.ts
import { pickChain, signerFor, escrowAddressFor, preflightGas } from './worker.js';

/**
 * A deployed agent could accept a Base task and never deliver it: the worker
 * held a single signer bound to the 0G RPC, and a Base submitEvidence — which
 * carried no chainId — was broadcast onto 0G. These pin the chain-selection
 * seams that replace that: the backend names the chain, the worker picks the
 * matching signer, and a wallet with no gas on that chain is refused before
 * the attempt is spent.
 */
const fakeSigner = (balance: bigint | Error, address = '0xabc') => ({
  address,
  provider: { getBalance: async () => { if (balance instanceof Error) throw balance; return balance; } },
});

describe('pickChain — the backend names the chain; anything else is 0G', () => {
  it('maps "base" to base and everything else to 0G', () => {
    expect(pickChain('base')).toBe('base');
    expect(pickChain('0g')).toBe('0g');
    expect(pickChain(undefined)).toBe('0g');   // backend older than the field
    expect(pickChain('solana')).toBe('0g');
  });
});

describe('signerFor — one signer per chain', () => {
  it('returns the signer bound to the requested chain', () => {
    const og = fakeSigner(1n), base = fakeSigner(1n);
    expect(signerFor('0g', { '0g': og, base })).toBe(og);
    expect(signerFor('base', { '0g': og, base })).toBe(base);
  });
  it('returns null when Base is not configured — never falls back to the 0G signer', () => {
    // The regression: falling back would broadcast a Base tx on 0G.
    expect(signerFor('base', { '0g': fakeSigner(1n), base: null })).toBeNull();
  });
});

describe('escrowAddressFor', () => {
  it('routes base to the Base escrow env and 0G to the 0G one', () => {
    // Both env vars are unset in this test process, so both resolve to '';
    // the point is that the two chains read DIFFERENT variables.
    expect(escrowAddressFor('base')).toBe(process.env.AGENT_BASE_ESCROW_ADDRESS ?? '');
    expect(escrowAddressFor('0g')).toBe(process.env.AGENT_ESCROW_ADDRESS ?? '');
  });
});

describe('preflightGas — refuse before spending an attempt', () => {
  it('names the missing Base signer specifically', async () => {
    const why = await preflightGas('base', null);
    expect(why).toMatch(/no base signer/);
    expect(why).toMatch(/BASE_RPC_URL/);
  });
  it('refuses a wallet with zero native balance and says which chain and token', async () => {
    const why = await preflightGas('base', fakeSigner(0n, '0xdead'));
    expect(why).toMatch(/0 ETH on base/);
    expect(why).toMatch(/0xdead/);
    const why0g = await preflightGas('0g', fakeSigner(0n));
    expect(why0g).toMatch(/0 0G on 0g/);
  });
  it('passes a funded wallet', async () => {
    expect(await preflightGas('base', fakeSigner(10n ** 15n))).toBeNull();
  });
  it('does not block on an RPC blip — the broadcast reports the real error', async () => {
    expect(await preflightGas('base', fakeSigner(new Error('ECONNRESET')))).toBeNull();
  });
});
