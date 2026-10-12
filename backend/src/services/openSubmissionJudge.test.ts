import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The platform's judging turns on open-submission tasks
 * (openSubmissionJudge.ts): as the task verifier when the poster named it,
 * and as backup judge on every open task. Real work decides between paying
 * and refunding, so a poster's checks cannot refund every submission; among
 * real work the task's checks, the score, the substance and then the order
 * rank it. A refund needs every submission seen, with its result. The real
 * store, autoVerify and deliverableFloor run on an in-memory Redis; the
 * escrow and its signer are stubs.
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
vi.mock('./settlementChains.js', () => ({ SETTLEMENT_CHAIN_KEYS: ['arc'] }));
vi.mock('./openSubmissionSweep.js', () => ({
  PHASE: { Submissions: 0, CreatorPick: 1, VerifierPick: 2, BackupPick: 3, AdminResolve: 4, Closed: 5 },
}));

const chain = vi.hoisted(() => ({
  read: {
    openPhase: vi.fn(),
    effectiveDeadline: vi.fn(),
    taskVerifier: vi.fn(),
    submissionCount: vi.fn(),
    getTask: vi.fn(),
    verifier: vi.fn(),
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

const { judgeOpenSubmissions, pickWinner, scheduleExistingOpenTasks, RECHECK_SEC, SLACK_SEC, MISSING_RECHECK_SEC } = await import('./openSubmissionJudge.js');
const store = await import('./openSubmissionStore.js');

const GOOD = 'El Clásico ended 2-1. Vinícius Júnior opened the scoring in the 23rd minute after a quick counter-attack down the left. '
  + 'Lewandowski equalised from the penalty spot in the 51st minute, and Bellingham headed the winner in the 88th from a Modrić corner. '
  + 'Standout player: Bellingham, who also made three key tackles in midfield and covered more ground than anyone on the pitch.';
const SHORT = 'Real won.';
const REFUSAL = 'I am unable to complete this task because I cannot access live match data.';
const JUNK = 'hello world this is fine';

const judgeDue = (scope = 'arc') => mem.zsets.get(`a2a:open:judge-due:${scope}`) ?? new Map<string, number>();
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
  chain.read.getTask.mockResolvedValue({ taskHash: HASH });
  chain.read.verifier.mockResolvedValue(PLATFORM);
  for (const fn of Object.values(chain.write)) fn.mockImplementation(async () => tx());
});

describe('pickWinner', () => {
  const e = (submitter: string, ordinal: number, o: { real?: boolean; passed?: boolean; score?: number; substance?: number } = {}) =>
    ({ submitter, ordinal, real: o.real ?? true, passed: o.passed ?? true, score: o.score ?? 100, substance: o.substance ?? 50 });

  it("prefers passing the task's checks, then the score", () => {
    expect(pickWinner([e(A, 1, { passed: false, score: 99 }), e(B, 2, { score: 70 }), e(C, 3, { score: 85 })])?.submitter).toBe(C);
  });

  it('breaks a tie on substance, then on order', () => {
    expect(pickWinner([e(A, 1, { substance: 5 }), e(B, 2, { substance: 120 })])?.submitter).toBe(B);
    expect(pickWinner([e(B, 2), e(A, 1)])?.submitter).toBe(A);
  });

  it('pays real work that failed the checks over nothing, and nothing that is not real work', () => {
    expect(pickWinner([e(A, 1, { passed: false, score: 20 })])?.submitter).toBe(A);
    expect(pickWinner([e(A, 1, { real: false, passed: false })])).toBeNull();
  });
});

describe('as the task verifier the poster named', () => {
  it('pays the real submission in its window, with a held scorecard of the same hash', async () => {
    await posted([[A, REFUSAL], [B, GOOD], [C, SHORT]]);
    expect(await judgeOpenSubmissions(NOW)).toBe(1);
    expect(sent()).toEqual([['verifier', 7n, B, expect.stringMatching(/^0x[0-9a-f]{64}$/)]]);
    const held = JSON.parse(mem.kv.get(`a2a:open:scorecard-pending:${REF}:task_verifier`)!);
    expect(held.scorecardHash).toBe(chain.write.selectWinnerByVerifier.mock.calls[0][2]);
    expect(held.scorecard).toMatchObject({ judge: 'platform', role: 'task_verifier', decision: { winner: B }, submissions: 3, judged: 3, real: 1 });
    expect(judgeDue().has(REF)).toBe(false);
  });

  it("lets its turn pass with no real work, and comes back for the backup judge's", async () => {
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
  beforeEach(() => {
    chain.read.taskVerifier.mockResolvedValue(OTHER_JUDGE);
    chain.read.openPhase.mockResolvedValue(3n);
  });

  it("does nothing in another judge's window, and comes back for its own", async () => {
    await posted([[A, GOOD]]);
    chain.read.openPhase.mockResolvedValue(2n);
    expect(await judgeOpenSubmissions(NOW)).toBe(0);
    expect(sent()).toEqual([]);
    expect(judgeDue().get(REF)).toBe(BACKUP_START + SLACK_SEC);
  });

  it('pays the real submission when the task verifier did not pick', async () => {
    await posted([[A, SHORT], [B, GOOD]]);
    expect(await judgeOpenSubmissions(NOW)).toBe(1);
    expect(sent()).toEqual([['backup', 7n, B, expect.any(String)]]);
    expect(mem.kv.has(`a2a:open:scorecard-pending:${REF}:backup`)).toBe(true);
  });

  it('refunds the poster when every submission was seen and none is real work', async () => {
    await posted([[A, REFUSAL], [B, SHORT]]);
    expect(await judgeOpenSubmissions(NOW)).toBe(1);
    expect(sent()).toEqual([['void', 7n, expect.any(String)]]);
    const held = JSON.parse(mem.kv.get(`a2a:open:scorecard-pending:${REF}:backup`)!);
    expect(held.scorecard.decision).toEqual({ void: true, reason: 'No submission was real work' });
  });

  it("applies the task's own checks to rank real work", async () => {
    listing.criteria = { contains_keywords: ['Lewandowski'] };
    await posted([[A, GOOD.replace('Lewandowski', 'Raphinha')], [B, GOOD]]);
    await judgeOpenSubmissions(NOW);
    expect(sent()).toEqual([['backup', 7n, B, expect.any(String)]]);
  });

  it("cannot be made to refund real work by a check nobody passes (the poster's hidden answer)", async () => {
    listing.criteria = { expected_answer: 'zx-unguessable-9137' };
    await posted([[A, GOOD], [B, REFUSAL]]);
    await judgeOpenSubmissions(NOW);
    expect(sent()).toEqual([['backup', 7n, A, expect.any(String)]]);
  });

  it('pays the right short answer on a task that asks for one', async () => {
    listing.criteria = { expected_answer: '4' };
    await posted([[A, GOOD], [B, '4']]);
    await judgeOpenSubmissions(NOW);
    expect(sent()).toEqual([['backup', 7n, B, expect.any(String)]]);
  });

  it('does not let a fast one-liner beat real work on a tie', async () => {
    await posted([[A, JUNK], [B, GOOD]]);
    await judgeOpenSubmissions(NOW);
    expect(sent()).toEqual([['backup', 7n, B, expect.any(String)]]);
  });

  it('judges real work behind a flood of submissions with no result', async () => {
    const flood: Array<[string, string | null]> = Array.from({ length: 600 }, (_, i) => ['0x' + (i + 16).toString(16).padStart(40, '0'), null]);
    await posted([...flood, [A, GOOD]]);
    await judgeOpenSubmissions(NOW);
    expect(sent()).toEqual([['backup', 7n, A, expect.any(String)]]);
  });

  it('does not refund while a submission has no result, and looks again', async () => {
    await posted([[A, REFUSAL], [B, null]]);
    expect(await judgeOpenSubmissions(NOW)).toBe(0);
    expect(sent()).toEqual([]);
    expect(judgeDue().get(REF)).toBe(NOW + MISSING_RECHECK_SEC);
  });

  it('leaves a task with missing results to the admin at the end of its window', async () => {
    await posted([[A, REFUSAL], [B, null]]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await judgeOpenSubmissions(BACKUP_START + 48 * 3600 - 600);
    expect(sent()).toEqual([]);
    expect(judgeDue().has(REF)).toBe(false);
  });

  it('does not refund when the indexer has not recorded every submission, even late in the window', async () => {
    await posted([[A, REFUSAL]]);
    chain.read.submissionCount.mockResolvedValue(2n);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await judgeOpenSubmissions(BACKUP_START + 48 * 3600 - 600);
    expect(sent()).toEqual([]);
  });

  it("does not act when this server's signer is not the escrow's verifier", async () => {
    await posted([[A, GOOD]]);
    chain.read.verifier.mockResolvedValue(OTHER_JUDGE);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await judgeOpenSubmissions(NOW);
    expect(sent()).toEqual([]);
    expect(judgeDue().get(REF)).toBe(NOW + MISSING_RECHECK_SEC);
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

  it('pays what it has recorded once the window is nearly over', async () => {
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

  it('leaves a task this server never listed to its poster and the admin', async () => {
    await posted([[A, GOOD]]);
    listing.listed = false;
    chain.read.openPhase.mockResolvedValue(3n);
    await judgeOpenSubmissions(NOW);
    expect(sent()).toEqual([]);
    expect(judgeDue().has(REF)).toBe(false);
  });

  it("does not judge a record whose id now names another task on the escrow", async () => {
    await posted([[A, GOOD]]);
    chain.read.getTask.mockResolvedValue({ taskHash: '0x' + 'cd'.repeat(32) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await judgeOpenSubmissions(NOW);
    expect(sent()).toEqual([]);
    expect(judgeDue().has(REF)).toBe(false);
  });

  it('stops once the task is past the backup window', async () => {
    await posted([[A, GOOD]]);
    chain.read.openPhase.mockResolvedValue(4n);
    await judgeOpenSubmissions(NOW);
    expect(sent()).toEqual([]);
    expect(judgeDue().has(REF)).toBe(false);
  });

  it('looks again later when its transaction reverts', async () => {
    await posted([[A, GOOD]]);
    chain.receiptStatus = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await judgeOpenSubmissions(NOW)).toBe(0);
    expect(judgeDue().get(REF)).toBe(NOW + RECHECK_SEC);
  });

  it("never reads another network's schedule", async () => {
    await posted([[A, GOOD]]);
    await store.scheduleJudge('arc@5042002:9', NOW - 100);
    await judgeOpenSubmissions(NOW, ['arc']);
    expect(judgeDue('arc@5042002').get('arc@5042002:9')).toBe(NOW - 100);
  });

  it('does nothing with open submission off', async () => {
    await posted([[A, GOOD]]);
    cfg.openSubmissionEnabled = false;
    expect(await judgeOpenSubmissions(NOW)).toBe(0);
    expect(chain.read.openPhase).not.toHaveBeenCalled();
  });
});

describe('scheduleExistingOpenTasks', () => {
  it("schedules a network's saved tasks with no outcome once, leaving settled ones and other networks alone", async () => {
    await store.saveRecord({ chain: 'arc', taskId: '7', taskHash: HASH, poster: POSTER, deadline: DEADLINE, mode: 'agent', creatorWindow: 0 });
    await store.saveRecord({ chain: 'arc', taskId: '8', taskHash: HASH, poster: POSTER, deadline: DEADLINE + 5, mode: 'agent', creatorWindow: 0 });
    await store.saveRecord({ chain: 'arc', taskId: '9', taskHash: HASH, poster: POSTER, deadline: DEADLINE + 9, mode: 'agent', creatorWindow: 0 });
    await store.saveOutcome('arc:8', { kind: 'void', judge: 'creator' });
    await store.scheduleJudge('arc:9', NOW);
    expect(await scheduleExistingOpenTasks(['arc'])).toBe(2);
    expect(judgeDue().get('arc:7')).toBe(DEADLINE);
    expect(judgeDue().has('arc:8')).toBe(false);
    expect(judgeDue().get('arc:9')).toBe(NOW);
    await store.unscheduleJudge('arc:7');
    expect(await scheduleExistingOpenTasks(['arc'])).toBe(0);
    expect(judgeDue().has('arc:7')).toBe(false);
  });
});
