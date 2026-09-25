/**
 * Which escrow an indexer's Redis keys belong to.
 *
 * An indexer's keys (checkpoint, hash↔id maps) describe one escrow on one
 * chain, but their names don't say which. A redeployed escrow, or a backend
 * for another network sharing this Redis, would read and write the same
 * keys. Each indexer records `<chainId>:<escrow>` under its prefix the first
 * time it runs and compares on later runs. A mismatch is logged and reported
 * as `indexerError` in /health/bridge. Indexing carries on: the operator
 * decides whether the keys are wrong.
 */

import { redis } from './redis.js';
import type { TaskChain } from './taskChain.js';
import { chainScope } from './chainScope.js';

/** Fingerprint key for a chain, next to that indexer's other keys and under
 *  the same network scope (chainScope), so a testnet and a mainnet backend
 *  never share keys in the first place. */
export function fingerprintKey(chain: TaskChain, chainId?: number): string {
  return `${chainScope(chain, chainId)}:events:escrow`;
}

const RECHECK_MS = 60_000;

interface State {
  checkedAt: number;
  error: string | null;
}

const states = new Map<TaskChain, State>();

/**
 * Record or compare the fingerprint, at most once per RECHECK_MS. Never
 * throws: a failed Redis call keeps the previous result and is retried on
 * the next call.
 */
export async function checkEscrowFingerprint(
  chain: TaskChain,
  chainId: number,
  escrowAddress: string | null | undefined,
  now = Date.now(),
): Promise<void> {
  if (!escrowAddress || /^0x0{40}$/i.test(escrowAddress)) return;
  let state = states.get(chain);
  if (!state) {
    state = { checkedAt: Number.NEGATIVE_INFINITY, error: null };
    states.set(chain, state);
  }
  if (now - state.checkedAt < RECHECK_MS) return;

  const key = fingerprintKey(chain, chainId);
  const expected = `${chainId}:${escrowAddress.toLowerCase()}`;
  try {
    const written = await redis.set(key, expected, 'NX');
    const stored = written === null ? await redis.get(key) : expected;
    state.checkedAt = now;

    const error = stored === null || stored === expected
      ? null
      : `${key} is ${stored} but this backend indexes ${expected}; this chain's index keys may belong to another escrow or network`;
    if (error !== state.error) {
      if (error) console.error(`[escrowFingerprint] ${chain}: ${error}`);
      else console.log(`[escrowFingerprint] ${chain}: fingerprint matches ${expected} again`);
      state.error = error;
    }
  } catch (err) {
    console.warn(`[escrowFingerprint] ${chain}: check failed: ${(err as Error).message}`);
  }
}

/** The last mismatch seen for a chain, or null. */
export function escrowFingerprintError(chain: TaskChain): string | null {
  return states.get(chain)?.error ?? null;
}
