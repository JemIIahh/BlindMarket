import { useWallet } from '../context/WalletContext';
import { useAuth } from '../context/AuthContext';
import { useChain } from '../context/ChainContext';
import { OG_CHAIN_ID, BASE_CHAIN_ID, getChainConfig } from '../config/constants';
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
  const targetChainId = activeChain === 'base' ? BASE_CHAIN_ID : OG_CHAIN_ID;

  if (!isAuthenticated) return null;
  if (chainId == null) return null;
  if (isCorrectChain) return null;

  return (
    <div className="sticky top-0 z-40 flex items-center justify-between gap-4 border-b border-warn/40 bg-warn/10 px-6 py-2 text-sm text-ink backdrop-blur">
      <div className="flex items-center gap-3">
        <span className="inline-block h-2 w-2 bg-warn" aria-hidden />
        <span>
          Wrong network — you're on chain <span className="font-mono">{chainId}</span>. BlindMarket runs on {netName} ({targetChainId}).
        </span>
      </div>
      <button
        type="button"
        onClick={() => switchChain(targetChainId)}
        className="border border-warn/60 bg-warn/20 px-3 py-1 text-xs font-medium text-ink hover:bg-warn/30 transition-colors whitespace-nowrap"
      >
        Switch to {netName}
      </button>
    </div>
  );
}