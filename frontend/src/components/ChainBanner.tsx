import { useWallet } from '../context/WalletContext';
import { useAuth } from '../context/AuthContext';
import { useChain } from '../context/ChainContext';
import { ARC_CHAIN_ID, getChainConfig } from '../config/constants';
import { SupportedChain } from '../config/constants';

/**
 * Sticky banner shown when the user is connected but on a chain other than the
 * active network. Clicking "Switch" asks the wallet to switch (adding the
 * network if it doesn't exist yet). Invisible when the user is disconnected or
 * already on the right chain.
 */
export function ChainBanner() {
  const { chainId, isCorrectChain, switchChain } = useWallet();
  const { isAuthenticated } = useAuth();
  const { activeChain } = useChain();
  const config = getChainConfig(activeChain as SupportedChain);
  const netName = config.chainName;
  const targetChainId = ARC_CHAIN_ID;

  if (!isAuthenticated) return null;
  if (chainId == null) return null;
  if (isCorrectChain) return null;

  // A floating rounded bar under the top bar, inset like the page content.
  return (
    <div className="sticky top-0 z-40 px-4 sm:px-6 md:px-8 pt-3">
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-[color-mix(in_srgb,var(--bb-warn)_40%,transparent)] bg-[color-mix(in_srgb,var(--bb-warn)_12%,var(--bb-surface))] px-4 py-2.5 text-sm text-ink shadow-[var(--bb-card-shadow)]">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-warn" aria-hidden />
          <span className="min-w-0">
            Wrong network: you're on chain <span className="font-mono">{chainId}</span>. BlindMarket runs on {netName} ({targetChainId}).
          </span>
        </div>
        <button
          type="button"
          onClick={() => switchChain(targetChainId)}
          className="shrink-0 whitespace-nowrap rounded-full border border-[color-mix(in_srgb,var(--bb-warn)_60%,transparent)] bg-[color-mix(in_srgb,var(--bb-warn)_20%,transparent)] px-3.5 py-1.5 text-xs font-medium text-ink transition-colors duration-200 hover:bg-[color-mix(in_srgb,var(--bb-warn)_30%,transparent)]"
        >
          Switch to {netName}
        </button>
      </div>
    </div>
  );
}