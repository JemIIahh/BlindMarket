import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAccount, useBalance } from 'wagmi';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Breadcrumb, PageHeader, SectionRule, Tag, StatCard } from '../components/bb';
import { truncateAddress } from '../lib/utils';
import { get, post, patch } from '../lib/api';
import { API_BASE_URL } from '../config/constants';

interface AgentTool { type: string; name: string; description: string; url?: string; endpointUrl?: string; method?: string; toolName?: string; }
interface AgentDetails {
  id: string; name: string; provider: string; model: string; status: string;
  ownerAddress: string; deployedAt: string; instructions: string;
  walletAddress?: string; publicKey?: string; inftTokenId?: number;
  tasksCompleted?: number; totalEarned?: string; tools?: AgentTool[];
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'err' | 'neutral'> = {
  running: 'ok', idle: 'neutral', paused: 'warn', stopped: 'err', error: 'err',
};

export default function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const { address } = useAccount();
  const qc = useQueryClient();

  const [agent, setAgent] = useState<AgentDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<string[]>([]);
  const [tab, setTab] = useState<'logs' | 'tools' | 'tasks' | 'edit'>('logs');

  // Edit state
  const [editInstructions, setEditInstructions] = useState('');
  const [editModel, setEditModel] = useState('');

  const { data: balance } = useBalance({
    address: agent?.walletAddress as `0x${string}` | undefined,
    query: { enabled: !!agent?.walletAddress },
  });

  useEffect(() => {
    if (!id) return;
    get<AgentDetails>(`/api/v1/agents/${id}`)
      .then(data => {
        setAgent(data);
        setEditInstructions(data.instructions ?? '');
        setEditModel(data.model ?? '');
      })
      .catch(() => { /* not found / server error */ })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`${API_BASE_URL}/api/v1/agents/${id}/logs`);
    es.onmessage = e => {
      try { setLogs(prev => [...prev.slice(-199), JSON.parse(e.data)]); } catch {}
    };
    return () => es.close();
  }, [id]);

  const action = useMutation({
    mutationFn: (act: 'start' | 'pause' | 'stop') =>
      post<AgentDetails>(`/api/v1/agents/${id}/${act}`),
    onSuccess: (data) => { setAgent(data); qc.invalidateQueries({ queryKey: ['my-agents'] }); },
  });

  const save = useMutation({
    mutationFn: () =>
      patch<AgentDetails>(`/api/v1/agents/${id}`, {
        ownerAddress: address,
        instructions: editInstructions,
        model: editModel,
      }),
    onSuccess: (data) => { setAgent(data); setTab('logs'); },
  });

  if (loading) return <div className="text-xs font-mono text-ink-3 py-20 text-center">loading…</div>;
  if (!agent) return <div className="text-xs font-mono text-ink-3 py-20 text-center">agent not found</div>;

  const isOwner = address?.toLowerCase() === agent.ownerAddress?.toLowerCase();

  return (
    <div>
      <Breadcrumb items={['marketplace', 'agents', 'mine', agent.name]} />
      <PageHeader
        title={agent.name}
        description={`${agent.provider} · ${agent.model}`}
        right={
          <div className="flex items-center gap-3">
            <Tag tone={STATUS_TONE[agent.status] ?? 'neutral'}>{action.isPending ? `${action.variables}…` : agent.status}</Tag>
            {isOwner && (
              <div className="flex gap-2 text-[11px] font-mono">
                {agent.status !== 'running' && <button disabled={action.isPending} onClick={() => action.mutate('start')} className="px-3 py-1 border border-green-400 text-green-400 hover:bg-green-400 hover:text-bg transition-colors disabled:opacity-40">start</button>}
                {agent.status === 'running' && <button disabled={action.isPending} onClick={() => action.mutate('pause')} className="px-3 py-1 border border-yellow-400 text-yellow-400 hover:bg-yellow-400 hover:text-bg transition-colors disabled:opacity-40">pause</button>}
                <button disabled={action.isPending} onClick={() => action.mutate('stop')} className="px-3 py-1 border border-line text-ink-3 hover:border-red-400 hover:text-red-400 transition-colors disabled:opacity-40">stop</button>
              </div>
            )}
          </div>
        }
      />
      {action.isError && (
        <div className="mb-4 px-3 py-2 border border-red-900/40 bg-red-900/10 text-[11px] font-mono text-red-400">
          {action.variables} failed: {(action.error as Error).message}
        </div>
      )}

      <div className="grid grid-cols-3 gap-0 border border-line mb-8">
        <StatCard label="tasks completed" value={String(agent.tasksCompleted ?? 0)} sub="all time" />
        <div className="border-l border-line"><StatCard label="earned" value={`$${parseFloat(agent.totalEarned ?? '0').toFixed(2)}`} sub="USDC" subColor="ok" /></div>
        <div className="border-l border-line"><StatCard label="wallet balance" value={balance ? parseFloat(balance.formatted).toFixed(4) : '—'} sub={balance?.symbol ?? '0G'} /></div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
        {/* Identity */}
        <div className="border border-line p-5">
          <SectionRule num="01" title="identity" />
          <div className="mt-4 space-y-4 text-xs font-mono">
            <div><div className="text-ink-3 mb-1">owner</div><div className="text-ink">{truncateAddress(agent.ownerAddress)}</div></div>
            <div><div className="text-ink-3 mb-1">deployed</div><div className="text-ink">{new Date(agent.deployedAt).toLocaleString()}</div></div>
            {agent.walletAddress && <div><div className="text-ink-3 mb-1">agent wallet</div><div className="text-ink break-all text-[11px]">{agent.walletAddress}</div></div>}
            {agent.inftTokenId !== undefined && <div><div className="text-ink-3 mb-1">INFT token</div><div className="text-cream">#{agent.inftTokenId}</div></div>}
            {agent.publicKey && <div><div className="text-ink-3 mb-1">public key</div><div className="text-ink">{agent.publicKey.slice(0, 18)}…{agent.publicKey.slice(-6)}</div></div>}
          </div>
        </div>

        {/* Tabbed right panel */}
        <div className="border border-line flex flex-col">
          {/* Tabs */}
          <div className="flex flex-wrap border-b border-line">
            {(['logs', 'tools', 'tasks', ...(isOwner ? ['edit'] : [])] as const).map(t => (
              <button key={t} onClick={() => setTab(t as typeof tab)}
                className={`flex-1 min-w-[80px] px-3 sm:px-5 py-3 text-[11px] font-mono uppercase tracking-widest border-r border-line transition-colors ${tab === t ? 'text-cream bg-surface-2' : 'text-ink-3 hover:text-ink hover:bg-surface-2'}`}>
                {t}
              </button>
            ))}
          </div>

          <div className="flex-1 p-5 overflow-y-auto max-h-[520px]">
            {tab === 'logs' && (
              logs.length > 0 ? logs.map((line, i) => (
                <div key={i} className={`px-3 py-1.5 text-xs font-mono ${line.includes('[err]') ? 'text-red-400 bg-red-900/10' : 'text-ink-3 hover:bg-surface-2'}`}>{line}</div>
              )) : (
                <div className="text-center py-16 text-xs font-mono text-ink-3">
                  {agent.status === 'running' ? 'waiting for logs…' : 'start the agent to see logs'}
                </div>
              )
            )}

            {tab === 'tools' && (
              <div className="space-y-3">
                {(agent.tools ?? []).length === 0 ? (
                  <div className="text-xs font-mono text-ink-3 py-8 text-center">no tools configured</div>
                ) : (agent.tools ?? []).map((t, i) => (
                  <div key={i} className="border border-line p-4 text-xs font-mono">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-cream">{t.name}</span>
                      <span className="text-ink-3 border border-line px-2 py-0.5 text-[10px]">{t.type}</span>
                    </div>
                    <div className="text-ink-3">{t.description}</div>
                    {(t.url || t.endpointUrl) && <div className="text-ink-3 mt-1 text-[11px]">{t.url ?? t.endpointUrl}</div>}
                  </div>
                ))}
              </div>
            )}

            {tab === 'tasks' && (
              <AgentTasks agentWallet={agent.walletAddress} />
            )}

            {tab === 'edit' && isOwner && (
              <div className="space-y-4">
                <div>
                  <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">instructions</label>
                  <textarea rows={6} value={editInstructions} onChange={e => setEditInstructions(e.target.value)}
                    className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink focus:outline-none focus:border-cream resize-none" />
                </div>
                <div>
                  <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">model</label>
                  <input value={editModel} onChange={e => setEditModel(e.target.value)}
                    className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink focus:outline-none focus:border-cream" />
                </div>
                <button onClick={() => save.mutate()} disabled={save.isPending}
                  className="px-6 py-3 border border-cream text-xs font-mono text-cream hover:bg-cream hover:text-bg disabled:opacity-40 transition-colors">
                  {save.isPending ? 'saving…' : 'save changes →'}
                </button>
                {save.isError && <div className="text-xs font-mono text-red-400">save failed</div>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentTasks({ agentWallet }: { agentWallet?: string }) {
  const [tasks, setTasks] = useState<Array<{ taskId: string; category: string; status: number; reward: string }>>([]);

  useEffect(() => {
    if (!agentWallet) return;
    get<{ tasks?: Array<{ taskId: string; category: string; status: number; reward: string; worker?: string; agent?: string }> }>(
      `/api/v1/tasks?limit=50`,
    )
      .then(data => {
        setTasks((data.tasks ?? []).filter(t =>
          t.worker?.toLowerCase() === agentWallet.toLowerCase() || t.agent?.toLowerCase() === agentWallet.toLowerCase()
        ));
      })
      .catch(() => { /* leave empty */ });
  }, [agentWallet]);

  const STATUS: Record<number, string> = { 0: 'funded', 1: 'assigned', 2: 'submitted', 3: 'verified', 4: 'completed', 5: 'cancelled', 6: 'disputed' };

  if (tasks.length === 0) return <div className="text-xs font-mono text-ink-3 py-8 text-center">no tasks yet</div>;

  return (
    <div className="space-y-2">
      {tasks.map(t => (
        <div key={t.taskId} className="flex items-center justify-between border border-line px-4 py-3 text-xs font-mono">
          <span className="text-ink-3">#{t.taskId}</span>
          <span className="text-ink">{t.category}</span>
          <span className="text-ink-3">{STATUS[t.status] ?? t.status}</span>
          <span className="text-cream">${(BigInt(t.reward ?? '0') / 10n ** 18n).toString()} USDC</span>
        </div>
      ))}
    </div>
  );
}
