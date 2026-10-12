import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The platform's judging turns on open-submission tasks
 * (openSubmissionJudge.ts): as the task verifier when the poster named it,
 * and as backup judge on every open task. The task's own checks decide which
 * submissions are valid; the best score wins, the earliest on a tie; with
 * none valid the backup judge refunds the poster. The real store and
 * autoVerify run on an in-memory Redis; the escrow and its signer are stubs.
 *
 * Run: npx vitest run src/services/openSubmissionJudge.test.ts
 */

const PLATFORM = '0x' + 'e9'.repeat(20);
const OTHER_JUDGE = '0x' + '77'.repeat(20);
const POSTER = '0x' + 'a'.repeat(40);
const A = '0x' + '1'.repeat(40);
const B = '0x' + '2'.repeat(40);
const C = '0x' + '3'.repeat(40);
const HASH = '0x' + 'ab'.repeat(32);
const REF = 'arc:7';
const NOW = 1_800_000_000;
/** NOW falls in the task verifier's window: it opened a day ago, the backup judge's opens in a day. */
const DEADLINE = NOW - 2 * 86_400;
const CREATOR_WINDOW = 86_400;
const VERIFIER_START = DEADLINE + CREATOR_WINDOW;
const BACKUP_START = VERIFIER_START + 48 * 3600;

const mem = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  zsets: new Map<string, Map<string, number>>(),
  hashes: new Map<string, Map<string, string>>(),
}));
vi.mock('./redis.js', () => {
  const zset = (k: string) => {
    const z = mem.zsets.get(k) ?? new Map<string, number>();
    mem.zsets.set(k, z);
    return z;
  };
  const hash = (k: string) => {
    const h = mem.hashes.get(k) ?? new Map<string, string>();
    mem.hashes.set(k, h);
    return h;
  };
  return {
    redis: {
      get: async (k: string) => mem.kv.get(k) ?? null,
      set: async (k: string, v: string, ...args: unknown[]) => {
        if (args.includes('NX') && mem.kv.has(k)) return null;
        mem.kv.set(k, v);
        return 'OK';
      },
      del: async (k: string) => (mem.kv.delete(k) ? 1 : 0),
      exists: async (k: string) => (mem.kv.has(k) ? 1 : 0),
      expire: async () => 1,
      zadd: async (k: string, ...args: unknown[]) => {
        const nx = args[0] === 'NX';
        const [score, m] = (nx ? args.slice(1) : args) as [number, string];
        const z = zset(k);
        if (nx && z.has(m)) return 0;
        z.set(m, score);
        return 1;
      },
      zrem: async (k: string, m: string) => (mem.zsets.get(k)?.delete(m) ? 1 : 0),
      zrangebyscore: async (k: string, _min: string, max: number) =>
        [...zset(k).entries()].filter(([, s]) => s <= max).sort((a, b) => a[1] - b[1]).map(([m]) => m),
      hsetnx: async (k: string, f: string, v: string) => {
        const h = hash(k);
        if (h.has(f)) return 0;
        h.set(f, v);
        return 1;
      },
      hlen: async (k: string) => hash(k).size,
      hscan: async (k: string) => ['0', [...hash(k).entries()].flat()],
      hmget: async (k: string, ...fields: string[]) => fields.map((f) => hash(k).get(f) ?? null),
      scan: async (_cursor: string, _m: string, pattern: string) => {
        const prefix = pattern.replace(/\*$/, '');
        return ['0', [...mem.kv.keys()].filter((key) => key.startsWith(prefix))];
      },
    },
  };
});

const cfg = vi.hoisted(() => ({ openSubmissionEnabled: true }));
vi.mock('../config.js', () => ({ config: cfg }));
vi.mock('./deploymentIdentity.js', () => ({ backgroundWritesAllowed: () => true }));
vi.mock('./chainScope.js', () => ({ chainScope: (chain: string) => chain }));
vi.mock('./openSubmissionSweep.js', () => ({
  PHASE: { Submissions: 0, CreatorPick: 1, VerifierPick: 2, BackupPick: 3, AdminResolve: 4, Closed: 5 },
}));

const chain = vi.hoisted(() => ({
  read: {
    openPhase: vi.fn(),
    effectiveDeadline: vi.fn(),
    taskVerifier: vi.fn(),
    submissionCount: vi.fn(),
  },
  write: {
    selectWinnerByVerifier: vi.fn(),
    selectWinnerByBackup: vi.fn(),
    voidOpenTask: vi.fn(),
  },
  receiptStatus: 1,
}));
vi.mock('./escrow.js', () => ({ escrowFor: () => chain.read }));
vi.mock('./verifierSigner.js', () => ({
  verifierSignerFor: async () => ({ escrow: chain.write, enqueue: <T>(fn: () => Promise<T>) => fn(), address: PLATFORM }),
}));

const listing = vi.hoisted(() => ({ listed: true, criteria: {} as Record<string, unknown> | undefined }));
vi.mock('./openSubmissionEvents.js', () => ({
  listingOf: async () => (listing.listed ? { verificationCriteria: listing.criteria } : null),
}));

const { judgeOpenSubmissions, judgeSubmissions, pickWinner, scheduleExistingOpenTasks, RECHECK_SEC, SLACK_SEC } = await import('./openSubmissionJudge.js');
const store = await import('./openSubmissionStore.js');

const GOOD = 'El Clásico ended 2-1. Vinícius Júnior opened the scoring in the 23rd minute after a quick counter-attack down the left. '
  + 'Lewandowski equalised from the penalty spot in the 51st minute, and Bellingham headed the winner in the 88th from a Modrić corner. '
  + 'Standout player: Bellingham, who also made three key tackles in midfield and covered more ground than anyone on the pitch.';
const SHORT = 'Real won.';
const REFUSAL = 'I am unable to complete this task because I cannot access live match data.';

const judgeDue = () => mem.zsets.get('a2a:open:judge-due') ?? new Map<string, number>();
const sent = () => [
  ...chain.write.selectWinnerByVerifier.mock.calls.map((c) => ['verifier', ...c]),
  ...chain.write.selectWinnerByBackup.mock.calls.map((c) => ['backup', ...c]),
  ...chain.write.voidOpenTask.mock.calls.map((c) => ['void', ...c]),
];

async function posted(submissions: Array<[string, string | null]>) {
  await store.saveRecord({ chain: 'arc', taskId: '7', taskHash: HASH, poster: POSTER, deadline: DEADLINE, mode: 'creator', creatorWindow: CREATOR_WINDOW });
  await store.scheduleJudge(REF, DEADLINE);
  for (const [i, [who, output]] of submissions.entries()) {
    const evidenceHash = '0x' + String(i + 1).padStart(64, '0');
    await store.recordSubmission(REF, who, { evidenceHash, ordinal: i + 1, recordedAt: new Date().toISOString() });
    if (output !== null) await store.keepCommittedResult(REF, who, { resultData: { output }, evidenceHash, savedAt: new Date().toISOString() });
  }
  chain.read.submissionCount.mockResolvedValue(BigInt(submissions.length));
}

const tx = () => ({ hash: '0xtx', wait: async () => ({ status: chain.receiptStatus }) });

beforeEach(() => {
  vi.clearAllMocks();
  mem.kv.clear();
  mem.zsets.clear();
  mem.hashes.clear();
  cfg.openSubmissionEnabled = true;
  listing.listed = true;
  listing.criteria = {};
  chain.receiptStatus = 1;
  chain.read.openPhase.mockResolvedValue(2n);
  chain.read.effectiveDeadline.mockResolvedValue(BigInt(DEADLINE));
  chain.read.taskVerifier.mockResolvedValue(PLATFORM);
  for (const fn of Object.values(chain.write)) fn.mockImplementation(async () => tx());
});

describe('pickWinner', () => {
  const e = (submitter: string, ordinal: number, passed: boolean, score: number) => ({ submitter, ordinal, passed, score });

  it('takes the highest score among the valid submissions', () => {
    expect(pickWinner([e(A, 1, true, 70), e(B, 2, false, 99), e(C, 3, true, 85)])?.submitter).toBe(C);
  });

  it('gives a tie to the earliest submission', () => {
    expect(pickWinner([e(B, 2, true, 80), e(A, 1, true, 80)])?.submitter).toBe(A);
  });

  it('is null when nothing passed', () => {
    expect(pickWinner([e(A, 1, false, 90)])).toBeNull();
  });
});

describe('judgeSubmissions', () => {
  it('fails a submission whose result was never kept', () => {
    const [entry] = judgeSubmissions([{ submitter: A, ordinal: 1, result: null }], {});
    expect(entry).toMatchObject({ passed: false, score: 0, reason: 'No result was kept for this submission' });
  });
});

describe('as the task verifier the poster named', () => {
  it('pays the valid submission in its window, with a held scorecard of the same hash', async () => {
    await posted([[A, REFUSAL], [B, GOOD], [C, SHORT]]);
    expect(await judgeOpenSubmissions(NOW)).toBe(1);
    expect(sent()).toEqual([['verifier', 7n, B, expect.stringMatching(/^0x[0-9a-f]{64}$/)]]);
    const held = JSON.parse(mem.kv.get(`a2a:open:scorecard-pending:${REF}:task_verifier`)!);
    expect(held.scorecardHash).toBe(chain.write.selectWinnerByVerifier.mock.calls[0][2]);
    expect(held.scorecard).toMatchObject({ judge: 'platform', role: 'task_verifier', decision: { winner: B }, submissions: 3, judged: 3, valid: 1 });
    expect(judgeDue().has(REF)).toBe(false);
  });

  it("lets its turn pass when nothing is valid, and comes back for the backup judge's", async () => {
    await posted([[A, REFUSAL], [B, null]]);
    expect(await judgeOpenSubmissions(NOW)).toBe(0);
    expect(sent()).toEqual([]);
    expect(judgeDue().get(REF)).toBe(BACKUP_START + SLACK_SEC);
  });

  it("waits for the verifier's window while submissions are open or the poster may pick", async () => {
    await posted([[A, GOOD]]);
    chain.read.openPhase.mockResolvedValue(1n);
    await judgeOpenSubmissions(VERIFIER_START - 3600);
    expect(sent()).toEqual([]);
    expect(judgeDue().get(REF)).toBe(VERIFIER_START + SLACK_SEC);
  });
});

describe('as backup judge', () => {
  it("does nothing in another judge's window, and comes back for its own", async () => {
    await posted([[A, GOOD]]);
    chain.read.taskVerifier.mockResolvedValue(OTHER_JUDGE);
    expect(await judgeOpenSubmissions(NOW)).toBe(0);
    expect(sent()).toEqual([]);
    expect(judgeDue().get(REF)).toBe(BACKUP_START + SLACK_SEC);
  });

  it('pays the valid submission when the task verifier did not pick', async () => {
    await posted([[A, SHORT], [B, GOOD]]);
    chain.read.taskVerifier.mockResolvedValue(OTHER_JUDGE);
    chain.read.openPhase.mockResolvedValue(3n);
    expect(await judgeOpenSubmissions(NOW)).toBe(1);
    expect(sent()).toEqual([['backup', 7n, B, expect.any(String)]]);
    expect(mem.kv.has(`a2a:open:scorecard-pending:${REF}:backup`)).toBe(true);
  });

  it('refunds the poster when no submission passes', async () => {
    await posted([[A, REFUSAL], [B, SHORT]]);
    chain.read.openPhase.mockResolvedValue(3n);
    expect(await judgeOpenSubmissions(NOW)).toBe(1);
    expect(sent()).toEqual([['void', 7n, expect.any(String)]]);
    const held = JSON.parse(mem.kv.get(`a2a:open:scorecard-pending:${REF}:backup`)!);
    expect(held.scorecard.decision).toEqual({ void: true, reason: 'No submission passed the checks' });
  });

  it("applies the task's own checks", async () => {
    listing.criteria = { contains_keywords: ['Lewandowski'] };
    const noKeyword = GOOD.replace('Lewandowski', 'Raphinha');
    await posted([[A, noKeyword], [B, GOOD]]);
    chain.read.openPhase.mockResolvedValue(3n);
    await judgeOpenSubmissions(NOW);
    expect(sent()).toEqual([['backup', 7n, B, expect.any(String)]]);
  });
});

describe('when not to act', () => {
  it('waits while the indexer has recorded fewer submissions than the escrow counts', async () => {
    await posted([[A, GOOD]]);
    chain.read.submissionCount.mockResolvedValue(2n);
    expect(await judgeOpenSubmissions(NOW)).toBe(0);
    expect(sent()).toEqual([]);
    expect(judgeDue().get(REF)).toBe(NOW + RECHECK_SEC);
  });

  it('judges what it has once the window is nearly over', async () => {
    await posted([[A, GOOD]]);
    chain.read.submissionCount.mockResolvedValue(2n);
    await judgeOpenSubmissions(BACKUP_START - 600);
    expect(sent()).toEqual([['verifier', 7n, A, expect.any(String)]]);
  });

  it('leaves a task nobody submitted to for its poster', async () => {
    await posted([]);
    chain.read.openPhase.mockResolvedValue(3n);
    await judgeOpenSubmissions(NOW);
    expect(sent()).toEqual([]);
    expect(judgeDue().has(REF)).toBe(false);
  });

  it('stops once the task is closed or past the backup window', async () => {
    await posted([[A, GOOD]]);
    chain.read.openPhase.mockResolvedValue(4n);
    await judgeOpenSubmissions(NOW);
    expect(sent()).toEqual([]);
    expect(judgeDue().has(REF)).toBe(false);
  });

  it('leaves a task this server never listed to its poster and the admin', async () => {
    await posted([[A, GOOD]]);
    listing.listed = false;
    chain.read.openPhase.mockResolvedValue(3n);
    await judgeOpenSubmissions(NOW);
    expect(sent()).toEqual([]);
    expect(judgeDue().has(REF)).toBe(false);
  });

  it('judges every submission when there are more than one batch', async () => {
    const many: Array<[string, string | null]> = Array.from({ length: 60 }, (_, i) => ['0x' + (i + 16).toString(16).padStart(40, '0'), i === 47 ? GOOD : SHORT]);
    await posted(many);
    await judgeOpenSubmissions(NOW);
    expect(sent()).toEqual([['verifier', 7n, many[47][0], expect.any(String)]]);
    const held = JSON.parse(mem.kv.get(`a2a:open:scorecard-pending:${REF}:task_verifier`)!);
    expect(held.scorecard).toMatchObject({ judged: 60, valid: 1 });
  });

  it('looks again later when its transaction reverts', async () => {
    await posted([[A, GOOD]]);
    chain.receiptStatus = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await judgeOpenSubmissions(NOW)).toBe(0);
    expect(judgeDue().get(REF)).toBe(NOW + RECHECK_SEC);
  });

  it('does nothing with open submission off', async () => {
    await posted([[A, GOOD]]);
    cfg.openSubmissionEnabled = false;
    expect(await judgeOpenSubmissions(NOW)).toBe(0);
    expect(chain.read.openPhase).not.toHaveBeenCalled();
  });
});

describe('scheduleExistingOpenTasks', () => {
  it('schedules saved tasks with no outcome, and leaves settled ones and existing schedules alone', async () => {
    await store.saveRecord({ chain: 'arc', taskId: '7', taskHash: HASH, poster: POSTER, deadline: DEADLINE, mode: 'agent', creatorWindow: 0 });
    await store.saveRecord({ chain: 'arc', taskId: '8', taskHash: HASH, poster: POSTER, deadline: DEADLINE + 5, mode: 'agent', creatorWindow: 0 });
    await store.saveRecord({ chain: 'arc', taskId: '9', taskHash: HASH, poster: POSTER, deadline: DEADLINE + 9, mode: 'agent', creatorWindow: 0 });
    await store.saveOutcome('arc:8', { kind: 'void', judge: 'creator' });
    await store.scheduleJudge('arc:9', NOW);
    expect(await scheduleExistingOpenTasks()).toBe(2);
    expect(judgeDue().get('arc:7')).toBe(DEADLINE);
    expect(judgeDue().has('arc:8')).toBe(false);
    expect(judgeDue().get('arc:9')).toBe(NOW);
  });
});
