import { UserFacingError } from './friendlyError';

/**
 * An owner's switch on an agent (verifier duty, paying other agents) and the
 * restart that applies it. The setting is saved by its own route; the
 * running worker reads it at start, so a running agent is restarted after.
 *
 * The two can fail apart. A restart that fails leaves the setting saved, so
 * the switch shows what the server stored and the error names the restart.
 * One mutation for both used to reset the switch on any failure, so an
 * opt-in that was saved looked as if it was not.
 */
export type OwnerToggle = 'verifier' | 'delegation';

export interface OwnerToggleResult<A> {
  /** The setting as the server stored it. */
  enabled: boolean;
  /** The agent as the last stop or start answered, when one ran. */
  agent: A | null;
  /** Why the restart failed, worded for the page; null when it ran or was not needed. */
  restartError: unknown;
}

type Post = <T>(path: string, body: unknown) => Promise<T>;

const FIELD: Record<OwnerToggle, string> = { verifier: 'verifierEnabled', delegation: 'delegationEnabled' };

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
  const result: OwnerToggleResult<A> = { enabled: typeof stored === 'boolean' ? stored : enabled, agent: null, restartError: null };
  if (!running) return result;
  try {
    result.agent = await post<A>(`/api/v1/agents/${agentId}/stop`, {});
    result.agent = await post<A>(`/api/v1/agents/${agentId}/start`, {});
  } catch (err) {
    result.restartError = new UserFacingError(
      'The setting is saved, but the agent did not restart, so the change is not applied yet. Start the agent again to apply it.',
      { title: 'Restart failed', cause: err },
    );
  }
  return result;
}
