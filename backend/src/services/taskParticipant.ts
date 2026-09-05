import * as a2aStore from './a2aStore.js';
import type { AuthUser } from '../types.js';

/**
 * Chain-of-custody routes are keyed only by :taskId, so requireAuth alone
 * lets ANY authenticated wallet read or forge another task's evidence chain
 * (see backend/src/routes/custody.ts). This module is the shared predicate:
 * the caller must be the task's poster, its designated verifier, or its
 * assigned executor.
 *
 * Mirrors the check `backend/src/routes/forensics.ts` already applies inline
 * for the same class of data (forensic reports), and the multi-address
 * handling in `resultVisibility.ts` — an agent owner acting for their agent
 * carries `ownerAddress`/`addresses[]` rather than `address`, so all three
 * are checked, not just `address`.
 */
function callerAddresses(user: AuthUser | undefined): Set<string> {
  if (!user) return new Set();
  return new Set(
    [user.address, user.ownerAddress, ...(user.addresses ?? [])]
      .filter((a): a is string => typeof a === 'string' && a.startsWith('0x'))
      .map((a) => a.toLowerCase()),
  );
}

/**
 * True iff `user` is the task's poster, designated verifier, or assigned
 * executor. Used to gate the read routes (`/chain`, `/verify`, `/audit`) —
 * the custody chain includes `data_snapshot`, the evidence content itself.
 */
export async function assertTaskParticipant(taskId: string, user: AuthUser | undefined): Promise<boolean> {
  const caller = callerAddresses(user);
  if (caller.size === 0) return false;

  const [meta, state] = await Promise.all([
    a2aStore.getMeta(taskId),
    a2aStore.getState(taskId),
  ]);
  const allowed = [meta?.posterAddress, meta?.verifierAddress, state?.executorAddress]
    .filter((a): a is string => !!a)
    .map((a) => a.toLowerCase());

  return allowed.some((a) => caller.has(a));
}

/**
 * True iff `user` is the task's assigned executor. Stricter than
 * `assertTaskParticipant`: used to gate `POST /ingest`, where only the
 * executor that produced the evidence may append to the chain — the poster
 * and verifier are readers here, not submitters. A task with no assigned
 * executor yet has nothing legitimate to ingest, so this returns false
 * rather than allowing anyone through.
 */
export async function assertTaskExecutor(taskId: string, user: AuthUser | undefined): Promise<boolean> {
  const caller = callerAddresses(user);
  if (caller.size === 0) return false;

  const state = await a2aStore.getState(taskId);
  const executor = state?.executorAddress;
  if (!executor) return false;

  return caller.has(executor.toLowerCase());
}
