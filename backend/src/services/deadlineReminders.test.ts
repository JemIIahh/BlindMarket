import { describe, it, expect } from 'vitest';
import { dueReminderWindow, humanRemaining, reminderCopy, reminderKind, REMINDER_WINDOWS } from './deadlineReminders.js';

const H = 3600;
const DEADLINE = 1_800_000_000;
const at = (remainingSec: number) => DEADLINE - remainingSec;
// Seen by the sweep long before either mark.
const SEEN = DEADLINE - 7 * 24 * H;

describe('dueReminderWindow', () => {
  it('fires the 24h window when freshly inside it', () => {
    expect(dueReminderWindow(at(24 * H), DEADLINE, SEEN)).toBe(24 * H);
    expect(dueReminderWindow(at(23 * H), DEADLINE, SEEN)).toBe(24 * H);
  });

  it('fires the 1h window when freshly inside it', () => {
    expect(dueReminderWindow(at(H), DEADLINE, SEEN)).toBe(H);
    expect(dueReminderWindow(at(50 * 60), DEADLINE, SEEN)).toBe(H);
  });

  it('is quiet outside a window', () => {
    expect(dueReminderWindow(at(48 * H), DEADLINE, SEEN)).toBeNull();
    expect(dueReminderWindow(at(24 * H + 1), DEADLINE, SEEN)).toBeNull();
    expect(dueReminderWindow(at(12 * H), DEADLINE, SEEN)).toBeNull();
  });

  it('does not tell a late-posted task it has 24h left', () => {
    // Posted with 10 h to go: already far past the 24 h mark.
    expect(dueReminderWindow(at(10 * H), DEADLINE, SEEN)).toBeNull();
    // Posted with 20 min to go: past both marks.
    expect(dueReminderWindow(at(20 * 60), DEADLINE, SEEN)).toBeNull();
  });

  it('does not remind a task posted already inside a window (the default 24h deadline)', () => {
    // Posted with 23h58m left, first seen by the sweep a minute later: the 24h
    // mark passed before the task existed.
    const posted = at(24 * H - 120);
    expect(dueReminderWindow(posted + 60, DEADLINE, posted)).toBeNull();
    expect(dueReminderWindow(at(22 * H), DEADLINE, posted)).toBeNull();
    // It still gets the 1h reminder: it lived through that mark.
    expect(dueReminderWindow(at(50 * 60), DEADLINE, posted)).toBe(H);
  });

  it('does not remind a task posted with under an hour left', () => {
    const posted = at(59 * 60);
    expect(dueReminderWindow(at(58 * 60), DEADLINE, posted)).toBeNull();
  });

  it('reminds when the task was seen just before the mark', () => {
    expect(dueReminderWindow(at(24 * H - 30), DEADLINE, at(24 * H + 30))).toBe(24 * H);
  });

  it('is quiet once the deadline has passed', () => {
    expect(dueReminderWindow(DEADLINE, DEADLINE, SEEN)).toBeNull();
    expect(dueReminderWindow(DEADLINE + 10, DEADLINE, SEEN)).toBeNull();
  });

  it('windows never overlap, so a task is in at most one at a time', () => {
    for (let remaining = 1; remaining <= 25 * H; remaining += 60) {
      const hits = REMINDER_WINDOWS.filter((w) => remaining <= w.sec && remaining > w.sec - w.graceSec);
      expect(hits.length).toBeLessThanOrEqual(1);
    }
  });

  it('every window is wider than one scan tick, so a reminder is not missed by sweep cadence', () => {
    for (const w of REMINDER_WINDOWS) expect(w.graceSec).toBeGreaterThanOrEqual(10 * 60);
  });
});

describe('copy', () => {
  it('describes what the task is waiting on', () => {
    expect(reminderKind('open')).toBe('open');
    expect(reminderKind('accepted')).toBe('working');
    expect(reminderKind('in_progress')).toBe('working');
    expect(reminderKind('submitted')).toBe('review');
    expect(reminderKind('awaiting_verification')).toBe('review');
  });

  it('names the time left', () => {
    expect(humanRemaining(23 * H)).toBe('23 hours');
    expect(humanRemaining(H)).toBe('an hour');
    expect(humanRemaining(50 * 60)).toBe('an hour');
    expect(humanRemaining(30 * 60)).toBe('30 minutes');
  });

  it('is generic: no addresses, no task content', () => {
    for (const kind of ['open', 'working', 'review'] as const) {
      const { title, body } = reminderCopy(kind, 5 * H);
      expect(title).toBe('Deadline approaching');
      expect(body).not.toMatch(/0x[0-9a-fA-F]{4}/);
    }
  });
});
