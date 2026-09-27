import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Breadcrumb,
  PageHeader,
  SectionRule,
  Panel,
  StatCard,
  Tag,
  StatusTag,
  DataTable,
  type Column,
  useTabParam,
  Button,
  ErrorNotice,
} from '../components/bb';
import { useAccountingEntries, useAccountingSummary } from '../hooks/useAccounting';
import { useAuth } from '../context/AuthContext';
import { authedGet } from '../lib/api';
import { useChainAddress, useOwnerAddresses } from '../hooks/useChainWallet';
import type { Transaction } from '../services/accounting';
import { API_BASE_URL } from '../config/constants';
import { getPaymentSymbol, useSettlement } from '../config/settlement';

type Tab = 'transactions' | 'my_agents';

const TABS: { id: Tab; label: string }[] = [
  { id: 'transactions', label: 'Transactions' },
  { id: 'my_agents', label: 'My agents' },
];

type Agent = {
  id: string;
  name: string;
  walletAddress: string;
  status: string;
  inftTokenId?: number;
};

/** One execution tagged with the agent that ran it (executions are keyed by
 *  the agent's own wallet, not the owner EOA, so the page fans out per agent). */
type AgentExecution = {
  agentId: string;
  agentName: string;
  meta: { taskId: string; chain?: string };
  state: { status: string; acceptedAt?: string; submittedAt?: string };
};

/** Work my agents are currently doing (not yet delivered). */
const ASSIGNED_STATUSES = ['accepted', 'in_progress'];
/** Delivered by my agents but not yet settled — the real pending payments. */
const PENDING_PAYMENT_STATUSES = ['submitted', 'awaiting_verification'];

function taskTime(e: AgentExecution): number {
  const t = e.state.submittedAt ?? e.state.acceptedAt;
  const ms = t ? Date.parse(t) : 0;
  return Number.isNaN(ms) ? 0 : ms;
}

function formatCurrency(n: number | null | undefined, symbol: string): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : n > 0 ? '+' : '';
  return `${sign}${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${symbol}`;
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

/** Title Case the tx type for display (payout/fee/slash/…). */
function typeLabel(type: string): string {
  if (!type) return '—';
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function amountClass(n: number): string {
  return n > 0 ? 'text-ok' : n < 0 ? 'text-err' : 'text-ink-3';
}

const PAGE_SIZE = 20;

export default function Earnings() {
  // Re-render when the backend's settlement answer arrives (config/settlement.ts).
  useSettlement();
  const [tab, setTab] = useTabParam<Tab>('transactions', TABS.map((t) => t.id));
  const [txPage, setTxPage] = useState(1);
  const { isAuthenticated } = useAuth();
  const address = useChainAddress();
  const owners = useOwnerAddresses();
  const paymentSymbol = getPaymentSymbol();
  const fmt = (n: number | null | undefined) => formatCurrency(n, paymentSymbol);
  const { data: summary, isLoading: summaryLoading, isError: summaryError, refetch: refetchSummary } = useAccountingSummary();
  const { data: entriesRes, isLoading: entriesLoading, error: entriesError } = useAccountingEntries(undefined, undefined, undefined, txPage, PAGE_SIZE);
  const { data: agents, isLoading: agentsLoading, isError: agentsError, refetch: refetchAgents } = useQuery({
    queryKey: ['agents', owners],
    queryFn: async () => {
      // Throw on failure so react-query surfaces an error state — a silent
      // [] here used to read as "no agents" when the API was down.
      // Every wallet on the account: an agent's owner can be any of them.
      const res = await fetch(`${API_BASE_URL}/api/v1/agents?owner=${owners}`);
      if (!res.ok) throw new Error(`Agents request failed (${res.status})`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Agents request failed');
      return json.data as Agent[];
    },
    enabled: !!owners,
  });

  const entries: Transaction[] = entriesRes?.transactions ?? [];
  const totalEntries = entriesRes?.total ?? 0;
  const totalTxPages = Math.max(1, Math.ceil(totalEntries / PAGE_SIZE));

  // Executions live under each agent's own wallet — fan out one
  // /executions?address= call per deployed agent and merge. Cross-address
  // rows come back projected (no deliverable), which is all a dashboard needs.
  const agentWallets = (agents ?? [])
    .filter((a) => a.walletAddress)
    .map((a) => a.walletAddress.toLowerCase())
    .sort()
    .join(',');
  const {
    data: agentExecutions,
    isLoading: execLoading,
    isError: execError,
    refetch: refetchExec,
  } = useQuery({
    queryKey: ['agent-executions', agentWallets],
    queryFn: async (): Promise<AgentExecution[]> => {
      const lists = await Promise.all(
        (agents ?? []).filter((a) => a.walletAddress).map(async (a) => {
          const d = await authedGet<{ executions?: Array<{ meta: AgentExecution['meta']; state: AgentExecution['state'] }> }>(
            `/api/v1/a2a/executions?address=${a.walletAddress}`,
          );
          return (d.executions ?? []).map((e) => ({
            agentId: a.id,
            agentName: a.name,
            meta: e.meta,
            state: e.state,
          }));
        }),
      );
      return lists.flat();
    },
    // Authed fan-out — needs a signed-in session, not just a connected wallet.
    enabled: isAuthenticated && !!address && !!agents,
  });

  const executions = agentExecutions ?? [];
  const assigned = executions
    .filter((e) => ASSIGNED_STATUSES.includes(e.state.status))
    .sort((a, b) => taskTime(b) - taskTime(a));
  const pendingTasks = executions
    .filter((e) => PENDING_PAYMENT_STATUSES.includes(e.state.status))
    .sort((a, b) => taskTime(b) - taskTime(a));

  const taskCell = (e: AgentExecution) => (
    <Link to={`/tasks/${e.meta.taskId}`} className="font-mono text-ink-2 hover:text-ink transition-colors">
      {shortHash(e.meta.taskId)}
    </Link>
  );

  const assignedColumns: Column<AgentExecution>[] = [
    {
      key: 'task',
      header: 'Task',
      width: '130px',
      primary: true,
      cell: taskCell,
    },
    {
      key: 'agent',
      header: 'Agent',
      width: '1fr',
      cell: (e) => <span className="font-semibold text-ink truncate">{e.agentName}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: '130px',
      cell: (e) => <StatusTag status={e.state.status} />,
    },
    {
      key: 'accepted',
      header: 'Accepted',
      width: '110px',
      align: 'right',
      cell: (e) => (
        <span className="font-mono text-ink-3">{e.state.acceptedAt ? formatTime(e.state.acceptedAt) : '—'}</span>
      ),
    },
  ];

  const pendingTaskColumns: Column<AgentExecution>[] = [
    {
      key: 'task',
      header: 'Task',
      width: '130px',
      primary: true,
      cell: taskCell,
    },
    {
      key: 'agent',
      header: 'Agent',
      width: '1fr',
      cell: (e) => <span className="font-semibold text-ink truncate">{e.agentName}</span>,
    },
    {
      key: 'submitted',
      header: 'Submitted',
      width: '110px',
      cell: (e) => (
        <span className="font-mono text-ink-3">{e.state.submittedAt ? formatTime(e.state.submittedAt) : '—'}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '130px',
      trailing: true,
      align: 'right',
      cell: (e) => <StatusTag status={e.state.status} />,
    },
  ];

  const txColumns: Column<Transaction>[] = [
    {
      key: 'time',
      header: 'Time',
      width: '110px',
      primary: true,
      cell: (tx) => <span className="font-mono text-ink-2">{formatTime(tx.created_at)}</span>,
    },
    {
      key: 'type',
      header: 'Type',
      width: '100px',
      cell: (tx) => <Tag tone={typeTone(tx.type)}>{typeLabel(tx.type)}</Tag>,
    },
    {
      key: 'ref',
      header: 'Ref',
      width: '70px',
      cell: (tx) => <span className="font-mono text-ink-3">{tx.task_id ? `#${tx.task_id}` : '—'}</span>,
    },
    {
      key: 'amount',
      header: 'Amount',
      width: '120px',
      align: 'right',
      cell: (tx) => <span className={`font-mono font-semibold ${amountClass(tx.amount)}`}>{fmt(tx.amount)}</span>,
    },
    {
      key: 'net',
      header: 'Net',
      width: '110px',
      align: 'right',
      cell: (tx) => <span className="font-mono text-ink-3">{fmt(tx.net)}</span>,
    },
    {
      key: 'tx',
      header: 'Tx hash',
      width: '1fr',
      cell: (tx) => <span className="font-mono text-ink-3">{shortHash(tx.tx_hash)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: '90px',
      trailing: true,
      align: 'right',
      cell: (tx) => <StatusTag status={tx.status} />,
    },
  ];

  const agentColumns: Column<Agent>[] = [
    {
      key: 'agent',
      header: 'Agent',
      width: '1fr',
      primary: true,
      cell: (a) => <span className="font-semibold text-ink">{a.name}</span>,
    },
    {
      key: 'wallet',
      header: 'Wallet',
      width: '160px',
      cell: (a) => (
        <span className="font-mono text-ink-3">
          {a.walletAddress ? `${a.walletAddress.slice(0, 8)}…${a.walletAddress.slice(-4)}` : '—'}
        </span>
      ),
    },
    {
      key: 'inft',
      header: 'INFT',
      width: '100px',
      cell: (a) => <span className="font-mono text-ink-3">{a.inftTokenId != null ? `#${a.inftTokenId}` : '—'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: '90px',
      trailing: true,
      align: 'right',
      cell: (a) => <StatusTag status={a.status} />,
    },
  ];

  return (
    <div>
      <Breadcrumb items={['account', 'earnings']} />
      <PageHeader
        title="Earnings."
        titleMuted="What your agents earned."
      />

      {!isAuthenticated && (
        <div className="mb-6 rounded-2xl border border-line bg-surface-2 px-5 py-3 text-[13px] text-ink-3 leading-relaxed">
          Connect your wallet to see your earnings. Showing anonymized totals only.
        </div>
      )}

      {/* Summary fetch failed — say so instead of dashes that read as zero. */}
      {summaryError && (
        <div className="mb-4 rounded-2xl border border-[color-mix(in_srgb,var(--bb-err)_40%,transparent)] bg-[color-mix(in_srgb,var(--bb-err)_6%,transparent)] px-5 py-3 flex items-center justify-between gap-3 text-sm text-ink-2">
          <span>Couldn't load the earnings summary.</span>
          <Button variant="outline" size="sm" label="Retry" onClick={() => refetchSummary()} />
        </div>
      )}

      {/* Stat cards — live from accounting API */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
        <StatCard
          className="h-full"
          label="Total earned"
          value={summaryLoading ? '…' : fmt(summary?.totalEarned)}
          sub={summary && summary.taskCount > 0 ? `${summary.taskCount} tasks` : 'Across all time'}
        />
        <StatCard
          className="h-full"
          label="Net revenue"
          value={summaryLoading ? '…' : fmt(summary?.netRevenue)}
          sub="After fees"
          subColor="ok"
        />
        <StatCard
          className="h-full"
          label="Total fees"
          value={summaryLoading ? '…' : fmt(summary?.totalFees)}
          sub="10% platform"
          subColor="warn"
        />
        <StatCard
          className="h-full"
          label="Pending"
          value={execLoading && !!address ? '…' : String(pendingTasks.length)}
          sub="Awaiting settlement"
          subColor={pendingTasks.length > 0 ? 'warn' : 'ok'}
        />
      </div>

      {/* Tabs */}
      <div role="tablist" className="flex gap-5 sm:gap-7 border-b border-line mb-8 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`pb-3 -mb-px text-[14px] sm:text-[15px] border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              tab === t.id
                ? 'text-ink font-medium border-ink'
                : 'text-ink-3 border-transparent hover:text-ink-2'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'my_agents' ? (
        <Panel>
          <SectionRule num="01" title="My agents" side={`${agents?.length ?? 0} deployed`} />
          <div className="mt-4">
            <DataTable<Agent>
              columns={agentColumns}
              rows={address ? agents : []}
              rowKey={(a) => a.id}
              loading={agentsLoading}
              loadingLabel="Loading agents…"
              error={agentsError}
              onRetry={() => refetchAgents()}
              empty={
                !address
                  ? {
                      icon: 'wallet',
                      title: 'Connect your wallet',
                      description: 'Connect a wallet to see the agents you’ve deployed.',
                    }
                  : {
                      icon: 'user',
                      title: 'No agents deployed',
                      description: 'Deploy one, or register your wallet as an executor with the CLI: blind login, then blind register-executor',
                    }
              }
            />
          </div>
        </Panel>
      ) : (
        <>
          {/* Assigned tasks — work my agents are currently doing */}
          <div className="mb-8">
            <SectionRule num="01" title="Assigned tasks" side={`${assigned.length} active`} />
            <div className="mt-4">
              <DataTable<AgentExecution>
                columns={assignedColumns}
                rows={address ? assigned : []}
                rowKey={(e) => `${e.agentId}:${e.meta.taskId}`}
                loading={execLoading}
                loadingLabel="Loading assigned tasks…"
                error={execError}
                onRetry={() => refetchExec()}
                empty={
                  !address
                    ? {
                        icon: 'wallet',
                        title: 'Connect your wallet',
                        description: 'Connect a wallet to see the tasks your agents are working on.',
                      }
                    : {
                        icon: 'briefcase',
                        title: 'No assigned tasks',
                        description: 'Tasks your agents accept will appear here until they deliver.',
                      }
                }
              />
            </div>
          </div>

          {/* Pending payments — delivered by my agents, awaiting settlement */}
          <div className="mb-8">
            <SectionRule num="02" title="Pending payments" side={`${pendingTasks.length}`} />
            <div className="mt-4">
              <DataTable<AgentExecution>
                columns={pendingTaskColumns}
                rows={address ? pendingTasks : []}
                rowKey={(e) => `${e.agentId}:${e.meta.taskId}`}
                loading={execLoading}
                loadingLabel="Loading payments…"
                error={execError}
                onRetry={() => refetchExec()}
                empty={
                  !address
                    ? {
                        icon: 'wallet',
                        title: 'Connect your wallet',
                        description: 'Connect a wallet to see work awaiting settlement.',
                      }
                    : {
                        icon: 'clock',
                        title: 'No pending payments',
                        description: 'Delivered work awaiting settlement appears here. Settled payouts land in the log below.',
                      }
                }
              />
            </div>
          </div>

          {/* Transaction log */}
          <Panel>
            <SectionRule num="03" title="Transaction log" side={`${totalEntries} entries`} />
            <div className="mt-4">
              {entriesError ? (
                <ErrorNotice error={entriesError} title="Couldn't load the transaction log" />
              ) : (
                <DataTable<Transaction>
                  columns={txColumns}
                  rows={entries}
                  rowKey={(tx) => String(tx.id)}
                  loading={entriesLoading}
                  loadingLabel="Loading transactions…"
                  empty={{
                    icon: 'chart',
                    title: 'No transactions yet',
                    description: 'Complete or post a task to begin building your ledger.',
                  }}
                />
              )}
            </div>
            {totalTxPages > 1 && (
              <div className="flex items-center justify-between px-5 py-3 border-t border-line text-xs text-ink-3">
                <span>Page {txPage} of {totalTxPages}</span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    label="Previous"
                    onClick={() => setTxPage(p => Math.max(1, p - 1))}
                    disabled={txPage <= 1}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    label="Next"
                    onClick={() => setTxPage(p => Math.min(totalTxPages, p + 1))}
                    disabled={txPage >= totalTxPages}
                  />
                </div>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
