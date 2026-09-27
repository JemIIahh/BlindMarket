import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deviceAvatarsVersion,
  readDeviceAvatar,
  readFirstDeviceAvatar,
  saveDeviceAvatar,
  subscribeDeviceAvatars,
} from './deviceAvatars';

const ME = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const MINE_TOO = '0x1111111111111111111111111111111111111111';
const AVATAR = { top: ['bob'], eyes: ['wink'] };

function fakeStorage() {
  const rows = new Map<string, string>();
  return {
    rows,
    getItem: (k: string) => rows.get(k) ?? null,
    setItem: (k: string, v: string) => void rows.set(k, v),
  };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal('window', { localStorage: storage });
});

afterEach(() => vi.unstubAllGlobals());

describe('device avatars (development previews only)', () => {
  it("keeps one avatar for each of the viewer's wallets, whatever the address case", () => {
    expect(saveDeviceAvatar([ME, MINE_TOO], AVATAR)).toBe(true);
    expect(readDeviceAvatar(ME.toLowerCase())).toEqual(AVATAR);
    expect(readDeviceAvatar(MINE_TOO)).toEqual(AVATAR);
    expect(readFirstDeviceAvatar(['0x2222222222222222222222222222222222222222', ME])).toEqual(AVATAR);
  });

  it('tells avatars on the page to redraw after a save', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDeviceAvatars(listener);
    const before = deviceAvatarsVersion();
    saveDeviceAvatar([ME], AVATAR);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(deviceAvatarsVersion()).toBe(before + 1);
    unsubscribe();
    saveDeviceAvatar([ME], AVATAR);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reads nothing it cannot trust, and survives storage that throws', () => {
    storage.rows.set(`bb.avatar.preview:${ME.toLowerCase()}`, '{broken');
    expect(readDeviceAvatar(ME)).toBeNull();
    storage.rows.set(`bb.avatar.preview:${ME.toLowerCase()}`, JSON.stringify({ seed: 'x' }));
    expect(readDeviceAvatar(ME)).toBeNull();

    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(readDeviceAvatar(ME)).toBeNull();
    expect(saveDeviceAvatar([ME], AVATAR)).toBe(false);
  });
});
