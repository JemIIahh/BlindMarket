import { describe, expect, it } from 'vitest';
import { canCancelOpen, canReadSubmissions, isOpenTask, openPhaseCopy, openRowLabel, openStatusLabel, submissionsText, timeLeft, windowText } from './openTask';
import type { OpenTaskStatus } from '../services/openSubmission';
import { TaskStatus } from '../types/api';

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
    expect(openStatusLabel(status(), 'Funded')).toBe('Taking submissions');
    expect(openStatusLabel(status({ phase: 'verifier_pick' }), 'Funded')).toBe('Picking winner');
    expect(openStatusLabel(status({ phase: 'closed', outcome: { kind: 'winner', winner: '0x1', judge: 'creator' } }), 'Completed')).toBe('Completed');
    expect(openStatusLabel(status({ phase: 'closed', outcome: { kind: 'void', winner: null, judge: 'backup' } }), 'Cancelled')).toBe('Refunded');
    expect(openStatusLabel(status({ phase: 'closed' }), 'Cancelled')).toBe('Cancelled');
  });

  it('says nobody submitted once submissions closed with none', () => {
    expect(openStatusLabel(status({ phase: 'verifier_pick', submissions: 0 }), 'Funded')).toBe('No submissions');
    expect(openStatusLabel(status({ phase: 'submissions', submissions: 0 }), 'Funded')).toBe('Taking submissions');
    expect(openStatusLabel(status({ phase: 'closed', submissions: 0 }), 'Cancelled')).toBe('Cancelled');
  });

  it("shows the escrow status's label while the status loads or fails", () => {
    expect(openStatusLabel(undefined, 'Completed')).toBe('Completed');
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

  it('with no submissions past the deadline: the poster cancels, nobody picks', () => {
    for (const phase of ['creator_pick', 'verifier_pick', 'backup_pick', 'admin'] as const) {
      const s = status({ phase, submissions: 0 });
      expect(openPhaseCopy(s, ctx('poster'))).toEqual({ tone: 'warn', lead: 'No submissions.', body: 'Nobody submitted before the deadline. Cancel the task to get the escrow back.' });
      expect(openPhaseCopy(s, ctx('verifier')).body).toBe('Nobody submitted before the deadline. The poster can cancel the task and get the escrow back.');
    }
  });

  it('in the backup window: whether the verifier declined or ran out of time', () => {
    expect(openPhaseCopy(status({ phase: 'backup_pick' }), ctx()).body).toMatch(/^The verifier agent did not pick in time\. /);
    expect(openPhaseCopy(status({ phase: 'backup_pick', declined: { at: 'x' } }), ctx()).body).toMatch(/^The verifier agent found no submission acceptable\. /);
  });

  it('says when a pause moves the times, never once closed', () => {
    expect(openPhaseCopy(status({ paused: true }), ctx()).body).toMatch(/paused, which moves these times later\.$/);
    expect(openPhaseCopy(status({ paused: true, phase: 'closed' }), ctx()).body).not.toMatch(/paused/);
  });
});

describe('what the viewer may do', () => {
  it('cancels as the escrow allows: funded, nobody has submitted, not paused', () => {
    expect(canCancelOpen(status({ submissions: 0 }), TaskStatus.Funded)).toBe(true);
    expect(canCancelOpen(status({ submissions: 0, phase: 'creator_pick' }), TaskStatus.Funded)).toBe(true);
    expect(canCancelOpen(status(), TaskStatus.Funded)).toBe(false);
    expect(canCancelOpen(status({ submissions: 0, phase: 'closed' }), TaskStatus.Funded)).toBe(false);
    expect(canCancelOpen(status({ submissions: 0, paused: true }), TaskStatus.Funded)).toBe(false);
    // Cancelled on-chain, before the status refreshes.
    expect(canCancelOpen(status({ submissions: 0 }), TaskStatus.Cancelled)).toBe(false);
    expect(canCancelOpen(undefined, TaskStatus.Funded)).toBe(false);
  });

  it('labels a list row from its listing and escrow status', () => {
    expect(openRowLabel('collecting', T + 60, T)).toBe('taking submissions');
    expect(openRowLabel('collecting', T - 60, T)).toBe('deadline passed');
    expect(openRowLabel('completed', T - 60, T)).toBe('completed');
    expect(openRowLabel('failed', T - 60, T)).toBe('refunded');
    // The escrow closed it before the listing caught up.
    expect(openRowLabel('collecting', T - 60, T, TaskStatus.Completed)).toBe('completed');
    expect(openRowLabel('collecting', T + 60, T, TaskStatus.Cancelled)).toBe('refunded');
    expect(openRowLabel('collecting', T + 60, T, TaskStatus.Funded)).toBe('taking submissions');
  });

  it('reads submissions: the poster and verifier any time, anyone once they close', () => {
    expect(canReadSubmissions(status(), 'poster')).toBe(true);
    expect(canReadSubmissions(status(), 'verifier')).toBe(true);
    expect(canReadSubmissions(status(), 'other')).toBe(false);
    expect(canReadSubmissions(status({ phase: 'verifier_pick' }), 'other')).toBe(true);
  });
});
