// The backend counts a payment only from a wallet on the signed-in account: the
// embedded wallet or a linked external one (the Privy token's linked_accounts).
// The wallet that signs is whatever the browser wallet has selected, which can
// be another account entirely. On 2026-09-24 a poster's MetaMask was on an
// unlinked account: two 5 USDC escrows were funded, and the backend then
// refused to list either task (NOT_TASK_AGENT). So every flow that pays checks
// the signer against the account's wallets before spending anything.

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Why a payment from `signer` must not go ahead, or null when it may.
 * `consequence` completes "…isn't linked to your BlindMarket account, so …".
 * An empty `accountWallets` (the account not loaded yet) never blocks.
 */
export function unlinkedSignerError(
  signer: string,
  accountWallets: readonly (string | null | undefined)[],
  consequence: string,
): string | null {
  const from = signer.toLowerCase();
  const wallets = [...new Set(accountWallets.filter((a): a is string => !!a).map((a) => a.toLowerCase()))];
  if (wallets.length === 0 || wallets.includes(from)) return null;
  return (
    `Your wallet is set to ${short(from)}, which isn't linked to your BlindMarket account, so ${consequence}. ` +
    `Nothing was spent. Switch your wallet to ${wallets.map(short).join(' or ')}, ` +
    `or link ${short(from)} under Settings → Link wallet, then try again.`
  );
}
