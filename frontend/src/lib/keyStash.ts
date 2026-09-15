/**
 * AES-key stash for the just-in-time wrap flow.
 *
 * When a task is posted without a full executor set (or none at all), the
 * frontend keeps the AES key in localStorage so the poster can wrap it to
 * bidders that register *after* the post. The key never leaves this browser
 * unencrypted — wrap-to-bidder happens in JS, the backend only ever sees
 * ECIES blobs.
 *
 * Trade-off acknowledged in PITCH.md: if the poster clears the browser /
 * switches devices before bids arrive, the task becomes uncompletable. This
 * is the v1 cost of preserving the architectural-blindness invariant without
 * a TEE-held key (v2 roadmap).
 *
 * M4 (audit): entries used to live forever — clearAesKey had no callers and
 * no TTL existed, so any XSS could decrypt every brief ever posted from the
 * browser. Entries are now timestamped and expire after KEY_TTL_MS; every
 * stash triggers a bounded sweep, and reads lazily evict expired entries.
 */

const PREFIX = 'blindmarket:aesKey:';
// 30 days — generous vs task deadlines (max 90d escrow, but wrap-to-bidder
// only matters while the task is open for bids, i.e. days not months).
const KEY_TTL_MS = 30 * 24 * 3600 * 1000;

function hexFromBytes(b: Uint8Array): string {
  return Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('odd-length hex in keyStash');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function normalize(taskHash: string): string {
  return taskHash.startsWith('0x') ? taskHash.toLowerCase() : `0x${taskHash.toLowerCase()}`;
}

function readEntry(taskHash: string): { hex: string; at: number } | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(PREFIX + normalize(taskHash));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; at?: unknown };
    if (parsed && typeof parsed.v === 'string' && typeof parsed.at === 'number') {
      return { hex: parsed.v, at: parsed.at };
    }
    return null;
  } catch {
    // Legacy pre-TTL format (bare hex) — treat as already expired so the
    // next sweep evicts it instead of grandfathering it forever.
    return { hex: raw, at: 0 };
  }
}

function isExpired(at: number): boolean {
  return Date.now() - at > KEY_TTL_MS;
}

/** Evict every expired entry. Bounded by the stash's own keyspace. */
export function purgeExpiredKeys(): number {
  let purged = 0;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(PREFIX)) continue;
      const raw = localStorage.getItem(k);
      let at = 0;
      try {
        const parsed = JSON.parse(raw ?? '') as { at?: unknown };
        if (parsed && typeof parsed.at === 'number') at = parsed.at;
      } catch {
        at = 0; // legacy bare-hex format — expired by definition
      }
      if (isExpired(at)) doomed.push(k);
    }
    for (const k of doomed) {
      try {
        localStorage.removeItem(k);
        purged++;
      } catch { /* keep sweeping */ }
    }
  } catch { /* storage blocked — nothing to purge */ }
  return purged;
}

export function stashAesKey(taskHash: string, key: Uint8Array): void {
  try {
    localStorage.setItem(
      PREFIX + normalize(taskHash),
      JSON.stringify({ v: hexFromBytes(key), at: Date.now() }),
    );
  } catch (e) {
    // Storage full / disabled — the task still posts, the user just can't
    // wrap to post-hoc bidders from this browser. Log so it's visible.
    console.warn('[keyStash] failed to persist AES key:', (e as Error).message);
  }
  // Every stash pays for a sweep — the wrap consumer is not yet wired, so no
  // read path can be relied on to trigger eviction.
  purgeExpiredKeys();
}

// NB: with storage fully blocked (Safari "Block All Cookies", strict
// webviews) ANY localStorage access throws, not just setItem — every helper
// here degrades to "no key available" instead of crashing its caller.
export function getAesKey(taskHash: string): Uint8Array | null {
  const entry = readEntry(taskHash);
  if (!entry) return null;
  if (isExpired(entry.at)) {
    clearAesKey(taskHash);
    return null;
  }
  try {
    return hexToBytes(entry.hex);
  } catch {
    return null;
  }
}

export function clearAesKey(taskHash: string): void {
  try {
    localStorage.removeItem(PREFIX + normalize(taskHash));
  } catch {}
}

/** List every taskHash we currently hold a NON-EXPIRED key for. Used by the
 *  bid-watcher to know which tasks it should poll for new bidders. */
export function listStashedHashes(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
    }
  } catch {
    return out;
  }
  // Filter through the reader so expired entries are evicted, not returned.
  return out.filter((h) => getAesKey(h) !== null);
}
