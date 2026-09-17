import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { Breadcrumb, PageHeader, Panel, StatCard, LoadingState, ErrorState } from '../components/bb';
import { useAuth } from '../context/AuthContext';
import { authedGet } from '../lib/api';
import { FOUNDER_ADDRESSES } from '../config/constants';

interface FunnelRow {
  stage: string;
  uniqueVisitors: number;
  totalEvents: number;
  conversionFromPrev: number | null;
  conversionFromTop: number | null;
}

interface FunnelResponse {
  funnel: {
    windowDays: number;
    generatedAt: string;
    rows: FunnelRow[];
  };
  topEvents: Array<{ event: string; count: number }>;
}

function formatPct(n: number | null): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

const STAGE_LABEL: Record<string, string> = {
  landing_view: 'Landing view',
  cta_click: 'CTA click',
  connect_wallet: 'Connect wallet',
  post_task_view: 'Post task view',
  task_posted: 'Task posted',
  task_funded: 'Task funded',
};

export default function Metrics() {
  const { address, isConnected } = useAccount();
  const { isAuthenticated } = useAuth();
  const [windowDays, setWindowDays] = useState(30);
  const [data, setData] = useState<FunnelResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const isFounder =
    !!address && FOUNDER_ADDRESSES.includes(address.toLowerCase());

  useEffect(() => {
    if (!isFounder || !isAuthenticated) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    authedGet<FunnelResponse>(`/api/v1/analytics/funnel?windowDays=${windowDays}`)
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => { if (!cancelled) setError(e?.message || 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isFounder, isAuthenticated, windowDays, reloadKey]);

  if (!isConnected) {
    return (
      <div>
        <Breadcrumb items={['account', 'metrics']} />
        <PageHeader title="Metrics" description="Founder-only funnel analytics." />
        <Panel>
          <div className="px-4 py-6 text-sm text-ink-2 font-mono">
            Connect your wallet to continue.
          </div>
        </Panel>
      </div>
    );
  }

  if (!isFounder) {
    return (
      <div>
        <Breadcrumb items={['account', 'metrics']} />
        <PageHeader title="Metrics" description="Founder-only funnel analytics." />
        <Panel>
          <div className="px-4 py-6 text-sm text-ink-2 font-mono">
            Not authorized. This page is restricted to founder wallets.
          </div>
        </Panel>
      </div>
    );
  }

  const top = data?.funnel.rows[0];

  return (
    <div>
      <Breadcrumb items={['admin', 'metrics']} />
      <PageHeader
        title="Metrics"
        description={`Funnel · last ${windowDays} days · unique visitors per stage.`}
      />

      <div className="mb-6 flex items-center gap-2 text-xs font-mono">
        {[7, 30, 90].map(n => (
          <button
            key={n}
            onClick={() => setWindowDays(n)}
            className={`px-3 py-1 border ${
              windowDays === n
                ? 'border-cream bg-surface-2 text-ink'
                : 'border-line text-ink-2 hover:bg-surface-2'
            }`}
          >
            {n}d
          </button>
        ))}
      </div>

      {loading && <LoadingState label="Loading funnel…" />}
      {error && (
        <ErrorState
          title="Couldn't load metrics"
          description={error}
          onRetry={() => setReloadKey(k => k + 1)}
        />
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-6">
            <StatCard label="Top of funnel" value={top?.uniqueVisitors.toLocaleString() ?? '—'} />
            <StatCard
              label="End-to-end conversion"
              value={formatPct(data.funnel.rows.at(-1)?.conversionFromTop ?? null)}
            />
            <StatCard label="Window" value={`${data.funnel.windowDays}d`} />
          </div>

          <Panel>
            <div className="px-5 py-6">
              {data.funnel.rows.map((row, i) => {
                const topN = data.funnel.rows[0]?.uniqueVisitors ?? 0;
                const widthPct = topN > 0 ? Math.max((row.uniqueVisitors / topN) * 100, 2) : 0;
                const prevRow = i > 0 ? data.funnel.rows[i - 1] : null;
                const dropoff =
                  prevRow && prevRow.uniqueVisitors > 0
                    ? prevRow.uniqueVisitors - row.uniqueVisitors
                    : 0;
                const dropoffPct =
                  prevRow && prevRow.uniqueVisitors > 0
                    ? dropoff / prevRow.uniqueVisitors
                    : 0;
                const heavyDrop = dropoffPct >= 0.5;

                return (
                  <div key={row.stage}>
                    {/* Drop-off marker between stages */}
                    {prevRow && (
                      <div className="flex items-center gap-3 ml-10 my-2 text-[10px] font-mono">
                        <span className={heavyDrop ? 'text-err' : 'text-ink-3'}>↓</span>
                        <span className={heavyDrop ? 'text-err' : 'text-ink-3'}>
                          {dropoff > 0 ? `−${dropoff.toLocaleString()}` : '0'} dropped
                          {' · '}
                          {formatPct(row.conversionFromPrev)} continued
                        </span>
                      </div>
                    )}

                    {/* Stage row */}
                    <div className="flex items-center gap-4">
                      {/* Step number */}
                      <div className="w-7 h-7 flex items-center justify-center border border-line text-[11px] font-mono text-ink-3 shrink-0">
                        {i + 1}
                      </div>

                      {/* Bar + label */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between mb-1.5 gap-3">
                          <span className="text-sm text-ink truncate">
                            {STAGE_LABEL[row.stage] ?? row.stage}
                          </span>
                          <span className="text-xs font-mono text-ink-3 shrink-0">
                            {formatPct(row.conversionFromTop) === '—'
                              ? 'top of funnel'
                              : `${formatPct(row.conversionFromTop)} of top`}
                          </span>
                        </div>

                        <div className="relative h-9 bg-surface-2 border border-line">
                          <div
                            className="absolute inset-y-0 left-0 bg-cream/40 border-r border-cream transition-all duration-500"
                            style={{ width: `${widthPct}%` }}
                          />
                          <div className="absolute inset-0 flex items-center justify-between px-3">
                            <span className="text-base font-bold text-ink tabular-nums">
                              {row.uniqueVisitors.toLocaleString()}
                            </span>
                            <span className="text-[10px] font-mono text-ink-3">
                              {row.totalEvents.toLocaleString()} events
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          <div className="mt-8">
            <h3 className="text-xs font-mono uppercase tracking-wide text-ink-3 mb-3">
              top events
            </h3>
            <Panel>
              <div className="divide-y divide-line/50">
                {data.topEvents.map(e => (
                  <div
                    key={e.event}
                    className="flex items-center justify-between px-4 py-2 text-xs font-mono"
                  >
                    <span className="text-ink">{e.event}</span>
                    <span className="text-ink-2">{e.count.toLocaleString()}</span>
                  </div>
                ))}
                {data.topEvents.length === 0 && (
                  <div className="px-4 py-6 text-ink-3 text-xs font-mono">
                    no events recorded yet
                  </div>
                )}
              </div>
            </Panel>
          </div>

          <div className="mt-6 text-[10px] font-mono text-ink-3">
            generated {new Date(data.funnel.generatedAt).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}
