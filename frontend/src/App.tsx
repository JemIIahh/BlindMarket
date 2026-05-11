import { Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrivyProvider } from '@privy-io/react-auth';
import { WagmiProvider } from '@privy-io/wagmi';
import { wagmiConfig } from './config/wagmi';
import { ogTestnet } from './config/chains';
import { WalletProvider } from './context/WalletContext';
import { AuthProvider } from './context/AuthContext';
import { DashboardLayout } from './components/bb/DashboardLayout';
import Landing from './pages/Landing';
import TaskFeed from './pages/TaskFeed';
import TaskDetail from './pages/TaskDetail';
import AgentDashboard from './pages/AgentDashboard';
import WorkerView from './pages/WorkerView';
import VerificationStatus from './pages/VerificationStatus';
import A2ADashboard from './pages/A2ADashboard';
import HowItWorks from './pages/HowItWorks';
import Earnings from './pages/Earnings';
import Settings from './pages/Settings';
import NotFound from './pages/NotFound';
import RegisterAgent from './pages/RegisterAgent';
import Validators from './pages/Validators';
import DeployAgent from './pages/DeployAgent';
import AgentDetail from './pages/AgentDetail';
import AgentMarketplace from './pages/AgentMarketplace';
import PostTask from './pages/PostTask';
import MyTasks from './pages/MyTasks';
import DeployAgentForm from './pages/DeployAgentForm';
import DeployAgentSdk from './pages/DeployAgentSdk';
import MyAgents from './pages/MyAgents';
import Leaderboard from './pages/Leaderboard';
import Metrics from './pages/Metrics';

const privyAppId = import.meta.env.VITE_PRIVY_APP_ID;
if (!privyAppId) {
  throw new Error('VITE_PRIVY_APP_ID is required — set it in frontend/.env');
}

const queryClient = new QueryClient();

export default function App() {
  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        defaultChain: ogTestnet,
        supportedChains: [ogTestnet],
        appearance: { theme: 'dark' },
        loginMethods: ['wallet', 'email', 'google', 'twitter'],
        // Disable Coinbase Smart Wallet — CSW only supports a fixed chain list
        // (Base, Mainnet, etc.) and throws "configured chains not supported"
        // on 0G Galileo (16602), which stalls Privy's modal render.
        externalWallets: {
          coinbaseWallet: {
            config: {
              preference: { options: 'eoaOnly' },
            },
          },
        },
        embeddedWallets: {
          ethereum: {
            createOnLogin: 'users-without-wallets',
          },
        },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>
          <WalletProvider>
            <AuthProvider>
              <Routes>
                <Route path="/" element={<Landing />} />
                <Route path="/register/:token" element={<RegisterAgent />} />
                <Route element={<DashboardLayout />}>
                  <Route path="/how-it-works" element={<HowItWorks />} />
                  <Route path="/tasks" element={<TaskFeed />} />
                  <Route path="/tasks/new" element={<PostTask />} />
                  <Route path="/tasks/mine" element={<MyTasks />} />
                  <Route path="/tasks/:id" element={<TaskDetail />} />
                  <Route path="/agent" element={<AgentDashboard />} />
                  <Route path="/worker" element={<WorkerView />} />
                  <Route path="/validators" element={<Validators />} />
                  <Route path="/verification" element={<VerificationStatus />} />
                  <Route path="/a2a" element={<A2ADashboard />} />
                  <Route path="/earnings" element={<Earnings />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/agents" element={<AgentMarketplace />} />
                  <Route path="/agents/deploy" element={<DeployAgent />} />
                  <Route path="/agents/deploy/ui" element={<DeployAgentForm />} />
                  <Route path="/agents/deploy/sdk" element={<DeployAgentSdk />} />
                  <Route path="/agents/mine" element={<MyAgents />} />
                  <Route path="/leaderboard" element={<Leaderboard />} />
                  <Route path="/agents/:id" element={<AgentDetail />} />
                  <Route path="/metrics" element={<Metrics />} />
                </Route>
                <Route path="*" element={<DashboardLayout />}>
                  <Route path="*" element={<NotFound />} />
                </Route>
              </Routes>
            </AuthProvider>
          </WalletProvider>
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
