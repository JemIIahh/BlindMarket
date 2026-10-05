/**
 * "Deadline approaching" reminders for a task's poster.
 *
 * Pure logic, so the sweep stays thin and this is easy to test. The sweep calls
 * dueReminderWindow() on every tick and sends through notifyOnce() keyed by
 * (task, window), so a reminder goes out once per window however many ticks,
 * restarts or API replicas see it.
 *
 * A window only fires while the task is FRESHLY inside it: remaining time in
 * (sec - graceSec, sec]. A task posted with 20 minutes to go is already past
 * the 24 h and 1 h marks; telling its poster "24 hours left" would be wrong, so
 * it gets no reminder for them. The cost is that a sweep outage longer than
 * graceSec around the mark skips that reminder, which is better than a late,
 * misleading one.
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

/** The window a task is freshly inside right now, or null. */
export function dueReminderWindow(
  nowSec: number,
  deadlineSec: number,
  windows: readonly ReminderWindow[] = REMINDER_WINDOWS,
): number | null {
  const remaining = deadlineSec - nowSec;
  if (remaining <= 0) return null;
  for (const w of windows) {
    if (remaining <= w.sec && remaining > w.sec - w.graceSec) return w.sec;
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
