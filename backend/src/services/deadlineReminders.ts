/**
 * "Deadline approaching" reminders for a task's poster.
 *
 * Pure logic, so the sweep stays thin and this is easy to test. The sweep calls
 * dueReminderWindow() on every tick and sends through notifyOnce() keyed by
 * (task, window), so a reminder goes out once per window however many ticks,
 * restarts or API replicas see it.
 *
 * A window fires only for a mark the task actually lived through: the sweep
 * must have seen the task before the mark (firstSeenSec < deadline - sec). A
 * task posted with the default 24 h deadline is already inside the 24 h window
 * the moment it is listed; reminding its poster then would be noise. The sweep
 * sees a new task within a tick of it being listed, so "first seen" stands in
 * for "posted".
 *
 * And it fires only while the task is FRESHLY inside the window: remaining time
 * in (sec - graceSec, sec]. A sweep outage longer than graceSec around the mark
 * skips that reminder, which is better than a late, misleading one.
 */

export interface ReminderWindow {
  /** Remind when this much time is left. */
  sec: number;
  /** How late a reminder may be: it still fires while at most this long has passed since the mark. */
  graceSec: number;
}

export const REMINDER_WINDOWS: readonly ReminderWindow[] = [
  { sec: 24 * 3600, graceSec: 3 * 3600 },
  { sec: 3600, graceSec: 15 * 60 },
];

/**
 * The window a task is freshly inside right now, or null. `firstSeenSec` is
 * when the sweep first saw the task: a mark that had already passed by then is
 * never reminded.
 */
export function dueReminderWindow(
  nowSec: number,
  deadlineSec: number,
  firstSeenSec: number,
  windows: readonly ReminderWindow[] = REMINDER_WINDOWS,
): number | null {
  const remaining = deadlineSec - nowSec;
  if (remaining <= 0) return null;
  for (const w of windows) {
    if (remaining <= w.sec && remaining > w.sec - w.graceSec) {
      return firstSeenSec < deadlineSec - w.sec ? w.sec : null;
    }
  }
  return null;
}

/** What the task is waiting on, which decides the copy. */
export type ReminderKind = 'open' | 'working' | 'review';

export function reminderKind(status: string): ReminderKind {
  if (status === 'open') return 'open';
  if (status === 'submitted' || status === 'awaiting_verification') return 'review';
  return 'working';
}

export function humanRemaining(remainingSec: number): string {
  const hours = Math.round(remainingSec / 3600);
  if (hours >= 2) return `${hours} hours`;
  if (remainingSec >= 45 * 60) return 'an hour';
  return `${Math.max(1, Math.round(remainingSec / 60))} minutes`;
}

/** Reminder copy. Generic on purpose: it may be sent to Telegram (see telegram.ts). */
export function reminderCopy(kind: ReminderKind, remainingSec: number): { title: string; body: string } {
  const left = humanRemaining(remainingSec);
  const body =
    kind === 'open'
      ? `Your task closes in about ${left} and no agent has taken it yet.`
      : kind === 'working'
        ? `Your task's deadline is in about ${left}. The assigned agent is still working on it.`
        : `Your task's deadline is in about ${left}. A result is waiting to be reviewed.`;
  return { title: 'Deadline approaching', body };
}
