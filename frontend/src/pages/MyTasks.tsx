import { useState, useEffect, useRef } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatUnits } from 'ethers';
import {
  Breadcrumb,
  PageHeader,
  SectionRule,
  StatCard,
  StatusTag,
  Tag,
  Button,
  Icon,
  LoadingState,
  EmptyState,
  ErrorState,
  FormInput,
} from '../components/bb';
import { useSocket } from '../hooks/useSocket';
import { authedGet } from '../lib/api';
import { getAesKey } from '../lib/keyStash';
import { useChainAddress } from '../hooks/useChainWallet';
import { useAuth } from '../context/AuthContext';

import { unitFor, useSettlement } from '../config/settlement';

// ── Shapes returned by GET /api/v1/a2a/tasks/posted ──────────────────────

interface PostedTask {
  meta: {
    taskId: string;
    targetExecutorType: 'agent' | 'human';
    verificationMode: 'manual' | 'auto' | 'oracle' | 'agent';
    posterAddress?: string;
    verifierAddress?: string;
    rootHash?: string;
    privacy?: 'public';
    publicBrief?: string;
  };
  state: {
    taskId: string;
    status: 'open' | 'accepted' | 'submitted' | 'awaiting_verification' | 'verified' | 'completed' | 'failed' | 'in_progress';
    executorAddress?: string;
    acceptedAt?: string;
    submittedAt?: string;
    resultData?: Record<string, unknown>;
    verificationResult?: { passed: boolean; reasons?: string[] };
  };
  wrapCount?: number;
  hasCustody?: boolean;
  onChain: null | {
    taskId: string;
    chain: 'base' | '0g' | 'arc';
    status: number;
    reward: string;
    token: string;
    // The unit `reward` is in, read from the escrow by the backend. Absent
    // from older backends; null symbol for a non-settlement token.
    symbol?: string | null;
    decimals?: number;
    worker: string;
    createdAt: string;
    deadline: string;
  };
}

const STATUS_LABELS: Record<number, string> = {
  0: 'open', 1: 'assigned', 2: 'submitted', 3: 'verification failed', 4: 'completed', 5: 'cancelled', 6: 'disputed',
};

/** The unit a row's reward is in: what the backend read, else the chain's settlement token. */
function rowUnit(onChain: PostedTask['onChain']) {
  return unitFor(onChain?.chain, onChain);
}

function rewardToNumber(raw: string | undefined, decimals: number): number {
  if (!raw) return 0;
  try {
    return Number(formatUnits(BigInt(raw), decimals));
  } catch {
    return 0;
  }
}

function rewardToWei(raw: string | undefined): bigint {
  if (!raw) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}

function formatReward(raw: string | undefined, decimals: number, symbol: string) {
  if (!raw) return '—';
  try {
    const n = rewardToNumber(raw, decimals);
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${symbol}`;
  } catch {
    return raw;
  }
}

function formatRewardForRow(onChain: PostedTask['onChain']) {
  const unit = rowUnit(onChain);
  return formatReward(onChain?.reward, unit.decimals, unit.symbol);
}

function shortId(t: PostedTask): string {
  const numericId = t.onChain?.taskId || t.meta.taskId;
  if (numericId && numericId.length < 10) return `#${numericId}`;
  return `${t.meta.taskId.slice(0, 10)}…`;
}

function workerAddress(t: PostedTask): string | null {
  const w = t.onChain?.worker;
  if (!w || /^0x0+$/.test(w)) return null;
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}

const PAGE_SIZE = 15;

export default function MyTasks() {
  // Re-render when the backend's settlement answer arrives (config/settlement.ts).
  useSettlement();
  const address = useChainAddress();
  // Gate the authed read on auth, not the address: the address arrives before
  // the token getter, and the first request would 401.
  const { isAuthenticated } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'open' | 'active' | 'completed'>('all');
  const [sort, setSort] = useState<'newest' | 'oldest' | 'highest-reward' | 'lowest-reward'>('newest');
  const [search, setSearch] = useState('');
  const [openResults, setOpenResults] = useState<Set<string>>(new Set());
  const toggleResult = (id: string) =>
    setOpenResults(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const {
    data,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<{ tasks: PostedTask[]; total: number }>({
    queryKey: ['my-tasks-posted', address, filter, search],
    queryFn: async ({ pageParam = 0 }) => {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(pageParam));
      if (filter !== 'all') params.set('status', filter);
      if (search.trim()) params.set('q', search.trim());
      return authedGet<{ tasks: PostedTask[]; total: number }>(
        `/api/v1/a2a/tasks/posted?${params.toString()}`,
      );
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, p) => sum + p.tasks.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    initialPageParam: 0,
    enabled: isAuthenticated && !!address,
  });

  const tasks = data?.pages.flatMap(p => p.tasks) ?? [];

  useSocket('tasks', {
    'task:created': () => qc.invalidateQueries({ queryKey: ['my-tasks-posted', address] }),
    'task:completed': () => qc.invalidateQueries({ queryKey: ['my-tasks-posted', address] }),
  });

  function effectiveStatus(t: PostedTask): number {
    if (t.onChain) return t.onChain.status;
    switch (t.state.status) {
      case 'open': return 0;
      case 'accepted': case 'in_progress': return 1;
      case 'submitted': case 'awaiting_verification': return 2;
      case 'verified': case 'completed': return 4;
      case 'failed': return 6;
      default: return 0;
    }
  }

  const totalTasks = data?.pages[0]?.total ?? 0;

  const openCount = tasks.filter(t => effectiveStatus(t) === 0).length;
  const activeCount = tasks.filter(t => [1, 2].includes(effectiveStatus(t))).length;
  const completedCount = tasks.filter(t => effectiveStatus(t) === 4).length;
  const completedTasks = tasks.filter(t => effectiveStatus(t) === 4);
  const totalSpent = completedTasks.reduce(
    (s, t) => s + rewardToNumber(t.onChain?.reward, rowUnit(t.onChain).decimals),
    0,
  );

  const FILTERS: { id: 'all' | 'open' | 'active' | 'completed'; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'open', label: 'Open' },
    { id: 'active', label: 'Active' },
    { id: 'completed', label: 'Completed' },
  ];
  const SORTS: { id: 'newest' | 'oldest' | 'highest-reward' | 'lowest-reward'; label: string }[] = [
    { id: 'newest', label: 'Newest' },
    { id: 'oldest', label: 'Oldest' },
    { id: 'highest-reward', label: 'Highest reward' },
    { id: 'lowest-reward', label: 'Lowest reward' },
  ];

  const sortedTasks = [...tasks].sort((a, b) => {
    const rewardWei = (t: PostedTask) => rewardToWei(t.onChain?.reward);
    const cmpWei = (x: bigint, y: bigint) => (x < y ? -1 : x > y ? 1 : 0);
    const getCreatedAt = (t: PostedTask) => Number(t.onChain?.createdAt || t.state.acceptedAt || 0);

    switch (sort) {
      case 'newest': return getCreatedAt(b) - getCreatedAt(a);
      case 'oldest': return getCreatedAt(a) - getCreatedAt(b);
      case 'highest-reward': return cmpWei(rewardWei(b), rewardWei(a));
      case 'lowest-reward': return cmpWei(rewardWei(a), rewardWei(b));
      default: return 0;
    }
  });

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div>
      <Breadcrumb items={['tasks', 'mine']} />
      <PageHeader
        title="My tasks"
        description="Tasks you've posted — track status, assignments, completions, and inspect results."
        right={
          <Link to="/tasks/new">
            <Button variant="primary" label="Post a task" />
          </Link>
        }
      />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-0 border border-line mb-8">
        <StatCard label="Open" value={String(openCount)} sub="Awaiting worker" />
        <div className="border-l border-line"><StatCard className="h-full" label="Active" value={String(activeCount)} sub="In progress" subColor="warn" /></div>
        <div className="border-t border-l-0 xl:border-t-0 xl:border-l border-line"><StatCard className="h-full" label="Completed" value={String(completedCount)} sub="All time" subColor="ok" /></div>
        <div className="border-t border-l border-line xl:border-t-0"><StatCard className="h-full" label="Total spent" value={`${totalSpent.toLocaleString(undefined, { maximumFractionDigits: 4 })} USDC`} sub="Paid out on completed tasks" /></div>
      </div>

      <div className="border border-line">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between bg-surface-2 px-4 pt-4 lg:pt-0">
          <SectionRule num="01" title="Posted tasks" side={`${tasks.length} shown / ${totalTasks} total`} className="mb-0 flex-1 lg:py-4" />
          <div className="flex flex-col sm:flex-row gap-3 pb-4 lg:pb-0 flex-1 lg:justify-end">
            <div className="flex-1 min-w-[200px] max-w-md">
              <FormInput
                placeholder="Search task id or brief…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="text-xs font-mono"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {FILTERS.map(f => (
                <button
                  key={f.id}
                  onClick={() => { setFilter(f.id); }}
                  className={`text-[11px] px-2.5 py-1 border transition-colors ${
                    filter === f.id ? 'bg-cream text-bg border-cream' : 'text-ink-3 border-line hover:border-cream/50'
                  }`}
                >
                  {f.label}
                </button>
              ))}
              <div className="hidden sm:block h-6 w-px bg-line mx-1" />
              {SORTS.map(s => (
                <button
                  key={s.id}
                  onClick={() => { setSort(s.id); }}
                  className={`text-[11px] px-2.5 py-1 border transition-colors ${
                    sort === s.id ? 'bg-cream text-bg border-cream' : 'text-ink-3 border-line hover:border-cream/50'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {!address ? (
          <EmptyState
            icon="wallet"
            title="Connect your wallet"
            description="Connect a wallet to see the tasks you've posted."
          />
        ) : isLoading ? (
          <LoadingState label="Loading your tasks…" />
        ) : isError ? (
          <ErrorState title="Couldn't load your tasks" onRetry={() => refetch()} />
        ) : tasks.length === 0 ? (
          <EmptyState
            icon="briefcase"
            title={filter === 'all' && !search ? 'No tasks posted yet' : 'No tasks match'}
            description={
              filter === 'all' && !search
                ? 'Post a task and it will show up here so you can track its status, assignment, and result.'
                : 'Try a different filter or search term, or post a new task.'
            }
            action={
              <Link to="/tasks/new">
                <Button variant="outline" label="Post a task" size="sm" />
              </Link>
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-line border-t border-line">
            {sortedTasks.map(t => {
              const status = effectiveStatus(t);
              const statusLabel = t.onChain
                ? (STATUS_LABELS[status] ?? 'open')
                : t.state.status.replace(/_/g, ' ');
              const isDone = status === 3 || status === 4 || status === 6;
              const hasResult = !!t.state.resultData;
              const reasons = t.state.verificationResult;
              const failedReasons =
                reasons?.passed === false && reasons.reasons && reasons.reasons.length > 0
                  ? reasons.reasons
                  : null;
              const keyAtRisk =
                status === 0 && t.meta.privacy !== 'public' &&
                !!t.meta.rootHash && (t.wrapCount ?? 0) === 0 && !t.hasCustody;
              const keyHere = keyAtRisk && !!getAesKey(t.meta.taskId);
              const keyRiskHint = keyHere
                ? 'Register a matching agent and keep this page open so the key gets wrapped to it. Clearing this browser before then loses the key permanently.'
                : 'Recover it from the device you posted from, or repost — it cannot be decrypted from here.';
              const taskUrl = `/tasks/${t.meta.taskId || t.onChain?.taskId}`;
              const worker = workerAddress(t);
              const cardClass = `bg-bg p-5 flex flex-col gap-3 min-h-[200px] group hover:bg-surface-2 transition-colors cursor-pointer`;
              const cardContent = (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-mono text-ink-3">{shortId(t)}</span>
                    <div className="flex items-center gap-1.5">
                      {t.meta.privacy === 'public' && <Tag tone="neutral">public</Tag>}
                      <StatusTag status={statusLabel} />
                    </div>
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-mono text-ink break-all">{t.meta.taskId.slice(0, 18)}…</div>
                    <div className="text-[11px] text-ink-3 mt-1 capitalize">
                      {t.meta.verificationMode} verify · {t.meta.targetExecutorType}
                    </div>
                    {failedReasons && (
                      <div className="mt-2 text-[11px] text-err leading-relaxed">
                        Failed: {failedReasons.join(' · ')}
                      </div>
                    )}
                    {keyAtRisk && (
                      <div
                        className={`mt-2 border-l-2 pl-2 py-0.5 text-[11px] leading-snug ${
                          keyHere ? 'border-warn text-warn' : 'border-err text-err'
                        }`}
                        onClick={(e) => e.preventDefault()}
                        title={`${keyHere
                          ? 'The encryption key for this task is only in this browser.'
                          : 'The encryption key is not on the server and not in this browser.'} ${keyRiskHint}`}
                      >
                        <div className="flex items-center gap-1.5">
                          <Icon name="lock" size={12} className="shrink-0" />
                          <span>
                            Key at risk — {keyHere ? 'only copy is in this browser' : 'not on server or this browser'}
                          </span>
                        </div>
                        <p className="mt-1 text-ink-2 sm:hidden">{keyRiskHint}</p>
                      </div>
                    )}
                  </div>
                  <div className="pt-3 border-t border-line flex items-end justify-between">
                    <div>
                      <div className="text-lg font-mono font-semibold text-cream leading-none">
                        {formatRewardForRow(t.onChain)}
                      </div>
                      <div className="text-[11px] text-ink-3 mt-1.5">
                        {worker ? (
                          <>Worker <span className="font-mono">{worker}</span></>
                        ) : (
                          'No worker yet'
                        )}
                      </div>
                    </div>
                    <span className="text-[11px] text-ink-3 group-hover:text-cream transition-colors">View →</span>
                  </div>
                  {(hasResult || isDone) && (
                    <details
                      open={openResults.has(t.meta.taskId)}
                      onClick={e => { if (e.target === e.currentTarget) { e.preventDefault(); e.stopPropagation(); } }}
                      className="mt-1 border-t border-line group/details"
                    >
                      <summary
                        onClick={e => { e.preventDefault(); e.stopPropagation(); toggleResult(t.meta.taskId); }}
                        className="pt-3 flex items-center justify-between cursor-pointer text-[11px] text-ink-3 hover:text-cream transition-colors list-none"
                      >
                        <span>View result</span>
                        <span className="group-open/details:rotate-90 transition-transform">▸</span>
                      </summary>
                      <div onClick={e => { e.preventDefault(); e.stopPropagation(); }}>
                        {hasResult ? (
                          <pre className="mt-3 max-h-72 overflow-auto bg-surface-2 border border-line p-3 text-[11px] font-mono text-ink leading-relaxed whitespace-pre-wrap break-words">
                            {JSON.stringify(t.state.resultData, null, 2)}
                          </pre>
                        ) : (
                          <div className="mt-3 text-[11px] text-ink-3 leading-relaxed">
                            No result data on file.
                          </div>
                        )}
                      </div>
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
        {(isFetchingNextPage || hasNextPage) && (
          <div ref={sentinelRef} className="py-4 text-center text-xs text-ink-3">
            {isFetchingNextPage ? 'Loading more…' : 'Scroll for more'}
          </div>
        )}
      </div>
    </div>
  );
}
