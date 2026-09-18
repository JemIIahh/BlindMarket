import { useState, useEffect } from 'react';
import { useWalletClient } from 'wagmi';
import { Contract, formatUnits } from 'ethers';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Breadcrumb,
  PageHeader,
  SectionRule,
  StatCard,
  StatusTag,
  Button,
  LoadingState,
  EmptyState,
  ErrorState,
  SignInGate,
  Pagination,
} from '../components/bb';
import { truncateAddress } from '../lib/utils';
import { API_BASE_URL } from '../config/constants';
import { getMarketplaceTokenAddress, getPaymentSymbol, getPaymentDecimals } from '../config/settlement';
import { formatEarnings, sumEarnings } from '../lib/paymentUnits';
import { authedPost } from '../lib/api';
import { useChainAddress } from '../hooks/useChainWallet';
import { useAuth } from '../context/AuthContext';

const LOW_BALANCE_THRESHOLD = 1; // 1 USDC
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

// Per-row USDC balance probe. Returns null when balance is healthy or still
// loading, a warning chip when below the threshold.
function GasChip({ fundingAddress }: { fundingAddress: string }) {
  const { data: walletClient } = useWalletClient();
  const [balance, setBalance] = useState<number | null>(null);

  useEffect(() => {
    if (!fundingAddress || !walletClient) return;
    let cancelled = false;
    (async () => {
      try {
        const provider = new (await import('ethers')).BrowserProvider(walletClient.transport);
        const usdc = new Contract(getMarketplaceTokenAddress(), USDC_ABI, provider);
        const bal: bigint = await usdc.balanceOf(fundingAddress);
        if (!cancelled) setBalance(Number(formatUnits(bal, getPaymentDecimals())));
      } catch { /* non-blocking */ }
    })();
    return () => { cancelled = true; };
  }, [fundingAddress, walletClient]);

  if (balance === null) return null;
  if (balance >= LOW_BALANCE_THRESHOLD) return null;
  return (
    <span
      title={`Low balance: ${balance.toFixed(2)} ${getPaymentSymbol()} — fund wallet to keep this agent running`}
      className="inline-flex items-center gap-1 text-[10px] font-mono text-warn"
    >
      ⚠ Low balance
    </span>
  );
}

interface Agent {
  id: string;
  name: string;
  walletAddress: string;
  smartAccountAddress?: string;
  status: string;
  provider: string;
  model: string;
  tasksCompleted?: number;
  totalEarned?: string;
  totalEarnedUsdc?: string;
  totalEarnedNative?: string;
  createdAt?: string;
  reputation?: {
    decayedScore: number;
    tasksCompleted: number;
    decayFactor: number;
  };
}

const AGENTS_PAGE_SIZE = 20;

type Act = 'start' | 'pause' | 'stop' | 'restart';

export default function MyAgents() {
  const address = useChainAddress();
  const { isAuthenticated } = useAuth();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);

  const { data: agentsRes, isLoading, isError, refetch } = useQuery<{ agents: Agent[]; total: number }>({
    queryKey: ['my-agents', address, page],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/api/v1/agents?owner=${address}&page=${page}&pageSize=${AGENTS_PAGE_SIZE}`);
      const json = await res.json();
      return { agents: json.success ? json.data : [], total: json.total ?? 0 };
    },
    enabled: !!address,
  });

  const agents = agentsRes?.agents ?? [];
  const totalAgents = agentsRes?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalAgents / AGENTS_PAGE_SIZE));

  // Use `authedPost` from lib/api so non-2xx responses throw with the server's
  // error message instead of being silently swallowed by `res.json()`.
  const action = useMutation({
    mutationFn: ({ id, act }: { id: string; act: Act }) =>
      authedPost<Agent>(`/api/v1/agents/${id}/${act}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-agents', address] }),
  });

  const totalEarned = formatEarnings(sumEarnings(agents));
  const running = agents.filter((a) => a.status === 'running').length;
  const tasksTotal = agents.reduce((s, a) => s + (a.tasksCompleted ?? 0), 0);

  // Reputation decay → directional arrow + tone.
  const decayArrow = (factor: number) =>
    factor > 0.9 ? { glyph: '↑', cls: 'text-ok' } : factor > 0.5 ? { glyph: '→', cls: 'text-warn' } : { glyph: '↓', cls: 'text-err' };

  function RowActions({ agent }: { agent: Agent }) {
    const isActing = action.isPending && action.variables?.id === agent.id;
    const disabled = isActing || !isAuthenticated;
    return (
      <div className="flex flex-wrap items-center -mx-2 -my-1.5 text-xs">
        {agent.status !== 'running' && (
          <button
            disabled={disabled}
            onClick={() => action.mutate({ id: agent.id, act: 'start' })}
            className="px-2 py-1.5 min-h-[32px] text-ok hover:underline disabled:opacity-40"
          >
            Start
          </button>
        )}
        {agent.status === 'running' && (
          <button
            disabled={disabled}
            onClick={() => action.mutate({ id: agent.id, act: 'pause' })}
            className="px-2 py-1.5 min-h-[32px] text-warn hover:underline disabled:opacity-40"
          >
            Pause
          </button>
        )}
        <button
          disabled={disabled}
          onClick={() => action.mutate({ id: agent.id, act: 'stop' })}
          className="px-2 py-1.5 min-h-[32px] text-ink-3 hover:text-err hover:underline disabled:opacity-40"
        >
          Stop
        </button>
        {agent.status !== 'stopped' && (
          <button
            disabled={disabled}
            onClick={() => action.mutate({ id: agent.id, act: 'restart' })}
            className="px-2 py-1.5 min-h-[32px] text-ink-3 hover:text-ink hover:underline disabled:opacity-40"
          >
            Restart
          </button>
        )}
        <Link to={`/agents/${agent.id}`} className="inline-flex items-center px-2 py-1.5 min-h-[32px] text-cream hover:underline">
          Logs
        </Link>
      </div>
    );
  }

  // Desktop grid template — keep in sync between header and rows.
  const COLS = 'grid-cols-[1fr_150px_110px_110px_70px_100px_minmax(180px,_auto)]';

  return (
    <div>
      <Breadcrumb items={['marketplace', 'agents', 'mine']} />
      <PageHeader
        title="My agents"
        description="Manage your deployed agents and track their earnings."
        right={
          <Link to="/agents/deploy">
            <Button variant="primary" label="Deploy agent" />
          </Link>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-0 border border-line mb-8">
        <StatCard label="Agents" value={String(agents.length)} sub={`${running} running`} subColor={running > 0 ? 'ok' : undefined} />
        <div className="border-t lg:border-t-0 lg:border-l border-line">
          <StatCard
            className="h-full"
            label="Total earned"
            value={totalEarned}
            sub="All agents"
            subColor="ok"
          />
        </div>
        <div className="border-t lg:border-t-0 lg:border-l border-line">
          <StatCard className="h-full" label="Tasks completed" value={String(tasksTotal)} sub="All time" />
        </div>
      </div>

      {address && <SignInGate prompt="to manage your agents" />}

      {/* Agent list — custom responsive list matching the bb DataTable look
          (header row, hairline dividers, hover). A generic DataTable can't host
          the per-row action buttons cleanly, because it wraps each row in a
          single <Link>; nested buttons inside an anchor are invalid and would
          trigger navigation. So we mirror its visual style here instead. */}
      <div className="border border-line">
        <SectionRule num="01" title="Deployed agents" side={`${totalAgents} total`} className="px-5 pt-5" />

        {!address ? (
          <EmptyState
            icon="wallet"
            title="Connect your wallet"
            description="Connect a wallet to see the agents you've deployed."
          />
        ) : isLoading ? (
          <LoadingState label="Loading agents…" />
        ) : isError ? (
          <ErrorState title="Couldn't load your agents" onRetry={() => refetch()} />
        ) : agents.length === 0 ? (
          <EmptyState
            icon="user"
            title="No agents deployed yet"
            description="Deploy your first agent to start earning on tasks across the marketplace."
            action={
              <Link to="/agents/deploy">
                <Button variant="outline" label="Create agent" size="sm" />
              </Link>
            }
          />
        ) : (
          <>
            {/* Desktop: table */}
            <div className="hidden xl:block">
              <div className={`grid ${COLS} gap-6 px-5 py-3 border-t border-line text-[11px] font-medium uppercase tracking-wider text-ink-3`}>
                <span>Agent</span>
                <span>Model</span>
                <span>Reputation</span>
                <span className="text-right">Earned</span>
                <span className="text-right">Tasks</span>
                <span>Status</span>
                <span className="text-right">Actions</span>
              </div>
              {agents.map((agent) => {
                const isActing = action.isPending && action.variables?.id === agent.id;
                const failed = action.isError && action.variables?.id === agent.id;
                const arrow = agent.reputation ? decayArrow(agent.reputation.decayFactor) : null;
                return (
                  <div key={agent.id} className="border-t border-line hover:bg-surface-2 transition-colors">
                    <div className={`grid ${COLS} gap-6 px-5 py-3.5 text-sm items-center`}>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Link to={`/agents/${agent.id}`} className="text-ink hover:text-cream transition-colors truncate">
                            {agent.name}
                          </Link>
                          {agent.walletAddress && <GasChip fundingAddress={agent.smartAccountAddress || agent.walletAddress} />}
                        </div>
                        <div className="text-[11px] font-mono text-ink-3 mt-0.5 truncate">{truncateAddress(agent.walletAddress)}</div>
                      </div>
                      <span className="text-ink-3 text-xs truncate">{agent.provider} / {agent.model}</span>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono font-bold text-ink">{agent.reputation?.decayedScore ?? 0}</span>
                        {arrow && <span className={arrow.cls}>{arrow.glyph}</span>}
                      </div>
                      <span className="font-mono font-semibold text-ink text-right">
                        {formatEarnings(agent)}
                      </span>
                      <span className="font-mono text-ink-3 text-right">{agent.tasksCompleted ?? 0}</span>
                      <span>{isActing ? <StatusTag status={action.variables?.act} /> : <StatusTag status={agent.status} />}</span>
                      <div className="flex justify-end">
                        <RowActions agent={agent} />
                      </div>
                    </div>
                    {failed && (
                      <div className="px-5 pb-3 text-[11px] font-mono text-err">
                        {action.variables?.act} failed: {(action.error as Error).message}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Below xl: card per agent — the table needs ~900px beside the sidebar */}
            <div className="xl:hidden divide-y divide-line border-t border-line">
              {agents.map((agent) => {
                const isActing = action.isPending && action.variables?.id === agent.id;
                const failed = action.isError && action.variables?.id === agent.id;
                const arrow = agent.reputation ? decayArrow(agent.reputation.decayFactor) : null;
                return (
                  <div key={agent.id} className="px-5 py-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Link to={`/agents/${agent.id}`} className="text-sm text-ink hover:text-cream transition-colors truncate">
                            {agent.name}
                          </Link>
                          {agent.walletAddress && <GasChip fundingAddress={agent.smartAccountAddress || agent.walletAddress} />}
                        </div>
                        <div className="text-[11px] text-ink-3 mt-0.5">{agent.provider} / {agent.model}</div>
                        <div className="text-[10px] font-mono text-ink-3 mt-0.5 truncate">{truncateAddress(agent.walletAddress)}</div>
                      </div>
                      <div className="shrink-0">
                        {isActing ? <StatusTag status={action.variables?.act} /> : <StatusTag status={agent.status} />}
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 pt-2 border-t border-line">
                      <div>
                        <div className="text-[11px] uppercase tracking-wider text-ink-3">Reputation</div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className="text-sm font-mono font-bold text-ink">{agent.reputation?.decayedScore ?? 0}</span>
                          {arrow && <span className={`text-xs ${arrow.cls}`}>{arrow.glyph}</span>}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-wider text-ink-3">Earned</div>
                        <div className="text-sm font-mono font-semibold text-ink mt-0.5">
                          {formatEarnings(agent)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-wider text-ink-3">Tasks</div>
                        <div className="text-sm font-mono text-ink mt-0.5">{agent.tasksCompleted ?? 0}</div>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-line">
                      <RowActions agent={agent} />
                    </div>

                    {failed && (
                      <div className="text-[11px] font-mono text-err">
                        {action.variables?.act} failed: {(action.error as Error).message}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
        {agents.length > 0 && (
          <Pagination
            page={page}
            totalPages={totalPages}
            totalItems={totalAgents}
            pageSize={AGENTS_PAGE_SIZE}
            onPageChange={setPage}
          />
        )}
      </div>
    </div>
  );
}
