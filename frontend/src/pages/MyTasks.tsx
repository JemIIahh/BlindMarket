import { useState } from 'react';
import { useAccount } from 'wagmi';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
} from '../components/bb';
import { useSocket } from '../hooks/useSocket';
import { useBidWatcher } from '../hooks/useBidWatcher';
import { authedGet } from '../lib/api';
import { getAesKey } from '../lib/keyStash';

// ── Shapes returned by GET /api/v1/a2a/tasks/posted ──────────────────────
//
// The backend enriches each Redis-side task with its on-chain record so we
// have status + reward + worker in a single call. `onChain` is null when the
// task hasn't been indexed yet (createTask in flight) or never confirmed.

interface PostedTask {
  meta: {
    taskId: string;           // taskHash, bytes32 hex
    targetExecutorType: 'agent' | 'human';
    verificationMode: 'manual' | 'auto' | 'oracle' | 'agent';
    requiredCapabilities: string[];
    posterAddress?: string;
    verifierAddress?: string;
    rootHash?: string;
  };
  state: {
    taskId: string;
    status: 'open' | 'accepted' | 'submitted' | 'awaiting_verification' | 'verified' | 'failed' | 'in_progress';
    executorAddress?: string;
    acceptedAt?: string;
    submittedAt?: string;
    resultData?: Record<string, unknown>;
    verificationResult?: { passed: boolean; reasons?: string[] };
  };
  // Count of executors the brief's AES key is ECIES-wrapped to and persisted
  // server-side. 0 on an open encrypted task = the key exists only in a
  // browser's localStorage (the "key at risk" state). Added by GET /tasks/posted.
  wrapCount?: number;
  // Whether the brief AES key is also sealed to platform key-custody. If true,
  // the key is recoverable server-side via re-wrap even at wrapCount 0, so the
  // task is NOT "key at risk" (docs/TEE-REWRAP-SPEC.md). Added by /tasks/posted.
  hasCustody?: boolean;
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

// On-chain status enum → status string. StatusTag derives the chip colour
// semantically from this string, so we no longer hand-map status → tone.
const STATUS_LABELS: Record<number, string> = {
  0: 'open', 1: 'assigned', 2: 'submitted', 3: 'verified', 4: 'completed', 5: 'cancelled', 6: 'disputed',
};

// The marketplace settles every task in native 0G (18 decimals) on both
// mainnet and testnet — see MARKETPLACE_TOKEN_ADDRESS in config/constants.ts.
// If a whitelisted ERC-20 is ever added, this (and `sumRewards` below) must
// switch on `onChain.token` for the right decimals/symbol.
const NATIVE_DECIMALS = 18;
const NATIVE_SYMBOL = '0G';

// Convert a raw uint256 reward (wei, as string) to a 0G number. Uses
// `formatUnits` rather than `Number(BigInt(raw)) / 1e18` because a single 0G is
// 1e18 wei, which exceeds Number.MAX_SAFE_INTEGER (~9.007e15) — the old path
// silently lost low-order digits for any amount ≳ 0.009 0G.
function rewardToNumber(raw: string | undefined): number {
  if (!raw) return 0;
  try {
    return Number(formatUnits(BigInt(raw), NATIVE_DECIMALS));
  } catch {
    return 0;
  }
}

function formatReward(raw: string | undefined) {
  if (!raw) return '—';
  try {
    const n = rewardToNumber(raw);
    return `${n.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${NATIVE_SYMBOL}`;
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
// Returns the short address (mono) when assigned, or null when unassigned so
// the card can show a plain "No worker yet" hint in sans.
function workerAddress(t: PostedTask): string | null {
  const w = t.onChain?.worker;
  if (!w || /^0x0+$/.test(w)) return null;
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
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
  const { data: tasks = [], isLoading, isError, refetch } = useQuery<PostedTask[]>({
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
      case 'submitted': case 'awaiting_verification': return 2;
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
      // Compare rewards as BigInt — they're uint256 wei, well past the safe
      // integer range, so Number() coercion could mis-order near-equal amounts.
      const rewardWei = (t: PostedTask) => (t.onChain ? BigInt(t.onChain.reward) : 0n);
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

  const openCount = tasks.filter(t => effectiveStatus(t) === 0).length;
  const activeCount = tasks.filter(t => [1, 2].includes(effectiveStatus(t))).length;
  const completedCount = tasks.filter(t => effectiveStatus(t) === 4).length;
  // "Total spent" = gross 0G that has irreversibly left the poster — i.e. the
  // full escrowed amount (worker share + 15% platform fee) of tasks that
  // reached on-chain status Completed (4). Active/open tasks are deliberately
  // excluded: their escrow is still refundable on cancel/timeout/dispute, so it
  // isn't "spent" yet. Summed as BigInt wei, then formatted once, to avoid the
  // per-task Number() precision loss above 0.009 0G.
  const completedTasks = tasks.filter(t => effectiveStatus(t) === 4);
  const totalSpentWei = completedTasks.reduce(
    (s, t) => s + (t.onChain ? BigInt(t.onChain.reward) : 0n),
    0n,
  );
  const totalSpent = Number(formatUnits(totalSpentWei, NATIVE_DECIMALS));

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

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 border border-line mb-8">
        <StatCard label="Open" value={String(openCount)} sub="Awaiting worker" />
        <div className="border-l border-line"><StatCard label="Active" value={String(activeCount)} sub="In progress" subColor="warn" /></div>
        <div className="border-t border-l-0 sm:border-t-0 sm:border-l border-line"><StatCard label="Completed" value={String(completedCount)} sub="All time" subColor="ok" /></div>
        <div className="border-t border-l border-line sm:border-t-0"><StatCard label="Total spent" value={`${totalSpent.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${NATIVE_SYMBOL}`} sub="Paid out on completed tasks" /></div>
      </div>

      <div className="border border-line">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between bg-surface-2 px-4 pt-4 lg:pt-0">
          <SectionRule num="01" title="Posted tasks" side={`${filteredTasks.length} shown / ${tasks.length} total`} className="mb-0 flex-1 lg:py-4" />
          <div className="flex flex-wrap gap-2 pb-4 lg:pb-0">
            {FILTERS.map(f => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
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
                onClick={() => setSort(s.id)}
                className={`text-[11px] px-2.5 py-1 border transition-colors ${
                  sort === s.id ? 'bg-cream text-bg border-cream' : 'text-ink-3 border-line hover:border-cream/50'
                }`}
              >
                {s.label}
              </button>
            ))}
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
        ) : filteredTasks.length === 0 ? (
          <EmptyState
            icon="briefcase"
            title={filter === 'all' ? 'No tasks posted yet' : `No ${filter} tasks`}
            description={
              filter === 'all'
                ? 'Post a task and it will show up here so you can track its status, assignment, and result.'
                : 'Try a different filter, or post a new task.'
            }
            action={
              <Link to="/tasks/new">
                <Button variant="outline" label="Post a task" size="sm" />
              </Link>
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-line border-t border-line">
            {filteredTasks.map(t => {
              const status = effectiveStatus(t);
              const statusLabel = STATUS_LABELS[status] ?? 'open';
              const isDone = status === 3 || status === 4 || status === 6;
              const hasResult = !!t.state.resultData;
              const reasons = t.state.verificationResult;
              const failedReasons =
                reasons?.passed === false && reasons.reasons && reasons.reasons.length > 0
                  ? reasons.reasons
                  : null;
              // "Key at risk": an open, encrypted task whose AES key has not
              // been wrapped to any executor server-side AND isn't sealed to
              // key-custody. The only copy is then in a browser's localStorage —
              // if that's cleared before an agent is wrapped, the brief becomes
              // permanently undecryptable. A custody-sealed task (hasCustody) is
              // recoverable server-side via re-wrap, so it's NOT at risk even at
              // wrapCount 0. keyHere tells us whether THIS browser still holds
              // the key (recoverable but fragile) or not.
              const keyAtRisk =
                status === 0 && !!t.meta.rootHash && (t.wrapCount ?? 0) === 0 && !t.hasCustody;
              const keyHere = keyAtRisk && !!getAesKey(t.meta.taskId);
              const taskId = t.onChain?.taskId || t.meta.taskId;
              const taskUrl = `/tasks/${taskId}`;
              const worker = workerAddress(t);
              const cardClass = `bg-bg p-5 flex flex-col gap-3 min-h-[200px] group hover:bg-surface-2 transition-colors cursor-pointer`;
              const cardContent = (
                <>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-mono text-ink-3">{shortId(t)}</span>
                    <StatusTag status={statusLabel} />
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-mono text-ink break-all">{t.meta.taskId.slice(0, 18)}…</div>
                    <div className="text-[11px] text-ink-3 mt-1 capitalize">
                      {t.meta.verificationMode} verify · {t.meta.targetExecutorType}
                    </div>
                    {t.meta.requiredCapabilities && t.meta.requiredCapabilities.length > 0 && (
                      <div className="flex gap-1 mt-2 flex-wrap">
                        {t.meta.requiredCapabilities.slice(0, 4).map(c => (
                          <Tag key={c} tone="neutral">{c.replace(/_/g, ' ')}</Tag>
                        ))}
                      </div>
                    )}
                    {failedReasons && (
                      <div className="mt-2 text-[11px] text-err leading-relaxed">
                        Failed: {failedReasons.join(' · ')}
                      </div>
                    )}
                    {keyAtRisk && (
                      <div
                        className={`mt-2 flex items-center gap-1.5 border-l-2 pl-2 py-0.5 text-[11px] leading-snug ${
                          keyHere ? 'border-warn text-warn' : 'border-err text-err'
                        }`}
                        onClick={(e) => e.preventDefault()}
                        title={keyHere
                          ? 'The encryption key for this task is only in this browser. Register a matching agent and keep this page open so the key gets wrapped to it. Clearing this browser before then loses the key permanently.'
                          : 'The encryption key is not on the server and not in this browser. Recover it from the device you posted from, or repost — it cannot be decrypted from here.'}
                      >
                        <Icon name="lock" size={12} className="shrink-0" />
                        <span>
                          Key at risk — {keyHere ? 'only copy is in this browser' : 'not on server or this browser'}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="pt-3 border-t border-line flex items-end justify-between">
                    <div>
                      <div className="text-lg font-mono font-semibold text-cream leading-none">
                        {formatReward(t.onChain?.reward)}
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
                    <details className="mt-1 border-t border-line pt-3 group/details" onClick={e => e.preventDefault()}>
                      <summary className="flex items-center justify-between cursor-pointer text-[11px] text-ink-3 hover:text-cream transition-colors list-none">
                        <span>View result</span>
                        <span className="group-open/details:rotate-90 transition-transform">▸</span>
                      </summary>
                      {hasResult ? (
                        <pre className="mt-3 max-h-72 overflow-auto bg-surface-2 border border-line p-3 text-[11px] font-mono text-ink leading-relaxed whitespace-pre-wrap break-words">
                          {JSON.stringify(t.state.resultData, null, 2)}
                        </pre>
                      ) : (
                        <div className="mt-3 text-[11px] text-ink-3 leading-relaxed">
                          No result data on file.
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
