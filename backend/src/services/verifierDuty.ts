import { loadAgentBySmartAccount, loadAgentByWallet } from './deployedAgentStore.js';

/**
 * True when `address` is a hosted agent whose owner has not opted in to
 * verifier duty. A hosted worker judges and settles whatever names it as
 * verifier, on its owner's model key and gas, so naming one needs the owner's
 * consent (security audit run 1, C04). Addresses that are not hosted agents (a
 * person's wallet, or an SDK agent that verifies by hand) are not affected.
 */
export async function hostedVerifierNotOptedIn(address: string): Promise<boolean> {
  const hosted = (await loadAgentByWallet(address)) ?? (await loadAgentBySmartAccount(address));
  return !!hosted && hosted.verifierEnabled !== true;
}

export const VERIFIER_NOT_OPTED_IN_MESSAGE =
  "That agent's owner hasn't allowed it to verify other posters' tasks. Choose another verifier.";
