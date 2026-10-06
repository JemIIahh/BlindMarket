import { Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChainBanner } from '../ChainBanner';
import { isSidebarShortcut } from '../../lib/sidebarShortcut';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

// A boolean in localStorage; access is guarded because blocked storage throws.
const COLLAPSED_KEY = 'bb.sidebar.collapsed';
function loadBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
function saveBool(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {}
}

export function DashboardLayout() {
  const location = useLocation();
  const reduceMotion = useReducedMotion();
  const dist = reduceMotion ? 0 : 8;
  const [navOpen, setNavOpen] = useState(false);
  // Desktop-only (md+) icon-rail collapse; independent of the mobile drawer.
  const [collapsed, setCollapsed] = useState(() => loadBool(COLLAPSED_KEY, false));

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    saveBool(COLLAPSED_KEY, collapsed);
  }, [collapsed]);

  // ⌘B / Ctrl+B: the rail on desktop, the drawer below md (tablet keyboards).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSidebarShortcut(e)) return;
      e.preventDefault();
      if (window.matchMedia('(min-width: 768px)').matches) setCollapsed((v) => !v);
      else setNavOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="min-h-screen bb-ambient">
      <Sidebar
        open={navOpen}
        onClose={() => setNavOpen(false)}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
      />
      <div
        className={`${collapsed ? 'md:ml-16' : 'md:ml-[240px]'} flex flex-col min-h-screen transition-[margin-left] duration-200 ease-out motion-reduce:transition-none`}
      >
        {/* The frosted top bar stays put while the page scrolls under it.
            z-20 keeps it below the mobile drawer's backdrop (z-30). The
            banner's own sticky is contained by this wrapper, so the two
            never overlap. */}
        <div className="sticky top-0 z-20">
          <TopBar onMenuClick={() => setNavOpen(true)} />
          <ChainBanner />
        </div>
        <main
          className="flex-1 px-4 sm:px-6 md:px-8 pt-4 sm:pt-6 md:pt-8"
          style={{
            // Respect iOS safe-area at the bottom so the last action button
            // isn't hidden under the home indicator on notched devices.
            paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
          }}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: dist }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -dist }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            >
              {/* Per-route Suspense so navigating between dashboard pages swaps
                  only the content area (the lazy page chunk) while the sidebar
                  and top bar stay mounted. */}
              <Suspense fallback={<div className="min-h-[40vh]" aria-busy="true" />}>
                <Outlet />
              </Suspense>
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
