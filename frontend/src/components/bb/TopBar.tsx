import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from './Button';
import { ConnectWalletButton } from './ConnectWalletButton';
import { getStoredTheme } from '../ThemeSync';
import { useUsdcBalance } from '../../hooks/useChainWallet';

interface TopBarProps {
  onMenuClick?: () => void;
}

export function TopBar({ onMenuClick }: TopBarProps = {}) {
  const [currentTheme, setCurrentTheme] = useState<'dark' | 'light'>(getStoredTheme);
  const usdc = useUsdcBalance();

  const toggleTheme = () => {
    const next = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('bb.theme', next);
    } catch { }
    setCurrentTheme(next);
  };

  return (
    <header className="h-16 border-b border-line bg-surface flex items-center justify-end px-4 sm:px-6 gap-2 sm:gap-3">
      {/* Hamburger — mobile only, far left */}
      {onMenuClick && (
        <button
          onClick={onMenuClick}
          aria-label="open menu"
          className="md:hidden mr-auto -ml-2 p-2 text-ink-2 hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      )}

      {/* Post task — hidden on smallest screens to save space */}
      <Link to="/tasks/new" className="hidden sm:block">
        <Button variant="outline" label="Post task" size="sm" />
      </Link>

      {/* Theme toggle — hidden on small screens */}
      <button
        onClick={toggleTheme}
        aria-label="toggle theme"
        className="hidden md:flex items-center border border-line text-[11px]"
      >
        <span className={`px-3 py-1.5 ${currentTheme === 'light' ? 'text-ink' : 'text-ink-3'}`}>
          {currentTheme === 'light' ? '●' : '◌'} Light
        </span>
        <span className={`px-3 py-1.5 border-l border-line ${currentTheme === 'dark' ? 'text-ink' : 'text-ink-3'}`}>
          {currentTheme === 'dark' ? '●' : '◌'} Dark
        </span>
      </button>

      {/* Wallet — Privy-driven connect/disconnect pill */}
      <ConnectWalletButton />
      {/* USDC balance */}
      <div className="flex items-center gap-2 px-3 py-1.5 border border-line text-[11px] font-mono text-ink hover:bg-surface-2 transition-colors">
        <span className="w-1.5 h-1.5 bg-blue-500 inline-block" />
        <span className="text-[10px] text-blue-600">USDC</span>
        <span className="text-[10px] text-ink-2">${usdc.formatted}</span>
      </div>
    </header>
  );
}
