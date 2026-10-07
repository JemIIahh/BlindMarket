import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * An open-submission task (meta.submissionMode 'open') must never reach the
 * single-assignee flows: browse, accept, the offer cascade and the expiry
 * sweep all read the a2a:open index and state 'open'. setMeta gives it state
 * 'collecting' and its own index, and the readers of a2a:open refuse it even
 * if it got there some other way.
 */

const mem = vi.hoisted(() => ({ kv: new Map<string, string>(), sets: new Map<string, Set<string>>() }));

vi.mock('./redis.js', () => {
  const sadd = (k: string, ...m: string[]) => {
    const s = mem.sets.get(k) ?? new Set<string>();
    mem.sets.set(k, s);
    m.forEach((x) => s.add(x));
    return m.length;
  };
  const pipeline = () => {
    const ops: Array<() => unknown> = [];
    const p = {
      set: (k: string, v: string) => { ops.push(() => { mem.kv.set(k, v); return 'OK'; }); return p; },
      get: (k: string) => { ops.push(() => mem.kv.get(k) ?? null); return p; },
      sadd: (k: string, ...m: string[]) => { ops.push(() => sadd(k, ...m)); return p; },
      exec: async () => ops.map((op) => [null, op()]),
    };
    return p;
  };
  return {
    redis: {
      pipeline,
      get: async (k: string) => mem.kv.get(k) ?? null,
      exists: async (k: string) => (mem.kv.has(k) ? 1 : 0),
      smembers: async (k: string) => [...(mem.sets.get(k) ?? [])],
      sadd: async (k: string, ...m: string[]) => sadd(k, ...m),
      srem: async (k: string, ...m: string[]) => m.filter((x) => mem.sets.get(k)?.delete(x)).length,
      scan: async (_cursor: string, _match: string, pattern: string) => {
        const prefix = pattern.replace('*', '');
        return ['0', [...mem.kv.keys()].filter((k) => k.startsWith(prefix))];
      },
    },
  };
});

const { setMeta, getState, listOpenTasks, listOpenSubmissionTasks, resyncOpenIndex, browseAgentTasks } = await import('./a2aStore.js');

const POSTER = '0x' + 'a'.repeat(40);
const OPEN_TASK = '0x' + '0a'.repeat(32);
const SINGLE_TASK = '0x' + '0b'.repeat(32);
const meta = (taskId: string, open: boolean) => ({
  taskId,
  targetExecutorType: 'agent' as const,
  verificationMode: 'agent' as const,
  requiredCapabilities: [],
  posterAddress: POSTER,
  verifierAddress: '0x' + 'c'.repeat(40),
  deadline: Math.floor(Date.now() / 1000) + 3600,
  ...(open ? { submissionMode: 'open' as const, openPick: { mode: 'creator' as const, creatorWindow: 86_400 } } : {}),
});

beforeEach(() => {
  mem.kv.clear();
  mem.sets.clear();
});

describe('an open-submission task in the A2A store', () => {
  it("is 'collecting', in its own index, never in a2a:open", async () => {
    await setMeta(meta(OPEN_TASK, true));
    await setMeta(meta(SINGLE_TASK, false));
    expect((await getState(OPEN_TASK))?.status).toBe('collecting');
    expect((await getState(SINGLE_TASK))?.status).toBe('open');
    expect(mem.sets.get('a2a:open')).toEqual(new Set([SINGLE_TASK]));
    expect(mem.sets.get('a2a:open-submission')).toEqual(new Set([OPEN_TASK]));
    // Still the poster's and the verifier's, like any task.
    expect(mem.sets.get(`a2a:poster:${POSTER}`)).toEqual(new Set([OPEN_TASK, SINGLE_TASK]));
  });

  it('is never browsed or listed as an open single-assignee task', async () => {
    await setMeta(meta(OPEN_TASK, true));
    await setMeta(meta(SINGLE_TASK, false));
    expect((await browseAgentTasks()).map((t) => t.meta.taskId)).toEqual([SINGLE_TASK]);
    expect((await listOpenSubmissionTasks()).map((t) => t.meta.taskId)).toEqual([OPEN_TASK]);
  });

  it('is refused by the a2a:open readers even if it got into that index', async () => {
    await setMeta(meta(OPEN_TASK, true));
    mem.kv.set(`a2a:state:${OPEN_TASK}`, JSON.stringify({ taskId: OPEN_TASK, status: 'open' }));
    mem.sets.set('a2a:open', new Set([OPEN_TASK]));
    expect(await listOpenTasks()).toEqual([]);
  });

  it('is never put into a2a:open by the index repair, even with state open', async () => {
    await setMeta(meta(OPEN_TASK, true));
    mem.kv.set(`a2a:state:${OPEN_TASK}`, JSON.stringify({ taskId: OPEN_TASK, status: 'open' }));
    await setMeta(meta(SINGLE_TASK, false));
    mem.sets.delete('a2a:open');
    await resyncOpenIndex();
    expect(mem.sets.get('a2a:open')).toEqual(new Set([SINGLE_TASK]));
  });

  it('keeps its state on a re-index', async () => {
    await setMeta(meta(OPEN_TASK, true));
    mem.kv.set(`a2a:state:${OPEN_TASK}`, JSON.stringify({ taskId: OPEN_TASK, status: 'completed' }));
    await setMeta(meta(OPEN_TASK, true));
    expect((await getState(OPEN_TASK))?.status).toBe('completed');
  });
});
