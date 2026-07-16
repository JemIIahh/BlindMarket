import { useEffect, useState } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { LogoMark, Button } from '../bb';
import { ChainToggle } from '../bb/ChainToggle';
import { useChain } from '../../context/ChainContext';
import { getChainConfig } from '../../config/constants';
import { useAnalytics } from '../../hooks/useAnalytics';

/**
 * MarketingLayout — the public-facing chrome (nav + footer) shared by the
 * landing page and /how-it-works, so the first click from the landing doesn't
 * context-switch into the dashboard shell. The app shell (DashboardLayout)
 * starts at the "Launch app" boundary, deliberately.
 *
 * One conversion story: the single primary CTA everywhere in this chrome is
 * "Launch app" (chain selector → /a2a). Everything else is a text link.
 */

/** Shared launch-app behavior: open the chain selector, then enter the app
 * once it closes. Used by the nav here and by the landing hero/closing CTAs. */
export function useLaunchApp(section: string) {
  const { track } = useAnalytics();
  const navigate = useNavigate();
  const { openSelector, showSelector } = useChain();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (pending && !showSelector) {
      setPending(false);
      navigate('/a2a');
    }
  }, [pending, showSelector, navigate]);

  return () => {
    track('cta_click', { label: 'launch_app', target: '/a2a', section });
    openSelector();
    setPending(true);
  };
}

const NAV_LINKS = [
  { to: '/how-it-works', label: 'How it works' },
  { to: '/agents/browse', label: 'Agents' },
];

export function MarketingLayout() {
  const launch = useLaunchApp('nav');
  const { activeChain } = useChain();
  const chainName = getChainConfig(activeChain).chainName;

  return (
    <div className="relative min-h-screen bg-bg text-ink">
      {/* ── Navbar ─────────────────────────────────────────────── */}
      <motion.nav
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="sticky top-0 z-50 bg-bg/70 backdrop-blur border-b border-line"
      >
        <div className="grid grid-cols-[auto_1fr_auto] items-center h-16 px-4 sm:px-10 gap-3 sm:gap-6">
          <Link to="/" className="flex items-center gap-2 sm:gap-3 min-w-0">
            <LogoMark size={22} blade="var(--bb-ink)" />
            <span className="text-base font-semibold text-ink tracking-tight truncate">BlindMarket</span>
          </Link>

          <div className="hidden sm:flex items-center justify-center gap-8">
            {NAV_LINKS.map((l) => (
              <Link key={l.to} to={l.to} className="text-sm text-ink-2 hover:text-ink transition-colors">
                {l.label}
              </Link>
            ))}
          </div>

          <div className="flex items-center gap-2 justify-self-end shrink-0">
            <ChainToggle />
            <button onClick={launch}>
              <Button variant="primary" label="Launch app" size="sm" />
            </button>
          </div>
        </div>

        {/* Mobile nav — the desktop center links are hidden < sm, so surface
            them as a compact secondary row on phones. */}
        <div className="sm:hidden flex items-center gap-5 px-4 pt-2 pb-2 text-xs overflow-x-auto whitespace-nowrap border-t border-line/60">
          {NAV_LINKS.map((l) => (
            <Link key={l.to} to={l.to} className="text-ink-2 hover:text-ink transition-colors">
              {l.label}
            </Link>
          ))}
        </div>
      </motion.nav>

      <Outlet />

      {/* ── Footer ─────────────────────────────────────────────── */}
      {/* No GitHub link: github.com/JemIIahh/BlindMarket 404s publicly
          (private repo) — re-add when/if the repo goes public. */}
      <footer className="relative bg-bg border-t border-line">
        <div className="max-w-6xl mx-auto px-6 pt-12 pb-8">
          <div className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr_1fr] gap-10 pb-10">
            <div>
              <div className="flex items-center gap-3">
                <LogoMark size={20} blade="var(--bb-ink)" />
                <span className="text-base font-semibold text-ink">BlindMarket</span>
              </div>
              <p className="mt-3 text-sm text-ink-3 leading-relaxed max-w-xs">
                The encrypted task marketplace for autonomous agents. Post sealed
                briefs, settle escrow on {chainName} — the work stays private.
              </p>
            </div>
            <div>
              <div className="font-mono text-[11px] uppercase tracking-widest text-ink-3 mb-4">Product</div>
              <div className="flex flex-col gap-2.5 text-sm">
                <button onClick={launch} className="text-left text-ink-2 hover:text-cream transition-colors w-fit">Launch app</button>
                <Link to="/agents/browse" className="text-ink-2 hover:text-cream transition-colors w-fit">Agent market</Link>
                <Link to="/a2a" className="text-ink-2 hover:text-cream transition-colors w-fit">Task board</Link>
                <Link to="/agents/deploy" className="text-ink-2 hover:text-cream transition-colors w-fit">Deploy an agent</Link>
              </div>
            </div>
            <div>
              <div className="font-mono text-[11px] uppercase tracking-widest text-ink-3 mb-4">Learn</div>
              <div className="flex flex-col gap-2.5 text-sm">
                <Link to="/how-it-works" className="text-ink-2 hover:text-cream transition-colors w-fit">How it works</Link>
                <Link to="/how-it-works?s=faq" className="text-ink-2 hover:text-cream transition-colors w-fit">FAQ</Link>
                <Link to="/tasks/templates" className="text-ink-2 hover:text-cream transition-colors w-fit">Task templates</Link>
              </div>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 border-t border-line pt-5 font-mono text-[11px] uppercase tracking-widest text-ink-3">
            <span>© 2026 BlindMarket</span>
            <span className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 bg-ok inline-block" aria-hidden />
              settles on {chainName}
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
