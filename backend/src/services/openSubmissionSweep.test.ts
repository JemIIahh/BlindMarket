import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Once an open task's submissions close, its poster learns how many agents
 * submitted and what happens next; a poster who picks is reminded an hour
 * before their window ends (docs/OPEN-SUBMISSION-TASKS.md). The escrow's phase
 * and count decide, not the stored deadline: a pause moves every window.
 */

const POSTER = '0x' + 'a'.repeat(40);
const HASH = '0x' + 'ab'.repeat(32);
const NOW = 1_800_000_000;
const DEADLINE = NOW - 10;

const mem = vi.hoisted(() => ({ kv: new Map<string, string>(), zsets: new Map<string, Map<string, number>>() }));
vi.mock('./redis.js', () => ({
  redis: {
    get: async (k: string) => mem.kv.get(k) ?? null,
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && mem.kv.has(k)) return null;
      mem.kv.set(k, v);
      return 'OK';
    },
    exists: async (k: string) => (mem.kv.has(k) ? 1 : 0),
    zadd: async (k: string, score: number, m: string) => {
      const z = mem.zsets.get(k) ?? new Map<string, number>();
      mem.zsets.set(k, z);
      z.set(m, score);
      return 1;
    },
    zrem: async (k: string, m: string) => (mem.zsets.get(k)?.delete(m) ? 1 : 0),
    zrangebyscore: async (k: string, _min: string, max: number) =>
      [...(mem.zsets.get(k) ?? new Map<string, number>()).entries()].filter(([, s]) => s <= max).sort((a, b) => a[1] - b[1]).map(([m]) => m),
  },
}));

const cfg = vi.hoisted(() => ({ openSubmissionEnabled: true }));
vi.mock('../config.js', () => ({ config: cfg }));
vi.mock('./deploymentIdentity.js', () => ({ backgroundWritesAllowed: () => true }));

const escrow = vi.hoisted(() => ({
  openPhase: vi.fn(),
  submissionCount: vi.fn(),
  effectiveDeadline: vi.fn(),
}));
vi.mock('./escrow.js', () => ({ escrowFor: () => escrow }));

const notifyOnce = vi.hoisted(() => vi.fn(async (_key: string, _to: string, _input: Record<string, unknown>) => true));
vi.mock('./notificationStore.js', () => ({ notifyOnce, notify: vi.fn(), notifyOnceMany: vi.fn() }));

const { sweepOpenSubmissions, PHASE, PICK_REMINDER_SEC } = await import('./openSubmissionSweep.js');
const store = await import('./openSubmissionStore.js');

const due = () => mem.zsets.get('a2a:open:due') ?? new Map<string, number>();
const posted = async (mode: 'agent' | 'creator', creatorWindow = mode === 'creator' ? 86_400 : 0) => {
  await store.saveRecord({ chain: 'arc', taskId: '7', taskHash: HASH, poster: POSTER, deadline: DEADLINE, mode, creatorWindow });
  await store.scheduleSweep(HASH, DEADLINE);
};

beforeEach(() => {
  vi.clearAllMocks();
  mem.kv.clear();
  mem.zsets.clear();
  cfg.openSubmissionEnabled = true;
  notifyOnce.mockResolvedValue(true);
  escrow.openPhase.mockResolvedValue(BigInt(PHASE.CreatorPick));
  escrow.submissionCount.mockResolvedValue(12n);
  escrow.effectiveDeadline.mockResolvedValue(BigInt(DEADLINE));
});

describe('the deadline summary', () => {
  it('tells a picking poster how many submitted, then schedules the pick reminder', async () => {
    await posted('creator');
    expect(await sweepOpenSubmissions(NOW)).toBe(1);
    expect(notifyOnce).toHaveBeenCalledWith(`open:closed:${HASH}`, POSTER, expect.objectContaining({
      type: 'submissions',
      title: 'Submissions closed: pick a winner',
      body: expect.stringContaining('12 agents submitted. Pick a winner within about 24 hours'),
      taskId: HASH,
    }));
    expect(due().get(HASH)).toBe(DEADLINE + 86_400 - PICK_REMINDER_SEC);
  });

  it("tells the poster of an agent-managed task that its verifier is picking, and stops", async () => {
    escrow.openPhase.mockResolvedValue(BigInt(PHASE.VerifierPick));
    escrow.submissionCount.mockResolvedValue(1n);
    await posted('agent');
    await sweepOpenSubmissions(NOW);
    expect(notifyOnce.mock.calls[0][2]).toMatchObject({ type: 'submissions', title: 'Submissions closed', body: expect.stringContaining('1 agent submitted') });
    expect(due().has(HASH)).toBe(false);
  });

  it('with no submissions, tells the poster the escrow is theirs to reclaim', async () => {
    escrow.submissionCount.mockResolvedValue(0n);
    await posted('creator');
    await sweepOpenSubmissions(NOW);
    expect(notifyOnce.mock.calls[0][2]).toMatchObject({ type: 'expired', title: 'No submissions came in' });
    expect(due().has(HASH)).toBe(false);
  });

  it('times the reminder from the pause-adjusted deadline', async () => {
    escrow.effectiveDeadline.mockResolvedValue(BigInt(DEADLINE + 600));
    await posted('creator');
    await sweepOpenSubmissions(NOW);
    expect(due().get(HASH)).toBe(DEADLINE + 600 + 86_400 - PICK_REMINDER_SEC);
  });

  it('sets no reminder for a window of two hours or less: the summary already says it', async () => {
    await posted('creator', 7200);
    await sweepOpenSubmissions(NOW);
    expect(notifyOnce.mock.calls[0][2]).toMatchObject({ body: expect.stringContaining('about 2 hours') });
    expect(due().has(HASH)).toBe(false);
  });

  it('waits while the escrow still takes submissions (paused past the stored deadline)', async () => {
    escrow.openPhase.mockResolvedValue(BigInt(PHASE.Submissions));
    await posted('creator');
    await sweepOpenSubmissions(NOW);
    expect(notifyOnce).not.toHaveBeenCalled();
    expect(due().get(HASH)).toBe(NOW + 300);
  });

  it('drops a task that closed on-chain, or whose outcome is recorded, without an alert', async () => {
    escrow.openPhase.mockResolvedValue(BigInt(PHASE.Closed));
    await posted('creator');
    await sweepOpenSubmissions(NOW);
    expect(due().has(HASH)).toBe(false);

    escrow.openPhase.mockResolvedValue(BigInt(PHASE.CreatorPick));
    await store.scheduleSweep(HASH, DEADLINE);
    await store.saveOutcome(HASH, { kind: 'winner', winner: '0x' + '2'.repeat(40), judge: 'creator' });
    await sweepOpenSubmissions(NOW);
    expect(notifyOnce).not.toHaveBeenCalled();
    expect(due().has(HASH)).toBe(false);
  });

  it('keeps a task due when the chain cannot be read', async () => {
    escrow.openPhase.mockRejectedValue(new Error('rpc down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await posted('creator');
    await sweepOpenSubmissions(NOW);
    expect(notifyOnce).not.toHaveBeenCalled();
    expect(due().get(HASH)).toBe(DEADLINE);
  });

  it('does not look at tasks that are not due', async () => {
    await store.saveRecord({ chain: 'arc', taskId: '7', taskHash: HASH, poster: POSTER, deadline: NOW + 3600, mode: 'creator', creatorWindow: 86_400 });
    await store.scheduleSweep(HASH, NOW + 3600);
    await sweepOpenSubmissions(NOW);
    expect(escrow.openPhase).not.toHaveBeenCalled();
  });
});

describe('the pick reminder', () => {
  beforeEach(async () => {
    await posted('creator');
    await sweepOpenSubmissions(NOW);
    notifyOnce.mockClear();
  });
  const reminderAt = DEADLINE + 86_400 - PICK_REMINDER_SEC;

  it('reminds the poster an hour before their window ends, once', async () => {
    await sweepOpenSubmissions(reminderAt);
    expect(notifyOnce).toHaveBeenCalledWith(`open:pick-soon:${HASH}`, POSTER, expect.objectContaining({ type: 'deadline_soon', title: 'Pick a winner soon' }));
    expect(due().has(HASH)).toBe(false);
  });

  it('stays quiet once the window has passed to the verifier', async () => {
    escrow.openPhase.mockResolvedValue(BigInt(PHASE.VerifierPick));
    await sweepOpenSubmissions(reminderAt);
    expect(notifyOnce).not.toHaveBeenCalled();
    expect(due().has(HASH)).toBe(false);
  });
});

describe('the flag', () => {
  it('does nothing with OPEN_SUBMISSION_ENABLED off', async () => {
    await posted('creator');
    cfg.openSubmissionEnabled = false;
    expect(await sweepOpenSubmissions(NOW)).toBe(0);
    expect(escrow.openPhase).not.toHaveBeenCalled();
    expect(notifyOnce).not.toHaveBeenCalled();
  });
});
