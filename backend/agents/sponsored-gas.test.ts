import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

// @ts-expect-error — plain-JS worker, no d.ts
import { pickAffordable, DELEGATE_CALL_TYPES, DELEGATE_KIND, delegateCallDomain, signDelegateAuthorization, awaitSponsoredOutcome, isSponsoredCallOut } from './worker.js';
import { CALL_TYPES, DelegateKind, callDomain, callSigner } from '../src/services/blindAgentDelegate.js';
import { signAuthorization, authorizationSigner } from '../src/services/eip7702.js';

/**
 * Sponsored gas, worker side (docs/AGENT-GAS-FUNDING.md). The worker signs
 * what the backend's relayer checks, with its own copy of the EIP-712 types
 * and the 7702 authorization encoding (it does not import src/). These pin
 * the two copies together, and the gas gate a sponsored hint skips.
 */

const wallet = ethers.Wallet.createRandom();
const DELEGATE = '0x' + 'de'.repeat(20);
const ESCROW = '0x' + 'e5'.repeat(20);
const ARC = 5042002;

describe('pickAffordable with a sponsored hint', () => {
  const entry = (taskId: string, gasSponsored?: boolean) => ({ meta: { taskId, chain: 'arc', ...(gasSponsored == null ? {} : { gasSponsored }) } });

  it("takes a hinted Arc task without asking about the wallet's gas, and still gates the rest", async () => {
    const problemFor = vi.fn(async () => 'wallet holds 0 USDC on arc');
    const { affordable, skipped } = await pickAffordable([entry('0xs1', true), entry('0xa1'), entry('0xa2', false)], problemFor);
    expect(affordable.map((e: any) => e.meta.taskId)).toEqual(['0xs1']);
    expect(skipped.map((s: any) => s.taskHash)).toEqual(['0xa1', '0xa2']);
    expect(problemFor).toHaveBeenCalledTimes(2);
  });

  it('only a literal true counts as a hint', async () => {
    const problemFor = vi.fn(async () => 'no gas');
    const { affordable } = await pickAffordable([{ meta: { taskId: '0xs1', chain: 'arc', gasSponsored: 'true' } }], problemFor);
    expect(affordable).toEqual([]);
  });
});

describe('the signed call', () => {
  it('uses the same EIP-712 types, kinds and domain as the backend', () => {
    expect(DELEGATE_CALL_TYPES).toEqual(CALL_TYPES);
    expect(DELEGATE_KIND).toEqual({ submit: DelegateKind.SubmitEvidence, release: DelegateKind.ReleaseUnjudgedWork });
    expect(delegateCallDomain(ARC, wallet.address.toLowerCase())).toEqual(callDomain(ARC, wallet.address));
  });

  it("is a signature the relayer recovers to the agent's wallet", async () => {
    const call = { kind: DELEGATE_KIND.submit, taskId: 41n, evidenceHash: ethers.id('evidence'), nonce: 0n, deadline: 2_000_000_000n };
    const signature = await wallet.signTypedData(delegateCallDomain(ARC, wallet.address), DELEGATE_CALL_TYPES, { ...call, escrow: ESCROW });
    expect(callSigner(ARC, wallet.address, ESCROW, call, signature)).toBe(wallet.address);
    // Bound to the escrow and the chain: either changed, it recovers to someone else.
    expect(callSigner(ARC, wallet.address, '0x' + 'e6'.repeat(20), call, signature)).not.toBe(wallet.address);
    expect(callSigner(ARC + 1, wallet.address, ESCROW, call, signature)).not.toBe(wallet.address);
  });
});

describe('signDelegateAuthorization', () => {
  it("is byte-for-byte the backend's authorization, recovering to the wallet", () => {
    const auth = { chainId: BigInt(ARC), address: DELEGATE, nonce: 7n };
    const mine = signDelegateAuthorization(wallet.signingKey, { chainId: ARC, address: DELEGATE, nonce: 7 });
    expect(mine).toEqual(signAuthorization(wallet.signingKey, auth));
    expect(authorizationSigner(mine)).toBe(wallet.address);
  });

  it('encodes a zero nonce the way the backend does', () => {
    const mine = signDelegateAuthorization(wallet.signingKey, { chainId: ARC, address: DELEGATE, nonce: 0 });
    expect(mine).toEqual(signAuthorization(wallet.signingKey, { chainId: BigInt(ARC), address: DELEGATE, nonce: 0n }));
  });

  it('refuses chain id 0, which every chain would accept', () => {
    expect(() => signDelegateAuthorization(wallet.signingKey, { chainId: 0, address: DELEGATE, nonce: 0 })).toThrow(/chain-id-0/);
  });
});

describe('a sponsored call that is out blocks fallback and release', () => {
  const statuses = (...list: Array<string | Error>) => {
    let i = 0;
    return async () => {
      const next = list[Math.min(i++, list.length - 1)];
      if (next instanceof Error) throw next;
      return { status: next };
    };
  };
  const clock = (start = 1_000) => { let t = start; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

  it('holds the task while pending, and lets it go once the call lands', async () => {
    const c = clock();
    const out = await awaitSponsoredOutcome('0xt1', {
      getStatus: statuses('pending', 'pending'), chainNowSec: async () => 100n, maxWaitMs: 30_000, pollMs: 10_000, sleepFn: c.sleep, nowMs: c.now,
    });
    expect(out).toBe('pending');
    expect(isSponsoredCallOut('0xt1')).toBe(true); // releaseTask leaves it
    expect(await awaitSponsoredOutcome('0xt1', { getStatus: statuses('confirmed'), chainNowSec: async () => 100n })).toBe('landed');
    expect(isSponsoredCallOut('0xt1')).toBe(false);
  });

  it('waits through an unreadable status rather than falling back', async () => {
    const c = clock();
    const out = await awaitSponsoredOutcome('0xt2', {
      getStatus: statuses(new Error('backend down'), 'pending', 'confirmed'), chainNowSec: async () => 100n, pollMs: 1_000, sleepFn: c.sleep, nowMs: c.now,
    });
    expect(out).toBe('landed');
  });

  it('stops waiting at the deadline margin, still holding', async () => {
    let chain = 900n;
    const c = clock();
    const out = await awaitSponsoredOutcome('0xt3', {
      getStatus: statuses('pending'), chainNowSec: async () => (chain += 50n), untilSec: 1_000n, pollMs: 1_000, sleepFn: c.sleep, nowMs: c.now,
    });
    expect(out).toBe('pending');
    expect(isSponsoredCallOut('0xt3')).toBe(true);
  });

  it('releases the hold when the call failed for good, or nothing of ours is out', async () => {
    await awaitSponsoredOutcome('0xt4', { getStatus: statuses('pending'), chainNowSec: async () => 0n, maxWaitMs: 0 });
    expect(isSponsoredCallOut('0xt4')).toBe(true);
    expect(await awaitSponsoredOutcome('0xt4', { getStatus: statuses('failed'), chainNowSec: async () => 0n })).toBe('failed');
    expect(isSponsoredCallOut('0xt4')).toBe(false);
    expect(await awaitSponsoredOutcome('0xt5', { getStatus: statuses('none'), chainNowSec: async () => 0n })).toBe('none');
  });
});
