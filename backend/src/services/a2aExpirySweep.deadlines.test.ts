import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
// When the sweep first saw a task: a week before "now" unless a test says otherwise.
const firstSeenAt = vi.fn(async (_key: string, nowSec: number, _ttl: number) => nowSec - 7 * 86_400 as number | null);

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
  firstSeenAt: (key: string, nowSec: number, ttl: number) => firstSeenAt(key, nowSec, ttl),
}));
vi.mock('./socket.js', () => ({ emitTaskAvailable: () => {} }));
vi.mock('./chainRuntime.js', () => ({ chainRuntime: () => ({}) }));
vi.mock('./deployedAgentStore.js', () => ({ loadAgentByWallet: async () => null }));
vi.mock('../constants.js', () => ({ SWEEP_INTERVAL_MS: 60_000, EXPIRY_GRACE_SEC: 60 }));

const { sweepMissedDeadlines, sweepExpiredTasks, _resetMissedDeadlineScan, _resetReminderCache, MISSED_DEADLINE_SCAN_MS } = await import('./a2aExpirySweep.js');

function holding(deadline: number, status = 'accepted') {
  listInProgressTasks.mockResolvedValue([{ meta: { taskId: TASK, posterAddress: POSTER, deadline }, state: { taskId: TASK, status } }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetMissedDeadlineScan();
  _resetReminderCache();
  resolveCachedTaskByHash.mockResolvedValue({ taskId: '1', chain: 'arc' });
  getTaskOn.mockResolvedValue({ taskHash: TASK, status: 1 });
  notifyOnce.mockResolvedValue(true);
  firstSeenAt.mockImplementation(async (_key: string, nowSec: number) => nowSec - 7 * 86_400);
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

describe('deadline reminders', () => {
  const H = 3600;
  const inProgress = (deadline: number, status = 'accepted', poster: string | null = POSTER) =>
    listInProgressTasks.mockResolvedValue([{ meta: { taskId: TASK, posterAddress: poster, deadline }, state: { taskId: TASK, status } }]);
  const reminders = () => notifyOnce.mock.calls.filter(([, , input]) => input.type === 'deadline_soon');

  it('reminds the poster of a task still being worked, once its 24h mark passes', async () => {
    inProgress(Math.floor(NOW / 1000) + 23 * H);
    expect(await sweepMissedDeadlines(NOW)).toBe(0); // the return counts expiry notices only
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]).toEqual([
      `remind:${TASK}:${24 * H}`,
      POSTER,
      expect.objectContaining({ type: 'deadline_soon', title: 'Deadline approaching', taskId: TASK, body: expect.stringContaining('still working') }),
    ]);
  });

  it('uses a different key for the 1h mark, so the two reminders do not suppress each other', async () => {
    inProgress(Math.floor(NOW / 1000) + 50 * 60);
    await sweepMissedDeadlines(NOW);
    expect(reminders()[0][0]).toBe(`remind:${TASK}:${H}`);
  });

  it('says a submitted result is waiting to be reviewed', async () => {
    inProgress(Math.floor(NOW / 1000) + 50 * 60, 'submitted');
    await sweepMissedDeadlines(NOW);
    expect(reminders()[0][2].body).toEqual(expect.stringContaining('waiting to be reviewed'));
  });

  it('stays quiet between the marks', async () => {
    inProgress(Math.floor(NOW / 1000) + 12 * H);
    await sweepMissedDeadlines(NOW);
    expect(reminders()).toHaveLength(0);
  });

  it('does not tell a task posted with minutes left that it has 24h', async () => {
    inProgress(Math.floor(NOW / 1000) + 20 * 60);
    await sweepMissedDeadlines(NOW);
    expect(reminders()).toHaveLength(0);
  });

  it('does not remind a task the sweep is seeing for the first time inside a window', async () => {
    // Just posted with the default ~24h deadline.
    firstSeenAt.mockImplementation(async (_key: string, nowSec: number) => nowSec);
    inProgress(Math.floor(NOW / 1000) + 23 * H);
    await sweepMissedDeadlines(NOW);
    expect(reminders()).toHaveLength(0);
    expect(firstSeenAt).toHaveBeenCalledWith(`remind:${TASK}`, Math.floor(NOW / 1000), expect.any(Number));
  });

  it('records first sight once, and decides every later window from memory', async () => {
    const TASK2 = '0x' + '77'.repeat(32);
    const at = (deadline: number) =>
      listInProgressTasks.mockResolvedValue([{ meta: { taskId: TASK2, posterAddress: POSTER, deadline }, state: { taskId: TASK2, status: 'accepted' } }]);
    const deadline = Math.floor(NOW / 1000) + 3 * 86_400;
    at(deadline);
    await sweepMissedDeadlines(NOW);
    expect(firstSeenAt).toHaveBeenCalledTimes(1);
    _resetMissedDeadlineScan();
    await sweepMissedDeadlines(NOW + 60_000);
    expect(firstSeenAt).toHaveBeenCalledTimes(1);
    // Inside the 24h window: decided from the first sight already read.
    _resetMissedDeadlineScan();
    await sweepMissedDeadlines((deadline - 23 * H) * 1000);
    expect(firstSeenAt).toHaveBeenCalledTimes(1);
    expect(reminders()).toHaveLength(1);
  });

  it('sends nothing when the first-seen time cannot be read', async () => {
    firstSeenAt.mockResolvedValue(null);
    inProgress(Math.floor(NOW / 1000) + 50 * 60);
    await sweepMissedDeadlines(NOW);
    expect(reminders()).toHaveLength(0);
  });

  it('has nobody to remind without a poster', async () => {
    inProgress(Math.floor(NOW / 1000) + 50 * 60, 'accepted', null);
    await sweepMissedDeadlines(NOW);
    expect(notifyOnce).not.toHaveBeenCalled();
  });

  it('a reminder does not stop the expiry notice later', async () => {
    holding(PAST);
    expect(await sweepMissedDeadlines(NOW)).toBe(1);
    expect(reminders()).toHaveLength(0);
  });

  describe('open tasks (the sweep reads the real clock)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => vi.useRealTimers());
    const open = (deadline: number) =>
      listOpenTasks.mockResolvedValue([{ meta: { taskId: TASK, posterAddress: POSTER, deadline }, state: { taskId: TASK, status: 'open' } }]);

    it('reminds the poster that no agent has taken the task, and does not expire it', async () => {
      open(Math.floor(NOW / 1000) + 50 * 60);
      await sweepExpiredTasks();
      expect(reminders()).toHaveLength(1);
      expect(reminders()[0][0]).toBe(`remind:${TASK}:${H}`);
      expect(reminders()[0][2].body).toEqual(expect.stringContaining('no agent has taken it yet'));
      expect(tryExpire).not.toHaveBeenCalled();
    });

    it('stays quiet for a task with days left', async () => {
      open(Math.floor(NOW / 1000) + 72 * H);
      await sweepExpiredTasks();
      expect(notifyOnce).not.toHaveBeenCalled();
    });

    // tg-3 (delta audit 2026-10-06): a task posted with the default 24h
    // deadline is "inside" the 24h window for its first 3h but never reminded,
    // and the sweep used to re-read its first sight from Redis (SET NX + GET)
    // on every tick of those 3h.
    it('makes no reminder calls on the next tick for tasks just posted with a 24h deadline', async () => {
      firstSeenAt.mockImplementation(async (_key: string, nowSec: number) => nowSec); // first sight: now
      const deadline = Math.floor(NOW / 1000) + 24 * H;
      listOpenTasks.mockResolvedValue(Array.from({ length: 100 }, (_, i) => {
        const tid = '0x' + (i + 1).toString(16).padStart(64, 'f');
        return { meta: { taskId: tid, posterAddress: POSTER, deadline }, state: { taskId: tid, status: 'open' } };
      }));
      await sweepExpiredTasks();
      expect(firstSeenAt).toHaveBeenCalledTimes(100);
      expect(notifyOnce).not.toHaveBeenCalled();

      firstSeenAt.mockClear();
      vi.setSystemTime(NOW + 60_000);
      await sweepExpiredTasks();
      expect(firstSeenAt).not.toHaveBeenCalled();
      expect(notifyOnce).not.toHaveBeenCalled();
    });

    describe('one-by-one posts reach the poster together', () => {
      const nowSec = Math.floor(NOW / 1000);
      const OTHER = '0x' + 'c'.repeat(40);
      const task = (n: number) => '0x' + n.toString(16).padStart(64, '0');
      const openTasks = (rows: Array<[number, string, number]>) =>
        listOpenTasks.mockResolvedValue(rows.map(([n, poster, deadline]) => ({
          meta: { taskId: task(n), posterAddress: poster, deadline },
          state: { taskId: task(n), status: 'open' },
        })));
      const remindedTasks = () => reminders().map(([key]) => key);

      it("pulls in the poster's tasks whose 1 h mark is minutes away, in the same tick", async () => {
        openTasks([
          [1, POSTER, nowSec + 59 * 60], // due now
          [2, POSTER, nowSec + 63 * 60], // posted 4 min later: pulled in
          [3, POSTER, nowSec + 74 * 60], // 14 min later: pulled in
          [4, POSTER, nowSec + 80 * 60], // 21 min later: waits for its own mark
          [5, OTHER, nowSec + 62 * 60], //  another poster, nothing due: waits
        ]);
        await sweepExpiredTasks();
        expect(remindedTasks()).toEqual([`remind:${task(1)}:${H}`, `remind:${task(2)}:${H}`, `remind:${task(3)}:${H}`]);
        expect(reminders().every(([, to]) => to === POSTER)).toBe(true);
        expect(reminders().every(([, , input]) => String(input.body).includes('about an hour'))).toBe(true);
      });

      it('pulls nothing in when the due reminder had already been sent', async () => {
        notifyOnce.mockImplementation(async (key: string) => key !== `remind:${task(1)}:${H}`);
        openTasks([
          [1, POSTER, nowSec + 50 * 60], // reminded on an earlier tick
          [2, POSTER, nowSec + 70 * 60], // posted later: keeps its own mark
        ]);
        await sweepExpiredTasks();
        expect(remindedTasks()).toEqual([`remind:${task(1)}:${H}`]);
      });

      it('pulls only into the same mark: a 1 h reminder never carries a 24 h one', async () => {
        openTasks([
          [1, POSTER, nowSec + 59 * 60], //      1 h mark due now
          [2, POSTER, nowSec + 24 * H + 300], // 24 h mark 5 min away: waits for its own
        ]);
        await sweepExpiredTasks();
        expect(remindedTasks()).toEqual([`remind:${task(1)}:${H}`]);
      });

      it('still sends the reminders collected before a task that throws', async () => {
        openTasks([
          [1, POSTER, nowSec + 59 * 60],
          [2, POSTER, nowSec - 2 * H], // past its deadline: tryExpire runs, and throws
        ]);
        tryExpire.mockRejectedValueOnce(new Error('redis down'));
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await sweepExpiredTasks();
        expect(remindedTasks()).toEqual([`remind:${task(1)}:${H}`]);
      });

      it('pulls in nothing when no reminder is due', async () => {
        openTasks([[2, POSTER, nowSec + 63 * 60], [3, POSTER, nowSec + 70 * 60]]);
        await sweepExpiredTasks();
        expect(reminders()).toHaveLength(0);
      });
    });

    it('sends the expiry notice, not a reminder, once the deadline has passed', async () => {
      open(Math.floor(NOW / 1000) - 3600);
      await sweepExpiredTasks();
      expect(reminders()).toHaveLength(0);
      expect(notifyOnce).toHaveBeenCalledWith(`deadline:${TASK}`, POSTER, expect.objectContaining({ type: 'expired' }));
    });
  });
});
