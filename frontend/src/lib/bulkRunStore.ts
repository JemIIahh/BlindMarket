/**
 * A bulk run's progress, kept per wallet so a reload resumes it. Rows are
 * keyed by their content fingerprint (lib/bulkRows rowFingerprint), and only
 * their status is kept: never a brief. To resume, the poster adds the same
 * file again; rows already posted are skipped.
 *
 * A row that was in flight when the page went away is settled on load:
 * - preparing, or funding (its transaction built but not yet handed to the
 *   wallet): nothing was sent, so it is queued again;
 * - sending or listing with a transaction hash: the escrow may be funded,
 *   so it is shown as funded-not-listed (its pending entry, lib/pendingIndex,
 *   carries the listing request);
 * - sending without a hash: the wallet had it, but the page closed (or the
 *   wallet failed) before it said it broadcast. It may or may not have been
 *   paid, so it is marked unknown and never re-sent automatically; the poster
 *   checks, then may queue it again by hand (mayRequeue).
 *
 * The page settles its rows this way when a run stops, too, so a row the
 * engine left 'sending' offers the same check without a reload.
 *
 * 'sending' is written before the transaction goes to the wallet (the
 * write-ahead mark, lib/bulkPost), so a paid row can't come back as queued.
 */
import type { RowStatus } from './bulkPost';

const PREFIX = 'blindmarket:bulkRun:';
const TTL_MS = 7 * 24 * 3600 * 1000;

export const MAYBE_PAID = "May have been paid: the page closed while this row's payment was being sent. Check My tasks before posting it again.";

export type StoredStatus = RowStatus & { row: number };

export interface StoredRun {
  v: 1;
  startedAt: number;
  updatedAt: number;
  fileName?: string;
  statuses: Record<string, StoredStatus>;
}

function key(wallet: string): string {
  return PREFIX + wallet.toLowerCase();
}

export function loadRun(wallet: string): StoredRun | null {
  try {
    const raw = localStorage.getItem(key(wallet));
    if (!raw) return null;
    const run = JSON.parse(raw) as StoredRun;
    if (run?.v !== 1 || typeof run.statuses !== 'object' || !run.statuses) return null;
    if (Date.now() - (run.updatedAt ?? 0) > TTL_MS) {
      localStorage.removeItem(key(wallet));
      return null;
    }
    return run;
  } catch {
    return null;
  }
}

/** Save the run; false when storage is full or blocked. Nothing is sent for
 *  a row whose 'sending' mark didn't save (lib/bulkPost). */
export function saveRun(wallet: string, run: StoredRun): boolean {
  try {
    localStorage.setItem(key(wallet), JSON.stringify({ ...run, updatedAt: Date.now() }));
    return true;
  } catch (e) {
    console.warn('[bulkRun] could not save progress:', (e as Error).message);
    return false;
  }
}

export function clearRun(wallet: string): void {
  try {
    localStorage.removeItem(key(wallet));
  } catch { /* storage blocked: nothing to clear */ }
}

/** Statuses as they stand after a reload (see the note at the top). */
export function settleInFlight(statuses: Record<string, StoredStatus>): Record<string, StoredStatus> {
  const out: Record<string, StoredStatus> = {};
  for (const [fp, s] of Object.entries(statuses)) {
    const inFlight = s.state === 'funding' || s.state === 'sending' || s.state === 'listing';
    if (inFlight && s.txHash) {
      out[fp] = { ...s, state: 'unlisted', error: 'The run stopped while this was being paid for. Retry listing; do not post this row again.' };
    } else if (s.state === 'preparing' || s.state === 'queued' || s.state === 'funding') {
      out[fp] = { row: s.row, state: 'queued' };
    } else if (inFlight) {
      // The engine's own words when it left the row so, else a closed page.
      out[fp] = { ...s, state: 'unknown', error: s.error ?? MAYBE_PAID };
    } else {
      out[fp] = s;
    }
  }
  return out;
}

/** Rows a resumed run may send: queued (or never tried) and failed-before-paying. */
export function isSendable(status: StoredStatus | undefined): boolean {
  return !status || status.state === 'queued' || status.state === 'failed';
}

/**
 * Whether the poster may queue a row again by hand: only one whose payment is
 * unknown and has no transaction hash. With a hash the wallet broadcast it,
 * so it is checked on the explorer and never queued again from here.
 */
export function mayRequeue(status: StoredStatus | undefined): boolean {
  return status?.state === 'unknown' && !status.txHash;
}
