/**
 * Redis keys of the DisputeResolved listener, under each chain's index
 * prefix so the escrow fingerprint on that prefix describes them too. Kept
 * apart from disputeListener so /health/bridge can read them without
 * importing the settlement code.
 */

import type { TaskChain } from './taskChain.js';

const PREFIX: Record<TaskChain, string> = { base: 'base', arc: 'arc' };

export function disputeKeys(chain: TaskChain) {
  const p = PREFIX[chain];
  return {
    /** Hash { count, firstAt } of an event's consecutive failures. */
    attempts: (taskId: string) => `${p}:dispute-attempts:${taskId}`,
    /** Present once an event is fully processed. */
    done: (taskId: string) => `${p}:dispute-done:${taskId}`,
    /** Hash of taskId → JSON of a parked event. */
    parked: `${p}:dispute-parked`,
  };
}

/** How many of a chain's rulings are parked. */
export async function parkedDisputeCount(chain: TaskChain): Promise<number> {
  const { redis } = await import('./redis.js');
  return redis.hlen(disputeKeys(chain).parked);
}
