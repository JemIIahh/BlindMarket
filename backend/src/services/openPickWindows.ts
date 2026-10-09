/**
 * The escrow's open-task pick windows (BlindEscrow MIN/MAX_CREATOR_WINDOW,
 * VERIFIER_PICK_WINDOW, BACKUP_PICK_WINDOW), in seconds. Served to clients by
 * GET /a2a/open-submission and checked by POST /tasks before a createTaskOpen
 * is built.
 */
export const OPEN_PICK_WINDOWS = {
  creatorMinSec: 3600,
  creatorMaxSec: 7 * 86_400,
  verifierSec: 48 * 3600,
  backupSec: 48 * 3600,
};
