/**
 * telegramStore: link nonces, links, preferences. In-memory fake for redis.
 *
 * Run:  npx vitest run src/services/telegramStore.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mem = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  sets: new Map<string, Set<string>>(),
}));

vi.mock('./redis.js', () => ({
  redis: {
    get: async (k: string) => mem.kv.get(k) ?? null,
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && mem.kv.has(k)) return null;
      mem.kv.set(k, v);
      return 'OK';
    },
    del: async (k: string) => {
      const had = mem.kv.delete(k) || mem.sets.delete(k);
      return had ? 1 : 0;
    },
    sadd: async (k: string, m: string) => {
      const s = mem.sets.get(k) ?? new Set<string>();
      s.add(m);
      mem.sets.set(k, s);
      return 1;
    },
    srem: async (k: string, m: string) => {
      const s = mem.sets.get(k);
      if (!s) return 0;
      const had = s.delete(m);
      if (s.size === 0) mem.sets.delete(k);
      return had ? 1 : 0;
    },
    smembers: async (k: string) => [...(mem.sets.get(k) ?? [])],
  },
}));

import {
  claimUpdate,
  consumeLinkNonce,
  createLinkNonce,
  getLink,
  getPrefs,
  isTypeEnabled,
  linkChat,
  setPrefs,
  unlinkChat,
  unlinkWallets,
  walletsOfChat,
} from './telegramStore.js';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);

beforeEach(() => {
  mem.kv.clear();
  mem.sets.clear();
});

describe('link nonce', () => {
  it('is single use', async () => {
    const nonce = await createLinkNonce([A]);
    expect(await consumeLinkNonce(nonce)).toEqual([A]);
    expect(await consumeLinkNonce(nonce)).toBeNull();
  });

  it('a new nonce for the same wallet replaces the old one', async () => {
    const first = await createLinkNonce([A]);
    const second = await createLinkNonce([A]);
    expect(await consumeLinkNonce(first)).toBeNull();
    expect(await consumeLinkNonce(second)).toEqual([A]);
  });

  it('rejects malformed nonces without touching redis', async () => {
    expect(await consumeLinkNonce('not-a-nonce')).toBeNull();
    expect(await consumeLinkNonce('../../tg:link:x')).toBeNull();
  });

  it('refuses to mint a nonce for no valid wallet', async () => {
    await expect(createLinkNonce(['nope'])).rejects.toThrow();
  });

  it('normalises wallets to lowercase and drops duplicates', async () => {
    const nonce = await createLinkNonce([A.toUpperCase().replace('0X', '0x'), A]);
    expect(await consumeLinkNonce(nonce)).toEqual([A]);
  });
});

describe('links', () => {
  it('links a chat to wallets and reads it back', async () => {
    await linkChat('111', [A, B]);
    expect((await getLink(A))?.chatId).toBe('111');
    expect((await getLink(B))?.chatId).toBe('111');
    expect((await walletsOfChat('111')).sort()).toEqual([A, B].sort());
  });

  it('re-linking a chat drops wallets it no longer names', async () => {
    await linkChat('111', [A, B]);
    await linkChat('111', [A]);
    expect(await getLink(B)).toBeNull();
    expect(await walletsOfChat('111')).toEqual([A]);
  });

  it('a wallet has one chat: the previous chat loses it', async () => {
    await linkChat('111', [A]);
    await linkChat('222', [A]);
    expect((await getLink(A))?.chatId).toBe('222');
    expect(await walletsOfChat('111')).toEqual([]);
  });

  it('unlinking a chat removes every link and its preferences', async () => {
    await linkChat('111', [A, B]);
    await setPrefs('111', { expired: false });
    expect(await unlinkChat('111')).toBe(2);
    expect(await getLink(A)).toBeNull();
    expect(await getLink(B)).toBeNull();
    expect(await getPrefs('111')).toEqual({});
  });

  it('unlinkWallets unlinks the chats those wallets are on, once each', async () => {
    await linkChat('111', [A, B]);
    expect(await unlinkWallets([A, B])).toBe(1);
    expect(await getLink(A)).toBeNull();
  });

  it('unlinkWallets is a no-op when nothing is linked', async () => {
    expect(await unlinkWallets([A])).toBe(0);
  });
});

describe('preferences', () => {
  it('every type is on by default', async () => {
    const prefs = await getPrefs('111');
    expect(isTypeEnabled(prefs, 'deadline_soon')).toBe(true);
    expect(isTypeEnabled(prefs, 'completed')).toBe(true);
  });

  it('a type can be switched off and back on, others untouched', async () => {
    await setPrefs('111', { deadline_soon: false });
    expect(isTypeEnabled(await getPrefs('111'), 'deadline_soon')).toBe(false);
    expect(isTypeEnabled(await getPrefs('111'), 'expired')).toBe(true);
    await setPrefs('111', { deadline_soon: true });
    expect(isTypeEnabled(await getPrefs('111'), 'deadline_soon')).toBe(true);
  });

  it('ignores unknown keys stored in redis', async () => {
    mem.kv.set('tg:prefs:111', JSON.stringify({ assigned: false, bogus: false }));
    expect(await getPrefs('111')).toEqual({ assigned: false });
  });
});

describe('claimUpdate', () => {
  it('is true once per update id', async () => {
    expect(await claimUpdate(7)).toBe(true);
    expect(await claimUpdate(7)).toBe(false);
    expect(await claimUpdate(8)).toBe(true);
  });
});
