import { parseAvatar, type SavedAvatar } from './avatarOptions';

/**
 * Development only: avatars kept in this browser, for a local preview that
 * talks to an API without the avatar routes (it answers 404). Production
 * builds never read or write these: every entry point returns early, and
 * Vite drops the code, since import.meta.env.DEV is false there.
 */

const KEY = (address: string) => `bb.avatar.preview:${address.toLowerCase()}`;

let version = 0;
const listeners = new Set<() => void>();

export function readDeviceAvatar(address: string | null | undefined): SavedAvatar | null {
  if (!import.meta.env.DEV || !address) return null;
  try {
    const raw = window.localStorage.getItem(KEY(address));
    return raw ? parseAvatar(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** The first avatar kept for any of `addresses`. */
export function readFirstDeviceAvatar(addresses: readonly string[]): SavedAvatar | null {
  for (const address of addresses) {
    const avatar = readDeviceAvatar(address);
    if (avatar) return avatar;
  }
  return null;
}

/** Keeps `avatar` for each of `addresses`; false when storage is blocked. */
export function saveDeviceAvatar(addresses: readonly string[], avatar: SavedAvatar): boolean {
  if (!import.meta.env.DEV) return false;
  let saved = false;
  try {
    for (const address of addresses) {
      window.localStorage.setItem(KEY(address), JSON.stringify(avatar));
      saved = true;
    }
  } catch {
    saved = false;
  }
  version += 1;
  listeners.forEach((listener) => listener());
  return saved;
}

/** For useSyncExternalStore: redraw avatars after a device save. */
export function subscribeDeviceAvatars(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function deviceAvatarsVersion(): number {
  return version;
}
