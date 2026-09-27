import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { PrivyProvider } from '@privy-io/react-auth';
import { WagmiProvider } from '@privy-io/wagmi';
import { Analytics } from '@vercel/analytics/react';
import { wagmiConfig } from './config/wagmi';
import { arcChain, privySupportedChains } from './config/chains';
import { WalletProvider } from './context/WalletContext';
import { AuthProvider } from './context/AuthContext';
import { ChainProvider } from './context/ChainContext';
import { SettlementProvider } from './context/SettlementContext';
import { DashboardLayout } from './components/bb/DashboardLayout';
import { MarketingLayout } from './components/landing/MarketingLayout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemeSync, getStoredTheme } from './components/ThemeSync';

// Route-level code splitting. Previously every page was a static import, so the
// entire app (all ~19 routes + the three.js globe + the web3 stacks) shipped in
// one ~3.4 MB chunk that every first visit had to download and parse before
// first paint — even when landing on a single page. lazy() splits each page
// into its own chunk fetched on demand; the <Suspense> boundaries (here and
// around the dashboard <Outlet/>) render a lightweight fallback while a chunk
// loads. The QueryClient now lives solely in main.tsx (a second, defaults-less
// client used to be created here and silently shadowed it — staleTime:0 →
// refetch storms on every navigation/window-focus).
const LandingV3 = lazy(() => import('./pages/LandingV3'));
const TaskDetail = lazy(() => import('./pages/TaskDetail'));
const A2ADashboard = lazy(() => import('./pages/A2ADashboard'));
const HowItWorks = lazy(() => import('./pages/HowItWorks'));
const Earnings = lazy(() => import('./pages/Earnings'));
const Settings = lazy(() => import('./pages/Settings'));
const NotFound = lazy(() => import('./pages/NotFound'));
const RegisterAgent = lazy(() => import('./pages/RegisterAgent'));
const DeployAgent = lazy(() => import('./pages/DeployAgent'));
const AgentDetail = lazy(() => import('./pages/AgentDetail'));
const PostTask = lazy(() => import('./pages/PostTask'));
const MyTasks = lazy(() => import('./pages/MyTasks'));
const DeployAgentForm = lazy(() => import('./pages/DeployAgentForm'));
const DeployAgentSdk = lazy(() => import('./pages/DeployAgentSdk'));
const MyAgents = lazy(() => import('./pages/MyAgents'));
const Messages = lazy(() => import('./pages/Messages'));
const Metrics = lazy(() => import('./pages/Metrics'));
const AgentMarketplace = lazy(() => import('./pages/AgentMarketplace'));
const TaskTemplates = lazy(() => import('./pages/TaskTemplates'));
const StorageView = lazy(() => import('./pages/StorageView'));
const Activity = lazy(() => import('./pages/Activity'));

const privyAppId = import.meta.env.VITE_PRIVY_APP_ID;
// Deliberate hard fail on a misconfigured build — but render a readable
// error instead of throwing at module scope, which white-screens the whole
// site with zero fallback (the ErrorBoundary doesn't exist yet up here).
function MissingEnv() {
  return (
    <div className="min-h-screen bg-bg text-ink flex items-center justify-center p-6">
      <div className="max-w-md rounded-3xl border border-line bg-surface p-7">
        <h1 className="text-base font-semibold mb-2">BlindMarket can't start</h1>
        <p className="text-sm text-ink-2 leading-relaxed">
          This build is missing <code className="font-mono text-ink">VITE_PRIVY_APP_ID</code>.
          Set it in the deployment environment and rebuild.
        </p>
      </div>
    </div>
  );
}

// Plain, full-height route fallback — matches the app background so a chunk
// load reads as an instant flash rather than a jarring loading screen.
function RouteFallback() {
  return <div className="min-h-screen bg-bg" aria-busy="true" />;
}

export default function App() {
  if (!privyAppId) return <MissingEnv />;
  return (
    <ChainProvider>
      <SettlementProvider>
        <PrivyProvider
          appId={privyAppId}
          config={{
            defaultChain: arcChain,
            // Arc, the CCTP sources and the settlement Base chain (see
            // config/chains.ts) — Privy refuses to switch an external wallet to
            // any chain not in this list, surfacing as "Unsupported chainId:
            // <id>" rather than a wallet-level error.
            supportedChains: privySupportedChains,
            // Follows the saved bb.theme preference at load. Privy's modal theme
            // is fixed per provider mount, so a mid-session toggle applies to the
            // modal on the next reload.
            appearance: { theme: getStoredTheme() },
            loginMethods: ['email', 'wallet'],
            // Disable Coinbase Smart Wallet — prefer Privy embedded wallet
            // for gas sponsorship flow on Base.
            externalWallets: {
              coinbaseWallet: {
                config: {
                  preference: { options: 'eoaOnly' },
                },
              },
            },
            embeddedWallets: {
              ethereum: {
                createOnLogin: 'all-users',
              },
            },
          }}
        >
          <WagmiProvider config={wagmiConfig}>
            <WalletProvider>
              <AuthProvider>
                <ThemeSync />
                <ErrorBoundary>
                  <Suspense fallback={<RouteFallback />}>
                    <Routes>
                      {/* Public marketing chrome — landing and docs share one nav +
                    footer so the first click doesn't context-switch into the
                    dashboard shell. The app starts at "Launch app". */}
                      <Route element={<MarketingLayout />}>
                        <Route path="/" element={<LandingV3 />} />
                        <Route path="/how-it-works" element={<HowItWorks />} />
                      </Route>
                      {/* The redesign (formerly previewed at /v2) is now the live
                    landing at `/`. Redirect the old preview URL so existing
                    bookmarks/links don't 404. */}
                      <Route path="/v2" element={<Navigate to="/" replace />} />
                      <Route path="/register/:token" element={<RegisterAgent />} />
                      <Route element={<DashboardLayout />}>
                        <Route path="/tasks/new" element={<PostTask />} />
                        <Route path="/tasks/mine" element={<MyTasks />} />
                        <Route path="/tasks/templates" element={<TaskTemplates />} />
                        <Route path="/tasks/:id" element={<TaskDetail />} />
                        <Route path="/storage/:rootHash" element={<StorageView />} />
                        <Route path="/a2a" element={<A2ADashboard />} />
                        <Route path="/earnings" element={<Earnings />} />
                        <Route path="/settings" element={<Settings />} />
                        <Route path="/agents/browse" element={<AgentMarketplace />} />
                        <Route path="/agents/deploy" element={<DeployAgent />} />
                        <Route path="/agents/deploy/ui" element={<DeployAgentForm />} />
                        <Route path="/agents/deploy/sdk" element={<DeployAgentSdk />} />
                        <Route path="/agents/mine" element={<MyAgents />} />
                        <Route path="/agents/:id" element={<AgentDetail />} />
                        <Route path="/messages" element={<Messages />} />
                        <Route path="/activity" element={<Activity />} />
                        <Route path="/metrics" element={<Metrics />} />

                        {/* Pure-A2A pivot: H2H/H2A/A2H surfaces removed from the IA.
                      Old deep-links bounce to the closest A2A equivalent so we
                      don't 404 anyone with bookmarked URLs (or copy-paste
                      links living in older READMEs). */}
                        <Route path="/tasks" element={<Navigate to="/a2a" replace />} />
                        <Route path="/agents" element={<Navigate to="/a2a" replace />} />
                        <Route path="/agent" element={<Navigate to="/tasks/new" replace />} />
                        <Route path="/worker" element={<Navigate to="/a2a" replace />} />
                        <Route path="/validators" element={<Navigate to="/how-it-works" replace />} />
                        <Route path="/verification" element={<Navigate to="/a2a" replace />} />
                        <Route path="/leaderboard" element={<Navigate to="/a2a" replace />} />
                      </Route>
                      <Route path="*" element={<DashboardLayout />}>
                        <Route path="*" element={<NotFound />} />
                      </Route>
                    </Routes>
                  </Suspense>
                </ErrorBoundary>
                <Analytics />
              </AuthProvider>
            </WalletProvider>
          </WagmiProvider>
        </PrivyProvider>
      </SettlementProvider>
    </ChainProvider>
  );
}

