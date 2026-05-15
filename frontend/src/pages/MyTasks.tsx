import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Breadcrumb, PageHeader, SectionRule, Tag, StatCard } from '../components/bb';
import { useSocket } from '../hooks/useSocket';
import { useBidWatcher } from '../hooks/useBidWatcher';
import { authedGet } from '../lib/api';

// ── Shapes returned by GET /api/v1/a2a/tasks/posted ──────────────────────
//
// The backend enriches each Redis-side task with its on-chain record so we
// have status + reward + worker in a single call. `onChain` is null when the
// task hasn't been indexed yet (createTask in flight) or never confirmed.

interface PostedTask {
  meta: {
    taskId: string;           // taskHash, bytes32 hex
    targetExecutorType: 'agent' | 'human';
    verificationMode: 'manual' | 'auto' | 'oracle';
    requiredCapabilities: string[];
    posterAddress?: string;
    rootHash?: string;
  };
  state: {
    taskId: string;
    status: 'open' | 'accepted' | 'submitted' | 'verified' | 'failed' | 'in_progress';
    executorAddress?: string;
    acceptedAt?: string;
    submittedAt?: string;
    resultData?: Record<string, unknown>;
    verificationResult?: { passed: boolean; reasons?: string[] };
  };
  onChain: null | {
    taskId: string;           // numeric on-chain id, as string
    status: number;           // 0=Funded 1=Assigned 2=Submitted 3=Verified 4=Completed 5=Cancelled 6=Disputed
    reward: string;           // raw bigint as string
    token: string;
    worker: string;
    createdAt: string;
    deadline: string;
  };
}

const STATUS_LABELS: Record<number, string> = {
  0: 'open', 1: 'assigned', 2: 'submitted', 3: 'verified', 4: 'completed', 5: 'cancelled', 6: 'disputed',
};
const STATUS_TONE: Record<number, 'ok' | 'warn' | 'err' | 'neutral'> = {
  0: 'neutral', 1: 'warn', 2: 'warn', 3: 'ok', 4: 'ok', 5: 'err', 6: 'err',
};

// Marketplace token is Native 0G — 18 decimals.
function formatReward(raw: string | undefined) {
  if (!raw) return '—';
  try {
    const n = Number(BigInt(raw)) / 1e18;
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} 0G`;
  } catch {
    return raw;
  }
}

// Short id for the visible task identifier — we display the on-chain numeric
// id when available (familiar #42 form), otherwise the truncated hash.
function shortId(t: PostedTask): string {
  // Use onChain taskId first, then fall back to meta.taskId (also numeric)
  const numericId = t.onChain?.taskId || t.meta.taskId;
  // If it's a small number/string, it's our sequential ID
  if (numericId && numericId.length < 10) return `#${numericId}`;
  return `${t.meta.taskId.slice(0, 10)}…`;
}

// On-chain ZERO worker = "no one assigned yet". A non-zero, non-poster
// worker address means an executor has been assigned via marketplaceAssign.
function workerLabel(t: PostedTask): string {
  const w = t.onChain?.worker;
  if (!w || /^0x0+$/.test(w)) return 'no worker yet';
  return `worker · ${w.slice(0, 6)}…${w.slice(-4)}`;
}

export default function MyTasks() {
  const { address } = useAccount();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'open' | 'active' | 'completed'>('all');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'highest-reward' | 'lowest-reward'>('newest');

  // /a2a/tasks/posted returns every task the authed wallet posted, across
  // the full lifecycle. /api/v1/tasks would only return Funded ones, which
  // is why completed work used to vanish from this page the moment it
  // settled — the on-chain registry's getOpenTasks filters out non-open
  // entries. authedGet flows the JWT (Privy identity) for the server-side
  // posterAddress check.
  const { data: tasks = [], isLoading } = useQuery<PostedTask[]>({
    queryKey: ['my-tasks-posted', address],
    queryFn: async () => {
      const data = await authedGet<{ tasks: PostedTask[]; total: number }>('/api/v1/a2a/tasks/posted');
      return data.tasks ?? [];
    },
    enabled: !!address,
  });

  useSocket('tasks', {
    'task:created': () => qc.invalidateQueries({ queryKey: ['my-tasks-posted', address] }),
    'task:assigned': () => qc.invalidateQueries({ queryKey: ['my-tasks-posted', address] }),
    'task:completed': () => qc.invalidateQueries({ queryKey: ['my-tasks-posted', address] }),
  });

  // Just-in-time wrap loop for tasks posted from this browser. Polls every
  // task with a stashed AES key for new bidders and ECIES-wraps the key to
  // them. Active for as long as this page is mounted.
  useBidWatcher(!!address);

  // For status counts we prefer the on-chain status (source of truth for
  // settlement); fall back to the a2a state for tasks whose chain index
  // hasn't caught up yet (mapped to the closest matching enum).
  function effectiveStatus(t: PostedTask): number {
    if (t.onChain) return t.onChain.status;
    switch (t.state.status) {
      case 'open': return 0;
      case 'accepted': case 'in_progress': return 1;
      case 'submitted': return 2;
      case 'verified': return 3;
      case 'failed': return 6;
      default: return 0;
    }
  }

  const filteredTasks = tasks
    .filter(t => {
      const status = effectiveStatus(t);
      if (filter === 'open') return status === 0;
      if (filter === 'active') return [1, 2].includes(status);
      if (filter === 'completed') return status === 4;
      return true;
    })
    .sort((a, b) => {
      const getReward = (t: PostedTask) => (t.onChain ? Number(BigInt(t.onChain.reward)) : 0);
      const getCreatedAt = (t: PostedTask) => Number(t.onChain?.createdAt || t.state.acceptedAt || 0);
      
      switch (sort) {
        case 'newest': return getCreatedAt(b) - getCreatedAt(a);
        case 'oldest': return getCreatedAt(a) - getCreatedAt(b);
        case 'highest-reward': return getReward(b) - getReward(a);
        case 'lowest-reward': return getReward(a) - getReward(b);
        default: return 0;
      }
    });

  const openCount = tasks.filter(t => effectiveStatus(t) === 0).length;
  const activeCount = tasks.filter(t => [1, 2].includes(effectiveStatus(t))).length;
  const completedCount = tasks.filter(t => effectiveStatus(t) === 4).length;
  const totalSpent = tasks
    .filter(t => effectiveStatus(t) === 4)
    .reduce((s, t) => s + (t.onChain ? Number(BigInt(t.onChain.reward)) / 1e18 : 0), 0);

  return (
    <div>
      <Breadcrumb items={['tasks', 'mine']} />
      <PageHeader
        title="My tasks"
        description="Tasks you've posted — track status, assignments, completions, and inspect results."
        right={
          <Link to="/tasks/new" className="px-4 py-2 border border-cream text-[11px] font-mono text-cream hover:bg-cream hover:text-bg transition-colors uppercase tracking-widest">
            + post task
          </Link>
        }
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 border border-line mb-8">
        <StatCard label="open" value={String(openCount)} sub="awaiting worker" />
        <div className="border-l border-line"><StatCard label="active" value={String(activeCount)} sub="in progress" subColor="warn" /></div>
        <div className="border-t border-l-0 sm:border-t-0 sm:border-l border-line"><StatCard label="completed" value={String(completedCount)} sub="all time" subColor="ok" /></div>
        <div className="border-t border-l border-line sm:border-t-0"><StatCard label="total spent" value={`${totalSpent.toLocaleString(undefined, { maximumFractionDigits: 2 })} 0G`} sub="Native 0G paid out" /></div>
      </div>

      <div className="border border-line">
        <div className="flex items-center justify-between bg-surface-1 pr-4">
          <SectionRule num="01" title="posted tasks" side={`${filteredTasks.length} shown / ${tasks.length} total`} />
          <div className="flex gap-2">
            {(['all', 'open', 'active', 'completed'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`text-[10px] font-mono uppercase tracking-widest px-2 py-1 border transition-colors ${
                  filter === f ? 'bg-cream text-bg border-cream' : 'text-ink-3 border-line hover:border-cream/50'
                }`}
              >
                {f}
              </button>
            ))}
            <div className="h-6 w-px bg-line mx-2" />
            {(['newest', 'oldest', 'highest-reward', 'lowest-reward'] as const).map(s => (
              <button
                key={s}
                onClick={() => setSort(s)}
                className={`text-[10px] font-mono uppercase tracking-widest px-2 py-1 border transition-colors ${
                  sort === s ? 'bg-cream text-bg border-cream' : 'text-ink-3 border-line hover:border-cream/50'
                }`}
              >
                {s.replace('-', ' ')}
              </button>
            ))}
          </div>
        </div>

        {!address ? (
          <div className="px-5 py-10 text-center text-xs font-mono text-ink-3">connect wallet to see your tasks</div>
        ) : isLoading ? (
          <div className="px-5 py-10 text-center text-xs font-mono text-ink-3">loading…</div>
        ) : filteredTasks.length === 0 ? (
          <div className="px-5 py-10 flex flex-col items-center gap-3">
            <p className="text-xs font-mono text-ink-3">no {filter !== 'all' ? filter : ''} tasks found.</p>
            {filter === 'all' && <Link to="/tasks/new" className="text-xs font-mono text-cream hover:underline">post your first task →</Link>}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-line border-t border-line">
            {filteredTasks.map(t => {
              const status = effectiveStatus(t);
              const isDone = status === 3 || status === 4 || status === 6;
              const hasResult = !!t.state.resultData;
              const taskId = t.onChain?.taskId || t.meta.taskId;
              const taskUrl = `/tasks/${taskId}`;
              const cardClass = `bg-bg p-5 flex flex-col gap-3 min-h-[200px] group hover:bg-surface-2 transition-colors cursor-pointer`;
              const cardContent = (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-mono text-ink-3">{shortId(t)}</span>
                    <Tag tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABELS[status] ?? 'unknown'}</Tag>
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-mono text-ink break-all">{t.meta.taskId.slice(0, 18)}…</div>
                    <div className="text-[11px] font-mono text-ink-3 mt-0.5">
                      {t.meta.verificationMode} verify · {t.meta.targetExecutorType}
                    </div>
                    {t.meta.requiredCapabilities && t.meta.requiredCapabilities.length > 0 && (
                      <div className="flex gap-1 mt-2 flex-wrap">
                        {t.meta.requiredCapabilities.slice(0, 4).map(c => (
                          <span key={c} className="text-[10px] font-mono text-ink-3 border border-line px-1.5 py-0.5">
                            {c.replace(/_/g, ' ')}
                          </span>
                        ))}
                      </div>
                    )}
                    {t.state.verificationResult?.passed === false && t.state.verificationResult.reasons && t.state.verificationResult.reasons.length > 0 && (
                      <div className="mt-2 text-[10px] font-mono text-err leading-relaxed">
                        failed: {t.state.verificationResult.reasons.join(' · ')}
                      </div>
                    )}
                  </div>
                  <div className="pt-3 border-t border-line flex items-end justify-between">
                    <div>
                      <div className="text-lg font-mono font-semibold text-cream leading-none">
                        {formatReward(t.onChain?.reward)}
                      </div>
                      <div className="text-[10px] font-mono text-ink-3 mt-1.5 uppercase tracking-widest">
                        {workerLabel(t)}
                      </div>
                    </div>
                    <span className="text-[11px] font-mono text-ink-3 group-hover:text-cream transition-colors">view →</span>
                  </div>
                  {(hasResult || isDone) && (
                    <details className="mt-1 border-t border-line pt-3 group/details" onClick={e => e.preventDefault()}>
                      <summary className="flex items-center justify-between cursor-pointer text-[11px] font-mono uppercase tracking-widest text-ink-3 hover:text-cream transition-colors list-none">
                        <span>view result</span>
                        <span className="group-open/details:rotate-90 transition-transform">▸</span>
                      </summary>
                      {hasResult ? (
                        <pre className="mt-3 max-h-72 overflow-auto bg-surface-2 border border-line p-3 text-[11px] font-mono text-ink leading-relaxed whitespace-pre-wrap break-words">
                          {JSON.stringify(t.state.resultData, null, 2)}
                        </pre>
                      ) : (
                        <div className="mt-3 text-[11px] font-mono text-ink-3 leading-relaxed">
                          no result data on file.
                        </div>
                      )}
                    </details>
                  )}
                </>
              );
              return (
                <Link key={t.meta.taskId} to={taskUrl} className={cardClass}>{cardContent}</Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
