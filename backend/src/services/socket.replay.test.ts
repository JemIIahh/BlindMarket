import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./a2aStore.js', () => ({ browseAgentTasks: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ verifyRegistrationToken: vi.fn(() => null) }));

import { replayOpenBoard, BACKLOG_REPLAY_LIMIT, shouldReplayBacklog } from './socket.js';
import * as a2aStore from './a2aStore.js';

/**
 * Joining a room used to be the end of the story: nothing replayed, and
 * emitTaskAvailable is only called from the request and cascade paths in
 * routes/a2a.ts — no sweeper re-emits. A task broadcast while an agent was
 * disconnected (a backend restart kills the cascade's setTimeout) was never
 * mentioned to it again and sat open until it expired, escrow still funded.
 */
const entry = (taskId: string, caps: string[] = []) =>
  ({ meta: { taskId, requiredCapabilities: caps }, state: {} }) as never;

const fakeSocket = () => ({ emit: vi.fn() });
const JOINER = '0xjoiner';

beforeEach(() => vi.mocked(a2aStore.browseAgentTasks).mockReset());

describe('replayOpenBoard — a joining agent is told what is already open', () => {
  it('replays each open task as task:available, the event workers already handle', async () => {
    vi.mocked(a2aStore.browseAgentTasks).mockResolvedValue([
      entry('0xaaa'), entry('0xbbb', ['code_review']),
    ]);
    const s = fakeSocket();
    const n = await replayOpenBoard(s, JOINER);

    expect(n).toBe(2);
    expect(s.emit).toHaveBeenCalledWith('task:available', { taskId: '0xaaa', meta: {} });
    expect(s.emit).toHaveBeenCalledWith('task:available', {
      taskId: '0xbbb', meta: { requiredCapabilities: ['code_review'] },
    });
  });

  it('carries the task chain so a worker can gas-gate before accepting', async () => {
    vi.mocked(a2aStore.browseAgentTasks).mockResolvedValue([
      { meta: { taskId: '0xccc', requiredCapabilities: [], chain: 'base' }, state: {} } as never,
    ]);
    const s = fakeSocket();
    await replayOpenBoard(s, JOINER);
    expect(s.emit).toHaveBeenCalledWith('task:available', { taskId: '0xccc', meta: { chain: 'base' } });
  });

  it('leaves out a task pinned to another agent, and keeps one pinned to the joiner', async () => {
    vi.mocked(a2aStore.browseAgentTasks).mockResolvedValue([
      { meta: { taskId: '0xmine', requiredCapabilities: [], targetExecutor: '0xJOINER' }, state: {} } as never,
      { meta: { taskId: '0xtheirs', requiredCapabilities: [], targetExecutor: '0xother' }, state: {} } as never,
      entry('0xopen'),
    ]);
    const s = fakeSocket();
    expect(await replayOpenBoard(s, JOINER)).toBe(2);
    const replayed = s.emit.mock.calls.map((c) => (c[1] as { taskId: string }).taskId);
    expect(replayed).toEqual(['0xmine', '0xopen']);
  });

  it('emits nothing when the board is empty', async () => {
    vi.mocked(a2aStore.browseAgentTasks).mockResolvedValue([]);
    const s = fakeSocket();
    expect(await replayOpenBoard(s, JOINER)).toBe(0);
    expect(s.emit).not.toHaveBeenCalled();
  });

  it('caps the burst — one reconnect must not fire unbounded accepts', async () => {
    vi.mocked(a2aStore.browseAgentTasks).mockResolvedValue(
      Array.from({ length: BACKLOG_REPLAY_LIMIT + 40 }, (_, i) => entry(`0x${i}`)),
    );
    const s = fakeSocket();
    expect(await replayOpenBoard(s, JOINER)).toBe(BACKLOG_REPLAY_LIMIT);
    expect(s.emit).toHaveBeenCalledTimes(BACKLOG_REPLAY_LIMIT);
  });

  it('carries no key material — only taskId and capability tags', async () => {
    vi.mocked(a2aStore.browseAgentTasks).mockResolvedValue([
      { meta: {
          taskId: '0xaaa', requiredCapabilities: [],
          wrappedKeys: { '0xagent': 'SECRET' }, keyCustodyBlob: { keyId: 'k1' }, rootHash: '0xroot',
        }, state: {} } as never,
    ]);
    const s = fakeSocket();
    await replayOpenBoard(s, JOINER);
    const payload = JSON.stringify(s.emit.mock.calls[0]);
    expect(payload).not.toContain('SECRET');
    expect(payload).not.toContain('rootHash');
    expect(payload).not.toContain('keyCustodyBlob');
  });

  it('a mid-replay failure degrades to no replay, never a broken join', async () => {
    // Exercised through a socket that drops mid-emit rather than a throwing
    // store mock: same catch, and it is the realistic shape — the client can
    // disconnect between join and replay.
    vi.mocked(a2aStore.browseAgentTasks).mockResolvedValue([entry('0xaaa'), entry('0xbbb')]);
    const s = {
      emit: vi.fn(() => { throw new Error('socket closed'); }),
    };
    await expect(replayOpenBoard(s, JOINER)).resolves.toBe(0);
  });
});

describe('shouldReplayBacklog — only authenticated agents get the backlog', () => {
  const AGENT = '0xagent';

  it('replays to an authenticated agent joining the tasks room', () => {
    expect(shouldReplayBacklog('tasks', AGENT)).toBe(true);
  });

  it('does NOT replay to an anonymous client — tasks is a public room, and a\n     free join must not become a Redis read anyone can loop', () => {
    expect(shouldReplayBacklog('tasks', null)).toBe(false);
  });

  it('does not replay for other rooms', () => {
    expect(shouldReplayBacklog('platform', AGENT)).toBe(false);
    expect(shouldReplayBacklog('disputes', AGENT)).toBe(false);
    expect(shouldReplayBacklog(`agent:${AGENT}`, AGENT)).toBe(false);
  });
});
