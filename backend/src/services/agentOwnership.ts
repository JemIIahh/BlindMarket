import type { DeployedAgent } from '../types.js';

/**
 * Shared ownership predicate for deployed agents. Owner set = the original
 * wagmi deploy wallet (ownerAddress) plus any signature-linked wallets
 * (authorizedOwners, added via POST /agents/:id/link-owner).
 *
 * Used by both the REST routes (agents.ts authorizeOwner) and the MCP tool
 * surface (services/mcp/tools.ts) so the two gates cannot drift apart.
 */
export function isAgentOwner(agent: DeployedAgent, candidateAddresses: Array<string | undefined>): boolean {
  const ownerSet = new Set(
    [agent.ownerAddress, ...(agent.authorizedOwners ?? [])].map((a) => a.toLowerCase()),
  );
  return candidateAddresses.some(
    (a) => typeof a === 'string' && a !== 'agent' && ownerSet.has(a.toLowerCase()),
  );
}

/**
 * Strip every secret-bearing field from a DeployedAgent record before it
 * leaves the backend. Single definition shared by agents.ts strip() and the
 * MCP tools, so a newly added secret field only needs stripping in one place.
 */
export function stripAgentSecrets<T extends DeployedAgent>(agent: T | null | undefined) {
  if (!agent) return null;
  const { encryptedPrivateKey: _a, encryptedApiKey: _b, apiKey: _c, rawPrivateKey: _d, platformToken: _e, ...safe } = agent;
  return safe;
}
