/**
 * batchCreateSupport caches MAX_BATCH() per chain and escrow: a "yes" for 10
 * minutes, a "no" for 1 (an escrow upgrade shows within a minute), and a
 * request never waits more than 2 s on the RPC.
 *
 * Run: npx vitest run src/services/batchSupport.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { chain, cfg } = vi.hoisted(() => ({
  chain: { baseEscrow: {} as Record<string, unknown>, arcEscrow: null as Record<string, unknown> | null },
  cfg: {} as Record<string, unknown>,
}));
vi.mock('./chain.js', () => chain);
vi.mock('../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../config.js')>();
  Object.assign(cfg, mod.config);
  return { ...mod, config: cfg };
});

const { batchCreateSupport, openCreateSupport, _resetBatchCreateSupportCache } = await import('./batchSupport.js');

const BASE_ESCROW = '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf';
const OTHER_ESCROW = '0x00000000000000000000000000000000000e5c00';
const revert = () => Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });

let maxBatch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  _resetBatchCreateSupportCache();
  maxBatch = vi.fn(async () => 50n);
  chain.baseEscrow = { MAX_BATCH: maxBatch };
  Object.assign(cfg, { baseChainId: 84532, baseEscrowAddress: BASE_ESCROW, arcEscrowAddress: '' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('batchCreateSupport', () => {
  it('keeps a "yes" for ten minutes', async () => {
    expect(await batchCreateSupport('base')).toEqual({ supported: true, maxBatch: 50 });
    vi.advanceTimersByTime(9 * 60_000);
    await batchCreateSupport('base');
    expect(maxBatch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * 60_000);
    await batchCreateSupport('base');
    expect(maxBatch).toHaveBeenCalledTimes(2);
  });

  it('asks again a minute after a "no", and sees the upgraded escrow', async () => {
    maxBatch.mockRejectedValueOnce(revert());
    expect(await batchCreateSupport('base')).toEqual({ supported: false, maxBatch: 0 });
    vi.advanceTimersByTime(30_000);
    expect(await batchCreateSupport('base')).toEqual({ supported: false, maxBatch: 0 });
    expect(maxBatch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(31_000);
    // The expired answer is served while the new read runs; the next request has it.
    expect(await batchCreateSupport('base')).toEqual({ supported: false, maxBatch: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(await batchCreateSupport('base')).toEqual({ supported: true, maxBatch: 50 });
    expect(maxBatch).toHaveBeenCalledTimes(2);
  });

  it('answers "no" after 2 s on a slow RPC, and the late answer serves the next request', async () => {
    let answer!: (v: bigint) => void;
    maxBatch.mockImplementationOnce(() => new Promise<bigint>((resolve) => { answer = resolve; }));
    const first = batchCreateSupport('base');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await first).toEqual({ supported: false, maxBatch: 0 });
    // Still probing: no second read, and no second wait.
    expect(await batchCreateSupport('base')).toEqual({ supported: false, maxBatch: 0 });
    answer(50n);
    await vi.advanceTimersByTimeAsync(0);
    expect(await batchCreateSupport('base')).toEqual({ supported: true, maxBatch: 50 });
    expect(maxBatch).toHaveBeenCalledTimes(1);
  });

  it('gives up on a probe that never answers after 10 s, as "no"', async () => {
    maxBatch.mockImplementationOnce(() => new Promise<bigint>(() => {}));
    const first = batchCreateSupport('base');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await first).toEqual({ supported: false, maxBatch: 0 });
    // The next read starts a minute later.
    vi.advanceTimersByTime(60_000);
    await batchCreateSupport('base');
    await vi.advanceTimersByTimeAsync(0);
    expect(await batchCreateSupport('base')).toEqual({ supported: true, maxBatch: 50 });
  });

  it('makes one read for concurrent requests', async () => {
    const answers = await Promise.all([batchCreateSupport('base'), batchCreateSupport('base'), batchCreateSupport('base')]);
    expect(answers).toEqual(Array(3).fill({ supported: true, maxBatch: 50 }));
    expect(maxBatch).toHaveBeenCalledTimes(1);
  });

  it('reads again when the escrow address changes', async () => {
    await batchCreateSupport('base');
    cfg.baseEscrowAddress = OTHER_ESCROW;
    await batchCreateSupport('base');
    expect(maxBatch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['zero', 0n],
    ['a value past a safe integer', 2n ** 60n],
  ])('reads a MAX_BATCH of %s as unsupported', async (_label, value) => {
    maxBatch.mockResolvedValueOnce(value);
    expect(await batchCreateSupport('base')).toEqual({ supported: false, maxBatch: 0 });
  });

  it('never throws, even when the chain has no escrow object', async () => {
    (chain as Record<string, unknown>).baseEscrow = null;
    expect(await batchCreateSupport('base')).toEqual({ supported: false, maxBatch: 0 });
    expect(await batchCreateSupport('arc')).toEqual({ supported: false, maxBatch: 0 });
  });
});

describe('openCreateSupport', () => {
  it("says yes when the escrow answers getOpenTask, and keeps it apart from createTasks' answer", async () => {
    const getOpenTask = vi.fn(async () => ({ open: false, mode: 0n, creatorWindow: 0n, closedBy: 0n }));
    chain.baseEscrow = { MAX_BATCH: maxBatch, getOpenTask };
    maxBatch.mockRejectedValueOnce(revert());
    expect(await batchCreateSupport('base')).toEqual({ supported: false, maxBatch: 0 });
    expect(await openCreateSupport('base')).toBe(true);
    expect(getOpenTask).toHaveBeenCalledWith(0);
  });

  it('says no for an escrow from before the upgrade (the call reverts) or no escrow', async () => {
    chain.baseEscrow = { MAX_BATCH: maxBatch, getOpenTask: vi.fn(async () => { throw revert(); }) };
    expect(await openCreateSupport('base')).toBe(false);
    expect(await openCreateSupport('arc')).toBe(false);
  });
});

