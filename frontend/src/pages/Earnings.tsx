import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useQuery } from '@tanstack/react-query';
import {
  Breadcrumb,
  PageHeader,
  SectionRule,
  Panel,
  StatCard,
  Tag,
} from '../components/bb';
import { useAccountingEntries, useAccountingSummary } from '../hooks/useAccounting';
import { useAuth } from '../context/AuthContext';
import type { Transaction } from '../services/accounting';

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const delta = Date.now() - d.getTime();
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

function shortHash(h: string | null): string {
  if (!h) return '—';
  const s = h.replace(/^0x/, '');
  return `0x${s.slice(0, 4)}…${s.slice(-4)}`;
}

function typeTone(type: string): 'err' | 'warn' | 'neutral' | 'ok' {
  if (type === 'slash') return 'err';
  if (type === 'fee') return 'warn';
  if (type === 'payout') return 'ok';
  return 'neutral';
}

export default function Earnings() {
  const [tab, setTab] = useState<'transactions' | 'my_agents'>('transactions');
  const { isAuthenticated } = useAuth();
  const { address } = useAccount();
  const { data: summary, isLoading: summaryLoading } = useAccountingSummary();
  const { data: entriesRes, isLoading: entriesLoading, error: entriesError } = useAccountingEntries();
  const { data: agents } = useQuery({
    queryKey: ['agents', address],
    queryFn: async () => {
      const res = await fetch(`/api/v1/agents?owner=${address}`);
      const json = await res.json();
      return json.success ? json.data as Array<{ id: string; name: string; walletAddress: string; status: string; inftTokenId?: number }> : [];
    },
    enabled: !!address,
  });

  const entries: Transaction[] = entriesRes?.transactions ?? [];
  const pending = entries.filter((e) => e.status === 'pending');

  return (
    <div>
      <Breadcrumb items={['account', 'earnings']} />
      <PageHeader
        title="Earnings"
        description="Wallet balance · payouts · withdrawal history."
      />

      {!isAuthenticated && (
        <div className="mb-6 px-4 py-3 border border-line bg-surface-2 text-xs font-mono text-ink-3">
          connect your wallet to see your earnings. showing anonymized totals only.
        </div>
      )}

      {/* Stat cards — live from accounting API */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 border border-line mb-8">
        <StatCard
          label="total earned"
          value={summaryLoading ? '…' : formatUsd(summary?.totalEarned)}
          sub={summary && summary.taskCount > 0 ? `${summary.taskCount} tasks` : 'across all time'}
        />
        <div className="border-l border-line">
          <StatCard
            label="net revenue"
            value={summaryLoading ? '…' : formatUsd(summary?.netRevenue)}
            sub="after fees"
            subColor="ok"
          />
        </div>
        <div className="border-l border-line">
          <StatCard
            label="total fees"
            value={summaryLoading ? '…' : formatUsd(summary?.totalFees)}
            sub="15% platform"
            subColor="warn"
          />
        </div>
        <div className="border-l border-line">
          <StatCard
            label="pending"
            value={String(pending.length)}
            sub="unresolved"
            subColor={pending.length > 0 ? 'warn' : 'ok'}
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-6 border-b border-line mb-8">
        {(['transactions', 'my_agents'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`pb-2.5 text-xs font-mono font-semibold tracking-widest transition-colors border-b -mb-px ${tab === t ? 'text-cream border-cream' : 'text-ink-3 border-transparent hover:text-ink-2'}`}>
            {tab === t ? '▸ ' : ''}{t}
          </button>
        ))}
      </div>

      {tab === 'my_agents' ? (
        <Panel>
          <SectionRule num="01" title="my agents" side={`${agents?.length ?? 0} deployed`} />
          <div className="mt-4 border border-line">
            {!address ? (
              <div className="px-5 py-8 text-center text-xs font-mono text-ink-3">connect wallet to see your agents</div>
            ) : !agents || agents.length === 0 ? (
              <div className="px-5 py-8 text-center text-xs font-mono text-ink-3">no agents deployed. run <code className="text-cream">blind register --name my-agent</code></div>
            ) : (
              <>
                <div className="grid grid-cols-[1fr_160px_100px_80px] gap-4 px-5 py-3 border-b border-line text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3">
                  <span>agent</span><span>wallet</span><span>inft</span><span>status</span>
                </div>
                {agents.map((agent) => (
                  <div key={agent.id} className="grid grid-cols-[1fr_160px_100px_80px] gap-4 px-5 py-4 border-b border-line last:border-b-0 text-[13px] font-mono items-center">
                    <span className="text-ink font-semibold">{agent.name}</span>
                    <span className="text-ink-3 text-xs truncate">{agent.walletAddress.slice(0, 8)}…{agent.walletAddress.slice(-4)}</span>
                    <span className="text-ink-3 text-xs">{agent.inftTokenId != null ? `#${agent.inftTokenId}` : '—'}</span>
                    <Tag tone={agent.status === 'running' ? 'ok' : agent.status === 'paused' ? 'warn' : 'neutral'}>
                      {agent.status}
                    </Tag>
                  </div>
                ))}
              </>
            )}
          </div>
        </Panel>
      ) : (
        <>
      {/* Pending payments */}
      <div className="border border-line mb-8">
        <div className="px-5 py-3 border-b border-line flex items-center justify-between">
          <span className="text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3">
            pending payments · {pending.length}
          </span>
        </div>
        {pending.length === 0 ? (
          <div className="px-5 py-8 text-center text-xs font-mono text-ink-3">
            {entriesLoading ? 'loading…' : 'no pending payments.'}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[80px_100px_100px_100px_1fr_100px] gap-4 px-5 py-3 border-b border-line text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3">
              <span>task</span>
              <span>type</span>
              <span>amount</span>
              <span>fee</span>
              <span>tx_hash</span>
              <span>submitted</span>
            </div>
            {pending.map((p) => (
              <div
                key={p.id}
                className="grid grid-cols-[80px_100px_100px_100px_1fr_100px] gap-4 px-5 py-4 border-b border-line last:border-b-0 text-[13px] font-mono"
              >
                <span className="text-ink-3">{p.task_id ? `#${p.task_id}` : '—'}</span>
                <Tag tone={typeTone(p.type)}>{p.type}</Tag>
                <span className="text-ink font-semibold">{formatUsd(p.amount)}</span>
                <span className="text-ink-3">{formatUsd(p.fee)}</span>
                <span className="text-ink-3 truncate">{shortHash(p.tx_hash)}</span>
                <span className="text-ink-3">{formatTime(p.created_at)}</span>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Transaction log */}
      <Panel>
        <SectionRule num="01" title="transaction log" side={`${entries.length} entries`} />
        <div className="mt-4 border border-line">
          {entriesError && (
            <div className="px-5 py-8 text-center text-xs font-mono text-err break-all">
              failed to load accounting: {(entriesError as Error).message}
            </div>
          )}
          {!entriesError && entries.length === 0 && (
            <div className="px-5 py-8 text-center text-xs font-mono text-ink-3">
              {entriesLoading ? 'loading…' : 'no transactions yet. complete or post a task to begin.'}
            </div>
          )}
          {entries.length > 0 && (
            <>
              <div className="grid grid-cols-[100px_90px_60px_100px_90px_1fr_80px] gap-4 px-5 py-3 border-b border-line text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3">
                <span>time</span>
                <span>type</span>
                <span>ref</span>
                <span>amount</span>
                <span>net</span>
                <span>tx_hash</span>
                <span>status</span>
              </div>
              {entries.map((tx) => (
                <div
                  key={tx.id}
                  className="grid grid-cols-[100px_90px_60px_100px_90px_1fr_80px] gap-4 px-5 py-3 border-b border-line last:border-b-0 text-[12px] font-mono"
                >
                  <span className="text-ink-3">{formatTime(tx.created_at)}</span>
                  <Tag tone={typeTone(tx.type)}>{tx.type}</Tag>
                  <span className="text-ink-3 truncate">{tx.task_id ? `#${tx.task_id}` : '—'}</span>
                  <span className={tx.amount > 0 ? 'text-ok' : tx.amount < 0 ? 'text-err' : 'text-ink-3'}>
                    {formatUsd(tx.amount)}
                  </span>
                  <span className="text-ink-3">{formatUsd(tx.net)}</span>
                  <span className="text-ink-3 truncate">{shortHash(tx.tx_hash)}</span>
                  <Tag tone={tx.status === 'ok' ? 'ok' : tx.status === 'pending' ? 'warn' : 'err'}>
                    ● {tx.status}
                  </Tag>
                </div>
              ))}
            </>
          )}
        </div>
      </Panel>
        </>
      )}
    </div>
  );
}
