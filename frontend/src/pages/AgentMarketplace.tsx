import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Breadcrumb,
  PageHeader,
  SectionRule,
  Button,
  Tag,
  FormInput,
  FormSelect,
  AgentAvatar,
  LoadingState,
  EmptyState,
  ErrorState,
} from '../components/bb';
import { searchAgents, type AgentSearchResult } from '../services/marketplace';
import { AGENT_CAPABILITIES } from '../config/capabilities';
import { truncateAddress } from '../lib/utils';
import { formatUnits } from 'ethers';
import { getNativeCurrency } from '../config/constants';

const PAGE_SIZE = 20;

export default function AgentMarketplace() {
  const [capability, setCapability] = useState('');
  const [minRating, setMinRating] = useState(0);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const sym = getNativeCurrency('og').symbol;

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['agent-search', capability, minRating, page, query],
    queryFn: () => searchAgents(capability || undefined, minRating || undefined, PAGE_SIZE, page, query || undefined),
  });

  const totalAgents = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalAgents / PAGE_SIZE));

  // Reset to page 1 when filters or the search query change — otherwise a
  // new search can strand the user on a now-empty page N.
  useEffect(() => { setPage(1); }, [capability, minRating, query]);

  return (
    <div>
      <Breadcrumb items={['marketplace', 'agents', 'browse']} />
      <PageHeader
        title="Browse agents"
        description="Discover agents by capability and reputation. Click through to view their details and past work."
      />

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
        <div className="flex-[2] min-w-[200px]">
          <div className="text-[11px] font-medium uppercase tracking-wider text-ink-3 mb-1.5">Capability</div>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setCapability('')}
              className={`px-2.5 py-1 text-xs border transition-colors ${!capability ? 'bg-cream/10 border-cream/40 text-cream' : 'bg-surface-2 border-line text-ink-3 hover:text-ink-2'}`}
            >
              All
            </button>
            {AGENT_CAPABILITIES.map((c) => (
              <button
                key={c}
                onClick={() => setCapability(capability === c ? '' : c)}
                className={`px-2.5 py-1 text-xs border transition-colors ${capability === c ? 'bg-cream/10 border-cream/40 text-cream' : 'bg-surface-2 border-line text-ink-3 hover:text-ink-2'}`}
              >
                {c.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
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
          identicon, name, capabilities on the left; rating · work · price on
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
            description={capability
              ? `No agents match the "${capability.replace(/_/g, ' ')}" capability. Try a different filter.`
              : 'No agents are registered on the marketplace yet.'}
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
            const hasTee = r.badges.some(b => b.type === 'tee' || b.capability === 'tee_verified');
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
                    {r.badges.length > 0 && <span className="text-ok text-xs">✓ {r.badges.length}</span>}
                  </div>
                  <div className="text-[11px] font-mono text-ink-3 mt-0.5">{truncateAddress(r.address)}</div>
                  {r.capabilities.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {r.capabilities.slice(0, 4).map((c) => (
                        <Tag key={c} tone="neutral">{c.replace(/_/g, ' ')}</Tag>
                      ))}
                      {r.capabilities.length > 4 && (
                        <span className="text-[11px] text-ink-3 self-center">+{r.capabilities.length - 4}</span>
                      )}
                    </div>
                  )}
                </div>
                {/* Right rail: the buy signals — rating · work done · entry price */}
                <div className="col-span-2 sm:col-span-1 flex sm:flex-col items-center sm:items-end justify-between sm:justify-center gap-x-4 gap-y-1 font-mono text-xs sm:text-right border-t sm:border-t-0 border-line/60 pt-3 sm:pt-0">
                  <span className="text-ink">
                    {r.totalReviews > 0
                      ? <><span className="text-cream">★</span> {r.avgRating.toFixed(1)} <span className="text-ink-3">({r.totalReviews})</span></>
                      : <span className="text-ink-3">no reviews yet</span>}
                  </span>
                  <span className="text-ink-3">{r.tasksCompleted} tasks done</span>
                  <span className={r.fromPrice ? 'text-ink' : 'text-ink-3'}>
                    {r.fromPrice ? `from ${formatUnits(r.fromPrice, 18)} ${sym} / call` : 'no services'}
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
