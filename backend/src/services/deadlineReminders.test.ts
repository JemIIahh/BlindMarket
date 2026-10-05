import { describe, it, expect } from 'vitest';
import { dueReminderWindow, humanRemaining, reminderCopy, reminderKind, REMINDER_WINDOWS } from './deadlineReminders.js';

const H = 3600;
const DEADLINE = 1_800_000_000;
const at = (remainingSec: number) => DEADLINE - remainingSec;

describe('dueReminderWindow', () => {
  it('fires the 24h window when freshly inside it', () => {
    expect(dueReminderWindow(at(24 * H), DEADLINE)).toBe(24 * H);
    expect(dueReminderWindow(at(23 * H), DEADLINE)).toBe(24 * H);
  });

  it('fires the 1h window when freshly inside it', () => {
    expect(dueReminderWindow(at(H), DEADLINE)).toBe(H);
    expect(dueReminderWindow(at(50 * 60), DEADLINE)).toBe(H);
  });

  it('is quiet outside a window', () => {
    expect(dueReminderWindow(at(48 * H), DEADLINE)).toBeNull();
    expect(dueReminderWindow(at(24 * H + 1), DEADLINE)).toBeNull();
    expect(dueReminderWindow(at(12 * H), DEADLINE)).toBeNull();
  });

  it('does not tell a late-posted task it has 24h left', () => {
    // Posted with 10 h to go: already far past the 24 h mark.
    expect(dueReminderWindow(at(10 * H), DEADLINE)).toBeNull();
    // Posted with 20 min to go: past both marks.
    expect(dueReminderWindow(at(20 * 60), DEADLINE)).toBeNull();
  });

  it('is quiet once the deadline has passed', () => {
    expect(dueReminderWindow(DEADLINE, DEADLINE)).toBeNull();
    expect(dueReminderWindow(DEADLINE + 10, DEADLINE)).toBeNull();
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
