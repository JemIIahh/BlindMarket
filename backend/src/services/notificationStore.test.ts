/**
 * notificationStore — Redis-backed per-user event diary.
 * Uses an in-memory fake for the redis module (same approach as the
 * a2a.accept route tests) plus a stubbed a2aStore for fan-out.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mem = vi.hoisted(() => ({ lists: new Map<string, string[]>(), keys: new Map<string, string>() }));

vi.mock('./redis.js', () => {
  const lists = mem.lists;
  const pipe = () => {
    const ops: Array<() => unknown> = [];
    const p = {
      // SET key value EX s NX, as a pipelined command: its reply comes from exec().
      set: (k: string, v: string, ...args: unknown[]) => {
        ops.push(() => {
          if (args.includes('NX') && mem.keys.has(k)) return null;
          mem.keys.set(k, v);
          return 'OK';
        });
        return p;
      },
      lpush: (k: string, v: string) => { ops.push(() => lists.set(k, [v, ...(lists.get(k) ?? [])])); return p; },
      ltrim: (k: string, s: number, e: number) => { ops.push(() => lists.set(k, (lists.get(k) ?? []).slice(s, e + 1))); return p; },
      expire: (_k: string, _s: number) => { ops.push(() => {}); return p; },
      del: (k: string) => { ops.push(() => { lists.delete(k); }); return p; },
      rpush: (k: string, ...vs: string[]) => { ops.push(() => lists.set(k, [...(lists.get(k) ?? []), ...vs])); return p; },
      // Real Redis replies [error, result] per command.
      exec: async () => ops.map((op) => [null, op() ?? null]),
    };
    return p;
  };
  return {
    redis: {
      pipeline: pipe,
      // Mirror Redis negative indexes: -1 is the last element.
      lrange: async (k: string, s: number, e: number) => {
        const l = lists.get(k) ?? [];
        const end = e < 0 ? l.length + e + 1 : e + 1;
        return l.slice(s, end);
      },
      llen: async (k: string) => (lists.get(k) ?? []).length,
      get: async (k: string) => mem.keys.get(k) ?? null,
      // SET key value EX s NX: null when the key already exists.
      set: async (k: string, v: string, ...args: unknown[]) => {
        if (args.includes('NX') && mem.keys.has(k)) return null;
        mem.keys.set(k, v);
        return 'OK';
      },
      lset: async (k: string, i: number, v: string) => {
        const l = lists.get(k) ?? [];
        if (i < 0 || i >= l.length) throw new Error('index out of range');
        l[i] = v;
      },
    },
  };
});

const POSTER = '0xposter0000000000000000000000000000000001';
const EXEC = '0xexec000000000000000000000000000000000002';
const HASH = '0xhash00000000000000000000000000000000000000000000000000000003';

vi.mock('./a2aStore.js', () => ({
  getMeta: vi.fn(async () => ({ posterAddress: POSTER })),
  getState: vi.fn(async () => ({ executorAddress: EXEC })),
}));

import { notify, notifyOnce, notifyOnceMany, firstSeenAt, listNotifications, markRead, markAllRead, notifyLifecycle } from './notificationStore.js';

beforeEach(() => {
  mem.lists.clear();
  mem.keys.clear();
});

describe('notify / list / read', () => {
  it('pushes newest-first and counts unread', async () => {
    await notify(POSTER, { type: 'assigned', title: 'Task accepted', taskId: HASH });
    await notify(POSTER, { type: 'submitted', title: 'Result submitted', taskId: HASH });
    const { notifications, total, unread } = await listNotifications(POSTER);
    expect(total).toBe(2);
    expect(unread).toBe(2);
    expect(notifications[0].title).toBe('Result submitted');
  });

  it('markRead flips one item, markAllRead flips the rest', async () => {
    await notify(POSTER, { type: 'assigned', title: 'one' });
    await notify(POSTER, { type: 'submitted', title: 'two' });
    const first = (await listNotifications(POSTER)).notifications;
    expect(await markRead(POSTER, first[0].id)).toBe(true);
    expect((await listNotifications(POSTER)).unread).toBe(1);
    expect(await markAllRead(POSTER)).toBe(1);
    expect((await listNotifications(POSTER)).unread).toBe(0);
  });

  it('markRead on an unknown id returns false', async () => {
    expect(await markRead(POSTER, 'nope')).toBe(false);
  });

  it('addresses are case-insensitive', async () => {
    await notify(POSTER.toUpperCase(), { type: 'assigned', title: 'x' });
    expect((await listNotifications(POSTER)).total).toBe(1);
  });
});

describe('notifyLifecycle fan-out', () => {
  it('assigned notifies the poster only', async () => {
    await notifyLifecycle(HASH, 'assigned');
    expect((await listNotifications(POSTER)).total).toBe(1);
    expect((await listNotifications(EXEC)).total).toBe(0);
  });

  it('completed notifies poster and worker with different copy', async () => {
    await notifyLifecycle(HASH, 'completed');
    const p = (await listNotifications(POSTER)).notifications;
    const w = (await listNotifications(EXEC)).notifications;
    expect(p).toHaveLength(1);
    expect(w).toHaveLength(1);
    expect(p[0].title).toMatch(/completed/i);
    expect(w[0].title).toMatch(/payout/i);
  });

  it('failed and disputed reach both sides', async () => {
    await notifyLifecycle(HASH, 'failed');
    await notifyLifecycle(HASH, 'disputed');
    expect((await listNotifications(POSTER)).total).toBe(2);
    expect((await listNotifications(EXEC)).total).toBe(2);
  });

  // Only disputeListener sends 'disputed', once a ruling has refunded the
  // poster (delta audit 2026-10-06, tg-4): the copy must not say a ruling is
  // still to come.
  it('disputed tells both sides the ruling refunded the poster', async () => {
    await notifyLifecycle(HASH, 'disputed');
    for (const who of [POSTER, EXEC]) {
      const [n] = (await listNotifications(who)).notifications;
      expect(n.title).toMatch(/ruled/i);
      expect(n.body).toMatch(/refunded/i);
      expect(`${n.title} ${n.body}`).not.toMatch(/will rule|under dispute/i);
    }
  });
});

describe('notifyOnce', () => {
  it('sends a notice once per key, however often a sweep asks', async () => {
    const input = { type: 'expired' as const, title: 'The agent missed the deadline', taskId: HASH };
    expect(await notifyOnce(`deadline:${HASH}`, POSTER, input)).toBe(true);
    expect(await notifyOnce(`deadline:${HASH}`, POSTER, input)).toBe(false);
    const page = await listNotifications(POSTER);
    expect(page.notifications).toHaveLength(1);
    expect(page.notifications[0]).toMatchObject({ type: 'expired', taskId: HASH });
  });
});

describe('firstSeenAt', () => {
  it('records the first time and returns it after that', async () => {
    expect(await firstSeenAt('remind:0xabc', 1000, 3600)).toBe(1000);
    expect(await firstSeenAt('remind:0xabc', 2000, 3600)).toBe(1000);
    expect(await firstSeenAt('remind:0xdef', 2000, 3600)).toBe(2000);
  });
});

describe('notifyOnceMany', () => {
  const lost = (to: string) => ({
    dedupeKey: `open:lost:${HASH}:${to}`,
    to,
    input: { type: 'failed' as const, title: 'Another submission was picked', taskId: HASH },
  });
  const agent = (i: number) => '0x' + i.toString(16).padStart(40, '0');

  beforeEach(() => {
    mem.lists.clear();
    mem.keys.clear();
  });

  it('sends each notice once, to each feed, across batches', async () => {
    const notices = Array.from({ length: 450 }, (_, i) => lost(agent(i + 1)));
    expect(await notifyOnceMany(notices)).toBe(450);
    expect((await listNotifications(agent(1))).notifications[0]).toMatchObject({ type: 'failed', title: 'Another submission was picked' });
    expect((await listNotifications(agent(450))).total).toBe(1);
    // Redelivered event: nothing new.
    expect(await notifyOnceMany(notices)).toBe(0);
    expect((await listNotifications(agent(1))).total).toBe(1);
  });

  it('sends only the notices not sent before', async () => {
    await notifyOnceMany([lost(agent(1))]);
    expect(await notifyOnceMany([lost(agent(1)), lost(agent(2))])).toBe(1);
    expect((await listNotifications(agent(2))).total).toBe(1);
  });

  it('shares its once-keys with notifyOnce', async () => {
    await notifyOnce(`open:lost:${HASH}:${agent(3)}`, agent(3), { type: 'failed', title: 'x', taskId: HASH });
    expect(await notifyOnceMany([lost(agent(3))])).toBe(0);
  });
});
