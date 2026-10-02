/**
 * Centralised constants for the BlindMarket backend.
 *
 * Why a separate file? Magic numbers scattered across service files drift
 * silently when one is changed and others aren't. Grouping them here makes
 * the defaults discoverable and lets callers override via env vars where
 * appropriate.
 */

// ── A2A Accept Lock (Part 1: Race Condition Fix) ─────────────────────────────

/** How long the Redis accept lock is held per task (seconds). */
export const ACCEPT_LOCK_TTL_S = 30;

/**
 * The longest one /accept keeps re-extending its lock while it settles
 * (seconds). Settlement waits on the indexer, the serial tx queue and a
 * receipt, which can outlast ACCEPT_LOCK_TTL_S; past this cap a request that
 * hangs lets the lock lapse instead of holding the task forever.
 */
export const ACCEPT_LOCK_MAX_HOLD_S = 300;

/** How long accept attempt audit data is kept (seconds). 24h. */
export const ATTEMPT_STREAM_TTL_S = 86_400;

// ── Gas-Liveness (Part 3) ────────────────────────────────────────────────────

/** Seconds after CAS-win before the settlement deadline expires. */
export const SETTLEMENT_DEADLINE_TTL_S = 120;

// ── Cascade / Offers ─────────────────────────────────────────────────────────

/** How long a cascade lives before falling back to CAS-race broadcast. */
export const CASCADE_TTL_MS = 120_000;

/** How long each ranked agent gets an exclusive offer before advancing. */
export const CASCADE_OFFER_MS = 12_000;

/** Exclusive offer window per agent (ms). */
export const OFFER_TTL_MS = 15_000;

// ── Expiry Sweep ─────────────────────────────────────────────────────────────

/** Sweep interval for expired tasks (ms). */
export const SWEEP_INTERVAL_MS = 60_000;

/** Grace period after deadline before terminal expiry (seconds). */
export const EXPIRY_GRACE_SEC = 60;

// ── Agent Runner ─────────────────────────────────────────────────────────────

/** Window for counting restarts (ms). */
export const RESTART_WINDOW_MS = 10 * 60_000;

/** Delay before auto-restart (ms). */
export const RESTART_DELAY_MS = 3_000;

/** Max restarts within window before giving up. */
export const MAX_RESTARTS_IN_WINDOW = 5;

// ── Bulk posting (docs/BULK-POSTING.md) ──────────────────────────────────────

/**
 * The most tasks POST /tasks/batch builds into one createTasks, and the most
 * items POST /storage/upload-batch and /a2a/tasks/index-batch take. The batch
 * size /health/settlement reports is the escrow's MAX_BATCH capped at this.
 */
export const MAX_BATCH_REQUEST = 50;

/**
 * Each wallet's budget, in tasks (or uploads) a minute, on each family of
 * posting routes: uploads (/storage/upload, /upload-batch), builds (/tasks,
 * /tasks/batch) and listings (/a2a/tasks/index, /index-batch). A batch
 * spends one per item; the budget holds this many at once and refills at
 * this rate (2 a second). A 500-task bulk run takes about four minutes of
 * each, and a run posting one task per transaction is slower than that on
 * its own. Per wallet, this sustains no more than the 100 requests a minute
 * one IP had before, for each family.
 */
export const WALLET_POSTING_BUDGET_PER_MIN = 120;
