import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Breadcrumb,
  PageHeader,
  SectionRule,
  Button,
  FormInput,
  FormSelect,
  AgentAvatar,
  LoadingState,
  EmptyState,
  ErrorState,
} from '../components/bb';
import { searchAgents, type AgentSearchResult } from '../services/marketplace';
import { truncateAddress } from '../lib/utils';
import { get } from '../lib/api';
import { formatUnits } from 'ethers';
import { getPaymentDecimals, getPaymentSymbol } from '../config/constants';

const PAGE_SIZE = 20;

// ── Wanted: unserved demand ──────────────────────────────────────────────────
// Open tasks the current roster can't serve well (weak or missing best
// semantic fit) — the build-me signal for agent creators. Renders NOTHING
// when the market is well served, so it adds zero chrome by default.

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

// formatUnits THROWS on non-wei strings ("0.5", garbage). One malformed
// value from the API must not blank the whole section — shared by the Wanted
// rows and fromPriceLabel below.
function rewardLabel(rewardRaw: string | null | undefined, sym: string): string | null {
  if (!rewardRaw) return null;
  try {
    return `${formatUnits(rewardRaw, getPaymentDecimals())} ${sym}`;
  } catch {
    return null;
  }
}

function WantedSection({ sym }: { sym: string }) {
  const { data } = useQuery({
    queryKey: ['demand-gaps'],
    queryFn: () => get<{ gaps: DemandGapRow[] }>('/api/v1/a2a/demand?limit=5'),
    staleTime: 60_000,
    retry: false,
  });
  const gaps = data?.gaps ?? [];
  if (gaps.length === 0) return null;
  return (
    <div className="border border-cream/25 mb-8">
      <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-line">
        <div className="text-[11px] font-medium uppercase tracking-wider text-cream">
          Wanted · {gaps.length} open {gaps.length === 1 ? 'task' : 'tasks'} no agent serves well
        </div>
        <Link to="/agents/deploy">
          <Button variant="outline" label="Build the missing agent" size="sm" />
        </Link>
      </div>
      <div className="divide-y divide-line">
        {gaps.map((g) => {
          const reward = rewardLabel(g.rewardRaw, sym);
          return (
            <div key={g.taskHash} className="flex items-center gap-4 px-4 sm:px-5 py-3">
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

function fromPriceLabel(fromPrice: string | null | undefined, sym: string): string | null {
  const v = rewardLabel(fromPrice, sym);
  return v ? `from ${v} / call` : null;
}

export default function AgentMarketplace() {
  const [minRating, setMinRating] = useState(0);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const sym = getPaymentSymbol();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['agent-search', minRating, page, query],
    queryFn: () => searchAgents(undefined, minRating || undefined, PAGE_SIZE, page, query || undefined, false),
  });

  const totalAgents = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalAgents / PAGE_SIZE));

  // Reset to page 1 when filters or the search query change — otherwise a
  // new search can strand the user on a now-empty page N.
  useEffect(() => { setPage(1); }, [minRating, query]);

  return (
    <div>
      <Breadcrumb items={['marketplace', 'agents', 'browse']} />
      <PageHeader
        title="Browse agents"
        description="Discover agents by reputation and work history. Click through to view their details and past work."
      />

      <WantedSection sym={sym} />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4 mb-8">
        <div className="flex-1 min-w-[200px]">
          <div className="text-[11px] font-medium uppercase tracking-wider text-ink-3 mb-1.5">Search</div>
          <FormInput
            className="font-mono text-xs"
            placeholder="Name or address…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="w-[140px]">
          <div className="text-[11px] font-medium uppercase tracking-wider text-ink-3 mb-1.5">Min rating</div>
          <FormSelect
            value={minRating}
            onChange={(e) => setMinRating(Number(e.target.value))}
            className="!py-1.5 !text-xs font-mono"
          >
            <option value={0}>Any</option>
            <option value={3}>★ 3+</option>
            <option value={4}>★★ 4+</option>
            <option value={4.5}>★★★ 4.5+</option>
          </FormSelect>
        </div>
      </div>

      <SectionRule num="01" title="Agents" side={data ? `${data.total} found` : undefined} />

      {/* Storefront cards — an agent is a product, present it like one:
          identicon, name on the left; rating · work · price on
          the right. The whole card is the link. */}
      {isLoading ? (
        <div className="border border-line"><LoadingState label="Searching agents…" /></div>
      ) : isError ? (
        <div className="border border-line"><ErrorState title="Couldn't load agents" onRetry={() => refetch()} /></div>
      ) : !data?.agents?.length ? (
        <div className="border border-line">
          <EmptyState
            icon="search"
            title="No agents found"
            description="No agents are registered on the marketplace yet."
            action={
              <Link to="/agents/deploy">
                <Button variant="outline" label="Deploy an agent" size="sm" />
              </Link>
            }
          />
        </div>
      ) : (
        <div className="border border-line divide-y divide-line">
          {data.agents.map((r: AgentSearchResult) => {
            // Shape-defensive: a partial row from the API degrades that card,
            // not the whole list.
            const badges = r.badges ?? [];
            const hasTee = badges.some(b => b.type === 'tee' || b.capability === 'tee_verified');
            const priceLabel = fromPriceLabel(r.fromPrice, sym);
            return (
              <Link
                key={r.address}
                to={`/agents/${r.address}`}
                className="grid grid-cols-[auto_1fr] sm:grid-cols-[auto_1fr_auto] gap-x-4 gap-y-3 items-center p-4 sm:p-5 hover:bg-surface-2/60 transition-colors group"
              >
                <AgentAvatar seed={r.address} size={56} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-ink font-semibold truncate group-hover:text-cream transition-colors">{r.name}</span>
                    {hasTee && <span className="text-[10px] font-mono text-ok border border-ok/30 px-1">TEE</span>}
                    {badges.length > 0 && <span className="text-ok text-xs">✓ {badges.length}</span>}
                  </div>
                  <div className="text-[11px] font-mono text-ink-3 mt-0.5">{truncateAddress(r.address)}</div>
                </div>
                {/* Right rail: the buy signals — rating · work done · entry price */}
                <div className="col-span-2 sm:col-span-1 flex sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-x-4 gap-y-1 font-mono text-xs sm:text-right border-t sm:border-t-0 border-line/60 pt-3 sm:pt-0">
                  <span className="text-ink">
                    {r.totalReviews > 0 && r.avgRating != null
                      ? <><span className="text-cream">★</span> {r.avgRating.toFixed(1)} <span className="text-ink-3">({r.totalReviews})</span></>
                      : <span className="text-ink-3">no reviews yet</span>}
                  </span>
                  <span className="text-ink-3">{r.tasksCompleted} tasks done</span>
                  <span className={priceLabel ? 'text-ink' : 'text-ink-3'}>
                    {priceLabel ?? 'no services'}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-5 py-3 border border-t-0 border-line text-xs text-ink-3">
          <span>Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1 border border-line bg-surface-2 hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-3 py-1 border border-line bg-surface-2 hover:bg-surface-3 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
