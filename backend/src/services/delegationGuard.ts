import type { DeployedAgent } from '../types.js';
import { AppError } from '../middleware/errorHandler.js';
import { loadAgentBySmartAccount, loadAgentByWallet } from './deployedAgentStore.js';

/**
 * Who may make a hosted agent pay for a sub-task.
 *
 * A hosted agent posts a sub-task through delegate_to_agent, funding the
 * reward from its own wallet. The task brief sits in the same prompt as that
 * tool, so a poster could write a brief that has the agent pay a sub-task to
 * the poster's own agent. Delegation is therefore the owner's opt-in, off by
 * default (DeployedAgent.delegationEnabled): the worker does not give the
 * model the tool, and the backend refuses to build or list a task a hosted
 * agent's wallet posts, so a worker that bypassed its own check still can't
 * get a sub-task taken. Addresses that are not hosted agents (a person's
 * wallet, an SDK agent run with its own keys) are not affected.
 */

async function hostedAgent(address: string): Promise<DeployedAgent | null> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return (await loadAgentByWallet(address)) ?? (await loadAgentBySmartAccount(address));
}

export const DELEGATION_DISABLED_MESSAGE =
  "This agent's owner hasn't allowed it to post paid sub-tasks. Turn on delegation in the agent's settings to allow it.";

/** Throws 403 DELEGATION_DISABLED when `poster` is a hosted agent whose owner has not turned delegation on. */
export async function refuseUnapprovedDelegation(poster: string): Promise<void> {
  const agent = await hostedAgent(poster);
  if (agent && agent.delegationEnabled !== true) {
    throw new AppError(403, 'DELEGATION_DISABLED', DELEGATION_DISABLED_MESSAGE);
  }
}

/** A hosted agent's owner and linked owners, lowercase. */
function ownersOf(agent: DeployedAgent): Set<string> {
  return new Set([agent.ownerAddress, ...(agent.authorizedOwners ?? [])].map((a) => a.toLowerCase()));
}

/**
 * True when `poster` is a hosted agent (so the task is a sub-task) and
 * `executor` is an agent of the same owner, or the owner's own wallet. An
 * owner paying their own agent from another of their agents gains nothing
 * honest; it manufactures assignments. Defence in depth only: an owner with a
 * second address gets past it, which is why delegation is opt-in.
 */
export async function sameOwnerSubtask(poster: string, executor: string): Promise<boolean> {
  const posting = await hostedAgent(poster);
  if (!posting) return false;
  const posterOwners = ownersOf(posting);
  const executing = await hostedAgent(executor);
  const executorOwners = executing ? ownersOf(executing) : new Set([executor.toLowerCase()]);
  return [...executorOwners].some((owner) => posterOwners.has(owner));
}
