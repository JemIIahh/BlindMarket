/**
 * Agents deployed before the deploying Privy user was stored have none, so
 * they can't get sponsored gas (docs/AGENT-GAS-FUNDING.md, "Who is
 * eligible"). When their owner next uses an owner route with a verified Privy
 * token, the id is filled in on the agents that identity's own linked wallets
 * own or co-own, and only where none is recorded yet. An sk_ API key or an
 * agent's registration/platform token never fills it: neither carries a
 * verified Privy identity.
 */
import type { AuthUser } from '../types.js';
import { backfillPrivyUserId } from './deployedAgentStore.js';

const EVERY_MS = 10 * 60_000;
const lastRun = new Map<string, number>();

export async function backfillOwnerPrivyId(user: AuthUser | undefined, now = Date.now()): Promise<void> {
  // privyUserId is set only by verifyPrivyToken; any typ is an HS256 worker token.
  if (!user?.privyUserId || user.typ !== undefined) return;
  const did = user.privyUserId;
  if ((lastRun.get(did) ?? 0) > now - EVERY_MS) return;
  lastRun.set(did, now);
  try {
    const { filled, mismatched } = await backfillPrivyUserId(did, [user.address, ...(user.addresses ?? [])]);
    if (filled.length > 0) console.log(`[privyBackfill] recorded the deploying Privy user on ${filled.length} agent(s): ${filled.join(', ')}`);
    for (const m of mismatched) {
      console.warn(`[privyBackfill] agent ${m.id} records another Privy user than its signed-in owner; left as is`);
    }
  } catch (err) {
    lastRun.delete(did);
    console.warn(`[privyBackfill] could not backfill: ${(err as Error).message}`);
  }
}

/** Test hook. */
export function _resetPrivyBackfill(): void {
  lastRun.clear();
}
