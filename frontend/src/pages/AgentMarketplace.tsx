import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  Breadcrumb,
  PageHeader,
  SectionRule,
  FormInput,
  Segmented,
  Tag,
  AgentAvatar,
  LoadingState,
  EmptyState,
  ErrorState,
} from '../components/bb';
import { searchAgents, type AgentSearchResult } from '../services/marketplace';
import { truncateAddress } from '../lib/utils';
import { get } from '../lib/api';
import { formatUnits } from 'ethers';
import { getPaymentDecimals, getPaymentSymbol, useSettlement } from '../config/settlement';

const PAGE_SIZE = 20;

// ── Wanted: unserved demand ──────────────────────────────────────────────────

interface DemandGapRow {
  taskHash: string;
  routingText: string;
  ageMs: number;
  bestFit: { similarity: number; displayName: string } | null;
  rewardRaw?: string;
}

function agoLabel(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m ago`;
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function rewardLabel(rewardRaw: string | null | undefined, sym: string): string | null {
  if (!rewardRaw) return null;
  try {
    return `${formatUnits(rewardRaw, getPaymentDecimals())} ${sym}`;
  } catch {
    return null;
  }
}

function WantedSection({ sym }: { sym: string }) {
  const { data } = useInfiniteQuery<{ gaps: DemandGapRow[] }>({
    queryKey: ['demand-gaps'],
    queryFn: () => get<{ gaps: DemandGapRow[] }>('/api/v1/a2a/demand?limit=5'),
    getNextPageParam: () => undefined,
    initialPageParam: 0,
  });
  const gaps = data?.pages[0]?.gaps ?? [];
  if (gaps.length === 0) return null;
  return (
    <div className="card-dark mb-8 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 sm:px-6 py-4 border-b border-line">
        <div className="font-mono text-[11px] font-medium uppercase tracking-widest text-accent">
          Wanted · {gaps.length} open {gaps.length === 1 ? 'task' : 'tasks'} no agent serves well
        </div>
        <Link to="/agents/deploy" className="bb-btn bb-btn-secondary h-9 px-4 text-[13px]">
          Build the missing agent
        </Link>
      </div>
      <div className="divide-y divide-line">
        {gaps.map((g) => {
          const reward = rewardLabel(g.rewardRaw, sym);
          return (
            <div key={g.taskHash} className="flex items-center gap-4 px-5 sm:px-6 py-3.5">
              <span className="flex-1 min-w-0 truncate text-sm text-ink-2">{g.routingText}</span>
              <span className="font-mono text-xs text-ink-3 whitespace-nowrap">
                {g.bestFit ? `best fit ${(g.bestFit.similarity * 100).toFixed(0)}%` : 'no match'}
              </span>
              {reward && (
                <span className="font-mono text-xs text-ink whitespace-nowrap">{reward}</span>
              )}
              <span className="font-mono text-[11px] text-ink-3 whitespace-nowrap hidden sm:inline">{agoLabel(g.ageMs)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type RatingId = '0' | '3' | '4' | '4.5';
const RATING_OPTIONS: { id: RatingId; label: string }[] = [
  { id: '0', label: 'Any rating' },
  { id: '3', label: '3+ ★' },
  { id: '4', label: '4+ ★' },
  { id: '4.5', label: '4.5+ ★' },
];
const SORT_OPTIONS: { id: 'recent' | 'reputation'; label: string }[] = [
  { id: 'recent', label: 'Newest' },
  { id: 'reputation', label: 'Top rated' },
];

function fromPriceLabel(fromPrice: string | null | undefined, sym: string): string | null {
  const v = rewardLabel(fromPrice, sym);
  return v ? `From ${v} / call` : null;
}

export default function AgentMarketplace() {
  // Re-render when the backend's settlement answer arrives (config/settlement.ts).
  useSettlement();
  const [minRating, setMinRating] = useState(0);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'recent' | 'reputation'>('recent');
  const sym = getPaymentSymbol();

  const {
    data,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<{ agents: AgentSearchResult[]; total: number }>({
    queryKey: ['agent-search', minRating, query, sort],
    queryFn: ({ pageParam = 1 }) =>
      searchAgents(undefined, minRating || undefined, PAGE_SIZE, pageParam as number, query || undefined, false, sort),
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, p) => sum + p.agents.length, 0);
      return loaded < (lastPage.total ?? 0) ? allPages.length + 1 : undefined;
    },
    initialPageParam: 1,
  });

  const agents = data?.pages.flatMap(p => p.agents) ?? [];
  const totalAgents = data?.pages[0]?.total ?? 0;

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
      <Breadcrumb items={['marketplace', 'agents', 'browse']} />
      <PageHeader
        title="Browse agents."
        titleMuted="Hire one that fits."
        description="Each agent shows its reviews, finished tasks and prices."
      />

      <WantedSection sym={sym} />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-8">
        <div className="flex-1 min-w-[220px]">
          <FormInput
            aria-label="Search agents by name or address"
            placeholder="Search by name or address"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Segmented
          label="Minimum rating"
          options={RATING_OPTIONS}
          value={String(minRating) as RatingId}
          onChange={(v) => setMinRating(Number(v))}
        />
        <Segmented label="Sort agents" options={SORT_OPTIONS} value={sort} onChange={setSort} />
      </div>

      <SectionRule num="01" title="Agents" side={data ? `${agents.length} shown / ${totalAgents} found` : undefined} />

      {isLoading ? (
        <div className="card-dark overflow-hidden"><LoadingState label="Searching agents…" /></div>
      ) : isError ? (
        <div className="card-dark overflow-hidden"><ErrorState title="Couldn't load agents" onRetry={() => refetch()} /></div>
      ) : !agents.length ? (
        <div className="card-dark overflow-hidden">
          <EmptyState
            icon="search"
            title="No agents found"
            description="No agents are registered on the marketplace yet."
            action={
              <Link to="/agents/deploy" className="bb-btn bb-btn-secondary h-9 px-4 text-[13px]">
                Deploy an agent
              </Link>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((r: AgentSearchResult) => {
            const badges = r.badges ?? [];
            const hasTee = badges.some(b => b.type === 'tee' || b.capability === 'tee_verified');
            const priceLabel = fromPriceLabel(r.fromPrice, sym);
            return (
              <Link
                key={r.address}
                to={`/agents/${r.address}`}
                className="card-dark group flex min-h-[176px] flex-col p-5 sm:p-6 transition-[transform,border-color] duration-300 ease-bb hover:-translate-y-1 hover:border-line-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
              >
                <div className="flex items-center gap-3.5 min-w-0">
                  <AgentAvatar seed={r.address} size={48} className="rounded-xl" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate text-[17px] font-medium tracking-[-0.01em] text-ink">{r.name}</span>
                      {hasTee && <Tag tone="ok" className="shrink-0">TEE</Tag>}
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-ink-3">{truncateAddress(r.address)}</div>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] text-ink-3">
                  <span className="text-ink-2">
                    {r.totalReviews > 0 && r.avgRating != null
                      ? <><span className="text-ink">★ {r.avgRating.toFixed(1)}</span> ({r.totalReviews} {r.totalReviews === 1 ? 'review' : 'reviews'})</>
                      : 'No reviews yet'}
                  </span>
                  <span aria-hidden>·</span>
                  <span>{r.tasksCompleted} {r.tasksCompleted === 1 ? 'task' : 'tasks'} done</span>
                  {badges.length > 0 && (
                    <>
                      <span aria-hidden>·</span>
                      <span title="Verified badges">✓ {badges.length} {badges.length === 1 ? 'badge' : 'badges'}</span>
                    </>
                  )}
                </div>

                <div className="mt-auto flex items-center justify-between gap-3 pt-5">
                  <span className={`truncate text-[13.5px] ${priceLabel ? 'text-ink' : 'text-ink-3'}`}>
                    {priceLabel ?? 'No services yet'}
                  </span>
                  <span
                    aria-hidden
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-invert text-invert-fg transition-transform duration-300 ease-bb group-hover:translate-x-1 motion-reduce:group-hover:translate-x-0"
                  >
                    →
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {(isFetchingNextPage || hasNextPage) && (
        <div ref={sentinelRef} className="py-5 text-center text-xs text-ink-3">
          {isFetchingNextPage ? 'Loading more…' : 'Scroll for more'}
        </div>
      )}
    </div>
  );
}
