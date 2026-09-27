import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Avatars: what may be saved, where it is saved, and how task lists pick
 * them up. Redis is an in-memory map with just the calls avatarStore makes.
 */
const store = vi.hoisted(() => ({ rows: new Map<string, string>(), failPipeline: false, hangPipeline: false }));

vi.mock('./redis.js', () => {
  const pipeline = () => {
    const ops: Array<() => [Error | null, unknown]> = [];
    const pipe = {
      get(key: string) {
        ops.push(() => [null, store.rows.get(key) ?? null]);
        return pipe;
      },
      set(key: string, value: string) {
        ops.push(() => {
          store.rows.set(key, value);
          return [null, 'OK'];
        });
        return pipe;
      },
      del(key: string) {
        ops.push(() => [null, store.rows.delete(key) ? 1 : 0]);
        return pipe;
      },
      exec: async () => {
        if (store.failPipeline) throw new Error('Command timed out');
        if (store.hangPipeline) return new Promise<never>(() => {});
        return ops.map((op) => op());
      },
    };
    return pipe;
  };
  return {
    redis: {
      get: async (key: string) => store.rows.get(key) ?? null,
      set: async (key: string, value: string) => {
        store.rows.set(key, value);
        return 'OK';
      },
      del: async (key: string) => (store.rows.delete(key) ? 1 : 0),
      pipeline,
    },
  };
});

const { avatarConfigSchema, getAvatar, getAvatars, setAvatar, withPosterAvatars } = await import('./avatarStore.js');

const ALICE = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const BOB = '0x2222222222222222222222222222222222222222';

/** What the web app's builder sends: every part, one choice each. */
const FULL = {
  top: ['shortFlat'],
  eyes: ['happy'],
  eyebrows: ['defaultNatural'],
  mouth: ['smile'],
  facialHair: ['beardLight'],
  accessories: ['round'],
  clothing: ['hoodie'],
  clothingGraphic: ['pizza'],
  hairColor: ['2c1b18'],
  hatColor: ['262e33'],
  facialHairColor: ['2c1b18'],
  accessoriesColor: ['262e33'],
  clothesColor: ['ff5c5c'],
  skinColor: ['edb98a'],
  backgroundColor: ['FF6A3D'],
  topProbability: 100,
  facialHairProbability: 0,
  accessoriesProbability: 100,
};

beforeEach(() => {
  store.rows.clear();
  store.failPipeline = false;
  store.hangPipeline = false;
});

describe('avatarConfigSchema', () => {
  it("accepts the builder's full avatar", () => {
    expect(avatarConfigSchema.parse(FULL)).toEqual(FULL);
  });

  it.each([
    ['an option DiceBear avataaars does not have', { ...FULL, seed: 'someone-else' }],
    ['a part value outside the style', { ...FULL, top: ['mohawk'] }],
    ['more than one choice for a part', { ...FULL, eyes: ['happy', 'wink'] }],
    ['an empty choice', { ...FULL, mouth: [] }],
    ['a colour that is not six hex digits', { ...FULL, skinColor: ['#edb98a'] }],
    ['markup in a colour', { ...FULL, backgroundColor: ['"/><script>'] }],
    ['a probability above 100', { ...FULL, accessoriesProbability: 101 }],
    ['a fractional probability', { ...FULL, topProbability: 50.5 }],
    ['a long string', { ...FULL, top: ['x'.repeat(10_000)] }],
  ])('rejects %s', (_label, avatar) => {
    expect(avatarConfigSchema.safeParse(avatar).success).toBe(false);
  });
});

describe('saving and reading', () => {
  it('saves under the one address given, lowercased, and refuses anything that is not an address', async () => {
    await setAvatar(ALICE, FULL);
    expect([...store.rows.keys()]).toEqual([`profile:avatar:${ALICE.toLowerCase()}`]);
    expect(await getAvatar(ALICE)).toEqual(FULL);
    expect(await getAvatar(ALICE.toLowerCase())).toEqual(FULL);
    await expect(setAvatar('agent', FULL)).rejects.toThrow();
    expect(store.rows.size).toBe(1);
  });

  it('removes the avatar when an empty one is saved', async () => {
    await setAvatar(ALICE, FULL);
    await setAvatar(ALICE, {});
    expect(store.rows.size).toBe(0);
    expect(await getAvatar(ALICE)).toBeNull();
  });

  it('refuses to save an avatar the schema rejects', async () => {
    await expect(setAvatar(ALICE, { ...FULL, top: ['mohawk'] } as never)).rejects.toThrow();
    expect(store.rows.size).toBe(0);
  });

  it('treats a stored row that no longer parses, or says nothing, as no avatar', async () => {
    store.rows.set(`profile:avatar:${ALICE.toLowerCase()}`, '{not json');
    store.rows.set(`profile:avatar:${BOB}`, JSON.stringify({ top: ['mohawk'] }));
    expect(await getAvatar(ALICE)).toBeNull();
    expect((await getAvatars([ALICE, BOB])).size).toBe(0);
    store.rows.set(`profile:avatar:${BOB}`, '{}');
    expect(await getAvatar(BOB)).toBeNull();
  });
});

describe('withPosterAvatars', () => {
  it("adds each poster's avatar by address, whatever its case, and leaves other metas alone", async () => {
    await setAvatar(ALICE, FULL);
    const metas = [
      { taskId: '0x1', posterAddress: ALICE.toLowerCase() },
      { taskId: '0x2', posterAddress: BOB },
      { taskId: '0x3' },
    ];
    const out = await withPosterAvatars(metas);
    expect(out[0]).toEqual({ taskId: '0x1', posterAddress: ALICE.toLowerCase(), posterAvatar: FULL });
    expect(out[1]).toEqual({ taskId: '0x2', posterAddress: BOB });
    expect(out[2]).toEqual({ taskId: '0x3' });
    expect(out[1]).not.toHaveProperty('posterAvatar');
  });

  it('lists the tasks without avatars when Redis fails', async () => {
    await setAvatar(ALICE, FULL);
    store.failPipeline = true;
    const metas = [{ taskId: '0x1', posterAddress: ALICE }];
    expect(await withPosterAvatars(metas)).toEqual(metas);
  });

  it('stops waiting for a Redis that does not answer', async () => {
    vi.useFakeTimers();
    try {
      store.hangPipeline = true;
      const pending = withPosterAvatars([{ taskId: '0x1', posterAddress: ALICE }]);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(await pending).toEqual([{ taskId: '0x1', posterAddress: ALICE }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
