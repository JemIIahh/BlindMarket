import { extendAcceptLock } from './a2aStore.js';
import { ACCEPT_LOCK_MAX_HOLD_S, ACCEPT_LOCK_TTL_S } from '../constants.js';

/**
 * Keep request `token`'s accept lock alive while /accept settles. Settlement
 * waits on the indexer, the serial tx queue and a receipt, which can outlast
 * the lock's ACCEPT_LOCK_TTL_S; a lapsed lock let a retry of the same accept
 * run a second settlement alongside the first. Every `everyMs` the lock is
 * extended (a2aStore.extendAcceptLock, owner-checked, so a lock this request
 * lost is never extended), for at most `maxHoldMs` in all: past that a hung
 * request lets the TTL run out instead of holding the task forever. The TTL
 * still frees the lock if this process dies. Returns the function that stops
 * it; call it before releasing the lock.
 */
export function keepAcceptLock(
  taskId: string,
  agentAddress: string,
  token: string,
  { everyMs = (ACCEPT_LOCK_TTL_S * 1000) / 3, maxHoldMs = ACCEPT_LOCK_MAX_HOLD_S * 1000 } = {},
): () => void {
  const until = Date.now() + maxHoldMs;
  const timer = setInterval(() => {
    if (Date.now() >= until) {
      clearInterval(timer);
      return;
    }
    extendAcceptLock(taskId, agentAddress, token).catch(() => {});
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
