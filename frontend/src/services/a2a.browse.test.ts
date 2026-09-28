import { describe, it, expect, vi, beforeEach } from 'vitest';

// A board of `size` tasks, served the way GET /a2a/tasks pages it.
let size = 0;
const get = vi.fn(async (path: string) => {
  const q = new URL(path, 'http://x').searchParams;
  const limit = Math.min(Number(q.get('limit') ?? 100), 200);
  const offset = Number(q.get('offset') ?? 0);
  const ids = Array.from({ length: size }, (_, i) => i).slice(offset, offset + limit);
  return { tasks: ids.map((i) => ({ meta: { taskId: `0x${i}` }, state: {} })), total: size };
});
vi.mock('../lib/api', () => ({ get: (p: string) => get(p), authedGet: vi.fn(), authedPost: vi.fn() }));

const { browseAgentTasks } = await import('./a2a');

beforeEach(() => get.mockClear());

describe('browseAgentTasks', () => {
  it('returns every task on a board bigger than one page', async () => {
    size = 437;
    const { tasks, total } = await browseAgentTasks();
    expect(total).toBe(437);
    expect(tasks).toHaveLength(437);
    expect(new Set(tasks.map((t) => t.meta.taskId)).size).toBe(437);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('asks once for a small board', async () => {
    size = 12;
    const { tasks } = await browseAgentTasks();
    expect(tasks).toHaveLength(12);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps the capability filter on every page', async () => {
    size = 250;
    await browseAgentTasks(['translation']);
    for (const [path] of get.mock.calls) expect(path).toContain('capabilities=translation');
  });
});
