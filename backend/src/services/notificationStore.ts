/**
 * Per-user task-lifecycle notifications, backed by Redis (not Postgres).
 *
 * Rationale: notifications are high-write, per-address, capped, and
 * ephemeral — a bounded list with a TTL, exactly the shape Redis lists do
 * well (same pattern as agent log buffers in redis.ts). No migration, no
 * table, and reads are a single LRANGE. The 100-item cap + 30-day TTL keep
 * memory bounded; anything older than the cap is, by definition, not news.
 *
 * All writes are best-effort: a notification failure must never break the
 * settlement call that triggered it (callers fire-and-forget anyway).
 */

import { randomBytes } from 'crypto';
import { redis } from './redis.js';
import * as a2aStore from './a2aStore.js';
import { deliverToTelegram } from './telegram.js';

export type NotificationType =
  | 'assigned'
  | 'submitted'
  | 'completed'
  | 'failed'
  | 'disputed'
  | 'review_received'
  /** A task's deadline passed with its escrow still held: the poster can reclaim it. */
  | 'expired'
  /** A task's deadline is close and it is still waiting on an agent, its work or a verdict. */
  | 'deadline_soon'
  /** A hosted agent was left stopped (not restarted with the server): its owner can start it again. */
  | 'agent_stopped';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body?: string;
  /** Task hash (frontend routes /tasks/:id by hash). */
  taskId?: string;
  createdAt: string;
  read: boolean;
}

const FEED_CAP = 100;
const FEED_TTL_S = 30 * 24 * 3600; // 30 days

const KEY = {
  feed: (address: string) => `notif:feed:${address.toLowerCase()}`,
  once: (dedupeKey: string) => `notif:once:${dedupeKey}`,
};

function shortAddr(a: string): string {
  return a.length > 13 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export async function notify(
  toAddress: string,
  input: { type: NotificationType; title: string; body?: string; taskId?: string },
): Promise<Notification | null> {
  try {
    const notif: Notification = {
      id: `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
      type: input.type,
      title: input.title,
      body: input.body,
      taskId: input.taskId,
      createdAt: new Date().toISOString(),
      read: false,
    };
    const key = KEY.feed(toAddress);
    const pipe = redis.pipeline();
    pipe.lpush(key, JSON.stringify(notif));
    pipe.ltrim(key, 0, FEED_CAP - 1);
    pipe.expire(key, FEED_TTL_S);
    await pipe.exec();
    // Telegram is an extra channel: fire and forget, it never blocks the feed.
    void deliverToTelegram(toAddress, notif);
    return notif;
  } catch (err) {
    console.warn('[notifications] push failed:', (err as Error).message);
    return null;
  }
}

function parse(raw: string | null): Notification | null {
  if (!raw) return null;
  try {
    const n = JSON.parse(raw) as Notification;
    if (!n || typeof n.id !== 'string' || typeof n.type !== 'string') return null;
    return n;
  } catch {
    return null;
  }
}

export async function listNotifications(
  address: string,
  limit = 30,
  offset = 0,
): Promise<{ notifications: Notification[]; total: number; unread: number }> {
  const key = KEY.feed(address);
  const [items, total] = await Promise.all([
    redis.lrange(key, offset, offset + limit - 1),
    redis.llen(key),
  ]);
  const notifications = items.map(parse).filter((n): n is Notification => n !== null);
  // Unread is counted over the whole retained feed, not just the page.
  let unread: number;
  if (offset === 0 && notifications.length >= total) {
    unread = notifications.filter((n) => !n.read).length;
  } else {
    const all = (await redis.lrange(key, 0, -1))
      .map(parse)
      .filter((n): n is Notification => n !== null);
    unread = all.filter((n) => !n.read).length;
  }
  return { notifications, total, unread };
}

export async function markRead(address: string, id: string): Promise<boolean> {
  const key = KEY.feed(address);
  const items = await redis.lrange(key, 0, -1);
  const idx = items.findIndex((raw) => parse(raw)?.id === id);
  if (idx === -1) return false;
  const notif = parse(items[idx])!;
  if (notif.read) return true;
  notif.read = true;
  await redis.lset(key, idx, JSON.stringify(notif));
  return true;
}

export async function markAllRead(address: string): Promise<number> {
  const key = KEY.feed(address);
  const items = await redis.lrange(key, 0, -1);
  const notifs = items.map(parse).filter((n): n is Notification => n !== null);
  const unread = notifs.filter((n) => !n.read).length;
  if (unread === 0) return 0;
  for (const n of notifs) n.read = true;
  const pipe = redis.pipeline();
  pipe.del(key);
  if (notifs.length > 0) pipe.rpush(key, ...notifs.map((n) => JSON.stringify(n)));
  pipe.expire(key, FEED_TTL_S);
  await pipe.exec();
  return unread;
}

/**
 * notify(), at most once per `dedupeKey` (kept as long as the feed itself).
 * For notices a sweep would otherwise repeat every tick. Returns true when the
 * notice was sent now; false when it was sent before, or could not be stored.
 */
export async function notifyOnce(
  dedupeKey: string,
  toAddress: string,
  input: { type: NotificationType; title: string; body?: string; taskId?: string },
): Promise<boolean> {
  try {
    const first = await redis.set(KEY.once(dedupeKey), '1', 'EX', FEED_TTL_S, 'NX');
    if (first === null) return false;
    return (await notify(toAddress, input)) !== null;
  } catch (err) {
    console.warn('[notif] notifyOnce failed (non-fatal):', (err as Error).message);
    return false;
  }
}

/**
 * One-liner for route handlers: resolves poster + executor from the A2A
 * store and fans out the right copy to each. Never throws — failures log
 * and the settlement response proceeds.
 */
export async function notifyLifecycle(
  taskHash: string,
  event: 'assigned' | 'submitted' | 'completed' | 'failed' | 'disputed',
): Promise<void> {
  try {
    const [meta, state] = await Promise.all([
      a2aStore.getMeta(taskHash),
      a2aStore.getState(taskHash),
    ]);
    const poster = meta?.posterAddress;
    const executor = state?.executorAddress;
    const shortExec = executor ? shortAddr(executor) : 'An agent';
    const normHash = taskHash.toLowerCase();

    if (event === 'assigned' && poster) {
      await notify(poster, {
        type: 'assigned',
        title: 'Task accepted',
        body: `${shortExec} accepted your task and started executing.`,
        taskId: normHash,
      });
    } else if (event === 'submitted' && poster) {
      await notify(poster, {
        type: 'submitted',
        title: 'Result submitted',
        body: `${shortExec} submitted a result for your task.`,
        taskId: normHash,
      });
    } else if (event === 'completed') {
      if (poster) {
        await notify(poster, {
          type: 'completed',
          title: 'Task completed — escrow released',
          body: 'The result passed verification. You can rate your agent from the task page.',
          taskId: normHash,
        });
      }
      if (executor) {
        await notify(executor, {
          type: 'completed',
          title: 'Payout credited',
          body: 'Your task result passed and the worker share was credited to your earnings.',
          taskId: normHash,
        });
      }
    } else if (event === 'failed') {
      if (poster) {
        await notify(poster, {
          type: 'failed',
          title: 'Verification failed',
          body: `${shortExec}'s submission didn't meet the criteria — they can retry.`,
          taskId: normHash,
        });
      }
      if (executor) {
        await notify(executor, {
          type: 'failed',
          title: "Submission didn't pass",
          body: 'Your result failed verification — you can revise and resubmit.',
          taskId: normHash,
        });
      }
    } else if (event === 'disputed') {
      const payload = {
        type: 'disputed' as const,
        title: 'Task under dispute',
        body: 'ValidatorPool will rule on this task.',
        taskId: normHash,
      };
      if (poster) await notify(poster, payload);
      if (executor) await notify(executor, payload);
    }
  } catch (err) {
    console.warn('[notifications] lifecycle fan-out failed:', (err as Error).message);
  }
}
