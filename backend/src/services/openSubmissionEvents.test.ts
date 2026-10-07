import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Open-submission events become the off-chain record and the alerts for the
 * poster and the submitters (docs/OPEN-SUBMISSION-TASKS.md). The indexer
 * delivers each event at least once, so every handler must be idempotent.
 */

const POSTER = '0x' + 'a'.repeat(40);
const HASH = '0x' + 'ab'.repeat(32);
/** The on-chain task the store keys by. */
const REF = 'arc:7';
const NOW = 1_800_000_000;
const DEADLINE = NOW + 7200;
const agent = (i: number) => '0x' + i.toString(16).padStart(40, '0');

const mem = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  hashes: new Map<string, Map<string, string>>(),
  zsets: new Map<string, Map<string, number>>(),
  failNextZadd: false,
}));

vi.mock('./redis.js', () => ({
  redis: {
    get: async (k: string) => mem.kv.get(k) ?? null,
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && mem.kv.has(k)) return null;
      mem.kv.set(k, v);
      return 'OK';
    },
    exists: async (k: string) => (mem.kv.has(k) ? 1 : 0),
    hsetnx: async (k: string, f: string, v: string) => {
      const h = mem.hashes.get(k) ?? new Map<string, string>();
      mem.hashes.set(k, h);
      if (h.has(f)) return 0;
      h.set(f, v);
      return 1;
    },
    hlen: async (k: string) => mem.hashes.get(k)?.size ?? 0,
    hmget: async (k: string, ...fs: string[]) => fs.map((f) => mem.hashes.get(k)?.get(f) ?? null),
    expire: async () => 1,
    del: async (k: string) => (mem.kv.delete(k) ? 1 : 0),
    // One page holds everything: the cursor goes straight back to 0.
    hscan: async (k: string) => ['0', [...(mem.hashes.get(k) ?? new Map()).entries()].flat()],
    zadd: async (k: string, score: number, m: string) => {
      if (mem.failNextZadd) {
        mem.failNextZadd = false;
        throw new Error('redis blip');
      }
      const z = mem.zsets.get(k) ?? new Map<string, number>();
      mem.zsets.set(k, z);
      z.set(m, score);
      return 1;
    },
    zrem: async (k: string, m: string) => (mem.zsets.get(k)?.delete(m) ? 1 : 0),
  },
}));

const escrow = vi.hoisted(() => ({
  getTask: vi.fn(),
  getOpenTask: vi.fn(),
  submissionCount: vi.fn(),
}));
vi.mock('./escrow.js', () => ({ escrowFor: () => escrow }));
const closeOpenSubmissionTask = vi.hoisted(() => vi.fn(async (_hash: string, _outcome: unknown) => true));
vi.mock('./a2aStore.js', () => ({ closeOpenSubmissionTask }));
// The listing's hash → task mapping: by default the listing is task 7.
const listing = vi.hoisted(() => ({ resolveCachedTaskByHash: vi.fn(async (_hash: string) => ({ chain: 'arc', taskId: '7' }) as { chain: string; taskId: string } | null) }));
vi.mock('./taskChain.js', () => listing);

type Alert = { to: string; type: string; title: string; body?: string; taskId?: string };
/** What was actually delivered, in order. The once-senders skip a key seen before, like the real ones. */
const delivered = vi.hoisted(() => ({ list: [] as Alert[], once: new Set<string>() }));
const sent = vi.hoisted(() => ({
  notify: vi.fn(async (to: string, input: Record<string, unknown>) => {
    delivered.list.push({ to, ...input } as Alert);
    return {};
  }),
  notifyOnce: vi.fn(async (key: string, to: string, input: Record<string, unknown>) => {
    if (delivered.once.has(key)) return false;
    delivered.once.add(key);
    delivered.list.push({ to, ...input } as Alert);
    return true;
  }),
  notifyOnceMany: vi.fn(async (notices: Array<{ dedupeKey: string; to: string; input: Record<string, unknown> }>) => {
    let n = 0;
    for (const x of notices) {
      if (delivered.once.has(x.dedupeKey)) continue;
      delivered.once.add(x.dedupeKey);
      delivered.list.push({ to: x.to, ...x.input } as Alert);
      n++;
    }
    return n;
  }),
}));
vi.mock('./notificationStore.js', () => sent);

const { handleOpenTaskCreated, handleOpenSubmission, handleWinnerSelected, handleOpenTaskVoided, handleOpenEvent, COUNT_NOTICE_GAP_SEC } =
  await import('./openSubmissionEvents.js');
const store = await import('./openSubmissionStore.js');

const alerts = () => delivered.list;
const due = () => mem.zsets.get('a2a:open:due') ?? new Map<string, number>();

beforeEach(() => {
  vi.clearAllMocks();
  mem.kv.clear();
  mem.hashes.clear();
  mem.zsets.clear();
  delivered.list.length = 0;
  delivered.once.clear();
  escrow.getTask.mockResolvedValue({ agent: '0x' + 'A'.repeat(40), taskHash: HASH.toUpperCase().replace('0X', '0x'), deadline: BigInt(DEADLINE) });
  escrow.getOpenTask.mockResolvedValue({ open: true, mode: 1n, creatorWindow: 86_400n, closedBy: 0n });
  escrow.submissionCount.mockResolvedValue(3n);
});

describe('OpenTaskCreated', () => {
  it('saves the task from the chain and schedules the sweep at its deadline', async () => {
    await handleOpenTaskCreated('arc', 7n);
    expect(await store.getRecord(REF)).toEqual({
      chain: 'arc', taskId: '7', taskHash: HASH, poster: POSTER, deadline: DEADLINE, mode: 'creator', creatorWindow: 86_400,
    });
    expect(due().get(REF)).toBe(DEADLINE);
  });

  it('ignores a task that does not take open submissions', async () => {
    escrow.getOpenTask.mockResolvedValue({ open: false, mode: 0n, creatorWindow: 0n, closedBy: 0n });
    await handleOpenTaskCreated('arc', 7n);
    expect(await store.getRecord(REF)).toBeNull();
    expect(due().size).toBe(0);
  });

  it('redoes the whole setup when it failed part-way, so the task is still scheduled', async () => {
    mem.failNextZadd = true;
    await expect(handleOpenTaskCreated('arc', 7n)).rejects.toThrow('redis blip');
    // Not findable by id yet: the retried event sets it up again.
    expect(await store.getRecord(REF)).toBeNull();
    await handleOpenTaskCreated('arc', 7n);
    expect(due().get(REF)).toBe(DEADLINE);
    expect(await store.getRecord(REF)).not.toBeNull();
  });

  it('reads the chain once per task', async () => {
    await handleOpenTaskCreated('arc', 7n);
    await handleOpenSubmission('arc', 7n, agent(1), '0x01', 1n, undefined, NOW);
    expect(escrow.getTask).toHaveBeenCalledTimes(1);
  });
});

describe('OpenSubmission', () => {
  beforeEach(async () => {
    await handleOpenTaskCreated('arc', 7n);
  });

  it('tells the poster about the first submission at once', async () => {
    await handleOpenSubmission('arc', 7n, agent(1), '0x01', 1n, '0xtx', NOW);
    expect(alerts()).toEqual([{ to: POSTER, type: 'submissions', title: 'First submission on your task', body: expect.any(String), taskId: HASH }]);
    expect(await store.recordedSubmissionCount(REF)).toBe(1);
  });

  it('then says how many at most once an hour, with the running count', async () => {
    await handleOpenSubmission('arc', 7n, agent(1), '0x01', 1n, undefined, NOW);
    await handleOpenSubmission('arc', 7n, agent(2), '0x02', 2n, undefined, NOW + 60);
    await handleOpenSubmission('arc', 7n, agent(3), '0x03', 3n, undefined, NOW + 120);
    expect(alerts()).toHaveLength(1);
    // The gap has passed (the Redis TTL would have expired the gate).
    mem.kv.delete(`a2a:open:count-gate:${REF}`);
    await handleOpenSubmission('arc', 7n, agent(4), '0x04', 4n, undefined, NOW + COUNT_NOTICE_GAP_SEC + 1);
    expect(alerts()).toHaveLength(2);
    expect(alerts()[1]).toMatchObject({ to: POSTER, type: 'submissions', title: 'New submissions on your task', body: expect.stringContaining('4 agents have submitted so far') });
  });

  it('sends nothing twice when an event is delivered again', async () => {
    await handleOpenSubmission('arc', 7n, agent(1), '0x01', 1n, undefined, NOW);
    await handleOpenSubmission('arc', 7n, agent(1), '0x01', 1n, undefined, NOW + 5);
    expect(alerts()).toHaveLength(1);
    expect(await store.recordedSubmissionCount(REF)).toBe(1);
  });

  it('sends no stale count when an event is redelivered after the count gap', async () => {
    await handleOpenSubmission('arc', 7n, agent(1), '0x01', 1n, undefined, NOW);
    await handleOpenSubmission('arc', 7n, agent(2), '0x02', 2n, undefined, NOW + 60);
    mem.kv.delete(`a2a:open:count-gate:${REF}`);
    // The scan replays the block holding submission 2 an hour later.
    await handleOpenSubmission('arc', 7n, agent(2), '0x02', 2n, undefined, NOW + COUNT_NOTICE_GAP_SEC + 60);
    expect(alerts()).toHaveLength(1);
    // And the slot is still free for the next real submission.
    await handleOpenSubmission('arc', 7n, agent(3), '0x03', 3n, undefined, NOW + COUNT_NOTICE_GAP_SEC + 120);
    expect(alerts()[1]).toMatchObject({ body: expect.stringContaining('3 agents have submitted so far') });
  });

  it('sends no running count once the deadline is due or the summary went out', async () => {
    await handleOpenSubmission('arc', 7n, agent(1), '0x01', 1n, undefined, DEADLINE);
    expect(alerts()).toHaveLength(0);
    await store.markClosedNotified(REF);
    await handleOpenSubmission('arc', 7n, agent(2), '0x02', 2n, undefined, NOW);
    expect(alerts()).toHaveLength(0);
    // Still recorded: the outcome alerts go to every submitter.
    expect(await store.recordedSubmissionCount(REF)).toBe(2);
  });

  it('meets a task whose creation predates the scan, and schedules it', async () => {
    mem.kv.clear();
    mem.zsets.clear();
    await handleOpenSubmission('arc', 7n, agent(2), '0x02', 2n, undefined, NOW);
    expect(await store.getRecord(REF)).toMatchObject({ taskId: '7', poster: POSTER });
    expect(due().get(REF)).toBe(DEADLINE);
    expect(alerts()[0]).toMatchObject({ title: 'New submissions on your task', body: expect.stringContaining('2 agents') });
  });
});

describe('WinnerSelected', () => {
  beforeEach(async () => {
    await handleOpenTaskCreated('arc', 7n);
    for (let i = 1; i <= 3; i++) await handleOpenSubmission('arc', 7n, agent(i), `0x0${i}`, BigInt(i), undefined, NOW);
    delivered.list.length = 0;
  });

  it('tells the poster, the winner, and every other submitter, and stops the sweep', async () => {
    await handleWinnerSelected('arc', 7n, agent(2).toUpperCase().replace('0X', '0x'), 1);
    const a = alerts();
    expect(a.find((x) => x.to === POSTER)).toMatchObject({ type: 'completed', title: 'Winner picked — escrow released', body: expect.stringContaining('You picked a winner from 3 submissions') });
    expect(a.find((x) => x.to === agent(2))).toMatchObject({ type: 'completed', title: 'Your submission won' });
    expect(a.filter((x) => x.title === 'Another submission was picked').map((x) => x.to).sort()).toEqual([agent(1), agent(3)]);
    expect(await store.getOutcome(REF)).toEqual({ kind: 'winner', winner: agent(2), judge: 'creator' });
    expect(due().has(REF)).toBe(false);
    // The listing closes too: 'completed', with the winner as its executor.
    expect(closeOpenSubmissionTask).toHaveBeenCalledWith(HASH, { kind: 'winner', winner: agent(2) });
  });

  it('names the judge who picked', async () => {
    await handleWinnerSelected('arc', 7n, agent(1), 3);
    expect(alerts().find((x) => x.to === POSTER)?.body).toContain('backup judge');
  });

  it('counts from the chain, or from what was recorded when the chain cannot be read', async () => {
    escrow.submissionCount.mockRejectedValue(new Error('rpc down'));
    await handleWinnerSelected('arc', 7n, agent(1), 2);
    expect(alerts().find((x) => x.to === POSTER)?.body).toContain('from 3 submissions');
  });

  it('keys each submitter alert by task and address, so a redelivery sends none twice', async () => {
    await handleWinnerSelected('arc', 7n, agent(2), 1);
    const keys = sent.notifyOnceMany.mock.calls.flatMap(([n]) => n.map((x) => x.dedupeKey));
    expect(keys).toEqual(expect.arrayContaining([`open:lost:${REF}:${agent(1)}`, `open:lost:${REF}:${agent(3)}`]));
  });
});

describe('OpenTaskVoided', () => {
  beforeEach(async () => {
    await handleOpenTaskCreated('arc', 7n);
    for (let i = 1; i <= 2; i++) await handleOpenSubmission('arc', 7n, agent(i), `0x0${i}`, BigInt(i), undefined, NOW);
    delivered.list.length = 0;
  });

  it('by a judge: tells the poster their escrow came back, and every submitter', async () => {
    await handleOpenTaskVoided('arc', 7n, 3);
    expect(alerts().find((x) => x.to === POSTER)).toMatchObject({ type: 'completed', title: 'Task closed with no winner — escrow refunded' });
    expect(alerts().filter((x) => x.title === 'No submission was picked').map((x) => x.to).sort()).toEqual([agent(1), agent(2)]);
    expect(await store.getOutcome(REF)).toEqual({ kind: 'void', judge: 'backup' });
    expect(due().has(REF)).toBe(false);
    expect(closeOpenSubmissionTask).toHaveBeenCalledWith(HASH, { kind: 'void' });
  });

  it('by the poster (nobody submitted): no alert for their own refund, but the listing closes', async () => {
    await handleOpenTaskVoided('arc', 7n, 1);
    expect(alerts()).toHaveLength(0);
    expect(due().has(REF)).toBe(false);
    expect(closeOpenSubmissionTask).toHaveBeenCalledWith(HASH, { kind: 'void' });
  });
});

describe('what leaves the platform', () => {
  it('never puts an address or an evidence hash in an alert', async () => {
    await handleOpenTaskCreated('arc', 7n);
    for (let i = 1; i <= 3; i++) await handleOpenSubmission('arc', 7n, agent(i), `0xdead${i}`, BigInt(i), undefined, NOW);
    mem.kv.delete(`a2a:open:count-gate:${REF}`);
    await handleOpenSubmission('arc', 7n, agent(4), '0xdead4', 4n, undefined, NOW + 4000);
    await handleWinnerSelected('arc', 7n, agent(2), 2);
    await handleOpenTaskVoided('arc', 7n, 4);
    for (const a of alerts()) {
      const text = `${a.title} ${a.body ?? ''}`;
      expect(text).not.toMatch(/0x[0-9a-f]{6,}/i);
    }
  });
});

describe('handleOpenEvent', () => {
  it('routes each decoded event and ignores the rest', async () => {
    const log = (eventName: string, args: Record<string, unknown>) => ({ eventName, args, transactionHash: '0xtx' }) as never;
    await handleOpenEvent('arc', log('OpenTaskCreated', { taskId: 7n, mode: 1n, creatorWindow: 86_400n }));
    await handleOpenEvent('arc', log('OpenSubmission', { taskId: 7n, submitter: agent(1), evidenceHash: '0x01', count: 1n }));
    await handleOpenEvent('arc', log('TaskCreated', { taskId: 8n }));
    expect(await store.getRecord(REF)).not.toBeNull();
    expect(await store.recordedSubmissionCount(REF)).toBe(1);
  });
});

describe('a decoy task with the same hash (security review of #142)', () => {
  const ATTACKER = '0x' + 'e'.repeat(40);
  beforeEach(async () => {
    // Task 8 copies task 7's hash. The listing is task 7: its verified poster listed it.
    escrow.getTask.mockImplementation(async (id: bigint) =>
      id === 8n
        ? { agent: ATTACKER, taskHash: HASH, deadline: BigInt(NOW + 3600) }
        : { agent: POSTER, taskHash: HASH, deadline: BigInt(DEADLINE) });
    await handleOpenTaskCreated('arc', 7n);
    for (let i = 1; i <= 2; i++) await handleOpenSubmission('arc', 7n, agent(i), `0x0${i}`, BigInt(i), undefined, NOW);
    await handleOpenTaskCreated('arc', 8n);
    delivered.list.length = 0;
  });

  it('keeps its own record: its events never land on the real task', async () => {
    expect(await store.getRecord('arc:8')).toMatchObject({ taskId: '8', poster: ATTACKER });
    expect(await store.getRecord(REF)).toMatchObject({ taskId: '7', poster: POSTER });
    await handleOpenSubmission('arc', 8n, agent(9), '0x09', 1n, undefined, NOW);
    expect(await store.recordedSubmissionCount(REF)).toBe(2);
    expect(await store.recordedSubmissionCount('arc:8')).toBe(1);
  });

  it('cannot close the real listing by voiding itself', async () => {
    await handleOpenTaskVoided('arc', 8n, 1);
    expect(closeOpenSubmissionTask).not.toHaveBeenCalled();
    expect(await store.getOutcome(REF)).toBeNull();
    expect(due().has(REF)).toBe(true);
  });

  it("cannot mark the real listing won, or tell the real task's submitters they lost", async () => {
    await handleOpenSubmission('arc', 8n, ATTACKER, '0x0e', 1n, undefined, NOW);
    await handleWinnerSelected('arc', 8n, ATTACKER, 1);
    expect(closeOpenSubmissionTask).not.toHaveBeenCalled();
    expect(await store.getOutcome(REF)).toBeNull();
    // Only the decoy's own poster and submitter hear of it.
    expect(new Set(alerts().map((a) => a.to))).toEqual(new Set([ATTACKER]));
  });
});

describe('keeping results', () => {
  const H1 = '0x' + '11'.repeat(32);
  const pending = (evidenceHash: string) =>
    store.savePendingResult(REF, agent(1), { resultData: { output: 'mine' }, evidenceHash, rootHash: null, savedAt: new Date().toISOString() });

  beforeEach(async () => {
    await handleOpenTaskCreated('arc', 7n);
  });

  it('keeps the result sent to submit-open once its on-chain submission carries its hash', async () => {
    await pending(H1);
    await handleOpenSubmission('arc', 7n, agent(1), H1, 1n, undefined, NOW);
    expect((await store.getResults(REF, [agent(1)]))[0]).toMatchObject({ resultData: { output: 'mine' }, evidenceHash: H1 });
    expect(mem.kv.has(`a2a:open:pending:${REF}:${agent(1)}`)).toBe(false);
  });

  it('keeps nothing when the on-chain hash is a different one', async () => {
    await pending(H1);
    await handleOpenSubmission('arc', 7n, agent(1), '0x' + '22'.repeat(32), 1n, undefined, NOW);
    expect((await store.getResults(REF, [agent(1)]))[0]).toBeNull();
  });

  it('never replaces a kept result', async () => {
    await pending(H1);
    await handleOpenSubmission('arc', 7n, agent(1), H1, 1n, undefined, NOW);
    await store.savePendingResult(REF, agent(1), { resultData: { output: 'swapped' }, evidenceHash: H1, rootHash: null, savedAt: '' });
    await handleOpenSubmission('arc', 7n, agent(1), H1, 1n, undefined, NOW);
    expect((await store.getResults(REF, [agent(1)]))[0]?.resultData).toEqual({ output: 'mine' });
  });
});
