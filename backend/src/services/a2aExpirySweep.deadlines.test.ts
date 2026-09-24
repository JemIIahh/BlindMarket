import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Nothing refunds a task on its own: cancelTask and claimTimeout are
 * onlyAgent, so after a deadline the escrow sits until the poster reclaims it.
 * On 2026-09-24 a poster's 1.5 USDC sat in an assigned task past its deadline
 * with nothing on the site saying so. The sweep now tells the poster, once per
 * task, when an assigned task misses its deadline with the escrow still held,
 * and when an unclaimed task expires.
 */

const POSTER = '0xbb8021dc9a063f4f2525f532faa3fe1907599026';
const TASK = '0x' + '98'.repeat(32);
const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const PAST = Math.floor(NOW / 1000) - 3600; // an hour ago
const FUTURE = Math.floor(NOW / 1000) + 3600;

const listInProgressTasks = vi.fn(async () => [] as Array<{ meta: Record<string, unknown>; state: Record<string, unknown> }>);
const listOpenTasks = vi.fn(async () => [] as Array<{ meta: Record<string, unknown>; state: Record<string, unknown> }>);
const tryExpire = vi.fn(async () => ({ ok: true }));
const resolveCachedTaskByHash = vi.fn(async (_hash: string) => ({ taskId: '1', chain: 'arc' }) as { taskId: string; chain: string } | null);
const getTaskOn = vi.fn(async (_chain: string, _id: number) => ({ taskHash: TASK, status: 1 }) as { taskHash: string; status: number });
const notifyOnce = vi.fn(async (_key: string, _to: string, _input: Record<string, unknown>) => true);

vi.mock('./deploymentIdentity.js', () => ({ backgroundWritesAllowed: () => true }));
vi.mock('./a2aStore.js', () => ({
  listInProgressTasks: () => listInProgressTasks(),
  listOpenTasks: () => listOpenTasks(),
  resyncOpenIndex: async () => ({ added: 0, removed: 0 }),
  getCachedDeadline: async () => null,
  cacheDeadline: async () => {},
  tryExpire: (...a: unknown[]) => tryExpire(...(a as [])),
  clearOffer: async () => {},
  clearCascade: async () => {},
}));
vi.mock('./taskChain.js', () => ({
  resolveCachedTaskByHash: (hash: string) => resolveCachedTaskByHash(hash),
  resolveTaskByHash: async () => null,
}));
vi.mock('./escrow.js', () => ({ getTaskOn: (chain: string, id: number) => getTaskOn(chain, id) }));
vi.mock('./notificationStore.js', () => ({
  notifyOnce: (key: string, to: string, input: Record<string, unknown>) => notifyOnce(key, to, input),
}));
vi.mock('./socket.js', () => ({ emitTaskAvailable: () => {} }));
vi.mock('./chainRuntime.js', () => ({ chainRuntime: () => ({}) }));
vi.mock('./deployedAgentStore.js', () => ({ loadAgentByWallet: async () => null }));
vi.mock('../constants.js', () => ({ SWEEP_INTERVAL_MS: 60_000, EXPIRY_GRACE_SEC: 60 }));

const { sweepMissedDeadlines, sweepExpiredTasks, _resetMissedDeadlineScan, MISSED_DEADLINE_SCAN_MS } = await import('./a2aExpirySweep.js');

function holding(deadline: number, status = 'accepted') {
  listInProgressTasks.mockResolvedValue([{ meta: { taskId: TASK, posterAddress: POSTER, deadline }, state: { taskId: TASK, status } }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetMissedDeadlineScan();
  resolveCachedTaskByHash.mockResolvedValue({ taskId: '1', chain: 'arc' });
  getTaskOn.mockResolvedValue({ taskHash: TASK, status: 1 });
  notifyOnce.mockResolvedValue(true);
});

describe('sweepMissedDeadlines', () => {
  it('tells the poster once an assigned task misses its deadline with the escrow still held', async () => {
    holding(PAST);
    expect(await sweepMissedDeadlines(NOW)).toBe(1);
    expect(getTaskOn).toHaveBeenCalledWith('arc', 1);
    expect(notifyOnce).toHaveBeenCalledWith(`deadline:${TASK}`, POSTER, expect.objectContaining({ type: 'expired', taskId: TASK }));
  });

  it.each([2, 3])('also for on-chain status %i (submitted, or verification failed)', async (status) => {
    holding(PAST, 'submitted');
    getTaskOn.mockResolvedValue({ taskHash: TASK, status });
    expect(await sweepMissedDeadlines(NOW)).toBe(1);
  });

  it.each([[4, 'completed'], [5, 'cancelled or reclaimed'], [0, 'never assigned on-chain']])(
    'not when the escrow reads %i (%s): the chain decides, not Redis',
    async (status) => {
      holding(PAST);
      getTaskOn.mockResolvedValue({ taskHash: TASK, status });
      expect(await sweepMissedDeadlines(NOW)).toBe(0);
      expect(notifyOnce).not.toHaveBeenCalled();
    },
  );

  it('not before the deadline (plus grace), and without reading the chain', async () => {
    holding(FUTURE);
    expect(await sweepMissedDeadlines(NOW)).toBe(0);
    expect(getTaskOn).not.toHaveBeenCalled();
  });

  it('not when the id the hash maps to is another task on that chain', async () => {
    holding(PAST);
    getTaskOn.mockResolvedValue({ taskHash: '0x' + '11'.repeat(32), status: 1 });
    expect(await sweepMissedDeadlines(NOW)).toBe(0);
    expect(notifyOnce).not.toHaveBeenCalled();
  });

  it('counts only notices sent now: one already sent is not repeated', async () => {
    holding(PAST);
    notifyOnce.mockResolvedValue(false);
    expect(await sweepMissedDeadlines(NOW)).toBe(0);
  });

  it('scans at most once per interval', async () => {
    holding(PAST);
    await sweepMissedDeadlines(NOW);
    expect(await sweepMissedDeadlines(NOW + 60_000)).toBe(0);
    expect(listInProgressTasks).toHaveBeenCalledTimes(1);
    await sweepMissedDeadlines(NOW + MISSED_DEADLINE_SCAN_MS);
    expect(listInProgressTasks).toHaveBeenCalledTimes(2);
  });
});

describe('sweepExpiredTasks', () => {
  it('tells the poster when an unclaimed task expires, since its escrow waits for them', async () => {
    listOpenTasks.mockResolvedValue([{ meta: { taskId: TASK, posterAddress: POSTER, deadline: PAST }, state: { taskId: TASK, status: 'open' } }]);
    await sweepExpiredTasks();
    expect(tryExpire).toHaveBeenCalled();
    expect(notifyOnce).toHaveBeenCalledWith(`deadline:${TASK}`, POSTER, expect.objectContaining({ type: 'expired', title: 'Your task expired unclaimed' }));
  });
});
