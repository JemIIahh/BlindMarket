/**
 * Funded-but-unlisted tasks, kept so the poster can finish listing them.
 *
 * PostTask funds the escrow first and lists the task (POST
 * /api/v1/a2a/tasks/index) second. When every listing attempt failed, the
 * task used to vanish from the poster's view: My Tasks is built from indexed
 * tasks only, so there was no page to cancel it from, and posting again
 * funded a second escrow (a fresh AES key means a fresh hash). The listing
 * request is saved here before it is sent and removed once it lands, so a
 * failure leaves a "Retry listing" action instead. Re-listing is safe: the
 * backend lets the poster who first indexed a hash index it again.
 *
 * What is stored is exactly the index request: ECIES-wrapped key blobs and
 * the storage pointer, never the AES key or a private brief in plaintext
 * (a public task's brief is public by definition). Entries expire after
 * ENTRY_TTL_MS; every read and write tolerates blocked storage.
 */

const PREFIX = 'blindmarket:pendingIndex:';
const ENTRY_TTL_MS = 7 * 24 * 3600 * 1000;

export interface PendingIndex {
  taskHash: string;
  txHash: string;
  /** The poster's address, so a shared browser shows each poster only their own. */
  poster: string;
  /** The POST /api/v1/a2a/tasks/index body, as it was first sent. */
  body: Record<string, unknown>;
  at: number;
}

function key(taskHash: string): string {
  return PREFIX + taskHash.toLowerCase();
}

function parse(raw: string | null): PendingIndex | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<PendingIndex>;
    if (typeof p.taskHash === 'string' && typeof p.txHash === 'string' && typeof p.poster === 'string'
      && p.body && typeof p.body === 'object' && typeof p.at === 'number') {
      return p as PendingIndex;
    }
  } catch { /* corrupt entry — treated as absent */ }
  return null;
}

export function savePendingIndex(entry: Omit<PendingIndex, 'at'>): void {
  try {
    localStorage.setItem(key(entry.taskHash), JSON.stringify({ ...entry, poster: entry.poster.toLowerCase(), at: Date.now() }));
  } catch (e) {
    // Storage full / blocked: the listing still goes ahead, there is just no
    // retry entry if it fails.
    console.warn('[pendingIndex] failed to save the listing request:', (e as Error).message);
  }
}

export function clearPendingIndex(taskHash: string): void {
  try {
    localStorage.removeItem(key(taskHash));
  } catch { /* storage blocked — nothing to clear */ }
}

/** This poster's unexpired entries, oldest first. Expired or corrupt ones are evicted. */
export function listPendingIndex(poster: string): PendingIndex[] {
  const mine: PendingIndex[] = [];
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      const entry = parse(localStorage.getItem(k));
      if (!entry || Date.now() - entry.at > ENTRY_TTL_MS) {
        doomed.push(k);
        continue;
      }
      if (entry.poster === poster.toLowerCase()) mine.push(entry);
    }
    for (const k of doomed) {
      try { localStorage.removeItem(k); } catch { /* keep sweeping */ }
    }
  } catch { /* storage blocked — nothing listed */ }
  return mine.sort((a, b) => a.at - b.at);
}
