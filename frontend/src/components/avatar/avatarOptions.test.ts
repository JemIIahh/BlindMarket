import { describe, expect, it } from 'vitest';
import { avataaars } from '@dicebear/collection';
import {
  AVATAR_PALETTES,
  AVATAR_PARTS,
  avatarDataUri,
  avatarFromSeed,
  normalizeSeed,
  optionLabel,
  parseAvatar,
  randomAvatar,
  type SavedAvatar,
} from './avatarOptions';

type SchemaProp = { items?: { enum?: string[]; pattern?: string }; minimum?: number; maximum?: number };
const schema = (avataaars as unknown as { schema: { properties: Record<string, SchemaProp> } }).schema.properties;

const SEED = '0xabcdef0123456789abcdef0123456789abcdef01';

describe('the builder offers what DiceBear avataaars draws', () => {
  // A DiceBear upgrade that changes these lists fails here. Update this file
  // and backend/src/services/avatarStore.ts together, or saves start failing.
  it.each(Object.keys(AVATAR_PARTS))('%s matches the style schema exactly', (part) => {
    expect([...AVATAR_PARTS[part as keyof typeof AVATAR_PARTS]]).toEqual(schema[part].items?.enum);
  });

  it.each(Object.keys(AVATAR_PALETTES))('%s swatches are colours the schema accepts', (key) => {
    const pattern = new RegExp(schema[key].items!.pattern!);
    for (const color of AVATAR_PALETTES[key as keyof typeof AVATAR_PALETTES]) expect(color).toMatch(pattern);
  });
});

describe('avatarFromSeed', () => {
  it('spells out the exact face a seed already gets, so the builder starts from it', () => {
    for (const seed of [SEED, '0x1111111111111111111111111111111111111111', 'task-0x42']) {
      const avatar = avatarFromSeed(seed);
      expect(avatarDataUri('any-other-seed', avatar)).toBe(avatarDataUri(seed, null));
    }
  });

  it('gives a full avatar the backend accepts', () => {
    const avatar = avatarFromSeed(SEED);
    expect(parseAvatar(avatar)).toEqual(avatar);
    expect(Object.keys(avatar)).toHaveLength(17);
  });
});

describe('randomAvatar', () => {
  it('only makes avatars parseAvatar keeps whole', () => {
    for (let i = 0; i < 50; i++) {
      const avatar = randomAvatar();
      expect(parseAvatar(avatar)).toEqual(avatar);
    }
  });
});

describe('parseAvatar', () => {
  const good: SavedAvatar = { top: ['bob'], eyes: ['wink'], skinColor: ['D08B5B'], topProbability: 100 };

  it('keeps valid parts, lowercasing colours', () => {
    expect(parseAvatar(good)).toEqual({ top: ['bob'], eyes: ['wink'], skinColor: ['d08b5b'], topProbability: 100 });
  });

  it('drops keys and values the builder cannot make, so nothing else reaches the SVG', () => {
    expect(
      parseAvatar({
        ...good,
        seed: 'x',
        size: 9999,
        mouth: ['<script>'],
        hairColor: ['"/><image href=x>'],
        eyebrows: ['angry', 'default'],
        accessoriesProbability: 250,
      }),
    ).toEqual(parseAvatar(good));
  });

  it('is null for anything that is not an avatar', () => {
    for (const v of [null, undefined, 'bob', 42, [], {}, { seed: 'x' }]) expect(parseAvatar(v)).toBeNull();
  });
});

describe('helpers', () => {
  it('lowercases seeds so one wallet is one face, whatever its case', () => {
    expect(normalizeSeed('0xAbCdEf0123456789aBcDeF0123456789AbCdEf01')).toBe(SEED);
    expect(avatarDataUri('0xAbCdEf0123456789aBcDeF0123456789AbCdEf01')).toBe(avatarDataUri(SEED));
    expect(avatarDataUri('0x' + 'AB'.repeat(32))).toBe(avatarDataUri('0x' + 'ab'.repeat(32)));
  });

  it('labels options in plain words', () => {
    expect(optionLabel('shortFlat')).toBe('Short flat');
    expect(optionLabel('winterHat02')).toBe('Winter hat 02');
    expect(optionLabel('theCaesarAndSidePart')).toBe('The caesar and side part');
    expect(optionLabel('xDizzy')).toBe('X dizzy');
  });
});
