import { describe, it, expect, vi } from 'vitest';

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

// @ts-expect-error — plain-JS worker, no d.ts
import { pickChain, isUnsupportedChain, signerFor, escrowAddressFor, preflightGas, pickAffordable, acceptBlocker, registrationBody } from './worker.js';

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

describe('pickChain — the backend names the chain; a missing one is 0G', () => {
  it('returns the chains this worker signs for', () => {
    expect(pickChain('base')).toBe('base');
    expect(pickChain('0g')).toBe('0g');
  });
  it('treats a missing chain as 0G (tasks indexed before the field existed)', () => {
    expect(pickChain(undefined)).toBe('0g');
    expect(pickChain(null)).toBe('0g');
  });
  it.each(['solana', '', 'og', 'BASE', 84532])(
    'throws on %j instead of signing it with the 0G key',
    (chain) => {
      expect(() => pickChain(chain)).toThrow(/not supported by this worker/);
    },
  );
});

describe('registrationBody', () => {
  it('declares every chain this code can sign for, whatever the deployment configures', () => {
    const body = registrationBody({ displayName: 'w', capabilities: [], publicKey: '04ab', minReward: ' 5 ' });
    expect(body).toEqual({ displayName: 'w', capabilities: [], publicKey: '04ab', minReward: '5', supportedChains: ['0g', 'base', 'arc'] });
    // The chains it declares are exactly the ones pickChain accepts.
    for (const chain of body.supportedChains) expect(isUnsupportedChain(chain)).toBe(false);
  });

  it('declares only sui for a Sui-keyed worker, which has no EVM signer', () => {
    expect(registrationBody({ displayName: 'w', capabilities: [], publicKey: '04ab', sui: true }).supportedChains).toEqual(['sui']);
  });

  it('leaves out a blank minimum reward', () => {
    expect(registrationBody({ displayName: 'w', capabilities: [], publicKey: '04ab', minReward: '  ' }).minReward).toBeUndefined();
    expect(registrationBody({ displayName: 'w', capabilities: [], publicKey: '04ab' }).minReward).toBeUndefined();
  });
});

describe('isUnsupportedChain', () => {
  it('flags only a present, unknown chain', () => {
    expect(isUnsupportedChain('solana')).toBe(true);
    expect(isUnsupportedChain('')).toBe(true);
    expect(isUnsupportedChain('base')).toBe(false);
    expect(isUnsupportedChain('0g')).toBe(false);
    expect(isUnsupportedChain(undefined)).toBe(false);
    expect(isUnsupportedChain(null)).toBe(false);
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
  it('never hands out the 0G signer for an unknown chain', () => {
    expect(() => signerFor('solana', { '0g': fakeSigner(1n), base: fakeSigner(1n) })).toThrow();
  });
});

describe('escrowAddressFor', () => {
  it('routes base to the Base escrow env and 0G to the 0G one', () => {
    // Both env vars are unset in this test process, so both resolve to '';
    // the point is that the two chains read DIFFERENT variables.
    expect(escrowAddressFor('base')).toBe(process.env.AGENT_BASE_ESCROW_ADDRESS ?? '');
    expect(escrowAddressFor('0g')).toBe(process.env.AGENT_ESCROW_ADDRESS ?? '');
  });
  it('never returns the 0G escrow for an unknown chain', () => {
    expect(() => escrowAddressFor('solana')).toThrow();
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

describe('pickAffordable', () => {
  const entry = (taskId: string, chain?: string) => ({ meta: chain ? { taskId, chain } : { taskId } });

  it('drops tasks on a chain the wallet cannot pay gas on and keeps the rest', async () => {
    const problemFor = async (chain: string) => (chain === 'base' ? 'wallet holds 0 ETH on base' : null);
    const { affordable, skipped } = await pickAffordable(
      [entry('0xb1', 'base'), entry('0xo1', '0g'), entry('0xb2', 'base')],
      problemFor,
    );
    expect(affordable.map((e: any) => e.meta.taskId)).toEqual(['0xo1']);
    expect(skipped).toEqual([
      { taskHash: '0xb1', chain: 'base', reason: 'wallet holds 0 ETH on base', unsupported: false },
      { taskHash: '0xb2', chain: 'base', reason: 'wallet holds 0 ETH on base', unsupported: false },
    ]);
  });

  it('keeps tasks with no chain (legacy rows) for the post-accept check', async () => {
    const problemFor = async () => 'no signer';
    const { affordable, skipped } = await pickAffordable([entry('0xlegacy')], problemFor);
    expect(affordable).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  it('skips a chain this worker cannot sign for, without asking about gas', async () => {
    // Accepting assigns the task on-chain, so this has to happen before accept.
    const problemFor = vi.fn(async (_chain: string) => null);
    const { affordable, skipped } = await pickAffordable([entry('0xa1', 'solana'), entry('0xo1', '0g')], problemFor);
    expect(affordable.map((e: any) => e.meta.taskId)).toEqual(['0xo1']);
    expect(skipped).toEqual([
      { taskHash: '0xa1', chain: 'solana', reason: expect.stringMatching(/"solana" is not supported/), unsupported: true },
    ]);
    expect(problemFor).toHaveBeenCalledTimes(1);
    expect(problemFor).toHaveBeenCalledWith('0g');
  });
});

describe('acceptBlocker — the gate every accept path runs first', () => {
  it('refuses an unsupported chain without asking about gas, and marks it so it cannot speed up the feed scan', async () => {
    const problemFor = vi.fn(async (_chain: string) => null);
    expect(await acceptBlocker('solana', problemFor)).toEqual({
      reason: expect.stringMatching(/"solana" is not supported/),
      unsupported: true,
    });
    expect(problemFor).not.toHaveBeenCalled();
  });

  it('refuses a known chain with a gas problem, as a gas skip', async () => {
    const problemFor = vi.fn(async (_chain: string) => 'wallet holds 0 ETH on base');
    expect(await acceptBlocker('base', problemFor)).toEqual({ reason: 'wallet holds 0 ETH on base', unsupported: false });
    expect(problemFor).toHaveBeenCalledWith('base');
  });

  it('lets a funded known chain through, and a missing chain through to the post-accept check', async () => {
    const problemFor = vi.fn(async (_chain: string) => null);
    expect(await acceptBlocker('0g', problemFor)).toBeNull();
    expect(await acceptBlocker(undefined, problemFor)).toBeNull();
    expect(problemFor).toHaveBeenCalledTimes(1);
  });

  it('must run before preflightGas, which rejects an unsupported chain', async () => {
    // gasGateBroadcast and resume wrap preflightGas in .catch(() => null), so
    // without the gate this rejection would read as "no gas problem".
    await expect(preflightGas('solana', null)).rejects.toThrow(/not supported/);
  });
});
