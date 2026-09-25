import type { DeployedAgent } from '../types.js';
import { loadAgentBySmartAccount, loadAgentByWallet, loadAllAgents } from './deployedAgentStore.js';

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

/**
 * Hosted agents that will judge a task naming them as verifier: the owner
 * opted in and the agent is running (the worker only verifies when both hold).
 * Keyed by lowercase wallet and smart-account address, so a registry entry
 * under either one resolves. This is the set the web app's verifier picker
 * offers: any other hosted agent is refused at post, and an address outside
 * the hosted set gives no sign it will ever verify.
 */
export async function activeHostedVerifiers(): Promise<Map<string, DeployedAgent>> {
  const byAddress = new Map<string, DeployedAgent>();
  for (const agent of await loadAllAgents()) {
    if (agent.verifierEnabled !== true || agent.status !== 'running') continue;
    for (const addr of [agent.walletAddress, agent.smartAccountAddress]) {
      if (addr) byAddress.set(addr.toLowerCase(), agent);
    }
  }
  return byAddress;
}
