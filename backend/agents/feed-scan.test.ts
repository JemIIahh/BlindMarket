import { describe, it, expect, vi } from 'vitest';

vi.mock('ai', () => ({ tool: (d: unknown) => d, generateText: vi.fn(), generateObject: vi.fn(), stepCountIs: (n: number) => n }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: () => () => 'm' }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: () => () => 'm' }));
vi.mock('@ai-sdk/groq', () => ({ createGroq: () => () => 'm' }));
vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), emit: vi.fn() }) }));

// @ts-expect-error — plain-JS worker, no d.ts
import { shouldScanFeed, feedScanCadence, gasRecheckPollDue, WS_RECONCILE_MS } from './worker.js';

/**
 * The stranding bug. The offer cascade lives in a setTimeout (routes/a2a.ts)
 * and dies with the process on restart; its documented fallback is that agents
 * "pick it up via CAS race", which requires them to poll. But the worker
 * skipped the feed scan outright whenever its socket was up — so the fallback
 * could never fire, and any task open across a restart stayed invisible until
 * it expired with the escrow still funded.
 *
 * A connected agent must therefore still sweep the board on a floor cadence.
 */
describe('shouldScanFeed — a connected agent still sweeps the board', () => {
  const T0 = 1_700_000_000_000;

  it('scans every tick while disconnected', () => {
    expect(shouldScanFeed(false, T0, T0)).toBe(true);
  });

  it('does NOT scan on every tick while connected — WS is still the fast path', () => {
    expect(shouldScanFeed(true, T0 + 1_000, T0)).toBe(false);
  });

  it('scans again once the reconcile floor elapses, even while connected', () => {
    expect(shouldScanFeed(true, T0 + WS_RECONCILE_MS, T0)).toBe(true);
  });

  it('never lets a connected agent go longer than the floor without a sweep', () => {
    // The regression: previously this was `if (wsConnected) return;` — false forever.
    expect(shouldScanFeed(true, T0 + WS_RECONCILE_MS * 5, T0)).toBe(true);
  });

  it('scans on first tick after boot (no prior scan recorded)', () => {
    expect(shouldScanFeed(true, T0, 0)).toBe(true);
  });

  it('floor is long enough to stay cheap, short enough to rescue a task', () => {
    expect(WS_RECONCILE_MS).toBeGreaterThanOrEqual(60_000);
    expect(WS_RECONCILE_MS).toBeLessThanOrEqual(600_000);
  });
});

describe('feedScanCadence', () => {
  it('shortens the WS reconcile floor while tasks sit skipped for gas', () => {
    expect(feedScanCadence(true, 300_000, 60_000)).toBe(59_000);
    expect(feedScanCadence(false, 300_000, 60_000)).toBe(300_000);
  });
  it('lets every re-check tick scan, even one that fires a few ms early', () => {
    // lastFeedScanAt is stamped just after the tick that scanned, so the next
    // tick lands slightly under GAS_RECHECK_MS later (observed: half the ticks
    // skipped, worst-case pickup 2 × GAS_RECHECK_MS).
    for (const recheck of [2_000, 60_000]) {
      const last = 1_000_000;
      expect(shouldScanFeed(true, last + recheck - 15, last, feedScanCadence(true, 300_000, recheck))).toBe(true);
    }
  });
  it('never lengthens a floor that is already shorter than the recheck', () => {
    expect(feedScanCadence(true, 30_000, 60_000)).toBe(30_000);
  });
});

describe('gasRecheckPollDue', () => {
  it('polls on the gas re-check cadence only while tasks wait for gas (feed skips plus resume holds)', () => {
    expect(gasRecheckPollDue(1, false)).toBe(true);
    expect(gasRecheckPollDue(0, false)).toBe(false);
  });

  it('leaves a running poll alone', () => {
    expect(gasRecheckPollDue(3, true)).toBe(false);
  });
});
