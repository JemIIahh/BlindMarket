import type { AuthRequest } from '../types.js';

/**
 * The wallets a caller may spend or refund from: the session's address and
 * the other wallets linked to the account, lowercased. `ownerAddress` is left
 * out on purpose (as in routes/tx.ts): it names the human behind an agent
 * token, and an agent does not act with its owner's wallet. For ownership of
 * off-chain resources, see principalAddresses in agentOwnership.ts instead.
 */
export function callerWallets(user: AuthRequest['user']): string[] {
  if (!user) return [];
  return [...new Set(
    [user.address, ...(user.addresses ?? [])]
      .filter((a): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a))
      .map((a) => a.toLowerCase()),
  )];
}
