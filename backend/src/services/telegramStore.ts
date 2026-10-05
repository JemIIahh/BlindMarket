/**
 * Telegram links, preferences and link nonces, in Redis.
 *
 * A link says "notifications for this wallet go to this Telegram chat". It is
 * opt-in (the chat must present a nonce minted by a signed-in session), and it
 * can be removed from either side. Nothing here holds task content.
 *
 * Keys:
 *   tg:link:<addr>      JSON { chatId, linkedAt }   one per wallet
 *   tg:chat:<chatId>    set of wallets linked to that chat
 *   tg:prefs:<chatId>   JSON { <type>: boolean }    per chat, default all on
 *   tg:nonce:<nonce>    JSON [addr, ...]            single-use, 10 min
 *   tg:nonce-of:<addr>  the wallet's current nonce  so a new one replaces it
 */

import { randomBytes } from 'crypto';
import { redis } from './redis.js';

/** The notification types a chat may receive. */
export const TELEGRAM_TYPES = [
  'assigned',
  'submitted',
  'completed',
  'failed',
  'disputed',
  'expired',
  'deadline_soon',
] as const;
export type TelegramType = (typeof TELEGRAM_TYPES)[number];
export type TelegramPrefs = Partial<Record<TelegramType, boolean>>;

export function isTelegramType(t: string): t is TelegramType {
  return (TELEGRAM_TYPES as readonly string[]).includes(t);
}

/** Types are on unless the chat switched them off. */
export function isTypeEnabled(prefs: TelegramPrefs, type: TelegramType): boolean {
  return prefs[type] !== false;
}

export interface TelegramLink {
  chatId: string;
  linkedAt: string;
}

export const NONCE_TTL_S = 10 * 60;
const NONCE_RE = /^[a-f0-9]{32}$/;
const ADDR_RE = /^0x[0-9a-f]{40}$/;

const KEY = {
  link: (a: string) => `tg:link:${a}`,
  chat: (c: string) => `tg:chat:${c}`,
  prefs: (c: string) => `tg:prefs:${c}`,
  nonce: (n: string) => `tg:nonce:${n}`,
  nonceOf: (a: string) => `tg:nonce-of:${a}`,
};

function normalise(addresses: string[]): string[] {
  return [...new Set(addresses.map((a) => a.toLowerCase()).filter((a) => ADDR_RE.test(a)))];
}

/** A single-use nonce binding a Telegram chat to these wallets. Replaces the wallet's previous one. */
export async function createLinkNonce(addresses: string[]): Promise<string> {
  const addrs = normalise(addresses);
  if (addrs.length === 0) throw new Error('no valid wallet address to link');
  const nonce = randomBytes(16).toString('hex');
  const previous = await redis.get(KEY.nonceOf(addrs[0]));
  if (previous) await redis.del(KEY.nonce(previous));
  await redis.set(KEY.nonce(nonce), JSON.stringify(addrs), 'EX', NONCE_TTL_S);
  await redis.set(KEY.nonceOf(addrs[0]), nonce, 'EX', NONCE_TTL_S);
  return nonce;
}

/** The wallets a nonce was minted for, consuming it. null when unknown, used or expired. */
export async function consumeLinkNonce(nonce: string): Promise<string[] | null> {
  if (!NONCE_RE.test(nonce)) return null;
  // GET then DEL, and only the caller whose DEL removed the key wins: single
  // use on any Redis version (GETDEL needs 6.2).
  const raw = await redis.get(KEY.nonce(nonce));
  if (!raw) return null;
  if ((await redis.del(KEY.nonce(nonce))) !== 1) return null;
  try {
    const addrs = normalise(JSON.parse(raw) as string[]);
    if (addrs.length === 0) return null;
    await redis.del(KEY.nonceOf(addrs[0]));
    return addrs;
  } catch {
    return null;
  }
}

function parseLink(raw: string | null): TelegramLink | null {
  if (!raw) return null;
  try {
    const l = JSON.parse(raw) as TelegramLink;
    return l && typeof l.chatId === 'string' ? l : null;
  } catch {
    return null;
  }
}

export async function getLink(address: string): Promise<TelegramLink | null> {
  return parseLink(await redis.get(KEY.link(address.toLowerCase())));
}

/** Wallets currently linked to a chat. */
export async function walletsOfChat(chatId: string): Promise<string[]> {
  return redis.smembers(KEY.chat(chatId));
}

/**
 * Bind a chat to these wallets. A chat has one set of wallets: whatever it was
 * linked to before is dropped. A wallet has one chat: a previous chat loses it.
 */
export async function linkChat(chatId: string, addresses: string[]): Promise<string[]> {
  const addrs = normalise(addresses);
  const before = await walletsOfChat(chatId);
  for (const a of before) {
    if (!addrs.includes(a)) {
      await redis.del(KEY.link(a));
      await redis.srem(KEY.chat(chatId), a);
    }
  }
  for (const a of addrs) {
    const existing = await getLink(a);
    if (existing && existing.chatId !== chatId) {
      await redis.srem(KEY.chat(existing.chatId), a);
      if ((await walletsOfChat(existing.chatId)).length === 0) await redis.del(KEY.prefs(existing.chatId));
    }
    const link: TelegramLink = { chatId, linkedAt: new Date().toISOString() };
    await redis.set(KEY.link(a), JSON.stringify(link));
    await redis.sadd(KEY.chat(chatId), a);
  }
  return addrs;
}

/** Remove every link for a chat, and its preferences. Returns how many wallets were unlinked. */
export async function unlinkChat(chatId: string): Promise<number> {
  const wallets = await walletsOfChat(chatId);
  for (const a of wallets) await redis.del(KEY.link(a));
  await redis.del(KEY.chat(chatId));
  await redis.del(KEY.prefs(chatId));
  return wallets.length;
}

/** Unlink the chats these wallets are linked to. Returns the number of chats unlinked. */
export async function unlinkWallets(addresses: string[]): Promise<number> {
  const chats = new Set<string>();
  for (const a of normalise(addresses)) {
    const l = await getLink(a);
    if (l) chats.add(l.chatId);
  }
  for (const c of chats) await unlinkChat(c);
  return chats.size;
}

export async function getPrefs(chatId: string): Promise<TelegramPrefs> {
  const raw = await redis.get(KEY.prefs(chatId));
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const out: TelegramPrefs = {};
    for (const t of TELEGRAM_TYPES) if (typeof p[t] === 'boolean') out[t] = p[t] as boolean;
    return out;
  } catch {
    return {};
  }
}

export async function setPrefs(chatId: string, prefs: TelegramPrefs): Promise<TelegramPrefs> {
  const merged = { ...(await getPrefs(chatId)), ...prefs };
  await redis.set(KEY.prefs(chatId), JSON.stringify(merged));
  return merged;
}

/** True the first time an update id is seen: Telegram redelivers a webhook it did not get a 200 for. */
export async function claimUpdate(updateId: number): Promise<boolean> {
  return (await redis.set(`tg:update:${updateId}`, '1', 'EX', 3600, 'NX')) !== null;
}
