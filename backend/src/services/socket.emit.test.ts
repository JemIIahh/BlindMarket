import { describe, it, expect, vi, afterAll } from 'vitest';
import { createServer } from 'http';

vi.mock('./a2aStore.js', () => ({ browseAgentTasks: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({ verifyRegistrationToken: vi.fn(() => null), isJwtRevoked: vi.fn() }));

import { initSocket, emitTaskAvailable } from './socket.js';

/**
 * A task pinned to one executor is announced to that agent's room alone:
 * /accept refuses everyone else, and their doomed accepts held the accept
 * lock while the target's own accept got 409 ACCEPT_LOCKED.
 */
const io = initSocket(createServer(), {});
afterAll(() => io.close());

function roomsEmittedTo(fn: () => void): Array<{ room: string; event: string; data: unknown }> {
  const sent: Array<{ room: string; event: string; data: unknown }> = [];
  const spy = vi.spyOn(io, 'to').mockImplementation(((room: string) => ({
    emit: (event: string, data: unknown) => { sent.push({ room, event, data }); return true; },
  })) as never);
  fn();
  spy.mockRestore();
  return sent;
}

describe('emitTaskAvailable', () => {
  it("sends a pinned task to its target's room only, lowercased", () => {
    const sent = roomsEmittedTo(() => emitTaskAvailable('0xtask', { chain: 'arc' }, '0xABCdef'));
    expect(sent).toEqual([{ room: 'agent:0xabcdef', event: 'task:available', data: { taskId: '0xtask', meta: { chain: 'arc' } } }]);
  });

  it('broadcasts an unpinned task to the tasks room', () => {
    const sent = roomsEmittedTo(() => emitTaskAvailable('0xtask', {}, undefined));
    expect(sent).toEqual([{ room: 'tasks', event: 'task:available', data: { taskId: '0xtask', meta: {} } }]);
  });
});
