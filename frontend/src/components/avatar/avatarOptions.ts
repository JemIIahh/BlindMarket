import { createAvatar } from '@dicebear/core';
import { avataaars } from '@dicebear/collection';

/**
 * What the avatar builder offers, all of it drawn by DiceBear's "avataaars"
 * style (v9). The backend accepts exactly these parts and values
 * (backend/src/services/avatarStore.ts): keep the two lists in step.
 * avatarOptions.test.ts checks this file against DiceBear's own schema.
 */

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

export type AvatarPart = keyof typeof AVATAR_PARTS;

/** Headwear covers the hair, so these take a hat colour instead of a hair colour. */
export const HEADWEAR: readonly string[] = ['hat', 'hijab', 'turban', 'winterHat1', 'winterHat02', 'winterHat03', 'winterHat04'];

const HAIR = ['a55728', '2c1b18', 'b58143', 'd6b370', '724133', '4a312c', 'f59797', 'ecdcbf', 'c93305', 'e8e1e1'];
const FABRIC = ['262e33', '65c9ff', '5199e4', '25557c', 'e6e6e6', '929598', '3c4f5c', 'b1e2ff', 'a7ffc4', 'ffdeb5', 'ffafb9', 'ffffb1', 'ff488e', 'ff5c5c', 'ffffff'];

/** Swatches per colour option: DiceBear's own palettes, and for the
 *  background calm tones that sit with the landing palette: cream, paper,
 *  light gray, sand, sage, sky, graphite and ink. The first background is the
 *  builder's default. */
export const AVATAR_PALETTES = {
  hairColor: HAIR,
  facialHairColor: HAIR,
  hatColor: FABRIC,
  accessoriesColor: FABRIC,
  clothesColor: FABRIC.filter((c) => c !== 'ffdeb5'),
  skinColor: ['614335', 'd08b5b', 'ae5d29', 'edb98a', 'ffdbb4', 'fd9841', 'f8d25c'],
  backgroundColor: ['f5efe0', 'f4f4f2', 'e4e4e7', 'e9dcc6', 'd5e2d0', 'd6e4f0', '3f3f46', '101013'],
} as const;

export type AvatarColor = keyof typeof AVATAR_PALETTES;

/** A saved avatar: one choice per part, each as a one-item list (how DiceBear
 *  takes options), and 0 or 100 for the parts that can be left off. */
export type SavedAvatar = {
  top?: string[];
  eyes?: string[];
  eyebrows?: string[];
  mouth?: string[];
  facialHair?: string[];
  accessories?: string[];
  clothing?: string[];
  clothingGraphic?: string[];
  hairColor?: string[];
  hatColor?: string[];
  facialHairColor?: string[];
  accessoriesColor?: string[];
  clothesColor?: string[];
  skinColor?: string[];
  backgroundColor?: string[];
  topProbability?: number;
  facialHairProbability?: number;
  accessoriesProbability?: number;
};

const COLOR_KEYS = ['hairColor', 'hatColor', 'facialHairColor', 'accessoriesColor', 'clothesColor', 'skinColor', 'backgroundColor'] as const;
const PROBABILITY_KEYS = ['topProbability', 'facialHairProbability', 'accessoriesProbability'] as const;

/** An avatar from anywhere we don't control (an API answer, this browser's
 *  storage), cut down to the keys and values the builder can make. Anything
 *  else is dropped, so nothing unexpected reaches DiceBear or the SVG it
 *  writes. Null when nothing usable is left. */
export function parseAvatar(value: unknown): SavedAvatar | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const only = Array.isArray(v) && v.length === 1 && typeof v[0] === 'string' ? (v[0] as string) : null;
    if (key in AVATAR_PARTS) {
      if (only && (AVATAR_PARTS[key as AvatarPart] as readonly string[]).includes(only)) out[key] = [only];
    } else if ((COLOR_KEYS as readonly string[]).includes(key)) {
      if (only && /^[0-9a-fA-F]{6}$/.test(only)) out[key] = [only.toLowerCase()];
    } else if ((PROBABILITY_KEYS as readonly string[]).includes(key)) {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100) out[key] = v;
    }
  }
  return Object.keys(out).length > 0 ? (out as SavedAvatar) : null;
}

/** DiceBear takes a seed as-is, so 0xAbC… and 0xabc… would be two faces. */
export function normalizeSeed(seed: string): string {
  return seed.toLowerCase();
}

const first = <T extends string>(list: readonly T[]) => list[0];

/**
 * The face DiceBear draws for `seed` with no saved avatar (what a poster's
 * tasks show until they make one), spelled out as a full avatar, so the
 * builder starts from the face people already see.
 */
export function avatarFromSeed(seed: string): SavedAvatar {
  const extra = createAvatar(avataaars, { seed: normalizeSeed(seed) }).toJson().extra as Record<string, unknown>;
  const part = (key: AvatarPart): string | undefined => {
    const v = extra[key];
    return typeof v === 'string' && (AVATAR_PARTS[key] as readonly string[]).includes(v) ? v : undefined;
  };
  const color = (key: AvatarColor): string => {
    const v = typeof extra[key] === 'string' ? (extra[key] as string).replace(/^#/, '').toLowerCase() : '';
    return /^[0-9a-f]{6}$/.test(v) ? v : AVATAR_PALETTES[key][0];
  };
  const top = part('top');
  const facialHair = part('facialHair');
  const accessories = part('accessories');
  return {
    top: [top ?? 'shortFlat'],
    topProbability: top ? 100 : 0,
    hairColor: [color('hairColor')],
    hatColor: [color('hatColor')],
    eyes: [part('eyes') ?? 'default'],
    eyebrows: [part('eyebrows') ?? 'defaultNatural'],
    mouth: [part('mouth') ?? 'smile'],
    facialHair: [facialHair ?? first(AVATAR_PARTS.facialHair)],
    facialHairProbability: facialHair ? 100 : 0,
    facialHairColor: [color('facialHairColor')],
    accessories: [accessories ?? first(AVATAR_PARTS.accessories)],
    accessoriesProbability: accessories ? 100 : 0,
    accessoriesColor: [color('accessoriesColor')],
    clothing: [part('clothing') ?? 'hoodie'],
    clothesColor: [color('clothesColor')],
    clothingGraphic: [part('clothingGraphic') ?? first(AVATAR_PARTS.clothingGraphic)],
    skinColor: [color('skinColor')],
  };
}

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** A random full avatar for the builder's Randomise button. */
export function randomAvatar(): SavedAvatar {
  return {
    top: [pick(AVATAR_PARTS.top)],
    topProbability: Math.random() < 0.08 ? 0 : 100,
    hairColor: [pick(AVATAR_PALETTES.hairColor)],
    hatColor: [pick(AVATAR_PALETTES.hatColor)],
    eyes: [pick(AVATAR_PARTS.eyes)],
    eyebrows: [pick(AVATAR_PARTS.eyebrows)],
    mouth: [pick(AVATAR_PARTS.mouth)],
    facialHair: [pick(AVATAR_PARTS.facialHair)],
    facialHairProbability: Math.random() < 0.25 ? 100 : 0,
    facialHairColor: [pick(AVATAR_PALETTES.facialHairColor)],
    accessories: [pick(AVATAR_PARTS.accessories)],
    accessoriesProbability: Math.random() < 0.3 ? 100 : 0,
    accessoriesColor: [pick(AVATAR_PALETTES.accessoriesColor)],
    clothing: [pick(AVATAR_PARTS.clothing)],
    clothesColor: [pick(AVATAR_PALETTES.clothesColor)],
    clothingGraphic: [pick(AVATAR_PARTS.clothingGraphic)],
    skinColor: [pick(AVATAR_PALETTES.skinColor)],
    backgroundColor: [pick(AVATAR_PALETTES.backgroundColor)],
  };
}

/** "shortFlat" → "Short flat", "winterHat02" → "Winter hat 02". */
export function optionLabel(value: string): string {
  const words = value
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The avatar as an SVG data URI. `seed` fills any part the avatar leaves open. */
export function avatarDataUri(seed: string, config?: SavedAvatar | null, extra?: { scale?: number; translateY?: number }): string {
  // Callers pass avatars made from the lists above (the builder, parseAvatar).
  const options: Record<string, unknown> = { seed: normalizeSeed(seed), ...(config ?? {}), ...(extra ?? {}) };
  return createAvatar(avataaars, options).toDataUri();
}
