import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RELOAD_WINDOW_MS, isChunkLoadError, reloadForNewBuild, resetChunkReloadForTests } from './chunkReload';

function memoryStorage() {
  const rows = new Map<string, string>();
  return {
    rows,
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => void rows.set(key, value),
  };
}

beforeEach(() => resetChunkReloadForTests());

describe('isChunkLoadError', () => {
  it.each([
    ['Chrome', new TypeError('Failed to fetch dynamically imported module: https://www.blindmarket.xyz/assets/LandingV3-BZA5w9Ap.js')],
    ['Firefox', new TypeError('error loading dynamically imported module: https://www.blindmarket.xyz/assets/PostTask-x1.js')],
    ['Safari', new TypeError('Importing a module script failed.')],
    ['a CSS preload', new Error('Unable to preload CSS for /assets/index-abc.css')],
    ['a 404 served as HTML', new TypeError("Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of \"text/html\".")],
    ['a webpack-style name', Object.assign(new Error('Loading chunk 42 failed.'), { name: 'ChunkLoadError' })],
  ])('recognises %s', (_label, err) => {
    expect(isChunkLoadError(err)).toBe(true);
  });

  it.each([
    ['a render bug', new TypeError("Cannot read properties of undefined (reading 'map')")],
    ['a network error from the API', new TypeError('Failed to fetch')],
    ['nothing', null],
    ['a plain value', 42],
  ])('ignores %s', (_label, err) => {
    expect(isChunkLoadError(err)).toBe(false);
  });
});

describe('reloadForNewBuild', () => {
  it('reloads once, and reports a reload under way to later callers on the same page', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadForNewBuild({ now: 1_000_000, storage, reload })).toBe(true);
    expect(reloadForNewBuild({ now: 1_000_100, storage, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload again within the window after the page came back (a real outage)', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    reloadForNewBuild({ now: 1_000_000, storage, reload });
    resetChunkReloadForTests(); // the reloaded page starts fresh
    expect(reloadForNewBuild({ now: 1_000_000 + RELOAD_WINDOW_MS - 1, storage, reload })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again for a later deploy, once the window has passed', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    reloadForNewBuild({ now: 1_000_000, storage, reload });
    resetChunkReloadForTests();
    expect(reloadForNewBuild({ now: 1_000_000 + RELOAD_WINDOW_MS, storage, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('never reloads without storage to rate-limit with, so blocked site data cannot loop', () => {
    const reload = vi.fn();
    expect(reloadForNewBuild({ now: 1_000_000, storage: null, reload })).toBe(false);
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => {} };
    expect(reloadForNewBuild({ now: 1_000_000, storage: throwing, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
