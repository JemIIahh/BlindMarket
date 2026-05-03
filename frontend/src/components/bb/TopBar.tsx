import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Button } from './Button';

function shortenAddress(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

interface TopBarProps {
  onMenuClick?: () => void;
}

export function TopBar({ onMenuClick }: TopBarProps = {}) {
  const [currentTheme, setCurrentTheme] = useState('light');

  useEffect(() => {
    const savedTheme = localStorage.getItem('bb.theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    setCurrentTheme(savedTheme);
  }, []);

  const toggleTheme = () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('bb.theme', next);
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
        <Button variant="outline" label="post_task" size="sm" />
      </Link>

      {/* Theme toggle — hidden on small screens */}
      <button
        onClick={toggleTheme}
        className="hidden md:flex items-center border border-line text-[11px] font-mono"
      >
        <span className={`px-3 py-1.5 ${currentTheme === 'light' ? 'text-ink' : 'text-ink-3'}`}>
          {currentTheme === 'light' ? '●' : '◌'} light
        </span>
        <span className={`px-3 py-1.5 border-l border-line ${currentTheme === 'dark' ? 'text-ink' : 'text-ink-3'}`}>
          {currentTheme === 'dark' ? '●' : '◌'} dark
        </span>
      </button>

      {/* Wallet — custom-styled rainbowkit button */}
      <ConnectButton.Custom>
        {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
          const ready = mounted;
          const connected = ready && account && chain;

          if (!ready) {
            return <div aria-hidden className="opacity-0 pointer-events-none select-none" />;
          }

          if (!connected) {
            return (
              <button
                onClick={openConnectModal}
                className="px-3 py-1.5 border border-line text-[11px] font-mono text-ink hover:bg-surface-2 transition-colors"
              >
                <span className="opacity-40">[</span> connect_wallet <span className="opacity-40">]</span>
              </button>
            );
          }

          if (chain.unsupported) {
            return (
              <button
                onClick={openChainModal}
                className="px-3 py-1.5 border border-err text-[11px] font-mono text-err hover:bg-surface-2 transition-colors"
              >
                wrong_network
              </button>
            );
          }

          return (
            <div className="flex items-center border border-line text-[11px] font-mono">
              {/* Chain segment — hidden on small screens */}
              <button
                onClick={openChainModal}
                className="hidden sm:flex px-3 py-1.5 text-ink-2 hover:text-ink hover:bg-surface-2 transition-colors items-center gap-1.5"
              >
                <span className="w-1.5 h-1.5 bg-ok inline-block" />
                {chain.name}
              </button>
              <button
                onClick={openAccountModal}
                className="px-3 py-1.5 sm:border-l border-line text-ink hover:bg-surface-2 transition-colors flex items-center gap-1.5"
              >
                {/* On mobile, dot indicator stays since chain segment is hidden */}
                <span className="sm:hidden w-1.5 h-1.5 bg-ok inline-block" />
                {shortenAddress(account.address)}
              </button>
            </div>
          );
        }}
      </ConnectButton.Custom>
    </header>
  );
}
