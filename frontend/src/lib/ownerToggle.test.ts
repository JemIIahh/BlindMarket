import { describe, expect, it } from 'vitest';
import { friendlyError } from './friendlyError';
import { restartAgent, saveOwnerToggle, type OwnerToggle } from './ownerToggle';

/** An API error the way lib/api.ts throws one. */
const apiError = (code: string, status: number, message = code) => Object.assign(new Error(message), { code, status });

/**
 * POST answers by path, recording each call: the toggle route answers the
 * stored value, stop and start answer the agent, and `fail` names a route
 * that throws instead.
 */
function backend(toggle: OwnerToggle, opts: { stored?: boolean; fail?: Record<string, Error> } = {}) {
  const calls: string[] = [];
  const post = async <T,>(path: string, body: unknown): Promise<T> => {
    const route = path.split('/').pop()!;
    calls.push(route);
    const err = opts.fail?.[route];
    if (err) throw err;
    if (route === toggle) {
      const field = toggle === 'verifier' ? 'verifierEnabled' : 'delegationEnabled';
      return { [field]: opts.stored ?? (body as { enabled: boolean }).enabled, note: 'Restart the agent for the change to take effect.' } as T;
    }
    return { id: 'agent-1', status: route === 'stop' ? 'stopped' : 'running' } as T;
  };
  return { post, calls };
}

describe('saveOwnerToggle', () => {
  for (const toggle of ['delegation', 'verifier'] as const) {
    it(`keeps ${toggle} on when the save worked and only the restart failed, and names the restart`, async () => {
      const { post, calls } = backend(toggle, { fail: { start: apiError('AGENT_ACTION_FAILED', 400, 'No free worker slot') } });
      const out = await saveOwnerToggle(post, 'agent-1', toggle, true, true);
      expect(calls).toEqual([toggle, 'stop', 'start']);
      expect(out.enabled).toBe(true);
      // Stopped, not running: the page shows it.
      expect(out.agent).toEqual({ id: 'agent-1', status: 'stopped' });
      const shown = friendlyError(out.restartError);
      expect(shown.title).toMatch(/restart/i);
      expect(shown.message).toMatch(/saved/i);
      expect(shown.details).toMatch(/No free worker slot/);
    });
  }

  it('shows what the server stored, not what was asked for', async () => {
    const { post } = backend('delegation', { stored: false });
    const out = await saveOwnerToggle(post, 'agent-1', 'delegation', true, false);
    expect(out).toEqual({ enabled: false, agent: null, restartError: null });
  });

  it('restarts a running agent and returns it as start answered', async () => {
    const { post, calls } = backend('verifier');
    const out = await saveOwnerToggle(post, 'agent-1', 'verifier', false, true);
    expect(calls).toEqual(['verifier', 'stop', 'start']);
    expect(out).toEqual({ enabled: false, agent: { id: 'agent-1', status: 'running' }, restartError: null });
  });

  it('does not restart an agent that is not running', async () => {
    const { post, calls } = backend('delegation');
    await saveOwnerToggle(post, 'agent-1', 'delegation', true, false);
    expect(calls).toEqual(['delegation']);
  });

  it('throws when the setting itself was not saved, and restarts nothing', async () => {
    const { post, calls } = backend('delegation', { fail: { delegation: apiError('FORBIDDEN', 403) } });
    await expect(saveOwnerToggle(post, 'agent-1', 'delegation', true, true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toEqual(['delegation']);
  });
});

describe('restartAgent', () => {
  it('answers with the agent as start returned it', async () => {
    const { post, calls } = backend('delegation');
    expect(await restartAgent(post, 'agent-1')).toEqual({ agent: { id: 'agent-1', status: 'running' }, restartError: null });
    expect(calls).toEqual(['stop', 'start']);
  });

  it('never throws: a failed stop is a restart error that says the save stands', async () => {
    const { post, calls } = backend('delegation', { fail: { stop: apiError('AGENT_ACTION_FAILED', 400, 'not running') } });
    const out = await restartAgent(post, 'agent-1');
    expect(calls).toEqual(['stop']);
    expect(out.agent).toBeNull();
    expect(friendlyError(out.restartError)).toMatchObject({ title: 'Restart failed' });
    expect(friendlyError(out.restartError).message).toMatch(/^Saved/);
  });
});
