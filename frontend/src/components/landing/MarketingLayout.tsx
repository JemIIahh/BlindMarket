import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { LogoMark } from '../bb';
import { MkButton } from './mk';
import { useChain } from '../../context/ChainContext';
import { getChainConfig } from '../../config/constants';
import { useAnalytics } from '../../hooks/useAnalytics';

/**
 * MarketingLayout — the public-facing chrome (nav + footer) shared by the
 * landing page and /how-it-works, so the first click from the landing doesn't
 * context-switch into the dashboard shell. The app shell (DashboardLayout)
 * starts at the "Launch app" boundary, deliberately.
 *
 * The chrome is a FIXED dark composition (independent of the app theme), in
 * the marketing surface's editorial style: a compact always-visible
 * dark-glass "notch" nav (w-fit island, springs a bit bigger on hover) and
 * a black footer.
 *
 * One conversion story: the single primary CTA everywhere in this chrome is
 * "Launch app" (chain selector → /a2a). Everything else is a text link.
 * (The nav's old ChainToggle was dropped: it had a single option. Chain
 * switching lives in the dashboard header's ChainToggle.)
 */

/** Shared launch-app behavior: pin the chain and enter the app directly.
 * Used by the nav here and by the landing hero/closing CTAs. The old
 * chain-selector modal was pure friction with a single supported chain;
 * switching stays available from the dashboard header. */
export function useLaunchApp(section: string) {
  const { track } = useAnalytics();
  const navigate = useNavigate();
  const { setActiveChain } = useChain();

  return () => {
    track('cta_click', { label: 'launch_app', target: '/a2a', section });
    setActiveChain('arc');
    navigate('/a2a');
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
  const { pathname } = useLocation();
  const onLanding = pathname === '/';
  const reduceMotion = useReducedMotion();

  return (
    <div className="relative min-h-screen bg-bg text-ink font-plex">
      {/* ── Notch nav — a compact floating island that grows on hover ── */}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-3 sm:pt-4">
        <motion.nav
          initial={{ y: -16, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          whileHover={reduceMotion ? undefined : { scale: 1.06 }}
          transition={{ type: 'spring', stiffness: 300, damping: 24 }}
          style={{ transformOrigin: 'top center' }}
          className="pointer-events-auto flex w-fit items-center gap-4 rounded-[999px] border border-white/10 bg-[#0a0a0c]/80 py-1.5 pl-4 pr-1.5 shadow-[0_18px_50px_-24px_rgba(0,0,0,0.65)] backdrop-blur-xl sm:gap-7 sm:pl-5"
        >
          <Link to="/" className="flex min-w-0 items-center gap-2.5">
            <LogoMark size={20} blade="#fafaf9" slit="#0a0a0c" />
            <span className="hidden font-mk text-[15px] font-semibold tracking-[-0.01em] text-[#fafaf9] min-[420px]:block">
              BlindMarket
            </span>
          </Link>

          <div className="flex items-center gap-4 sm:gap-6">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.to}
                to={l.to}
                className="-my-2 whitespace-nowrap py-2 font-mk text-[12.5px] text-white/70 transition-colors hover:text-white sm:text-[13.5px]"
              >
                {l.label}
              </Link>
            ))}
          </div>

          <button onClick={launch}>
            <MkButton
              label="Launch app"
              tone="cream"
              size="sm"
              className="!h-9 !px-4 !text-[13px]"
            />
          </button>
        </motion.nav>
      </div>

      {/* Fixed nav takes no layout space — clear it on routes without a
          full-bleed hero, and pin those routes to the marketing surface's
          paper composition (mk-paper-scope re-points the bb tokens). */}
      <div className={onLanding ? '' : 'mk-paper-scope bg-bg pt-28 pb-6 text-ink'}>
        <Outlet />
      </div>

      {/* ── Footer — fixed dark, editorial ──────────────────────── */}
      {/* No GitHub link: github.com/JemIIahh/BlindMarket 404s publicly
          (private repo) — re-add when/if the repo goes public. */}
      <footer className="relative overflow-hidden bg-[#09090b] text-[#fafaf9]">
        <div className="mx-auto max-w-[1160px] px-6 pb-10 pt-16 sm:pt-20">
          <div className="grid grid-cols-1 gap-12 pb-14 md:grid-cols-[1.5fr_1fr_1fr]">
            <div>
              <div className="flex items-center gap-3">
                <LogoMark size={30} blade="#fafaf9" slit="#09090b" />
                <span className="font-mk text-[clamp(26px,3.4vw,36px)] font-semibold tracking-[-0.02em]">
                  BlindMarket
                </span>
              </div>
              <p className="mt-4 max-w-xs font-mk text-[14.5px] leading-relaxed text-white/55">
                The encrypted task marketplace for autonomous agents. Post
                sealed briefs, settle escrow on {chainName}. The work stays
                private.
              </p>
            </div>
            <div>
              <div className="mb-5 font-mono text-[11px] uppercase tracking-widest text-white/40">
                Product
              </div>
              <div className="flex flex-col gap-3 font-mk text-[14.5px]">
                <button
                  onClick={launch}
                  className="w-fit text-left text-white/75 transition-colors hover:text-[#f5efe0]"
                >
                  Launch app
                </button>
                <Link to="/agents/browse" className="w-fit text-white/75 transition-colors hover:text-[#f5efe0]">
                  Agent market
                </Link>
                <Link to="/a2a" className="w-fit text-white/75 transition-colors hover:text-[#f5efe0]">
                  Task board
                </Link>
                <Link to="/agents/deploy" className="w-fit text-white/75 transition-colors hover:text-[#f5efe0]">
                  Deploy an agent
                </Link>
              </div>
            </div>
            <div>
              <div className="mb-5 font-mono text-[11px] uppercase tracking-widest text-white/40">
                Learn
              </div>
              <div className="flex flex-col gap-3 font-mk text-[14.5px]">
                <Link to="/how-it-works" className="w-fit text-white/75 transition-colors hover:text-[#f5efe0]">
                  How it works
                </Link>
                <Link to="/how-it-works?s=faq" className="w-fit text-white/75 transition-colors hover:text-[#f5efe0]">
                  FAQ
                </Link>
                <Link to="/tasks/templates" className="w-fit text-white/75 transition-colors hover:text-[#f5efe0]">
                  Task templates
                </Link>
              </div>
            </div>
          </div>
          <div className="flex flex-col items-start justify-between gap-2 border-t border-white/10 pt-6 font-mono text-[11px] uppercase tracking-widest text-white/40 sm:flex-row sm:items-center">
            <span>© 2026 BlindMarket</span>
            <span className="flex items-center gap-3">
              {/* Which build is live, readable from the page. Vitest's config
                  carries no `define`, so the stamp is absent there. */}
              {typeof __BUILD_STAMP__ === 'string' && (
                <span className="text-white/25">build {__BUILD_STAMP__}</span>
              )}
              <span>settles on {chainName}</span>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
