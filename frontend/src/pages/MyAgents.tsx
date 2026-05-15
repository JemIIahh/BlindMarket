import { useAccount, useBalance } from 'wagmi';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Breadcrumb, PageHeader, SectionRule, Tag, StatCard } from '../components/bb';
import { truncateAddress } from '../lib/utils';
import { API_BASE_URL } from '../config/constants';
import { post } from '../lib/api';

// Mirrors AgentDetail's threshold so a low-gas chip here is consistent with
// the warning the user sees once they click into the agent. If you change one,
// change the other.
const LOW_GAS_THRESHOLD = 0.005;

// Per-row balance probe. wagmi's useBalance is a hook, so it must run at the
// component-render level, not inside a loop callback — hence this little leaf
// component. Returns null (renders nothing) when balance is healthy or still
// loading, a warning chip when below the gas threshold.
function GasChip({ walletAddress }: { walletAddress: string }) {
  const { data: balance } = useBalance({
    address: walletAddress as `0x${string}`,
    query: { enabled: !!walletAddress },
  });
  if (!balance) return null;
  const ether = parseFloat(balance.formatted);
  if (ether >= LOW_GAS_THRESHOLD) return null;
  return (
    <span
      title={`Low gas: ${ether.toFixed(4)} 0G — click to top up`}
      className="inline-flex items-center gap-1 text-[10px] font-mono text-yellow-400"
    >
      ⚠ low gas
    </span>
  );
}

interface Agent {
  id: string;
  name: string;
  walletAddress: string;
  status: string;
  provider: string;
  model: string;
  tasksCompleted?: number;
  totalEarned?: string;
  createdAt?: string;
  reputation?: {
    decayedScore: number;
    tasksCompleted: number;
    decayFactor: number;
  };
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'err' | 'neutral'> = {
  running: 'ok', idle: 'neutral', paused: 'warn', stopped: 'err', error: 'err',
};

export default function MyAgents() {
  const { address } = useAccount();
  const qc = useQueryClient();

  const { data: agents = [], isLoading } = useQuery<Agent[]>({
    queryKey: ['my-agents', address],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/api/v1/agents?owner=${address}`);
      const json = await res.json();
      return json.success ? json.data : [];
    },
    enabled: !!address,
  });

  // Use `post` from lib/api so non-2xx responses throw with the server's
  // error message instead of being silently swallowed by `res.json()`.
  const action = useMutation({
    mutationFn: ({ id, act }: { id: string; act: 'start' | 'pause' | 'stop' }) =>
      post<Agent>(`/api/v1/agents/${id}/${act}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-agents', address] }),
  });

  const totalEarned = agents.reduce((sum, a) => sum + parseFloat(a.totalEarned ?? '0'), 0);
  const running = agents.filter(a => a.status === 'running').length;

  return (
    <div>
      <Breadcrumb items={['marketplace', 'agents', 'mine']} />
      <PageHeader
        title="My agents"
        description="Manage your deployed agents and track their earnings."
        right={
          <Link to="/agents/deploy" className="px-4 py-2 border border-cream text-[11px] font-mono text-cream hover:bg-cream hover:text-bg transition-colors uppercase tracking-widest">
            + deploy agent
          </Link>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-0 border border-line mb-8">
        <StatCard label="agents" value={String(agents.length)} sub={`${running} running`} subColor={running > 0 ? 'ok' : undefined} />
        <div className="border-t sm:border-t-0 sm:border-l border-line">
          <StatCard label="total earned" value={`${totalEarned.toLocaleString(undefined, { maximumFractionDigits: 2 })} 0G`} sub="Native 0G · all agents" subColor="ok" />
        </div>
        <div className="border-t sm:border-t-0 sm:border-l border-line">
          <StatCard label="tasks completed" value={String(agents.reduce((s, a) => s + (a.tasksCompleted ?? 0), 0))} sub="all time" />
        </div>
      </div>

      {/* Agent list */}
      <div className="border border-line">
        <SectionRule num="01" title="deployed agents" side={`${agents.length} total`} />

        {!address ? (
          <div className="px-5 py-10 text-center text-xs font-mono text-ink-3">connect wallet to see your agents</div>
        ) : isLoading ? (
          <div className="px-5 py-10 text-center text-xs font-mono text-ink-3">loading…</div>
        ) : agents.length === 0 ? (
          <div className="px-5 py-10 flex flex-col items-center gap-3">
            <p className="text-xs font-mono text-ink-3">no agents deployed yet.</p>
            <Link to="/agents/deploy" className="text-xs font-mono text-cream hover:underline">deploy your first agent →</Link>
          </div>
        ) : (
          <>
            {/* ── Mobile: card-per-agent (stacked, no scroll required) ─── */}
            <div className="md:hidden">
              {agents.map(agent => {
                const isActing = action.isPending && action.variables?.id === agent.id;
                const failed = action.isError && action.variables?.id === agent.id;
                return (
                  <div key={agent.id} className="border-t border-line px-5 py-4 space-y-3">
                    {/* Header row: name + status */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-mono text-ink flex items-center gap-2">
                          <Link to={`/agents/${agent.id}`} className="hover:text-cream hover:underline">{agent.name}</Link>
                          {agent.walletAddress && <GasChip walletAddress={agent.walletAddress} />}
                        </div>
                        <div className="text-[11px] font-mono text-ink-3 mt-0.5">{agent.provider} / {agent.model}</div>
                        <div className="text-[10px] font-mono text-ink-3 mt-0.5">{truncateAddress(agent.walletAddress)}</div>
                      </div>
                      <Tag tone={STATUS_TONE[agent.status] ?? 'neutral'}>{isActing ? `${action.variables?.act}…` : agent.status}</Tag>
                    </div>
                    {/* Metric row: reputation / earned / tasks */}
                    <div className="grid grid-cols-3 gap-2 pt-2 border-t border-line/50">
                      <div>
                        <div className="text-[10px] font-mono uppercase tracking-widest text-ink-3">rep</div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <span className="text-sm font-mono font-bold text-ink">{agent.reputation?.decayedScore ?? 0}</span>
                          {agent.reputation && (
                            <span className={`text-xs ${agent.reputation.decayFactor > 0.9 ? 'text-ok' : agent.reputation.decayFactor > 0.5 ? 'text-warn' : 'text-err'}`}>
                              {agent.reputation.decayFactor > 0.9 ? '↑' : agent.reputation.decayFactor > 0.5 ? '→' : '↓'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] font-mono uppercase tracking-widest text-ink-3">earned</div>
                        <div className="text-sm font-mono font-semibold text-ink mt-0.5">{parseFloat(agent.totalEarned ?? '0').toLocaleString(undefined, { maximumFractionDigits: 2 })} 0G</div>
                      </div>
                      <div>
                        <div className="text-[10px] font-mono uppercase tracking-widest text-ink-3">tasks</div>
                        <div className="text-sm font-mono text-ink mt-0.5">{agent.tasksCompleted ?? 0}</div>
                      </div>
                    </div>
                    {/* Actions */}
                    <div className="flex gap-4 pt-2 border-t border-line/50 text-[12px] font-mono">
                      {agent.status !== 'running' && (
                        <button disabled={isActing} onClick={() => action.mutate({ id: agent.id, act: 'start' })} className="text-green-500 hover:underline disabled:opacity-40">start</button>
                      )}
                      {agent.status === 'running' && (
                        <button disabled={isActing} onClick={() => action.mutate({ id: agent.id, act: 'pause' })} className="text-yellow-500 hover:underline disabled:opacity-40">pause</button>
                      )}
                      <button disabled={isActing} onClick={() => action.mutate({ id: agent.id, act: 'stop' })} className="text-ink-3 hover:text-red-500 hover:underline disabled:opacity-40">stop</button>
                      <Link to={`/agents/${agent.id}`} className="text-cream hover:underline ml-auto">logs →</Link>
                    </div>
                    {failed && (
                      <div className="text-[11px] font-mono text-red-400">
                        {action.variables?.act} failed: {(action.error as Error).message}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* ── md+: original table layout, unchanged ──────────────── */}
            <div className="hidden md:block">
              <div className="grid grid-cols-[1fr_140px_100px_100px_100px_80px_120px] gap-4 px-5 py-3 border-t border-line text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3">
                <span>name · wallet</span><span>model</span><span>reputation</span><span>earned</span><span>tasks</span><span>status</span><span></span>
              </div>
              {agents.map(agent => {
                const isActing = action.isPending && action.variables?.id === agent.id;
                const failed = action.isError && action.variables?.id === agent.id;
                return (
                  <div key={agent.id} className="border-t border-line">
                    <div className="grid grid-cols-[1fr_140px_100px_100px_100px_80px_120px] gap-4 px-5 py-4 text-[13px] font-mono items-center">
                      <div>
                        <div className="text-ink flex items-center gap-2">
                          <Link to={`/agents/${agent.id}`} className="hover:text-cream hover:underline">{agent.name}</Link>
                          {agent.walletAddress && <GasChip walletAddress={agent.walletAddress} />}
                        </div>
                        <div className="text-[11px] text-ink-3">{truncateAddress(agent.walletAddress)}</div>
                      </div>
                      <span className="text-ink-3 text-xs">{agent.provider} / {agent.model}</span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-ink font-bold">{agent.reputation?.decayedScore ?? 0}</span>
                        {agent.reputation && (
                          <span className={agent.reputation.decayFactor > 0.9 ? 'text-ok' : agent.reputation.decayFactor > 0.5 ? 'text-warn' : 'text-err'}>
                            {agent.reputation.decayFactor > 0.9 ? '↑' : agent.reputation.decayFactor > 0.5 ? '→' : '↓'}
                          </span>
                        )}
                      </div>
                      <span className="text-ink font-semibold">{parseFloat(agent.totalEarned ?? '0').toLocaleString(undefined, { maximumFractionDigits: 2 })} 0G</span>
                      <span className="text-ink-3">{agent.tasksCompleted ?? 0}</span>
                      <Tag tone={STATUS_TONE[agent.status] ?? 'neutral'}>{isActing ? `${action.variables?.act}…` : agent.status}</Tag>
                      <div className="flex gap-2 text-[11px] font-mono">
                        {agent.status !== 'running' && (
                          <button disabled={isActing} onClick={() => action.mutate({ id: agent.id, act: 'start' })} className="text-green-400 hover:underline disabled:opacity-40">start</button>
                        )}
                        {agent.status === 'running' && (
                          <button disabled={isActing} onClick={() => action.mutate({ id: agent.id, act: 'pause' })} className="text-yellow-400 hover:underline disabled:opacity-40">pause</button>
                        )}
                        <button disabled={isActing} onClick={() => action.mutate({ id: agent.id, act: 'stop' })} className="text-ink-3 hover:text-red-400 hover:underline disabled:opacity-40">stop</button>
                        <Link to={`/agents/${agent.id}`} className="text-cream hover:underline">logs</Link>
                      </div>
                    </div>
                    {failed && (
                      <div className="px-5 pb-3 text-[11px] font-mono text-red-400">
                        {action.variables?.act} failed: {(action.error as Error).message}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
