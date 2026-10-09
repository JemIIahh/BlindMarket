import { UserFacingError } from './friendlyError';

/**
 * An owner's change to an agent (its settings, verifier duty, paying other
 * agents) and the restart that applies it. The change is saved by its own
 * route; the running worker reads it at start, so a running agent is
 * restarted after.
 *
 * The two can fail apart. A restart that fails leaves the change saved, so
 * the page shows what the server stored and the error names the restart.
 * One mutation for both used to reset a switch on any failure, so an opt-in
 * that was saved looked as if it was not.
 */
export type OwnerToggle = 'verifier' | 'delegation' | 'open-submission';

export interface OwnerToggleResult<A> {
  /** The setting as the server stored it. */
  enabled: boolean;
  /** The agent as the last stop or start answered, when one ran. */
  agent: A | null;
  /** Why the restart failed, worded for the page; null when it ran or was not needed. */
  restartError: unknown;
}

type Post = <T>(path: string, body: unknown) => Promise<T>;

const FIELD: Record<OwnerToggle, string> = {
  verifier: 'verifierEnabled',
  delegation: 'delegationEnabled',
  'open-submission': 'openSubmissionEnabled',
};

/**
 * Stop and start the agent so it runs on what was just saved. Never throws:
 * `agent` is the agent as the last of the two answered, and `restartError`
 * says, for the page, that the save stands and the restart did not happen.
 */
export async function restartAgent<A>(post: Post, agentId: string): Promise<{ agent: A | null; restartError: unknown }> {
  let agent: A | null = null;
  try {
    agent = await post<A>(`/api/v1/agents/${agentId}/stop`, {});
    agent = await post<A>(`/api/v1/agents/${agentId}/start`, {});
    return { agent, restartError: null };
  } catch (err) {
    return {
      agent,
      restartError: new UserFacingError(
        'Saved, but the agent did not restart, so the change is not applied yet. Start the agent again to apply it.',
        { title: 'Restart failed', cause: err },
      ),
    };
  }
}

/** Save `toggle`, then restart the agent when it runs. Throws only when the setting was not saved. */
export async function saveOwnerToggle<A>(
  post: Post,
  agentId: string,
  toggle: OwnerToggle,
  enabled: boolean,
  running: boolean,
): Promise<OwnerToggleResult<A>> {
  const saved = await post<Record<string, unknown> | null>(`/api/v1/agents/${agentId}/${toggle}`, { enabled });
  const stored = saved?.[FIELD[toggle]];
  const value = typeof stored === 'boolean' ? stored : enabled;
  if (!running) return { enabled: value, agent: null, restartError: null };
  return { enabled: value, ...(await restartAgent<A>(post, agentId)) };
}
