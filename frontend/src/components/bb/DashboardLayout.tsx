import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ChainBanner } from '../ChainBanner';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export function DashboardLayout() {
  const location = useLocation();
  const reduceMotion = useReducedMotion();
  const dist = reduceMotion ? 0 : 8;
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-bg">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="md:ml-[240px] flex flex-col min-h-screen">
        <TopBar onMenuClick={() => setNavOpen(true)} />
        <ChainBanner />
        <main className="flex-1 p-4 sm:p-6 md:p-8">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: dist }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -dist }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
