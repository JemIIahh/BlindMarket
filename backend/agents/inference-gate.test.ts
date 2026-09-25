import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * An agent takes work only when it can run its model. /accept assigns a task
 * on-chain and the escrow cannot unassign it before the deadline, so an agent
 * that accepted work it could not think through left the poster's money
 * locked until then. On Sep 25 a 0g-compute agent did exactly that (Arc task
 * 10): its 0G Compute account was never opened, because the worker tried to
 * open it with 1 0G and the SDK refuses anything under 3.
 */

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

const ORIGINAL = { ...process.env };
process.env = { ...ORIGINAL, AGENT_PRIVATE_KEY: '0x' + '11'.repeat(32), AGENT_ID: 'test-agent', SETTLEMENT_CHAINS_JSON: '' };
// @ts-expect-error — plain-JS worker, no d.ts
const { createInferenceGate, ogLedgerPlan, readinessFrom, NOT_CHECKED_YET, OG_LEDGER_OPEN_WEI, OG_SETUP_GAS_RESERVE_WEI } = await import('./worker.js');

afterEach(() => {
  process.env = { ...ORIGINAL };
});

const OG = 10n ** 18n;

describe('0G Compute account setup plan', () => {
  it('opens an account with the 3 0G the SDK requires, not 1', () => {
    expect(OG_LEDGER_OPEN_WEI).toBe(3n * OG);
  });

  it('uses an account that already exists, and never deposits into it again', () => {
    expect(ogLedgerPlan(true, 0n)).toEqual({ action: 'use' });
    expect(ogLedgerPlan(true, 100n * OG)).toEqual({ action: 'use' });
  });

  it('opens one when the wallet covers 3 0G plus gas', () => {
    expect(ogLedgerPlan(false, OG_LEDGER_OPEN_WEI + OG_SETUP_GAS_RESERVE_WEI)).toEqual({ action: 'open' });
    expect(ogLedgerPlan(false, 5n * OG)).toEqual({ action: 'open' });
  });

  it('asks for the shortfall otherwise: the agent that stranded Arc task 10 held 1.6 0G', () => {
    const plan = ogLedgerPlan(false, 16n * 10n ** 17n);
    expect(plan.action).toBe('fund');
    expect(plan.needWei).toBe(31n * 10n ** 17n);
    expect(plan.shortfallWei).toBe(15n * 10n ** 17n);
  });
});

describe('inference gate', () => {
  function gate(probe: () => Promise<string | null>, clock = { t: 0 }) {
    const changes: Array<string | null> = [];
    const g = createInferenceGate({ probe, recheckMs: 1000, now: () => clock.t, onChange: (r: string | null) => changes.push(r) });
    return { g, changes, clock };
  }

  it('takes no work until a check has passed', async () => {
    const { g } = gate(async () => null);
    expect(g.blocker()).toMatch(/not been checked/);
    expect(await g.check()).toBe(true);
    expect(g.blocker()).toBeNull();
  });

  it('keeps the reason a check failed, and does not re-probe a pass', async () => {
    const probe = vi.fn(async () => null as string | null);
    probe.mockResolvedValueOnce('no 0G Compute account yet');
    const { g, changes, clock } = gate(probe);
    expect(await g.check()).toBe(false);
    expect(g.blocker()).toBe('no 0G Compute account yet');
    clock.t = 1000;
    expect(await g.check()).toBe(true);
    expect(await g.check()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(changes).toEqual(['no 0G Compute account yet', null]);
  });

  it('re-probes a failure at most once per recheck window, or at once with force', async () => {
    const probe = vi.fn(async () => 'model id retired' as string | null);
    const { g, clock } = gate(probe);
    await g.check();
    clock.t = 500;
    expect(await g.check()).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    await g.check({ force: true });
    expect(probe).toHaveBeenCalledTimes(2);
    clock.t = 1500;
    await g.check();
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("stops taking work when a task's model call fails, and re-checks at once", async () => {
    const probe = vi.fn(async () => null as string | null);
    const { g } = gate(probe);
    await g.check();
    g.suspect("a task's model call failed: 402 insufficient credit");
    expect(g.blocker()).toMatch(/402/);
    expect(await g.check()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('stays closed when the re-check after a failed task call also fails', async () => {
    const probe = vi.fn(async () => null as string | null);
    const { g } = gate(probe);
    await g.check();
    g.suspect('boom');
    probe.mockResolvedValueOnce('key revoked');
    expect(await g.check()).toBe(false);
    expect(g.blocker()).toBe('key revoked');
  });

  it('runs one probe for concurrent checks', async () => {
    let release!: (v: string | null) => void;
    const probe = vi.fn(() => new Promise<string | null>((r) => { release = r; }));
    const { g } = gate(probe);
    const a = g.check();
    const b = g.check();
    release(null);
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('turns a probe that throws into a reason', async () => {
    const { g } = gate(async () => { throw new Error('RPC down'); });
    expect(await g.check()).toBe(false);
    expect(g.blocker()).toBe('the model check failed: RPC down');
  });
});

// What the heartbeat tells the owner's agent page.
describe('readiness report', () => {
  const fund = { chain: '0g', address: '0x3a38cd7A3321A6716815f7B555F4dA6baDCCBC82', holdsWei: '1600000000000000000', needWei: '3100000000000000000', shortfallWei: '1500000000000000000' };

  it('is ready once a check passed, whatever the setup left behind', () => {
    expect(readinessFrom(null, fund, false)).toEqual({ ready: true, reason: null });
  });

  it('says it is still checking before the first check ends', () => {
    expect(readinessFrom(NOT_CHECKED_YET, fund, false)).toEqual({ ready: false, checking: true, reason: NOT_CHECKED_YET });
  });

  it('names the 0G the wallet needs while the account cannot be opened', () => {
    expect(readinessFrom('no 0G Compute account yet', fund, false)).toEqual({ ready: false, reason: 'no 0G Compute account yet', fund });
  });

  it('asks for no 0G once the account is open, even while a model call is failing', () => {
    expect(readinessFrom("a task's model call failed: 500", fund, true)).toEqual({ ready: false, reason: "a task's model call failed: 500" });
    expect(readinessFrom('key revoked', null, false)).toEqual({ ready: false, reason: 'key revoked' });
  });
});
