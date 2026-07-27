import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTask } from '../hooks/useTasks';
import { useWallet } from '../context/WalletContext';
import { useChain } from '../context/ChainContext';
import { useAuth } from '../context/AuthContext';
import { Panel, SectionRule, Tag, Button, StatusTag, Skeleton, ErrorState, useTabParam } from '../components/bb';
import { EncryptionIndicator } from '../components/EncryptionIndicator';
import { TxPendingModal } from '../components/TxPendingModal';
import { CustodyChain } from '../components/CustodyChain';
import { truncateAddress, formatDate } from '../lib/utils';
import { buildCancelTask, buildClaimTimeout } from '../services/tasks';
import { signAndSendTx } from '../lib/txSigner';
import { getNativeCurrency, WORKER_SHARE_PCT, PLATFORM_FEE_PCT, API_BASE_URL } from '../config/constants';
import { useChainExplorerUrl } from '../hooks/useChainWallet';
import { TaskStatus, TaskStatusLabels } from '../types/api';

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5 } },
};

type DetailTab = 'details' | 'custody';

const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: 'details', label: 'Details' },
  { id: 'custody', label: 'Custody' },
];

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
    <div className={span2 ? 'col-span-2' : undefined}>
      <span className="text-[11px] text-ink-3 tracking-wide">{label}</span>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export default function TaskDetail() {
  const { id } = useParams();
  const { data, isLoading, isError, refetch } = useTask(id || '');
  const { address, signer } = useWallet();
  const { activeChain } = useChain();
  const explorerUrl = useChainExplorerUrl();
  const native = getNativeCurrency(activeChain);
  // Auth context kept for any future reads; not used in the A2A view path.
  void useAuth();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useTabParam<DetailTab>('details', DETAIL_TABS.map((t) => t.id));

  // Build + sign + send the cancel / timeout tx as one mutation so React Query
  // surfaces the error (auth failure, server error, user-rejected sig) instead
  // of swallowing it in an unhandled promise.
  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!id) throw new Error('Missing task id');
      if (!signer) throw new Error('Wallet not connected');
      const tx = await buildCancelTask(id);
      await signAndSendTx(signer, tx);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', id] }),
  });

  const timeoutMutation = useMutation({
    mutationFn: async () => {
      if (!id) throw new Error('Missing task id');
      if (!signer) throw new Error('Wallet not connected');
      const tx = await buildClaimTimeout(id);
      await signAndSendTx(signer, tx);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', id] }),
  });

  const txPending = cancelMutation.isPending || timeoutMutation.isPending;
  const txError = cancelMutation.error ?? timeoutMutation.error;

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
        <Skeleton className="h-10 w-3/5" />
        <Skeleton className="h-52 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { onChain, meta } = data;
  // `onChain.agent` is the contract's name for the task poster — keep the
  // boolean named isPoster to make the intent clear in UI conditions.
  const isPoster = address?.toLowerCase() === onChain.agent?.toLowerCase();
  const decimals = meta.decimals ?? 18;
  // meta.reward can be absent on partial/undecryptable metas — render 0
  // rather than "NaN 0G" in the page's hero number.
  const rewardRaw = Number(meta.reward);
  const reward = Number.isFinite(rewardRaw) ? rewardRaw / 10 ** decimals : 0;

  const a2aState = onChain.a2aState;
  // Storage links go through the same API base as every other call.
  // (This used to read window.ENV?.VITE_BACKEND_URL — never defined anywhere —
  // and fell back to localhost:3001, a dead link in every production build.)
  const storageBase = API_BASE_URL;

  const isExpired = Date.now() > Number(onChain.deadline) * 1000;
  const canTimeout = isExpired && [
    TaskStatus.Assigned,
    TaskStatus.Submitted,
    TaskStatus.Verified
  ].includes(onChain.status);

  const taskLabel = onChain.taskId || id?.slice(0, 10);

  return (
    <motion.div initial="hidden" animate="visible" variants={fadeUp} className="max-w-3xl mx-auto">
      <TxPendingModal open={txPending} />

      {/* Breadcrumb — context-aware:
          • posters land back on their My tasks list
          • everyone else lands on the Marketplace (where they'd browse tasks)
          This matches the post-pivot IA: '/tasks' as a single bucket no longer
          exists, so the breadcrumb routes to whichever section the viewer
          actually belongs in. Kept as a custom nav (not the shared Breadcrumb)
          because the first crumb must be a working deep link. */}
      <nav className="flex items-center flex-wrap gap-x-2 gap-y-1 text-xs text-ink-3 mb-6">
        <Link
          to={isPoster ? '/tasks/mine' : '/a2a'}
          className="hover:text-cream transition-colors"
        >
          {isPoster ? 'My tasks' : 'Marketplace'}
        </Link>
        <span className="text-ink-3/50">/</span>
        <span className="text-ink-2">Task #{taskLabel}</span>
      </nav>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
        <div className="min-w-0">
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            <h1 className="text-3xl sm:text-[38px] font-bold text-ink leading-[1.05] tracking-tight break-words">
              {onChain.taskId ? (
                <>Task <span className="font-mono">#{onChain.taskId}</span></>
              ) : (
                <>Task <span className="font-mono text-ink-2">(hash {id?.slice(0, 10)}…)</span></>
              )}
            </h1>
            <StatusTag status={TaskStatusLabels[onChain.status]} />
          </div>
          <div className="flex items-center gap-4 text-sm text-ink-3 flex-wrap">
            <span>{(meta.category ?? 'unknown').replace(/_/g, ' ')}</span>
            <span>{meta.locationZone || 'Global'}</span>
            <EncryptionIndicator encrypted={true} />
          </div>
        </div>
        <div className="sm:text-right shrink-0">
          <div className="text-3xl font-bold font-mono text-cream">
            {reward.toLocaleString(undefined, { maximumFractionDigits: 4 })} {native.symbol}
          </div>
          <div className="text-[11px] tracking-wide text-ink-3 mt-1">Escrow locked</div>
        </div>
      </div>

      {/* Tabs: Details / Custody */}
      <div role="tablist" className="flex gap-6 border-b border-line mb-6">
        {DETAIL_TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`pb-3 -mb-px text-sm border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'text-ink font-medium border-cream'
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
                <p className="text-sm text-ink font-mono truncate" title={onChain.taskHash}>{onChain.taskHash}</p>
              </Field>
              <Field label="Posted by">
                <p className="text-sm text-ink font-mono">{truncateAddress(onChain.agent)}</p>
              </Field>
              <Field label="Accepted by">
                <p className="text-sm font-mono">
                  {onChain.worker === '0x0000000000000000000000000000000000000000' ? (
                    <span className="text-ink-3 font-sans">Waiting for an agent…</span>
                  ) : (
                    <span className="text-ink">{truncateAddress(onChain.worker)}</span>
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
                <p className="text-sm text-ink font-mono break-all">{onChain.evidenceHash || '—'}</p>
              </Field>
              {meta.rootHash && (
                <Field label="0G storage root (brief)" span2>
                  <p className="text-sm font-mono break-all">
                    <a
                      href={`${storageBase}/api/v1/storage/${meta.rootHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-cream hover:underline decoration-cream/30"
                    >
                      {meta.rootHash}
                    </a>
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
                      className="text-cream hover:underline decoration-cream/30"
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
                      className="text-cream hover:underline decoration-cream/30"
                    >
                      {a2aState.verifyTxHash}
                    </a>
                  </p>
                </Field>
              )}
            </div>

            {onChain.a2aMeta?.requiredCapabilities && onChain.a2aMeta.requiredCapabilities.length > 0 && (
              <div className="mt-6 pt-6 border-t border-line">
                <span className="text-[11px] text-ink-3 tracking-wide">Required capabilities</span>
                <div className="flex flex-wrap gap-2 mt-2">
                  {onChain.a2aMeta.requiredCapabilities.map((cap: string) => (
                    <Tag key={cap} tone="neutral">{cap.replace(/_/g, ' ')}</Tag>
                  ))}
                </div>
              </div>
            )}

            {/* Public task: the poster opted out of blindness — the brief is
                part of the public record, so show it. Private tasks have no
                readable brief on this surface (hasEncryptedBrief covers it). */}
            {onChain.a2aMeta?.privacy === 'public' && onChain.a2aMeta?.publicBrief && (
              <div className="mt-6 pt-6 border-t border-line">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[11px] text-ink-3 tracking-wide">Brief</span>
                  <Tag tone="neutral">public</Tag>
                </div>
                <p className="text-sm text-ink-2 leading-relaxed whitespace-pre-wrap">
                  {onChain.a2aMeta.publicBrief}
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
                <span className="font-mono text-ink">{truncateAddress(onChain.worker)}</span> is executing
                the task off-chain. They'll sign and broadcast their evidence when ready.
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
                <span className="font-mono text-ink">{truncateAddress(onChain.worker)}</span>, {PLATFORM_FEE_PCT}% to the
                treasury. Reputation updated.
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
                    <span className="text-[10px] font-mono uppercase tracking-wider text-ok border border-ok/30 px-1.5 py-0.5" title="Execution verified in Trusted Execution Environment">
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
                  <p className="text-sm text-ink-3 italic">No output data provided by agent.</p>
                ) : typeof a2aState.resultData.output === 'string' ? (
                  <>
                    {a2aState.resultData.output.trim() ? (
                      <p className="text-sm text-ink-2 whitespace-pre-wrap leading-relaxed">{a2aState.resultData.output}</p>
                    ) : (
                      <p className="text-sm text-ink-3 italic">Agent provided an empty output string.</p>
                    )}
                    {Object.keys(a2aState.resultData).length > 1 && (
                      <details className="mt-3">
                        <summary className="text-[11px] text-ink-3 cursor-pointer hover:text-ink-2">Advanced details</summary>
                        <pre className="mt-2 text-xs font-mono text-ink bg-surface-2 border border-line p-3 overflow-x-auto whitespace-pre-wrap">
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
                        <pre className="text-xs font-mono text-ink bg-surface-2 border border-line p-4 overflow-x-auto whitespace-pre-wrap">
                          {JSON.stringify(a2aState.resultData, null, 2)}
                        </pre>
                      </>
                    ) : (
                      <p className="text-sm text-ink-3 italic">Agent provided an empty result object.</p>
                    )}
                  </div>
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
                          <span className={`w-1.5 h-1.5 ${r.score >= 0.8 ? 'bg-ok' : r.score >= 0.5 ? 'bg-warn' : 'bg-err'}`} />
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

          {/* Poster: Cancel / Timeout actions */}
          {isPoster && (onChain.status === TaskStatus.Funded || canTimeout) && (
            <Panel padding="md" className="mb-6">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-ink">Poster actions</h3>
                  <p className="text-xs text-ink-3 mt-1 leading-relaxed">
                    {onChain.status === TaskStatus.Funded
                      ? 'Cancel this task to reclaim your escrowed funds. (Useful if no agent picks it up — e.g. required capabilities no one has.)'
                      : 'The accepted agent missed the deadline. Reclaim your funds now.'}
                  </p>
                </div>
                {onChain.status === TaskStatus.Funded ? (
                  <Button
                    variant="outline"
                    label={cancelMutation.isPending ? 'Cancelling…' : 'Cancel & refund'}
                    onClick={() => cancelMutation.mutate()}
                    disabled={txPending}
                  />
                ) : (
                  <Button
                    variant="outline"
                    label={timeoutMutation.isPending ? 'Claiming…' : 'Claim timeout'}
                    onClick={() => timeoutMutation.mutate()}
                    disabled={txPending}
                  />
                )}
              </div>
              {txError && (
                <div className="mt-3 text-xs font-mono text-err break-words">
                  {(txError as Error).message}
                </div>
              )}
            </Panel>
          )}
        </>
      )}
    </motion.div>
  );
}