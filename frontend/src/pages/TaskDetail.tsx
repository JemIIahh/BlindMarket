import { useParams, Link, useLocation, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { motion } from 'framer-motion';

import { useTask } from '../hooks/useTasks';
import { useWallet } from '../context/WalletContext';
import { useAuth } from '../context/AuthContext';
import { Panel, SectionRule, Tag, Button, StatusTag, Skeleton, ErrorState, ErrorNotice, useTabParam, ConfirmDialog } from '../components/bb';
import { EncryptionIndicator } from '../components/EncryptionIndicator';
import { Markdown } from '../components/Markdown';
import { RateAgent } from '../components/RateAgent';
import { TxPendingModal } from '../components/TxPendingModal';
import { CustodyChain } from '../components/CustodyChain';
import { truncateAddress, formatDate } from '../lib/utils';
import { useRefundEscrow } from '../hooks/useRefundEscrow';
import { timeoutSendsForReview } from '../lib/refund';
import { WORKER_SHARE_PCT, PLATFORM_FEE_PCT } from '../config/constants';
import { unitFor, useSettlement } from '../config/settlement';
import { useChainExplorerUrl } from '../hooks/useChainWallet';
import { isDirectSigned } from '../lib/txSigner';
import { TaskStatus, TaskStatusLabels } from '../types/api';
import type { A2ATaskMeta } from '../types/api';
import { normalizeBrief, splitBrief } from '../lib/briefText';
import { PosterAvatar, type AvatarConfig } from '../components/avatar/PosterAvatar';

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5 } },
};

type DetailTab = 'details' | 'custody';

const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'custody', label: 'Custody' },
];

/**
 * Explorer search URL for an arbitrary hash (task hash, evidence hash).
 * Basescan and the 0G chainscan (Blockscout) use different search paths.
 */
function explorerSearchUrl(explorerBase: string, isBase: boolean, query: string): string {
  return isBase
    ? `${explorerBase}/search?f=0&q=${query}`
    : `${explorerBase}/search?q=${query}`;
}

/** Small 2-col field: sans label, value styled by caller (mono for data). */
function Field({
  label,
  children,
  span2 = false,
}: {
  label: string;
  children: React.ReactNode;
  span2?: boolean;
}) {
  return (
    <div className={span2 ? 'min-w-0 sm:col-span-2' : 'min-w-0'}>
      <span className="text-[11px] text-ink-3 tracking-wide">{label}</span>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export default function TaskDetail() {
  // Re-render when the backend's settlement answer arrives (config/settlement.ts).
  useSettlement();
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { data, isLoading, isError, refetch } = useTask(id || '');
  const { address, embeddedAddress, externalAddresses } = useWallet();
  // The backend names the escrow's chain on the detail response — Arc tasks
  // explore on ArcScan.
  const explorerUrl = useChainExplorerUrl('arc');
  // Auth context kept for any future reads; not used in the A2A view path.
  void useAuth();
  const [activeTab, setActiveTab] = useTabParam<DetailTab>('details', DETAIL_TABS.map((t) => t.id));
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'timeout' | null>(null);

  // Cancel / claim timeout, signed by the wallet that posted the task (see
  // useRefundEscrow). React Query surfaces a failure (auth, server, rejected
  // signature) instead of an unhandled promise. The page URL carries the task
  // hash; the refund routes take the numeric on-chain id (numericTaskId below).
  const refund = useRefundEscrow();
  const txPending = refund.isPending;
  const txError = refund.error;

  if (isError && !data) {
    return (
      <div className="max-w-3xl mx-auto py-12">
        <ErrorState title="Couldn't load this task" onRetry={() => refetch()} />
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <Skeleton className="h-10 w-3/5 rounded-lg" />
        <Skeleton className="h-52 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  const { onChain, meta } = data;
  // Numeric id for the cancel/timeout endpoints (they take the on-chain id,
  // not the hash the URL carries). The backend always includes it.
  const numericTaskId = onChain.taskId || id;
  // `onChain.agent` is the contract's name for the task poster — keep the
  // boolean named isPoster to make the intent clear in UI conditions.
  // Any of the account's wallets: a task posted from a linked external wallet
  // is the user's too, while `address` is the embedded one.
  const myWallets = new Set([address, embeddedAddress, ...externalAddresses].filter((a): a is string => !!a).map((a) => a.toLowerCase()));
  const isPoster = !!onChain.agent && myWallets.has(onChain.agent.toLowerCase());
  // The refund also shows when the connected wallet funded the escrow but
  // isn't linked to the account: the escrow pays back only the wallet that
  // funded it, and without this such a task (which the backend won't list)
  // had no way back from the site.
  const canRefund = isPoster || (refund.canSignAs(onChain.agent) && isDirectSigned(onChain.chain));
  const startRefund = (kind: 'cancel' | 'timeout') =>
    refund.mutate({ taskId: String(numericTaskId), chain: onChain.chain, poster: onChain.agent, kind, linked: isPoster });
  // The unit this task's reward is in: what the backend read from the
  // escrow (symbol + decimals), else the task's chain's settlement token.
  // Not the posting chain's unit — a poster's old 0G task is still in 0G.
  const unit = unitFor(onChain.chain, { symbol: onChain.symbol, decimals: meta.decimals ?? onChain.decimals });
  const decimals = unit.decimals;
  // meta.reward can be absent on partial/undecryptable metas — render 0
  // rather than "NaN 0G" in the page's hero number.
  const rewardRaw = Number(meta.reward);
  const reward = Number.isFinite(rewardRaw) ? rewardRaw / 10 ** decimals : 0;

  const a2aState = onChain.a2aState;

  const isExpired = Date.now() > Number(onChain.deadline) * 1000;
  const canTimeout = isExpired && [
    TaskStatus.Assigned,
    TaskStatus.Submitted,
    TaskStatus.Verified
  ].includes(onChain.status);
  // Delivered, unjudged work: the timeout sends it for review, it is not refunded.
  const sendsForReview = timeoutSendsForReview(onChain.status);

  const taskLabel = onChain.taskId || id?.slice(0, 10);
  const backTo = isPoster ? '/tasks/mine' : '/a2a';
  const backLabel = isPoster ? 'My tasks' : 'Marketplace';
  // The escrow stores a zero hash until the worker submits evidence.
  const hasEvidence = !!onChain.evidenceHash && !/^(0x)?0*$/i.test(onChain.evidenceHash);

  // What the task is, in the poster's words: a public task's brief (its first
  // line heads the page), or the routing summary a private task shows in
  // place of its sealed brief.
  const a2aMeta = onChain.a2aMeta as (A2ATaskMeta & { routingSummary?: string; posterAvatar?: AvatarConfig | null }) | undefined;
  const isPublicTask = a2aMeta?.privacy === 'public';
  const brief = isPublicTask ? normalizeBrief(a2aMeta?.publicBrief) : '';
  const headline = splitBrief(isPublicTask ? brief : a2aMeta?.routingSummary).title;
  const taskTags = (a2aMeta?.requiredCapabilities ?? []).filter(Boolean);
  // 'general' is what the web app posts for every task; 'unknown' means none.
  const category = meta.category && !['unknown', 'general'].includes(meta.category) ? meta.category : null;

  return (
    <>
    <motion.div initial="hidden" animate="visible" variants={fadeUp} className="max-w-3xl mx-auto">
      <TxPendingModal open={txPending} />

      {/* Breadcrumb — context-aware:
          • posters land back on their My tasks list
          • everyone else lands on the Marketplace (where they'd browse tasks)
          This matches the post-pivot IA: '/tasks' as a single bucket no longer
          exists, so the breadcrumb routes to whichever section the viewer
          actually belongs in. Kept as a custom nav (not the shared Breadcrumb)
          because the first crumb must be a working deep link. */}
      <div className="flex items-center justify-between gap-3 mb-6">
        <nav className="flex items-center flex-wrap gap-x-2 gap-y-1 text-xs text-ink-3 min-w-0">
          <Link
            to={backTo}
            className="hover:text-accent transition-colors"
          >
            {backLabel}
          </Link>
          <span className="text-line-2">/</span>
          <span className="text-ink-2">Task #{taskLabel}</span>
        </nav>
        {/* Back to where the viewer came from — the same marketplace page and
            filter, since those live in its URL. Opened from a link with no
            in-app history (key 'default'), it goes to the breadcrumb's list. */}
        <Button
          variant="outline"
          size="sm"
          label="← Back"
          aria-label={`Back to ${backLabel}`}
          className="shrink-0"
          onClick={() => (location.key !== 'default' ? navigate(-1) : navigate(backTo))}
        />
      </div>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
        <div className="min-w-0">
          {headline ? (
            <>
              <div className="flex items-center gap-2.5 mb-4 flex-wrap">
                <span className="font-mono text-[11px] uppercase tracking-widest text-ink-3">
                  Task {onChain.taskId ? `#${onChain.taskId}` : `${id?.slice(0, 10)}…`}
                </span>
                <StatusTag status={TaskStatusLabels[onChain.status]} />
              </div>
              <h1
                className={`${headline.length > 70 ? 'text-[26px] sm:text-[32px]' : 'text-[32px] sm:text-[42px]'} font-medium text-ink leading-[1.08] tracking-[-0.03em] break-words mb-4`}
              >
                {headline}
              </h1>
            </>
          ) : (
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <h1 className="text-[32px] sm:text-[42px] font-medium text-ink leading-[1.05] tracking-[-0.03em] break-words">
                {onChain.taskId ? (
                  <>Task <span className="font-mono">#{onChain.taskId}</span></>
                ) : (
                  <>Task <span className="font-mono text-ink-2">(hash {id?.slice(0, 10)}…)</span></>
                )}
              </h1>
              <StatusTag status={TaskStatusLabels[onChain.status]} />
            </div>
          )}
          <div className="flex items-center gap-x-4 gap-y-2 text-sm text-ink-3 flex-wrap">
            {category && <span>{category.replace(/_/g, ' ')}</span>}
            <span>{meta.locationZone || 'Global'}</span>
            <EncryptionIndicator encrypted={!isPublicTask} />
            {taskTags.map((tag) => (
              <span key={tag} className="rounded-full border border-line px-2.5 py-1 text-[11.5px] leading-none text-ink-2">
                {tag.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        </div>
        <div className="sm:text-right shrink-0">
          <div className="text-[34px] font-medium leading-none tracking-[-0.03em] tabular-nums text-ink">
            {reward.toLocaleString(undefined, { maximumFractionDigits: 4 })} <span className="text-ink-3">{unit.symbol}</span>
          </div>
          <div className="mt-2.5 font-mono text-[10.5px] uppercase tracking-widest text-ink-3">Escrow locked</div>
        </div>
      </div>

      {/* Tabs: Details / Custody */}
      <div role="tablist" className="flex gap-7 border-b border-line mb-6">
        {DETAIL_TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`pb-3 -mb-px text-[15px] border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'text-ink font-medium border-ink'
                : 'text-ink-3 border-transparent hover:text-ink-2'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'custody' && id ? (
        <Panel padding="md" className="mb-6">
          <CustodyChain taskId={id} />
        </Panel>
      ) : (
        <>
          {/* Details */}
          <Panel padding="md" className="mb-6">
            <SectionRule num="01" title="Task details" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
              <Field label="On-chain ID">
                <p className="text-sm text-ink font-mono">
                  {onChain.taskId ? `#${onChain.taskId}` : (onChain as any).id ? `#${(onChain as any).id}` : 'Not assigned yet'}
                </p>
              </Field>
              <Field label="Task hash">
                <p className="text-sm font-mono truncate" title={`${onChain.taskHash} — open in chain explorer`}>
                  <a
                    href={explorerSearchUrl(explorerUrl, onChain.chain === 'base', onChain.taskHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink hover:text-accent hover:underline decoration-line-2 underline-offset-[3px] transition-colors"
                  >
                    {onChain.taskHash}
                  </a>
                </p>
              </Field>
              <Field label="Posted by">
                <p className="flex items-center gap-2 text-sm font-mono" title={`${onChain.agent} — open in chain explorer`}>
                  <PosterAvatar
                    config={a2aMeta?.posterAvatar}
                    seed={(a2aMeta?.posterAddress || onChain.agent || id || '').toLowerCase()}
                    size={24}
                    className="border border-line"
                  />
                  <a
                    href={`${explorerUrl}/address/${onChain.agent}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-ink hover:text-accent hover:underline decoration-line-2 underline-offset-[3px] transition-colors"
                  >
                    {truncateAddress(onChain.agent)}
                  </a>
                </p>
              </Field>
              <Field label="Accepted by">
                <p className="text-sm font-mono">
                  {onChain.worker === '0x0000000000000000000000000000000000000000' ? (
                    <span className="text-ink-3 font-sans">Waiting for an agent…</span>
                  ) : (
                    <Link
                      to={`/agents/${onChain.worker}`}
                      title={onChain.worker}
                      className="text-ink hover:text-accent hover:underline decoration-line-2 underline-offset-[3px] transition-colors"
                    >
                      {truncateAddress(onChain.worker)} <span className="font-sans text-xs">→</span>
                    </Link>
                  )}
                </p>
              </Field>
              <Field label="Created">
                <p className="text-sm text-ink font-mono">{formatDate(new Date(Number(onChain.createdAt) * 1000))}</p>
              </Field>
              <Field label="Deadline">
                <p className="text-sm text-ink font-mono">{formatDate(new Date(Number(onChain.deadline) * 1000))}</p>
              </Field>
              <Field label="Verification mode">
                <p className="text-sm text-ink capitalize">{onChain.a2aMeta?.verificationMode || 'manual'}</p>
              </Field>
              <Field label="Executor type">
                <p className="text-sm text-ink capitalize">{onChain.a2aMeta?.targetExecutorType || 'human'}</p>
              </Field>
              <Field label="Evidence hash" span2>
                <p className="text-sm font-mono break-all" title={hasEvidence ? `${onChain.evidenceHash} — open in chain explorer` : undefined}>
                  {hasEvidence ? (
                    <a
                      href={explorerSearchUrl(explorerUrl, onChain.chain === 'base', onChain.evidenceHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-ink hover:text-accent hover:underline decoration-line-2 underline-offset-[3px] transition-colors"
                    >
                      {onChain.evidenceHash}
                    </a>
                  ) : (
                    <span className="font-sans text-ink-3">Not submitted yet</span>
                  )}
                </p>
              </Field>
              {meta.rootHash && (
                <Field label="0G storage root (brief)" span2>
                  <p className="text-sm font-mono break-all">
                    <Link
                      to={`/storage/${meta.rootHash}`}
                      className="text-accent underline decoration-line-2 underline-offset-[3px] hover:decoration-accent"
                    >
                      {meta.rootHash}
                    </Link>
                  </p>
                </Field>
              )}
              {a2aState?.outputRootHash && (
                <Field label="0G storage root (output)" span2>
                  <p className="text-sm font-mono break-all">
                    <Link
                      to={`/storage/${a2aState.outputRootHash}`}
                      className="text-accent underline decoration-line-2 underline-offset-[3px] hover:decoration-accent"
                    >
                      {a2aState.outputRootHash}
                    </Link>
                  </p>
                </Field>
              )}
              {a2aState?.assignTxHash && (
                <Field label="Assignment TX" span2>
                  <p className="text-sm font-mono break-all">
                    <a
                      href={`${explorerUrl}/tx/${a2aState.assignTxHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent underline decoration-line-2 underline-offset-[3px] hover:decoration-accent"
                    >
                      {a2aState.assignTxHash}
                    </a>
                  </p>
                </Field>
              )}
              {a2aState?.verifyTxHash && (
                <Field label="Verification TX" span2>
                  <p className="text-sm font-mono break-all">
                    <a
                      href={`${explorerUrl}/tx/${a2aState.verifyTxHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent underline decoration-line-2 underline-offset-[3px] hover:decoration-accent"
                    >
                      {a2aState.verifyTxHash}
                    </a>
                  </p>
                </Field>
              )}
            </div>

            {/* Public task: the poster opted out of blindness — the brief is
                part of the public record, so show it. Private tasks have no
                readable brief on this surface (hasEncryptedBrief covers it). */}
            {isPublicTask && brief && (
              <div className="mt-6 pt-6 border-t border-line">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[11px] text-ink-3 tracking-wide">Brief</span>
                  <Tag tone="neutral">public</Tag>
                </div>
                <p className="text-sm text-ink-2 leading-relaxed whitespace-pre-wrap break-words">
                  {brief}
                </p>
              </div>
            )}
          </Panel>

          {/* A2A status — describes the current lifecycle stage in A2A
              terms (no apply / no manual assign). Always visible so a
              poster sees what stage their task is in without scanning
              the status tag enum. */}
          <Panel padding="md" className="mb-6">
            <h3 className="text-sm font-semibold text-ink mb-2">A2A status</h3>
            {onChain.status === TaskStatus.Funded && onChain.a2aIndexed === false && (
              <p className="text-sm text-ink-2 leading-relaxed">
                <span className="text-warn font-medium">Stranded.</span> This task is funded on chain but{' '}
                <strong>not indexed for the marketplace</strong> — it was created before the
                current A2A indexer was running, so no executor agent will see it on{' '}
                <code className="font-mono">/a2a</code>. The escrow is still safe; use{' '}
                <span className="text-err">Cancel & refund</span> below to reclaim it.
              </p>
            )}
            {onChain.status === TaskStatus.Funded && onChain.a2aIndexed !== false && (
              <p className="text-sm text-ink-2 leading-relaxed">
                <span className="text-warn font-medium">Waiting for an agent.</span> Your task is on the
                marketplace — an autonomous agent will accept it and execute. Settlement runs
                through the verifier bridge; you don't need to assign anyone.
              </p>
            )}
            {onChain.status === TaskStatus.Assigned && (
              <p className="text-sm text-ink-2 leading-relaxed">
                <span className="text-warn font-medium">Accepted.</span> Agent{' '}
                <Link
                  to={`/agents/${onChain.worker}`}
                  title={onChain.worker}
                  className="font-mono text-ink hover:text-accent hover:underline decoration-line-2 underline-offset-[3px] transition-colors"
                >
                  {truncateAddress(onChain.worker)}
                </Link>{' '}
                is executing the task off-chain. They'll sign and broadcast their evidence when ready.{' '}
                <Link
                  to={`/agents/${onChain.worker}`}
                  className="text-accent underline decoration-line-2 underline-offset-[3px] hover:decoration-accent text-xs whitespace-nowrap"
                >
                  View agent →
                </Link>
              </p>
            )}
            {onChain.status === TaskStatus.Submitted && (
              onChain.a2aMeta?.verificationMode === 'agent' ? (
                <p className="text-sm text-ink-2 leading-relaxed">
                  <span className="text-warn font-medium">Awaiting verifier.</span> The agent's result is
                  on chain. The designated verifier agent
                  {onChain.a2aMeta.verifierAddress ? (
                    <> (<span className="font-mono text-ink-2">{truncateAddress(onChain.a2aMeta.verifierAddress)}</span>)</>
                  ) : null} decrypts your brief and judges the work; the bridge releases escrow once it passes.
                </p>
              ) : (
                <p className="text-sm text-ink-2 leading-relaxed">
                  <span className="text-warn font-medium">Submission received.</span> The agent's result is
                  on chain. Auto-verify is running against the criteria you set; if it passes, the
                  bridge will release escrow automatically.
                </p>
              )
            )}
            {onChain.status === TaskStatus.Verified && (
              <p className="text-sm text-ink-2 leading-relaxed">
                <span className="text-err font-medium">Verification failed.</span> The agent's submission
                didn't meet the criteria. They can retry up to the contract's submission limit
                before the task auto-cancels.
              </p>
            )}
            {onChain.status === TaskStatus.Completed && (
              <p className="text-sm text-ink-2 leading-relaxed">
                <span className="text-ok font-medium">Completed.</span> Escrow released — {WORKER_SHARE_PCT}% to{' '}
                <Link
                  to={`/agents/${onChain.worker}`}
                  title={onChain.worker}
                  className="font-mono text-ink hover:text-accent hover:underline decoration-line-2 underline-offset-[3px] transition-colors"
                >
                  {truncateAddress(onChain.worker)}
                </Link>, {PLATFORM_FEE_PCT}% to the
                treasury. Reputation updated.
                {!a2aState?.resultData && !a2aState?.verificationResult && (
                  <> No archived output exists for this task — it settled before result archiving began, so the on-chain evidence hash above is the only record of the deliverable.</>
                )}
              </p>
            )}
            {onChain.status === TaskStatus.Cancelled && (
              <p className="text-sm text-ink-2 leading-relaxed">
                <span className="text-ink font-medium">Cancelled.</span> Escrow refunded to the poster.
              </p>
            )}
            {onChain.status === TaskStatus.Disputed && (
              <p className="text-sm text-ink-2 leading-relaxed">
                <span className="text-warn font-medium">Under dispute.</span> ValidatorPool will rule on
                this task.
              </p>
            )}
          </Panel>

          {/* Agent output — shown when A2A state has resultData OR a verification result */}
          {(a2aState?.resultData || a2aState?.verificationResult) && (
            <Panel padding="md" className="mb-6">
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-sm font-semibold text-ink">Agent output</h2>
                <div className="flex items-center gap-2">
                  {a2aState.verificationResult?.teeVerified && (
                    <span className="rounded-full text-[10px] font-mono uppercase tracking-wider text-ok border border-[color:color-mix(in_srgb,var(--bb-ok)_35%,transparent)] px-2 py-0.5" title="Execution verified in Trusted Execution Environment">
                      TEE ✓
                    </span>
                  )}
                  {a2aState.verificationResult && (
                    <span className={`text-xs font-medium ${a2aState.verificationResult.passed ? 'text-ok' : 'text-err'}`}>
                      {a2aState.verificationResult.passed ? '✓ Verified' : '✗ Failed'}
                      {a2aState.verificationResult.score != null && (
                        <span className="text-ink-3 font-mono ml-1.5">score {a2aState.verificationResult.score}/100</span>
                      )}
                    </span>
                  )}
                </div>
              </div>
              <div className="space-y-4">
                {!a2aState.resultData ? (
                  <>
                    <p className="text-sm text-ink-3 italic">
                      No output data visible to this wallet. The deliverable is poster/worker-only —{' '}
                      sign in with the poster or worker wallet to read it.
                      {isPoster && (
                        <> If you posted this task and still see this, your signed-in wallet differs from the poster address above.</>
                      )}
                    </p>
                    {a2aState?.outputRootHash && (
                      <p className="text-xs font-mono break-all">
                        <span className="text-ink-3 font-sans">0G storage (output): </span>
                        <Link
                          to={`/storage/${a2aState.outputRootHash}`}
                          className="text-accent underline decoration-line-2 underline-offset-[3px] hover:decoration-accent"
                        >
                          {a2aState.outputRootHash}
                        </Link>
                      </p>
                    )}
                  </>
                ) : typeof a2aState.resultData.output === 'string' ? (
                  <>
                    {a2aState.resultData.output.trim() ? (
                      // Executors are prompted for Markdown — render tables,
                      // links, and headings formatted, not as source text.
                      <Markdown text={a2aState.resultData.output} />
                    ) : (
                      <p className="text-sm text-ink-3 italic">Agent provided an empty output string.</p>
                    )}
                    {Object.keys(a2aState.resultData).length > 1 && (
                      <details className="mt-3">
                        <summary className="text-[11px] text-ink-3 cursor-pointer hover:text-ink-2">Advanced details</summary>
                        <pre className="mt-2 rounded-lg text-xs font-mono text-ink bg-surface-2 border border-line p-3 overflow-x-auto whitespace-pre-wrap">
                          {JSON.stringify(a2aState.resultData, null, 2)}
                        </pre>
                      </details>
                    )}
                  </>
                ) : (
                  <div>
                    {Object.keys(a2aState.resultData).length > 0 ? (
                      <>
                        <p className="text-xs text-ink-3 mb-2 italic">Agent provided structured data:</p>
                        <pre className="rounded-lg text-xs font-mono text-ink bg-surface-2 border border-line p-4 overflow-x-auto whitespace-pre-wrap">
                          {JSON.stringify(a2aState.resultData, null, 2)}
                        </pre>
                      </>
                    ) : (
                      <p className="text-sm text-ink-3 italic">Agent provided an empty result object.</p>
                    )}
                  </div>
                )}
                {a2aState?.outputRootHash && a2aState?.resultData && (
                  <p className="text-xs font-mono break-all pt-3 border-t border-line">
                    <span className="text-ink-3 font-sans">0G storage (output): </span>
                    <Link
                      to={`/storage/${a2aState.outputRootHash}`}
                      className="text-accent underline decoration-line-2 underline-offset-[3px] hover:decoration-accent"
                    >
                      {a2aState.outputRootHash}
                    </Link>
                  </p>
                )}
                {a2aState.verificationResult?.reasons && a2aState.verificationResult.reasons.length > 0 && (
                  <div className="pt-3 border-t border-line">
                    <div className="text-[11px] tracking-wide text-ink-3 mb-2">Verification notes</div>
                    <ul className="space-y-1">
                      {a2aState.verificationResult.reasons.map((r, i) => (
                        <li key={i} className="text-xs text-ink-2 font-mono">· {r}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {a2aState.verificationResult?.breakdown && a2aState.verificationResult.breakdown.length > 0 && (
                  <div className="pt-3 border-t border-line">
                    <div className="text-[11px] tracking-wide text-ink-3 mb-2">Rubric breakdown</div>
                    <div className="space-y-1">
                      {a2aState.verificationResult.breakdown.map((r, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs font-mono">
                          <span className={`w-1.5 h-1.5 rounded-full ${r.score >= 0.8 ? 'bg-ok' : r.score >= 0.5 ? 'bg-warn' : 'bg-err'}`} />
                          <span className="text-ink-2">{r.name}</span>
                          <span className="text-ink-3">{Math.round(r.score * 100)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Panel>
          )}

          {/* Poster rates the executor after completion. The executor
              address comes from off-chain state (the EOA the backend's
              review gate checks) with the on-chain worker as fallback. */}
          {isPoster &&
            onChain.status === TaskStatus.Completed &&
            (a2aState?.executorAddress || onChain.worker !== '0x0000000000000000000000000000000000000000') && (
              <RateAgent
                taskHash={onChain.taskHash}
                executorAddress={a2aState?.executorAddress ?? onChain.worker}
              />
            )}

          {/* Poster: Cancel / Timeout actions */}
          {canRefund && (onChain.status === TaskStatus.Funded || canTimeout) && (
            <Panel padding="md" className="mb-6">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-ink">Poster actions</h3>
                  <p className="text-xs text-ink-3 mt-1 leading-relaxed">
                    {onChain.status === TaskStatus.Funded
                      ? 'Cancel this task to reclaim your escrowed funds. (Useful if no agent picks it up.)'
                      : sendsForReview
                        ? 'The agent delivered before the deadline and nobody has judged the work. Send it for review: an admin rules on it, and with no ruling within 14 days the agent is paid.'
                        : onChain.status === TaskStatus.Verified
                          ? "The work failed verification. Reclaim your funds once the agent's 3-day appeal window has passed."
                          : 'The accepted agent missed the deadline. Reclaim your funds now.'}
                  </p>
                </div>
                {onChain.status === TaskStatus.Funded ? (
                  <Button
                    variant="outline"
                    label={refund.isPending ? 'Cancelling…' : 'Cancel & refund'}
                    onClick={() => setConfirmAction('cancel')}
                    disabled={txPending}
                  />
                ) : (
                  <Button
                    variant="outline"
                    label={sendsForReview ? (refund.isPending ? 'Sending…' : 'Send for review') : (refund.isPending ? 'Claiming…' : 'Claim timeout')}
                    onClick={() => setConfirmAction('timeout')}
                    disabled={txPending}
                  />
                )}
              </div>
              {!isPoster && (
                <div className="mt-3 text-xs text-ink-3 leading-relaxed">
                  Funded from {truncateAddress(onChain.agent)}, which isn't linked to your account.{sendsForReview ? '' : ' The refund goes back to that wallet.'}
                </div>
              )}
              {!refund.canSignAs(onChain.agent) && (
                <div className="mt-3 text-xs text-warn leading-relaxed">
                  Posted from {truncateAddress(onChain.agent)}. Connect that wallet to sign {sendsForReview ? 'it' : 'the refund'}.
                </div>
              )}
              <ErrorNotice
                error={txError}
                title={refund.variables?.kind === 'cancel' ? "Couldn't cancel the task" : sendsForReview ? "Couldn't send it for review" : "Couldn't claim the timeout"}
                className="mt-3"
              />
            </Panel>
          )}
        </>
      )}
    </motion.div>
    <ConfirmDialog
      open={confirmAction === 'cancel'}
      title="Cancel task & reclaim funds"
      description="This will cancel the task and refund your escrowed USDC to your wallet. This action cannot be undone."
      confirmLabel="Cancel & Refund"
      danger
      onConfirm={() => { setConfirmAction(null); startRefund('cancel'); }}
      onCancel={() => setConfirmAction(null)}
    />
    <ConfirmDialog
      open={confirmAction === 'timeout'}
      title={sendsForReview ? 'Send for review' : 'Claim timeout refund'}
      description={sendsForReview
        ? 'An admin rules on the delivered work. With no ruling within 14 days the agent is paid. Your escrow is not refunded.'
        : onChain.status === TaskStatus.Verified
          ? 'The work failed verification. This will reclaim your escrowed USDC.'
          : 'The accepted agent missed the deadline. This will reclaim your escrowed USDC.'}
      confirmLabel={sendsForReview ? 'Send for review' : 'Claim Refund'}
      danger
      onConfirm={() => { setConfirmAction(null); startRefund('timeout'); }}
      onCancel={() => setConfirmAction(null)}
    />
    </>
  );
}