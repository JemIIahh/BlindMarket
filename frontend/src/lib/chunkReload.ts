/**
 * Every page is a lazy chunk (App.tsx). After a deploy the site serves only the
 * new build, so a tab opened before it asks for chunk names that now 404, and
 * the page used to fall into the ErrorBoundary's "Something went wrong" until
 * the person reloaded by hand. A dropped connection fails the same way.
 *
 * The fix is one automatic reload, which fetches the current index.html and
 * its chunk names. It is rate-limited through sessionStorage, so a real outage
 * (the chunk still fails after the reload) shows an error instead of looping.
 */

// Chrome, Firefox and Safari word a failed dynamic import differently; the
// rest are a CSS preload failing and a 404 answered with an HTML page.
const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (?:CSS )?chunk \S+ failed|ChunkLoadError|Expected a JavaScript(?:-or-Wasm)? module script|is not a valid JavaScript MIME type/i;

/** True for a page or component chunk that failed to download. */
export function isChunkLoadError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const e = err as { name?: unknown; message?: unknown };
  const name = typeof e.name === 'string' ? e.name : '';
  const message = typeof e.message === 'string' ? e.message : typeof err === 'string' ? err : '';
  return CHUNK_ERROR.test(`${name} ${message}`);
}

const LAST_RELOAD_KEY = 'bb.chunkReloadAt';
/** A chunk failing again this soon after a reload is an outage, not a stale tab. */
export const RELOAD_WINDOW_MS = 30_000;

let reloading = false;

function sessionStore(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Reloads the page once to pick up the current build. Returns true when a
 * reload is under way (started now, or earlier on this page), false when one
 * already ran within RELOAD_WINDOW_MS or there is no sessionStorage to rate
 * limit with (blocked site data): the caller then shows an error instead.
 */
export function reloadForNewBuild({
  now = Date.now(),
  storage = sessionStore(),
  reload = () => window.location.reload(),
}: {
  now?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  reload?: () => void;
} = {}): boolean {
  if (reloading) return true;
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(LAST_RELOAD_KEY) || 0);
    if (now - last < RELOAD_WINDOW_MS) return false;
    storage.setItem(LAST_RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reloading = true;
  reload();
  return true;
}

/** Test hook: forget a reload started in this module instance. */
export function resetChunkReloadForTests(): void {
  reloading = false;
}
