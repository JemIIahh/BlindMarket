import { z } from 'zod';
import { redis } from './redis.js';

/**
 * A person's avatar: the options they picked in the web app's builder for
 * DiceBear's "avataaars" style (v9), which draws it in the browser. Keyed by
 * the one address their tasks are posted from (the session address, which
 * /tasks/index records as posterAddress), so a task's public posterAddress is
 * enough to show its poster's face.
 *
 * Never copy an avatar to a person's other linked wallets: the same face on
 * two addresses would publicly tie those wallets, and an anonymous poster's
 * tasks, to one account.
 *
 * Every accepted value is one DiceBear 9's avataaars schema allows, and every
 * part is a single choice, so a saved avatar draws the same everywhere and a
 * stored row is a few hundred bytes at most. Keep these lists in step with
 * frontend/src/components/avatar/avatarOptions.ts.
 */

const KEY = (address: string) => `profile:avatar:${address.toLowerCase()}`;

export const AVATAR_PARTS = {
  top: [
    'hat', 'hijab', 'turban', 'winterHat1', 'winterHat02', 'winterHat03', 'winterHat04',
    'bob', 'bun', 'curly', 'curvy', 'dreads', 'frida', 'fro', 'froBand', 'longButNotTooLong',
    'miaWallace', 'shavedSides', 'straight02', 'straight01', 'straightAndStrand', 'dreads01',
    'dreads02', 'frizzle', 'shaggy', 'shaggyMullet', 'shortCurly', 'shortFlat', 'shortRound',
    'shortWaved', 'sides', 'theCaesar', 'theCaesarAndSidePart', 'bigHair',
  ],
  eyes: ['closed', 'cry', 'default', 'eyeRoll', 'happy', 'hearts', 'side', 'squint', 'surprised', 'winkWacky', 'wink', 'xDizzy'],
  eyebrows: [
    'angryNatural', 'defaultNatural', 'flatNatural', 'frownNatural', 'raisedExcitedNatural',
    'sadConcernedNatural', 'unibrowNatural', 'upDownNatural', 'angry', 'default', 'raisedExcited',
    'sadConcerned', 'upDown',
  ],
  mouth: ['concerned', 'default', 'disbelief', 'eating', 'grimace', 'sad', 'screamOpen', 'serious', 'smile', 'tongue', 'twinkle', 'vomit'],
  facialHair: ['beardLight', 'beardMajestic', 'beardMedium', 'moustacheFancy', 'moustacheMagnum'],
  accessories: ['kurt', 'prescription01', 'prescription02', 'round', 'sunglasses', 'wayfarers', 'eyepatch'],
  clothing: [
    'blazerAndShirt', 'blazerAndSweater', 'collarAndSweater', 'graphicShirt', 'hoodie', 'overall',
    'shirtCrewNeck', 'shirtScoopNeck', 'shirtVNeck',
  ],
  clothingGraphic: ['bat', 'bear', 'cumbia', 'deer', 'diamond', 'hola', 'pizza', 'resist', 'skull', 'skullOutline'],
} as const;

/** The colour options, each a six-digit hex colour as DiceBear takes it (no #). */
export const AVATAR_COLORS = [
  'hairColor', 'hatColor', 'facialHairColor', 'accessoriesColor', 'clothesColor', 'skinColor', 'backgroundColor',
] as const;

/** How often an optional part shows. The builder sends 0 (none) or 100. */
export const AVATAR_PROBABILITIES = ['topProbability', 'facialHairProbability', 'accessoriesProbability'] as const;

const one = <T extends readonly [string, ...string[]]>(values: T) => z.array(z.enum(values)).length(1);
const hex = z.array(z.string().regex(/^[0-9a-fA-F]{6}$/, 'colours are six hex digits, no #')).length(1);
const probability = z.number().int().min(0).max(100);

export const avatarConfigSchema = z.object({
  top: one(AVATAR_PARTS.top),
  eyes: one(AVATAR_PARTS.eyes),
  eyebrows: one(AVATAR_PARTS.eyebrows),
  mouth: one(AVATAR_PARTS.mouth),
  facialHair: one(AVATAR_PARTS.facialHair),
  accessories: one(AVATAR_PARTS.accessories),
  clothing: one(AVATAR_PARTS.clothing),
  clothingGraphic: one(AVATAR_PARTS.clothingGraphic),
  hairColor: hex,
  hatColor: hex,
  facialHairColor: hex,
  accessoriesColor: hex,
  clothesColor: hex,
  skinColor: hex,
  backgroundColor: hex,
  topProbability: probability,
  facialHairProbability: probability,
  accessoriesProbability: probability,
}).partial().strict();

export type AvatarConfig = z.infer<typeof avatarConfigSchema>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A row read back from Redis, re-checked: anything that no longer parses (a
 *  hand edit, an older format) is treated as no avatar rather than served. */
function parseStored(raw: string | null | undefined): AvatarConfig | null {
  if (!raw) return null;
  try {
    const parsed = avatarConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function getAvatar(address: string): Promise<AvatarConfig | null> {
  if (!ADDRESS.test(address)) return null;
  return parseStored(await redis.get(KEY(address)));
}

/** Saves the avatar under the caller's posting address, and only that one
 *  (see the note at the top). An empty avatar removes it: their tasks go back
 *  to the default face. */
export async function setAvatar(address: string, avatar: AvatarConfig): Promise<void> {
  if (!ADDRESS.test(address)) throw new Error('setAvatar: not a 20-byte hex address');
  const parsed = avatarConfigSchema.parse(avatar);
  if (Object.keys(parsed).length === 0) await redis.del(KEY(address));
  else await redis.set(KEY(address), JSON.stringify(parsed));
}

/** Saved avatars for many addresses in one round trip, keyed by lowercased address. */
export async function getAvatars(addresses: readonly string[]): Promise<Map<string, AvatarConfig>> {
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => ADDRESS.test(a));
  const out = new Map<string, AvatarConfig>();
  if (unique.length === 0) return out;
  const pipe = redis.pipeline();
  for (const address of unique) pipe.get(KEY(address));
  const results = (await pipe.exec()) ?? [];
  unique.forEach((address, i) => {
    const [err, raw] = results[i] ?? [];
    const avatar = err ? null : parseStored(raw as string | null);
    if (avatar) out.set(address, avatar);
  });
  return out;
}

/** The longest a task list waits for avatars before it goes out without them. */
const JOIN_TIMEOUT_MS = 1_500;
/** A Redis outage fails every browse request's lookup; warn once a minute, not once per request. */
const WARN_EVERY_MS = 60_000;
let lastWarnAt = 0;

/**
 * Adds `posterAvatar` to each public task meta whose poster saved one. Faces
 * are decoration: a slow or failing Redis leaves the metas as they were
 * rather than slowing or failing the task list they ride on.
 */
export async function withPosterAvatars<M extends { posterAddress?: string }>(
  metas: readonly M[],
): Promise<Array<M & { posterAvatar?: AvatarConfig }>> {
  const posters = metas.map((m) => m.posterAddress).filter((a): a is string => typeof a === 'string' && ADDRESS.test(a));
  if (posters.length === 0) return [...metas];
  let found: Map<string, AvatarConfig>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    found = await Promise.race([
      getAvatars(posters),
      new Promise<Map<string, AvatarConfig>>((resolve) => {
        timer = setTimeout(() => resolve(new Map()), JOIN_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    if (Date.now() - lastWarnAt >= WARN_EVERY_MS) {
      lastWarnAt = Date.now();
      console.warn('[avatars] poster avatar lookup failed, listing without them:', (err as Error).message);
    }
    found = new Map();
  } finally {
    clearTimeout(timer);
  }
  return metas.map((meta) => {
    const avatar = meta.posterAddress ? found.get(meta.posterAddress.toLowerCase()) : undefined;
    return avatar ? { ...meta, posterAvatar: avatar } : meta;
  });
}
