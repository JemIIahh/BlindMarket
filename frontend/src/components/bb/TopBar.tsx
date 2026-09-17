import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePrivy } from '@privy-io/react-auth';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import { Button } from './Button';
import { LogoMark } from './LogoMark';
import { NotificationBell } from './NotificationBell';
import { getStoredTheme } from '../ThemeSync';
import { useUsdcBalance } from '../../hooks/useChainWallet';
import { baseChain, ogTestnet } from '../../config/chains';
import { isMainnet, isCctpUsable } from '../../config/constants';
import { copyToClipboard } from '../../lib/utils';
import { get } from '../../lib/api';
import { CctpFundModal } from '../CctpFundModal';
import { WithdrawModal } from '../WithdrawModal';

interface TopBarProps {
  onMenuClick?: () => void;
}

function shortenAddress(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}




export function TopBar({ onMenuClick }: TopBarProps = {}) {
  const [currentTheme, setCurrentTheme] = useState<'dark' | 'light'>(getStoredTheme);
  const { ready, authenticated, login, logout } = usePrivy();
  const { address } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  const usdc = useUsdcBalance();

  // Balance segment: which asset the single slot displays. The chevron opens
  // the switch-asset menu; the address opens the account menu
  // (copy/disconnect). Only one menu is ever open.
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [assetMenuOpen, setAssetMenuOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement | null>(null);

  // Fund-from-another-chain (Circle CCTP). Hidden entirely unless the backend
  // reports CCTP enabled on this deployment — the route 400s CCTP_DISABLED
  // otherwise, so there is nothing to offer.
  const [fundModalOpen, setFundModalOpen] = useState(false);
  const [withdrawModalOpen, setWithdrawModalOpen] = useState(false);
  const [cctpEnabled, setCctpEnabled] = useState(false);
  useEffect(() => {
    get<{ enabled: boolean; baseChainId?: number | null }>('/api/v1/cctp/config')
      .then((data) => setCctpEnabled(isCctpUsable(data)))
      .catch(() => setCctpEnabled(false));
  }, []);

  useEffect(() => {
    if (!accountMenuOpen && !assetMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
        setAssetMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [accountMenuOpen, assetMenuOpen]);

  const toggleTheme = () => {
    const next = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('bb.theme', next);
    } catch { }
    setCurrentTheme(next);
  };

  const supportedChainIds = [baseChain.id, ogTestnet.id];
  const offSupported = !!authenticated && !!chainId && !supportedChainIds.includes(chainId);
  const networkName = chainId === baseChain.id
    ? (isMainnet ? 'Base' : 'Base Sepolia')
    : (isMainnet ? '0G Mainnet' : ogTestnet.name);

  const shownAsset = { dot: 'bg-blue-500', symbol: 'USDC', sub: 'Base', amount: usdc.formatted };
  const refreshing = usdc.refreshing;
  const refreshBalances = () => usdc.refresh();

  return (
    <header className="h-14 w-full border-b border-line bg-surface flex items-center justify-between px-4">
      {/* zone: brand */}
      <div className="flex items-center gap-2.5 min-w-0">
        {onMenuClick && (
          <button
            onClick={onMenuClick}
            aria-label="open menu"
            className="md:hidden -ml-2 p-2 text-ink-2 hover:text-ink shrink-0"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}
        <Link to="/" className="flex items-center gap-2.5 min-w-0">
          <LogoMark size={22} blade="var(--bb-ink)" slit="var(--bb-surface)" className="shrink-0" />
          <span className={`hidden ${authenticated ? 'min-[520px]:inline md:hidden lg:inline' : 'min-[400px]:inline'} font-semibold text-[15px] text-ink tracking-tight whitespace-nowrap`}>
            BlindMarket
          </span>
        </Link>
      </div>

      {/* zone: controls */}
      <div className="flex items-center gap-3 shrink-0">
        {/* group: primary-action */}
        <Link to="/tasks/new" className={authenticated ? 'hidden lg:block' : 'hidden sm:block'}>
          <Button variant="outline" label="Post task" size="sm" className="h-8 rounded-md" />
        </Link>

        <span aria-hidden className={`${authenticated ? 'hidden lg:block' : 'hidden sm:block'} w-px h-5 bg-line`} />

        {/* group: utility */}
        <div className="flex items-center gap-1">
          <button
            onClick={toggleTheme}
            aria-label={currentTheme === 'light' ? 'switch to dark theme' : 'switch to light theme'}
            title={currentTheme === 'light' ? 'Dark theme' : 'Light theme'}
            className="hidden md:flex items-center justify-center h-8 w-8 rounded-md text-ink-2 hover:text-ink hover:bg-surface-2 transition-colors"
          >
            {currentTheme === 'light' ? (
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
            )}
          </button>
          <NotificationBell />
        </div>

        <span aria-hidden className={`${authenticated ? 'hidden sm:block' : ''} w-px h-5 bg-line`} />

        {/* group: account — ONE bordered box, segments joined by border-r */}
        {!ready ? (
          <div aria-hidden className="h-8 opacity-0 pointer-events-none select-none" />
        ) : !authenticated ? (
          <div className="flex items-center h-8 rounded-md border border-line text-[11px] font-mono">
            <button
              onClick={login}
              className="flex items-center px-2.5 h-full rounded-md text-ink hover:bg-surface-2 transition-colors"
            >
              <span className="opacity-40">[</span>&nbsp;{address ? 'sign_in' : 'connect_wallet'}&nbsp;<span className="opacity-40">]</span>
            </button>
          </div>
        ) : offSupported ? (
          <div className="flex items-center h-8 rounded-md border border-line text-[11px] font-mono">
            <button
              onClick={() => switchChain({ chainId: baseChain.id })}
              className="flex items-center px-2.5 h-full rounded-md text-err hover:bg-surface-2 transition-colors"
            >
              wrong_network
            </button>
          </div>
        ) : (
          <div ref={accountRef} className="relative flex items-center h-8 rounded-md border border-line text-[11px] font-mono">
            {/* segment: network */}
            <span className="hidden sm:flex md:hidden min-[800px]:flex items-center gap-1.5 px-2.5 h-full border-r border-line text-ink-2 whitespace-nowrap">
              <span className="w-1.5 h-1.5 rounded-full bg-ok shrink-0" />
              {networkName}
            </span>
            {/* segment: address */}
            <span className="flex items-center gap-1.5 px-2.5 h-full border-r border-line whitespace-nowrap">
              <button
                onClick={() => { setAssetMenuOpen(false); setAccountMenuOpen(o => !o); }}
                aria-haspopup="menu"
                aria-expanded={accountMenuOpen}
                className="font-mono text-ink hover:text-cream transition-colors"
              >
                {address ? shortenAddress(address) : 'connected'}
              </button>
              <button
                onClick={() => { if (address) copyToClipboard(address); }}
                aria-label="copy address"
                title="Copy address"
                className="hidden min-[520px]:inline-flex p-1.5 -m-1.5 text-ink-3 hover:text-ink transition-colors"
              >
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="12" height="12" rx="1" />
                  <path d="M5 15V4a1 1 0 0 1 1-1h10" />
                </svg>
              </button>
            </span>
            {/* segment: balance */}
            <button
              onClick={() => { setAccountMenuOpen(false); setAssetMenuOpen(o => !o); }}
              aria-haspopup="menu"
              aria-expanded={assetMenuOpen}
              title="Switch asset"
              className="flex items-center gap-1.5 px-2.5 h-full text-ink hover:bg-surface-2 rounded-r-md transition-colors whitespace-nowrap"
            >
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${shownAsset.dot}`} />
              <span className="hidden min-[520px]:inline text-ink-2">{shownAsset.symbol}</span>
              <span className="font-mono">{shownAsset.amount}</span>
              <svg
                viewBox="0 0 24 24"
                className={`w-3 h-3 text-ink-3 transition-transform ${assetMenuOpen ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            {accountMenuOpen && (
              <div role="menu" className="absolute right-0 top-full mt-1 min-w-[180px] border border-line bg-surface text-[11px] font-mono z-50">
                {address && (
                  <button
                    onClick={() => { copyToClipboard(address); setAccountMenuOpen(false); }}
                    className="block w-full text-left px-3 py-2 text-ink-2 hover:bg-surface-2 hover:text-ink transition-colors"
                  >
                    copy_address
                  </button>
                )}
                <button
                  onClick={() => { logout(); setAccountMenuOpen(false); }}
                  className={`block w-full text-left px-3 py-2 text-err hover:bg-surface-2 transition-colors ${address ? 'border-t border-line' : ''}`}
                >
                  disconnect
                </button>
              </div>
            )}

            {assetMenuOpen && (
              <div role="menu" aria-label="balance options" className="absolute right-0 top-full mt-1 min-w-[210px] border border-line bg-surface text-[11px] font-mono z-50">
                <div className="flex w-full items-center gap-2 px-3 py-2 text-ink-2">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-blue-500" />
                  <span>USDC</span>
                  <span className="text-ink-3">· {networkName}</span>
                  <span className="ml-auto font-mono">{usdc.formatted}</span>
                  <span className="text-cream">✓</span>
                </div>
                {cctpEnabled && (
                  <button
                    onClick={() => { setAssetMenuOpen(false); setFundModalOpen(true); }}
                    className="flex w-full items-center gap-2 px-3 py-2 border-t border-line text-ink-2 hover:bg-surface-2 hover:text-ink transition-colors"
                    title="Fund from another chain"
                  >
                    <span className="text-ink-3">+</span>
                    Fund from another chain
                  </button>
                )}
                <button
                  onClick={() => { setAssetMenuOpen(false); setWithdrawModalOpen(true); }}
                  className="flex w-full items-center gap-2 px-3 py-2 border-t border-line text-ink-2 hover:bg-surface-2 hover:text-ink transition-colors"
                  title="Withdraw USDC to any address"
                >
                  <span className="text-ink-3">→</span>
                  Withdraw
                </button>
                <button
                  onClick={() => { refreshBalances(); setAssetMenuOpen(false); }}
                  className="flex w-full items-center gap-2 px-3 py-2 border-t border-line text-ink-3 hover:bg-surface-2 hover:text-ink transition-colors"
                >
                  <svg
                    viewBox="0 0 16 16"
                    className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M14 2a8 8 0 0 1-12.4 9.6" />
                    <path d="M2 14a8 8 0 0 1 12.4-9.6" />
                    <path d="M14 2v3h-3" />
                    <path d="M2 14v-3h3" />
                  </svg>
                  Refresh balances
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {fundModalOpen && (
        <CctpFundModal onClose={() => setFundModalOpen(false)} onFunded={() => refreshBalances()} />
      )}
      {withdrawModalOpen && (
        <WithdrawModal onClose={() => setWithdrawModalOpen(false)} onWithdrawn={() => refreshBalances()} />
      )}
    </header>
  );
}
