import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccount } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { Breadcrumb, PageHeader, StatCard, Button } from '../components/bb';
import { useOpenTasks } from '../hooks/useTasks';
import { useReputation } from '../hooks/useReputation';
import { useSocket } from '../hooks/useSocket';
import { truncateAddress } from '../lib/utils';
import type { TaskMeta } from '../types/api';

function formatBounty(amountWei: string, decimals: number = 18): string {
  try {
    const n = BigInt(amountWei);
    const divisor = 10n ** BigInt(decimals);
    const whole = n / divisor;
    const frac = Number(n % divisor) / (10 ** decimals);
    const total = Number(whole) + frac;
    return total >= 1
      ? `$${total.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`
      : `$${total.toFixed(4)} USDC`;
  } catch {
    return amountWei;
  }
}

function formatAge(isoOrSeconds: string): string {
  const ts = /^\d+$/.test(isoOrSeconds) ? Number(isoOrSeconds) * 1000 : Date.parse(isoOrSeconds);
  if (!Number.isFinite(ts)) return '—';
  const delta = Date.now() - ts;
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

export default function TaskFeed() {
  const { address } = useAccount();
  const qc = useQueryClient();
  const { data: tasks, isLoading, error } = useOpenTasks(0, 50);
  const { data: reputation } = useReputation(address ?? null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Live updates — refetch when new tasks are posted or assigned
  useSocket('tasks', {
    'task:created': () => qc.invalidateQueries({ queryKey: ['tasks', 'open'] }),
    'task:assigned': () => qc.invalidateQueries({ queryKey: ['tasks', 'open'] }),
  });

  const selected: TaskMeta | null =
    (tasks && selectedId && tasks.find((t) => t.taskId === selectedId)) || tasks?.[0] || null;
  // If user hasn't manually clicked a row yet, default to first real task so the detail pane isn't empty.
  const activeId = selectedId ?? selected?.taskId ?? null;

  const totalOpenReward =
    tasks?.reduce((acc, t) => {
      try { 
        const decimals = (t as any).decimals ?? 18;
        const normalized = BigInt(t.reward) * (10n ** BigInt(18 - decimals));
        return acc + normalized; 
      } catch { return acc; }
    }, 0n) ?? 0n;

  return (
    <div>
      <Breadcrumb items={['marketplace', 'tasks']} />
      <PageHeader
        title="Task feed"
        description="Open encrypted tasks available for workers."
        right={
          <div className="flex items-center gap-4">
            <span className="text-[11px] font-mono text-ink-3 uppercase tracking-widest">
              {tasks?.length ?? 0} open · live from chain
            </span>
            <Link
              to="/tasks/new"
              className="px-4 py-2 border border-cream text-[11px] font-mono text-cream hover:bg-cream hover:text-bg transition-colors uppercase tracking-widest"
            >
              + post task
            </Link>
          </div>
        }
      />

      {/* Stat cards — live counts, rest remain placeholders until backend exposes them */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 border border-line mb-8">
        <StatCard label="open bounties" value={formatBounty(totalOpenReward.toString(), 18)} sub="total escrowed" />
        <div className="border-l border-line">
          <StatCard label="open tasks" value={String(tasks?.length ?? 0)} sub="live" subColor="ok" />
        </div>
        <div className="border-l border-line">
          <StatCard label="my reputation" value={reputation ? reputation.decayedScore.toFixed(1) : '—'} sub={address ? `${reputation?.tasksCompleted ?? 0} tasks` : 'connect wallet'} />
        </div>
        <div className="border-l border-line">
          <StatCard label="network" value="0g" sub="galileo · 16602" subColor="ok" />
        </div>
      </div>

      {/* Table + detail panel */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-0 border border-line">
        {/* Task table */}
        <div className="overflow-x-auto min-w-0">
          <div className="grid grid-cols-[80px_1fr_100px_100px_80px] gap-4 px-5 py-3 border-b border-line text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3 min-w-[480px]">
            <span>id</span>
            <span>category · zone</span>
            <span>bounty</span>
            <span>agent</span>
            <span>age</span>
          </div>

          {isLoading && (
            <div className="px-5 py-8 text-center text-xs font-mono text-ink-3">loading…</div>
          )}

          {error && !isLoading && (
            <div className="px-5 py-8 text-center text-xs font-mono text-err">
              failed to load tasks: {(error as Error).message}
            </div>
          )}

          {!isLoading && !error && tasks && tasks.length === 0 && (
            <div className="px-5 py-8 text-center text-xs font-mono text-ink-3">
              no open tasks. check back soon.
            </div>
          )}

          {tasks?.map((task) => (
            <button
              key={task.taskId}
              onClick={() => setSelectedId(task.taskId)}
              className={`grid grid-cols-[80px_1fr_100px_100px_80px] gap-4 px-5 py-4 border-b border-line text-[13px] font-mono w-full text-left transition-colors duration-150 min-w-[480px] ${
                activeId === task.taskId ? 'bg-surface-2' : 'hover:bg-surface-2'
              }`}
            >
              <span className="text-ink-3">#{task.taskId}</span>
              <span className="text-ink truncate">
                {task.category} · <span className="text-ink-3">{task.locationZone || 'global'}</span>
              </span>
              <span className="text-ink font-semibold">{formatBounty(task.reward, (task as any).decimals)}</span>
              <span className="text-ink-3 truncate">{truncateAddress(task.agent)}</span>
              <span className="text-ink-3">{formatAge(task.createdAt)}</span>
            </button>
          ))}
        </div>

        {/* Detail panel */}
        <div className="border-l border-line p-6">
          {selected ? (
            <>
              <div className="text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3 mb-2">
                task detail · #{selected.taskId}
              </div>
              <h2 className="text-2xl font-mono font-bold text-ink leading-tight mb-6">
                {selected.category}
              </h2>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-0 border border-line mb-6">
                <div className="p-4">
                  <div className="text-[10px] font-mono font-semibold uppercase tracking-widest text-ink-3 mb-1">bounty</div>
                  <div className="text-xl font-mono font-bold text-ink">{formatBounty(selected.reward, (selected as any).decimals)}</div>
                </div>
                <div className="p-4 border-l border-line">
                  <div className="text-[10px] font-mono font-semibold uppercase tracking-widest text-ink-3 mb-1">zone</div>
                  <div className="text-xl font-mono font-bold text-ink truncate">{selected.locationZone || 'global'}</div>
                </div>
              </div>

              <div className="mb-6">
                <div className="text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3 mb-2">
                  agent
                </div>
                <div className="bg-surface-2 border border-line p-3 text-xs font-mono text-ink-3 break-all">
                  {selected.agent}
                </div>
              </div>

              <div className="mb-6">
                <div className="text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3 mb-2">
                  posted
                </div>
                <div className="text-sm font-mono text-ink">{formatAge(selected.createdAt)} ago</div>
              </div>

              <div className="flex gap-3">
                <Link to={`/tasks/${selected.taskId}`} className="flex-1">
                  <Button variant="primary" label="view_details" className="w-full" />
                </Link>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full text-sm font-mono text-ink-3">
              {isLoading ? 'loading…' : 'select a task to view details'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
