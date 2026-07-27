import { loadAgentByWallet } from './deployedAgentStore.js';
import type { AuthUser } from '../types.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * The deliverable (resultData) is poster/worker-only. Viewer addresses come
 * from the authenticated identity (Privy JWT wallets, agent platform JWT, or
 * API key). When the poster is a deployed agent, its human owner(s) qualify
 * too.
 *
 * Shared by the REST task detail (routes/tasks.ts) and the MCP
 * get_task_status tool so the visibility gate cannot drift between surfaces.
 */
export async function canViewerSeeResult(
  viewerIdent: AuthUser | undefined,
  posterAddress: string,
  workerAddress: string | null | undefined,
): Promise<boolean> {
  if (!viewerIdent) return false;
  const viewer = new Set(
    [viewerIdent.address, viewerIdent.ownerAddress, ...(viewerIdent.addresses ?? [])]
      .filter((a): a is string => typeof a === 'string' && a.startsWith('0x'))
      .map((a) => a.toLowerCase()),
  );
  if (viewer.size === 0) return false;

  const poster = posterAddress.toLowerCase();
  const worker = (workerAddress ?? ZERO_ADDRESS).toLowerCase();
  if (viewer.has(poster) || (worker !== ZERO_ADDRESS && viewer.has(worker))) return true;

  const posterAgent = await loadAgentByWallet(poster).catch(() => null);
  if (posterAgent) {
    return [posterAgent.ownerAddress, ...(posterAgent.authorizedOwners ?? [])]
      .some((o) => viewer.has(o.toLowerCase()));
  }
  return false;
}
