import { useState, useRef, useEffect } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import { arcChain } from '../../config/chains';
import { copyToClipboard } from '../../lib/utils';

function shortenAddress(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

interface Props {
  variant?: 'pill' | 'block';
}

function EvmWalletButton({ variant }: Props) {
  const { ready, authenticated, login, logout } = usePrivy();
  const { address } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // The wallet connects to Arc only (wagmi + Privy are configured with
  // arcChain alone), so Arc is the one network that is not "wrong" — and the
  // only one a switch can reach.
  const activeChain = chainId === arcChain.id ? null : arcChain;
  const networkName = arcChain.name;

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  if (!ready) {
    return <div aria-hidden className="opacity-0 pointer-events-none select-none" />;
  }

  if (!authenticated) {
    // An injected wallet can be connected (address present) without a Privy
    // session — the backend still needs a sign-in. Name the actual next step.
    const label = address ? 'sign_in' : 'connect_wallet';
    if (variant === 'block') {
      return (
        <button onClick={login} className="w-full px-4 py-2 border border-line text-sm font-mono text-ink hover:bg-surface-2 transition-colors">
          {label}
        </button>
      );
    }
    return (
      <button onClick={login} className="px-3 py-1.5 border border-line text-[11px] font-mono text-ink hover:bg-surface-2 transition-colors">
        <span className="opacity-40">[</span> {label} <span className="opacity-40">]</span>
      </button>
    );
  }

  if (chainId && activeChain) {
    return (
      <button onClick={() => switchChain({ chainId: activeChain.id })} className="px-3 py-1.5 border border-err text-[11px] font-mono text-err hover:bg-surface-2 transition-colors">
        wrong_network
      </button>
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      <div className="flex items-center border border-line text-[11px] font-mono">
        <span className="hidden sm:flex px-3 py-1.5 text-ink-2 items-center gap-1.5">
          <span className="w-1.5 h-1.5 bg-ok inline-block" />
          {networkName}
        </span>
        <button onClick={() => setMenuOpen(o => !o)} className="px-3 py-1.5 sm:border-l border-line text-ink hover:bg-surface-2 transition-colors flex items-center gap-1.5">
          <span className="sm:hidden w-1.5 h-1.5 bg-ok inline-block" />
          {address ? shortenAddress(address) : 'connected'}
        </button>
      </div>
      {menuOpen && (
        <div className="absolute right-0 top-full mt-1 min-w-[180px] border border-line bg-surface text-[11px] font-mono z-50">
          {address && (
            <button onClick={() => { copyToClipboard(address); setMenuOpen(false); }} className="block w-full text-left px-3 py-2 text-ink-2 hover:bg-surface-2 hover:text-ink transition-colors">
              copy_address
            </button>
          )}
          <button onClick={() => { logout(); setMenuOpen(false); }} className="block w-full text-left px-3 py-2 border-t border-line text-err hover:bg-surface-2 transition-colors">
            disconnect
          </button>
        </div>
      )}
    </div>
  );
}

export function ConnectWalletButton({ variant = 'pill' }: Props) {
  return <EvmWalletButton variant={variant} />;
}