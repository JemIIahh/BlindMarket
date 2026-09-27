import { useEffect, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { Panel } from '../bb';
import { authedGet } from '../../lib/api';

interface ModelSummary {
  provider: string;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  estimatedCost: boolean;
}

interface DailyPoint {
  day: string;
  totalTokens: number;
  byModel: Record<string, number>;
}

interface UsageSummary {
  agentId: string;
  windowDays: number;
  totals: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number; estimatedCost: boolean };
  byModel: ModelSummary[];
  daily: DailyPoint[];
}

const PALETTE = ['#e8dcc3', '#7fb069', '#5aa9e6', '#e07a5f', '#b388eb', '#f2c14e', '#63d2d6', '#ef6461'];

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtUsd(n: number, estimated: boolean): string {
  return `${estimated ? '~' : ''}$${n.toFixed(n < 1 ? 3 : 2)}`;
}

/** Per-agent LLM usage: tokens + estimated cost, broken down by model. Owner-only. */
export function UsagePanel({ agentId }: { agentId: string }) {
  const [windowDays, setWindowDays] = useState(30);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(false);
    authedGet<UsageSummary>(`/api/v1/agents/${agentId}/usage?windowDays=${windowDays}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [agentId, windowDays]);

  const models = data?.byModel ?? [];
  const modelKeys = models.map((m) => `${m.provider}/${m.model}`);
  const colorOf = (key: string) => PALETTE[modelKeys.indexOf(key) % PALETTE.length];
  const chartData = (data?.daily ?? []).map((d) => ({ day: d.day.slice(5), ...d.byModel }));

  return (
    <Panel padding="md" className="mb-6">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-ink">Token usage</h3>
        <div className="flex gap-1.5">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setWindowDays(d)}
              aria-pressed={windowDays === d}
              className={`rounded-full px-3 py-1 text-xs font-mono border transition-colors ${
                windowDays === d ? 'border-invert bg-invert text-invert-fg' : 'border-line text-ink-3 hover:text-ink-2'
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-err">Couldn't load usage.</p>}
      {!error && !data && <p className="text-sm text-ink-3">Loading usage…</p>}
      {data && data.totals.calls === 0 && (
        <p className="text-sm text-ink-3">No LLM calls recorded in the last {data.windowDays} days. Usage appears here after the agent runs tasks.</p>
      )}
      {data && data.totals.calls > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            {[
              { label: 'LLM calls', value: String(data.totals.calls) },
              { label: 'Tokens', value: fmtTokens(data.totals.totalTokens) },
              { label: 'Est. cost', value: fmtUsd(data.totals.costUsd, data.totals.estimatedCost) },
              { label: 'Models', value: String(models.length) },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border border-line px-4 py-3">
                <div className="text-[11px] text-ink-3 tracking-wide">{s.label}</div>
                <div className="text-lg font-mono text-ink mt-0.5">{s.value}</div>
              </div>
            ))}
          </div>

          {chartData.length > 0 && (
            <div className="mb-6">
              <div className="text-[11px] tracking-wide text-ink-3 mb-2">Daily tokens by model</div>
              <div style={{ width: '100%', height: 220 }}>
                <ResponsiveContainer>
                  <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" vertical={false} />
                    <XAxis dataKey="day" tick={{ fill: '#8a8a8a', fontSize: 11 }} tickLine={false} axisLine={{ stroke: '#2a2a2a' }} />
                    <YAxis tick={{ fill: '#8a8a8a', fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtTokens(v)} />
                    <Tooltip
                      contentStyle={{ background: '#141414', border: '1px solid #2a2a2a', fontSize: 12 }}
                      formatter={(value: any, name: any) => [fmtTokens(Number(value)), name]}
                    />
                    {modelKeys.map((k) => (
                      <Line key={k} type="monotone" dataKey={k} stroke={colorOf(k)} strokeWidth={2} dot={false} name={k} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                {modelKeys.map((k) => (
                  <span key={k} className="inline-flex items-center gap-1.5 text-xs font-mono text-ink-3">
                    <span className="w-2 h-2 inline-block rounded-full" style={{ background: colorOf(k) }} />
                    {k}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="text-[11px] tracking-wide text-ink-3 mb-2">By model</div>
          <div className="space-y-2">
            {models.map((m) => {
              const key = `${m.provider}/${m.model}`;
              return (
                <div key={key} className="flex items-center gap-3 rounded-xl border border-line px-4 py-3 flex-wrap">
                  <span className="w-2 h-2 shrink-0 rounded-full" style={{ background: colorOf(key) }} />
                  <span className="font-mono text-sm text-ink truncate flex-1 min-w-[140px]">{key}</span>
                  <span className="text-xs font-mono text-ink-3">{m.calls} calls</span>
                  <span className="text-xs font-mono text-ink-3">↑{fmtTokens(m.promptTokens)} ↓{fmtTokens(m.completionTokens)}</span>
                  <span className="text-xs font-mono text-ink-3" title={m.estimatedCost ? 'Model not in price table — rate is a fallback estimate' : 'Priced from the model rate table'}>
                    {fmtUsd(m.costUsd, m.estimatedCost)}
                  </span>
                </div>
              );
            })}
          </div>
          {data.totals.estimatedCost && (
            <p className="text-[11px] text-ink-3 mt-3">~ = at least one model uses a fallback rate. Set MODEL_PRICES_JSON on the backend to price it exactly.</p>
          )}
        </>
      )}
    </Panel>
  );
}
