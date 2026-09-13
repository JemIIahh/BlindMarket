/**
 * notificationStore — Redis-backed per-user event diary.
 * Uses an in-memory fake for the redis module (same approach as the
 * a2a.accept route tests) plus a stubbed a2aStore for fan-out.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mem = vi.hoisted(() => ({ lists: new Map<string, string[]>() }));

vi.mock('./redis.js', () => {
  const lists = mem.lists;
  const pipe = () => {
    const ops: Array<() => void> = [];
    const p = {
      lpush: (k: string, v: string) => { ops.push(() => lists.set(k, [v, ...(lists.get(k) ?? [])])); return p; },
      ltrim: (k: string, s: number, e: number) => { ops.push(() => lists.set(k, (lists.get(k) ?? []).slice(s, e + 1))); return p; },
      expire: (_k: string, _s: number) => { ops.push(() => {}); return p; },
      del: (k: string) => { ops.push(() => { lists.delete(k); }); return p; },
      rpush: (k: string, ...vs: string[]) => { ops.push(() => lists.set(k, [...(lists.get(k) ?? []), ...vs])); return p; },
      exec: async () => { ops.forEach((op) => op()); return []; },
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

import { notify, listNotifications, markRead, markAllRead, notifyLifecycle } from './notificationStore.js';

beforeEach(() => {
  mem.lists.clear();
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
});
