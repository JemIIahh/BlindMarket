import type { AgentExecutor } from '../types.js';

/**
 * The chains an executor registered before `supportedChains` existed can
 * sign for. A literal on purpose: it describes that old code, so it must not
 * grow when this backend learns a new chain.
 */
export const LEGACY_SUPPORTED_CHAINS: readonly string[] = Object.freeze(['base']);

/**
 * Does this executor's declaration include `chain`? No chain means no filter,
 * which is right for listings and for ranking (a freshly indexed task always
 * has one). No imports beyond types, so any module (and its tests) can use it
 * without loading stores.
 */
export function supportsChain(
  agent: Pick<AgentExecutor, 'supportedChains'>,
  chain: string | null | undefined,
): boolean {
  if (!chain) return true;
  return (agent.supportedChains ?? LEGACY_SUPPORTED_CHAINS).includes(chain);
}

/**
 * Can this executor take this task? Used where a task is handed over
 * (/accept, /bid, the verifier's list). A task indexed before its chain was
 * recorded may be on either legacy chain, so the executor must support both.
 */
export function supportsTaskChain(
  agent: Pick<AgentExecutor, 'supportedChains'>,
  chain: string | null | undefined,
): boolean {
  return chain
    ? supportsChain(agent, chain)
    : LEGACY_SUPPORTED_CHAINS.every((c) => supportsChain(agent, c));
}
