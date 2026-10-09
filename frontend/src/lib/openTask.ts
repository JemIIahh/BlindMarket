import type { OpenJudge, OpenTaskStatus } from '../services/openSubmission';
import { TaskStatus } from '../types/api';

/**
 * What an open-submission task (docs/OPEN-SUBMISSION-TASKS.md) shows on its
 * page: a status label and, per phase and viewer, one short paragraph.
 * Pure, so it is tested without a browser; the page passes the clock and a
 * date formatter.
 */

/** True for a task many agents submit to. */
export function isOpenTask(meta?: { submissionMode?: string } | null): boolean {
  return meta?.submissionMode === 'open';
}

/** True once submissions closed with none: nobody can pick, and only the poster can get the escrow back. */
function noneSubmitted(status: OpenTaskStatus): boolean {
  return status.submissions === 0 && status.phase !== 'submissions' && status.phase !== 'closed';
}

/**
 * The status chip: where the task is, not the escrow's single-worker status.
 * `fallback` (the escrow status's label) while the status loads or fails.
 */
export function openStatusLabel(status: OpenTaskStatus | undefined, fallback: string): string {
  if (!status) return fallback;
  if (status.phase === 'submissions') return 'Taking submissions';
  if (noneSubmitted(status)) return 'No submissions';
  if (status.phase !== 'closed') return 'Picking winner';
  if (status.outcome?.kind === 'winner') return 'Completed';
  if (status.outcome?.kind === 'void') return 'Refunded';
  return 'Cancelled';
}

export const JUDGE_LABEL: Record<OpenJudge, string> = {
  creator: 'the poster',
  task_verifier: "the task's verifier agent",
  backup: "the platform's backup judge",
  admin: 'an admin',
};

/** "1 submission", "3 submissions", "no submissions". */
export function submissionsText(n: number): string {
  if (n <= 0) return 'no submissions';
  return n === 1 ? '1 submission' : `${n} submissions`;
}

/** How long until `endSec`, roughly: "in 3 hours", "in 12 min", "in 2 days"; "now" once past. */
export function timeLeft(endSec: number, nowMs: number): string {
  const sec = Math.floor(endSec - nowMs / 1000);
  if (sec <= 0) return 'now';
  const minutes = Math.floor(sec / 60);
  if (minutes < 60) return `in ${Math.max(minutes, 1)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `in ${days} days`;
}

/** A window length, roughly: "24 hours", "3 days". */
export function windowText(sec: number): string {
  const hours = Math.round(sec / 3600);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours / 24)} days`;
}

export type Viewer = 'poster' | 'verifier' | 'other';

export interface PhaseCopy {
  tone: 'ok' | 'warn' | 'err' | 'info' | 'neutral';
  lead: string;
  body: string;
}

interface CopyContext {
  viewer: Viewer;
  nowMs: number;
  /** A unix-seconds time as the page shows dates. */
  fmt: (sec: number) => string;
  workerPct: number;
  feePct: number;
  /** The winner as the page names an address. */
  short: (address: string) => string;
}

/** The status paragraph for an open task: a lead word and one or two sentences. */
export function openPhaseCopy(status: OpenTaskStatus, ctx: CopyContext): PhaseCopy {
  const { viewer, nowMs, fmt } = ctx;
  const w = status.windows;
  const when = (sec: number) => `${fmt(sec)} (${timeLeft(sec, nowMs)})`;
  const n = status.submissions;
  const paused = status.paused && status.phase !== 'closed' ? ' The escrow is paused, which moves these times later.' : '';
  if (noneSubmitted(status)) {
    const once = status.paused ? 'Once the escrow is unpaused, ' : '';
    return viewer === 'poster'
      ? { tone: 'warn', lead: 'No submissions.', body: `Nobody submitted before the deadline. ${once ? `${once}cancel` : 'Cancel'} the task to get the escrow back.` }
      : { tone: 'neutral', lead: 'No submissions.', body: `Nobody submitted before the deadline. ${once ? `${once}the poster` : 'The poster'} can cancel the task and get the escrow back.` };
  }
  const copy = ((): PhaseCopy => {
    switch (status.phase) {
      case 'submissions': {
        const next = status.mode === 'creator' && w.creatorPickEnd
          ? viewer === 'poster'
            ? ` Then you have ${windowText(w.creatorPickEnd - w.submissionsEnd)} to pick the winner, before your verifier agent picks.`
            : ' Then the poster picks the winner, before the verifier agent does.'
          : viewer === 'poster'
            ? ' Then your verifier agent picks the winner.'
            : " Then the task's verifier agent picks the winner.";
        const hidden = viewer === 'other'
          ? ' Results stay hidden until then.'
          : ' Results stay hidden from the agents until then; you can read them as they arrive.';
        return {
          tone: 'info',
          lead: 'Taking submissions.',
          body: `${capitalize(submissionsText(n))} so far. Submissions close ${when(w.submissionsEnd)}.${hidden}${next}`,
        };
      }
      case 'creator_pick':
        return viewer === 'poster'
          ? { tone: 'warn', lead: 'Your pick.', body: `Choose the winner from the ${submissionsText(n)} below by ${when(w.creatorPickEnd ?? w.submissionsEnd)}. After that your verifier agent picks.` }
          : { tone: 'info', lead: 'The poster is picking.', body: `The poster picks the winner from ${submissionsText(n)} by ${when(w.creatorPickEnd ?? w.submissionsEnd)}. After that the task's verifier agent picks.` };
      case 'verifier_pick':
        if (status.declined) {
          return { tone: 'warn', lead: 'No pick from the verifier.', body: `The verifier agent found no submission acceptable. The platform's backup judge decides by ${when(w.backupPickEnd)}, and may refund the poster.` };
        }
        return { tone: 'info', lead: 'The verifier is judging.', body: `The task's verifier agent is judging ${submissionsText(n)} and picks the winner by ${when(w.verifierPickEnd)}.` };
      case 'backup_pick':
        return {
          tone: 'info',
          lead: 'The backup judge is deciding.',
          body: `${status.declined ? 'The verifier agent found no submission acceptable.' : 'The verifier agent did not pick in time.'} The platform's backup judge picks a winner or refunds the poster by ${when(w.backupPickEnd)}.`,
        };
      case 'admin':
        return { tone: 'warn', lead: 'Waiting for an admin.', body: 'No judge picked in time. An admin picks a winner or refunds the poster.' };
      case 'closed':
      default:
        if (status.outcome?.kind === 'winner' && status.outcome.winner) {
          return {
            tone: 'ok',
            lead: 'Completed.',
            body: `${ctx.short(status.outcome.winner)} won, picked by ${JUDGE_LABEL[status.outcome.judge]}, from ${submissionsText(n)}. The escrow paid them ${ctx.workerPct}% and the treasury ${ctx.feePct}%.`,
          };
        }
        if (status.outcome?.kind === 'void') {
          return { tone: 'neutral', lead: 'Closed with no winner.', body: `No submission was picked. The escrow went back to the poster.` };
        }
        return { tone: 'neutral', lead: 'Cancelled.', body: 'The escrow went back to the poster.' };
    }
  })();
  return { ...copy, body: copy.body + paused };
}

/**
 * Whether a status read is older than what the escrow already shows: the
 * task left Funded (cancelled, paid, refunded) but the read, perhaps from the
 * server's 15-second cache, still has it open. The page then waits for a
 * fresh one rather than show it.
 */
export function openStatusStale(status: OpenTaskStatus, onChainStatus: number | undefined): boolean {
  return onChainStatus !== undefined && onChainStatus !== TaskStatus.Funded && status.phase !== 'closed';
}

/**
 * Whether polling the status can stop: closed, and how it ended is known
 * (an outcome, or a cancel the escrow shows). A closed read with no outcome
 * on a task the escrow shows paid is a read that lagged; keep polling.
 */
export function openStatusSettled(status: OpenTaskStatus, onChainStatus: number | undefined): boolean {
  return status.phase === 'closed' && (!!status.outcome || onChainStatus === TaskStatus.Cancelled);
}

/**
 * Whether the poster may cancel and get the escrow back now, as the escrow's
 * cancelTask allows: still funded, nobody has submitted, and not paused.
 */
export function canCancelOpen(status: OpenTaskStatus | undefined, onChainStatus: number): boolean {
  return !!status && onChainStatus === TaskStatus.Funded && !status.paused && status.phase !== 'closed' && status.submissions === 0;
}

/**
 * An open task's label in a list, from its listing and the escrow status the
 * list already has: taking submissions until its deadline, then past it
 * (the list does not know whether anyone submitted) until it closes as
 * completed or refunded (cancelled or closed with no winner: both return
 * the escrow to the poster).
 */
export function openRowLabel(state: string | undefined, deadline: number | undefined, nowSec: number, onChainStatus?: number): string {
  if (onChainStatus === TaskStatus.Completed || state === 'completed') return 'completed';
  if (onChainStatus === TaskStatus.Cancelled || state === 'failed') return 'refunded';
  return deadline && nowSec >= deadline ? 'deadline passed' : 'taking submissions';
}

/** Whether the viewer may read the submissions now: the poster and the verifier any time, anyone once they close. */
export function canReadSubmissions(status: OpenTaskStatus | undefined, viewer: Viewer): boolean {
  if (viewer !== 'other') return true;
  return !!status && status.phase !== 'submissions';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
