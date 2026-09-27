import { useMemo, useSyncExternalStore } from 'react';
import { avatarDataUri, parseAvatar } from './avatarOptions';
import { deviceAvatarsVersion, readDeviceAvatar, subscribeDeviceAvatars } from './deviceAvatars';

/**
 * The options a person saved in the avatar builder (DiceBear "avataaars"
 * options: top, eyes, mouth, colours…). Absent means they never made one.
 */
export type AvatarConfig = Record<string, unknown>;

/**
 * A person's avatar. With their saved config it draws that; without one it
 * draws a stable default from `seed` (the poster's address, or the task id),
 * so the same poster always looks the same. Round, like the landing page's
 * circles, unless `className` sets its own radius.
 */
export function PosterAvatar({
  config,
  seed,
  size = 28,
  className = '',
  label = '',
}: {
  config?: AvatarConfig | null;
  seed: string;
  size?: number;
  className?: string;
  label?: string;
}) {
  // Development previews against an API without avatar routes keep the
  // viewer's own avatar in this browser (deviceAvatars.ts); always 0 in production.
  const deviceVersion = useSyncExternalStore(subscribeDeviceAvatars, deviceAvatarsVersion, () => 0);
  const uri = useMemo(() => {
    const saved = parseAvatar(config) ?? (import.meta.env.DEV ? readDeviceAvatar(seed) : null);
    return avatarDataUri(seed, saved);
  }, [config, seed, deviceVersion]); // deviceVersion: re-read after a save in this browser
  const shape = /(^|\s)rounded(-|\s|$)/.test(className) ? '' : 'rounded-full';
  return <img src={uri} width={size} height={size} alt={label} className={`shrink-0 bg-surface-2 ${shape} ${className}`} />;
}
