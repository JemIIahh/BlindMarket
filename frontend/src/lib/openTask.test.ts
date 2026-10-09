import { describe, expect, it } from 'vitest';
import { canCancelOpen, canReadSubmissions, isOpenTask, openPhaseCopy, openRowLabel, openStatusLabel, submissionsText, timeLeft, windowText } from './openTask';
import type { OpenTaskStatus } from '../services/openSubmission';

const NOW = 1_800_000_000_000;
const T = NOW / 1000;
const status = (over: Partial<OpenTaskStatus> = {}): OpenTaskStatus => ({
  taskHash: '0xabc',
  onChainTaskId: '7',
  chain: 'arc',
  mode: 'agent',
  phase: 'submissions',
  paused: false,
  submissions: 3,
  windows: { submissionsEnd: T + 7200, creatorPickEnd: null, verifierPickEnd: T + 7200 + 172_800, backupPickEnd: T + 7200 + 345_600 },
  outcome: null,
  declined: null,
  ...over,
});
const ctx = (viewer: 'poster' | 'verifier' | 'other' = 'other') => ({
  viewer,
  nowMs: NOW,
  fmt: (sec: number) => `<${sec - T}>`,
  workerPct: 90,
  feePct: 10,
  short: (a: string) => `short(${a})`,
});

describe('open task labels', () => {
  it('knows an open task', () => {
    expect(isOpenTask({ submissionMode: 'open' })).toBe(true);
    expect(isOpenTask({})).toBe(false);
    expect(isOpenTask(undefined)).toBe(false);
  });

  it('names where the task is', () => {
    expect(openStatusLabel(status())).toBe('Taking submissions');
    expect(openStatusLabel(status({ phase: 'verifier_pick' }))).toBe('Picking winner');
    expect(openStatusLabel(status({ phase: 'closed', outcome: { kind: 'winner', winner: '0x1', judge: 'creator' } }))).toBe('Completed');
    expect(openStatusLabel(status({ phase: 'closed', outcome: { kind: 'void', winner: null, judge: 'backup' } }))).toBe('Refunded');
    expect(openStatusLabel(status({ phase: 'closed' }))).toBe('Cancelled');
  });

  it('counts and times in plain words', () => {
    expect(submissionsText(0)).toBe('no submissions');
    expect(submissionsText(1)).toBe('1 submission');
    expect(submissionsText(4)).toBe('4 submissions');
    expect(timeLeft(T + 30, NOW)).toBe('in 1 min');
    expect(timeLeft(T + 3 * 3600, NOW)).toBe('in 3 hours');
    expect(timeLeft(T + 5 * 86_400, NOW)).toBe('in 5 days');
    expect(timeLeft(T - 1, NOW)).toBe('now');
    expect(windowText(86_400)).toBe('24 hours');
    expect(windowText(3 * 86_400)).toBe('3 days');
  });
});

describe('openPhaseCopy', () => {
  it('while taking submissions: the count, the close, and who picks next', () => {
    const other = openPhaseCopy(status(), ctx('other'));
    expect(other.lead).toBe('Taking submissions.');
    expect(other.body).toBe("3 submissions so far. Submissions close <7200> (in 2 hours). Results stay hidden until then. Then the task's verifier agent picks the winner.");
    const poster = openPhaseCopy(status({ mode: 'creator', windows: { ...status().windows, creatorPickEnd: T + 7200 + 86_400 } }), ctx('poster'));
    expect(poster.body).toContain('you can read them as they arrive');
    expect(poster.body).toContain('Then you have 24 hours to pick the winner, before your verifier agent picks.');
  });

  it("in the poster's window: theirs to pick, or theirs to wait for", () => {
    const s = status({ phase: 'creator_pick', mode: 'creator', windows: { ...status().windows, creatorPickEnd: T + 3600 } });
    expect(openPhaseCopy(s, ctx('poster'))).toMatchObject({ tone: 'warn', lead: 'Your pick.' });
    expect(openPhaseCopy(s, ctx('poster')).body).toContain('by <3600> (in 1 hour)');
    expect(openPhaseCopy(s, ctx('other')).lead).toBe('The poster is picking.');
  });

  it("in the verifier's window, and when it declined", () => {
    expect(openPhaseCopy(status({ phase: 'verifier_pick' }), ctx()).lead).toBe('The verifier is judging.');
    const declined = openPhaseCopy(status({ phase: 'verifier_pick', declined: { at: 'x' } }), ctx('poster'));
    expect(declined.lead).toBe('No pick from the verifier.');
    expect(declined.body).toContain('backup judge decides by');
  });

  it('when it ended: the winner and who picked, a refund, a cancel', () => {
    const won = openPhaseCopy(status({ phase: 'closed', outcome: { kind: 'winner', winner: '0xw', judge: 'task_verifier' } }), ctx());
    expect(won).toMatchObject({ tone: 'ok', lead: 'Completed.' });
    expect(won.body).toBe("short(0xw) won, picked by the task's verifier agent, from 3 submissions. The escrow paid them 90% and the treasury 10%.");
    expect(openPhaseCopy(status({ phase: 'closed', outcome: { kind: 'void', winner: null, judge: 'backup' } }), ctx()).lead).toBe('Closed with no winner.');
    expect(openPhaseCopy(status({ phase: 'closed', submissions: 0 }), ctx()).lead).toBe('Cancelled.');
  });

  it('says when a pause moves the times, never once closed', () => {
    expect(openPhaseCopy(status({ paused: true }), ctx()).body).toMatch(/paused, which moves these times later\.$/);
    expect(openPhaseCopy(status({ paused: true, phase: 'closed' }), ctx()).body).not.toMatch(/paused/);
  });
});

describe('what the viewer may do', () => {
  it('cancels while nobody has submitted, until it closes (the escrow refuses once anyone has)', () => {
    expect(canCancelOpen(status({ submissions: 0 }))).toBe(true);
    expect(canCancelOpen(status({ submissions: 0, phase: 'creator_pick' }))).toBe(true);
    expect(canCancelOpen(status())).toBe(false);
    expect(canCancelOpen(status({ submissions: 0, phase: 'closed' }))).toBe(false);
    expect(canCancelOpen(undefined)).toBe(false);
  });

  it('labels a list row from its listing alone', () => {
    expect(openRowLabel('collecting', T + 60, T)).toBe('taking submissions');
    expect(openRowLabel('collecting', T - 60, T)).toBe('picking winner');
    expect(openRowLabel('completed', T - 60, T)).toBe('completed');
    expect(openRowLabel('failed', T - 60, T)).toBe('refunded');
  });

  it('reads submissions: the poster and verifier any time, anyone once they close', () => {
    expect(canReadSubmissions(status(), 'poster')).toBe(true);
    expect(canReadSubmissions(status(), 'verifier')).toBe(true);
    expect(canReadSubmissions(status(), 'other')).toBe(false);
    expect(canReadSubmissions(status({ phase: 'verifier_pick' }), 'other')).toBe(true);
  });
});
