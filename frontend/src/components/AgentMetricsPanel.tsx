import { useState, useEffect, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';
import { API_BASE_URL } from '../config/constants';

interface DataPoint {
  t: number;
  cpu: number;
  ramMb: number;
}

const MAX_POINTS = 30;
const POLL_MS = 10_000;

export default function AgentMetricsPanel({ agentId }: { agentId: string }) {
  const [data, setData] = useState<DataPoint[]>([]);
  const dataRef = useRef<DataPoint[]>([]);

  useEffect(() => {
    // New agent, new chart — otherwise the previous agent's points linger
    // when the route param changes without a remount.
    dataRef.current = [];
    setData([]);
    const fetchStats = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/v1/agents/${agentId}/stats`);
        if (!res.ok) return;
        const json = await res.json();
        if (!json.success || !json.data) return;
        const { cpu, ramMb } = json.data;
        const pt: DataPoint = { t: Date.now(), cpu, ramMb };
        dataRef.current = [...dataRef.current.slice(-(MAX_POINTS - 1)), pt];
        setData([...dataRef.current]);
      } catch (err) {
        console.warn('Failed to fetch agent metrics:', err);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, POLL_MS);
    return () => clearInterval(interval);
  }, [agentId]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getMinutes()}:${String(d.getSeconds()).padStart(2, '0')}`;
  };

  if (data.length < 2) {
    return (
      <div className="text-sm text-ink-3 py-6 text-center">
        Collecting metrics… (waiting for data points)
      </div>
    );
  }

  // Chart chrome from the design tokens so both themes work — recharts takes
  // inline colours, so read the CSS variables rather than hardcoding hexes.
  const tooltipStyle = {
    background: 'var(--bb-surface)',
    border: '1px solid var(--bb-line)',
    borderRadius: 12,
    fontSize: 12,
    color: 'var(--bb-ink)',
  } as const;
  const AXIS = 'var(--bb-ink-3)';
  const GRID = 'var(--bb-line)';

  const cpuMin = 0;
  const cpuMax = Math.max(100, ...data.map(d => d.cpu));

  const ramValues = data.map(d => d.ramMb);
  const ramMin = Math.max(0, Math.floor(Math.min(...ramValues) - 10));
  const ramMax = Math.ceil(Math.max(...ramValues) + 10);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 py-4">
      <div className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <h3 className="text-sm font-semibold text-ink mb-3">CPU (%)</h3>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
            <XAxis dataKey="t" tickFormatter={formatTime} stroke={AXIS} fontSize={11} />
            <YAxis domain={[cpuMin, cpuMax]} stroke={AXIS} fontSize={11} tickFormatter={v => v.toFixed(1)} />
            <Tooltip contentStyle={tooltipStyle as any} formatter={(value: any) => [`${Number(value).toFixed(1)}%`, 'CPU']} />
            <Line type="monotone" dataKey="cpu" stroke="var(--bb-accent)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <h3 className="text-sm font-semibold text-ink mb-3">Memory (MB)</h3>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID} />
            <XAxis dataKey="t" tickFormatter={formatTime} stroke={AXIS} fontSize={11} />
            <YAxis domain={[ramMin, ramMax]} stroke={AXIS} fontSize={11} tickFormatter={v => v.toFixed(0)} />
            <Tooltip contentStyle={tooltipStyle as any} formatter={(value: any) => [`${Number(value).toFixed(1)} MB`, 'RSS']} />
            <Line type="monotone" dataKey="ramMb" stroke="var(--bb-ok)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
