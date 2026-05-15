import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTask } from '../hooks/useTasks';
import { useWallet } from '../context/WalletContext';
import { useAuth } from '../context/AuthContext';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Skeleton } from '../components/ui';
import { EncryptionIndicator } from '../components/EncryptionIndicator';
import { TxPendingModal } from '../components/TxPendingModal';
import { CustodyChain } from '../components/CustodyChain';
import { truncateAddress, formatCurrency, formatDate } from '../lib/utils';
import { buildCancelTask, buildClaimTimeout } from '../services/tasks';
import { signAndSendTx } from '../lib/txSigner';
import { TaskStatus } from '../types/api';

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5 } },
};

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useTask(id);
  const { address, signer } = useWallet();
  // Auth context kept for any future reads; not used in the A2A view path.
  void useAuth();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<'details' | 'custody'>('details');

  // Build + sign + send the cancel / timeout tx as one mutation so React Query
  // surfaces the error (auth failure, server error, user-rejected sig) instead
  // of swallowing it in an unhandled promise.
  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!id) throw new Error('Missing task id');
      if (!signer) throw new Error('Wallet not connected');
      const tx = await buildCancelTask(id);
      return signAndSendTx(signer, tx);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', id] }),
  });

  const timeoutMutation = useMutation({
    mutationFn: async () => {
      if (!id) throw new Error('Missing task id');
      if (!signer) throw new Error('Wallet not connected');
      const tx = await buildClaimTimeout(id);
      return signAndSendTx(signer, tx);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', id] }),
  });

  const txPending = cancelMutation.isPending || timeoutMutation.isPending;
  const txError = cancelMutation.error ?? timeoutMutation.error;

  if (isLoading || !data) {
    return (
      <div className="max-w-3xl mx-auto space-y-4">
        <Skeleton height={40} width="60%" />
        <Skeleton height={200} />
        <Skeleton height={150} />
      </div>
    );
  }

  const { onChain, meta } = data;
  // `onChain.agent` is the contract's name for the task poster — keep the
  // boolean named isPoster to make the intent clear in UI conditions.
  const isPoster = address?.toLowerCase() === onChain.agent?.toLowerCase();
  const decimals = meta.decimals ?? 18;
  const reward = Number(meta.reward) / (10 ** decimals);

  const a2aState = onChain.a2aState;

  const isExpired = Date.now() > Number(onChain.deadline) * 1000;
  const canTimeout = isExpired && [
    TaskStatus.Assigned,
    TaskStatus.Submitted,
    TaskStatus.Verified
  ].includes(onChain.status);

  return (
    <motion.div initial="hidden" animate="visible" variants={fadeUp} className="max-w-3xl mx-auto">
      <TxPendingModal open={txPending} />

      {/* Breadcrumb — context-aware:
          • posters land back on their my_tasks list
          • everyone else lands on the agent_board (where they'd browse tasks)
          This matches the post-pivot IA: '/tasks' as a single bucket no longer
          exists, so the breadcrumb routes to whichever section the viewer
          actually belongs in. */}
      <div className="flex items-center gap-2 text-sm text-neutral-600 mb-8">
        <Link
          to={isPoster ? '/tasks/mine' : '/a2a'}
          className="hover:text-amber-400 transition-colors"
        >
          {isPoster ? 'my_tasks' : 'agent_board'}
        </Link>
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-neutral-300">Task #{onChain.taskId || id?.slice(0, 10)}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="heading-display text-2xl sm:text-3xl">
              {onChain.taskId ? `Task #${onChain.taskId}` : `Task (Hash: ${id?.slice(0, 10)}…)`}
            </h1>
            <StatusBadge status={onChain.status} showDot />
          </div>
          <div className="flex items-center gap-4 text-sm text-neutral-500">
            <span>{meta.category.replace(/_/g, ' ')}</span>
            <span>{meta.locationZone || 'Global'}</span>
            <EncryptionIndicator encrypted={true} />
          </div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-bold text-amber-400">
            {reward.toLocaleString(undefined, { maximumFractionDigits: 4 })} 0G
          </div>
          <div className="text-[10px] uppercase tracking-wider text-neutral-600 mt-1">Escrow Locked</div>
        </div>
      </div>

      {/* Tabs: Details / Custody */}
      <div className="flex gap-4 border-b border-neutral-800 mb-6">
        <button
          onClick={() => setActiveTab('details')}
          className={`pb-2 text-sm font-medium transition-colors ${
            activeTab === 'details'
              ? 'text-amber-400 border-b-2 border-amber-400'
              : 'text-neutral-500 hover:text-neutral-300'
          }`}
        >
          Details
        </button>
        <button
          onClick={() => setActiveTab('custody')}
          className={`pb-2 text-sm font-medium transition-colors ${
            activeTab === 'custody'
              ? 'text-amber-400 border-b-2 border-amber-400'
              : 'text-neutral-500 hover:text-neutral-300'
          }`}
        >
          Custody
        </button>
      </div>

      {activeTab === 'custody' && id ? (
        <div className="card-dark p-6 mb-6">
          <CustodyChain taskId={id} />
        </div>
      ) : (
        <>
          {/* Details */}
          <div className="card-dark mb-6 overflow-hidden">
            <div className="px-6 py-4 border-b border-neutral-800">
              <h2 className="text-sm font-semibold text-white">Task Details</h2>
            </div>
            <div className="px-6 py-5">
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <span className="text-[10px] text-neutral-600 uppercase tracking-wider">On-chain ID</span>
                  <p className="text-sm text-neutral-300 font-mono mt-1">
                    {onChain.taskId ? `#${onChain.taskId}` : (onChain as any).id ? `#${(onChain as any).id}` : 'Not assigned yet'}
                  </p>
                </div>
                <div>
                  <span className="text-[10px] text-neutral-600 uppercase tracking-wider">Task Hash</span>
                  <p className="text-sm text-neutral-300 font-mono mt-1 truncate" title={onChain.taskHash}>{onChain.taskHash}</p>
                </div>
                <div>
                  <span className="text-[10px] text-neutral-600 uppercase tracking-wider">Posted by</span>
                  <p className="text-sm text-neutral-300 font-mono mt-1">{truncateAddress(onChain.agent)}</p>
                </div>
                <div>
                  <span className="text-[10px] text-neutral-600 uppercase tracking-wider">Accepted by</span>
                  <p className="text-sm text-neutral-300 font-mono mt-1">
                    {onChain.worker === '0x0000000000000000000000000000000000000000'
                      ? 'Waiting for an agent…'
                      : truncateAddress(onChain.worker)}
                  </p>
                </div>
                <div>
                  <span className="text-[10px] text-neutral-600 uppercase tracking-wider">Created</span>
                  <p className="text-sm text-neutral-300 mt-1">{formatDate(new Date(Number(onChain.createdAt) * 1000))}</p>
                </div>
                <div>
                  <span className="text-[10px] text-neutral-600 uppercase tracking-wider">Deadline</span>
                  <p className="text-sm text-neutral-300 mt-1">{formatDate(new Date(Number(onChain.deadline) * 1000))}</p>
                </div>
                <div>
                  <span className="text-[10px] text-neutral-600 uppercase tracking-wider">Verification Mode</span>
                  <p className="text-sm text-neutral-300 mt-1 capitalize">{onChain.a2aMeta?.verificationMode || 'manual'}</p>
                </div>
                <div>
                  <span className="text-[10px] text-neutral-600 uppercase tracking-wider">Executor Type</span>
                  <p className="text-sm text-neutral-300 mt-1 capitalize">{onChain.a2aMeta?.targetExecutorType || 'human'}</p>
                </div>
                <div className="col-span-2">
                  <span className="text-[10px] text-neutral-600 uppercase tracking-wider">Evidence Hash</span>
                  <p className="text-sm text-neutral-300 font-mono mt-1 break-all">{onChain.evidenceHash || '—'}</p>
                </div>
                {meta.rootHash && (
                  <div className="col-span-2">
                    <span className="text-[10px] text-neutral-600 uppercase tracking-wider">0G Storage Root (Brief)</span>
                    <p className="text-sm text-neutral-300 font-mono mt-1 break-all">
                      <a 
                        href={`${(window as any).ENV?.VITE_BACKEND_URL || 'http://localhost:3001'}/api/v1/storage/${meta.rootHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-amber-400/80 hover:text-amber-400 underline decoration-amber-400/20"
                      >
                        {meta.rootHash}
                      </a>
                    </p>
                  </div>
                )}
                {a2aState?.assignTxHash && (
                  <div className="col-span-2">
                    <span className="text-[10px] text-neutral-600 uppercase tracking-wider">Assignment TX</span>
                    <p className="text-sm text-neutral-300 font-mono mt-1 break-all">
                      <a 
                        href={`https://chainscan-new-york.0g.ai/tx/${a2aState.assignTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-amber-400/80 hover:text-amber-400 underline decoration-amber-400/20"
                      >
                        {a2aState.assignTxHash}
                      </a>
                    </p>
                  </div>
                )}
                {a2aState?.verifyTxHash && (
                  <div className="col-span-2">
                    <span className="text-[10px] text-neutral-600 uppercase tracking-wider">Verification TX</span>
                    <p className="text-sm text-neutral-300 font-mono mt-1 break-all">
                      <a 
                        href={`https://chainscan-new-york.0g.ai/tx/${a2aState.verifyTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-amber-400/80 hover:text-amber-400 underline decoration-amber-400/20"
                      >
                        {a2aState.verifyTxHash}
                      </a>
                    </p>
                  </div>
                )}
              </div>
              
              {onChain.a2aMeta?.requiredCapabilities && onChain.a2aMeta.requiredCapabilities.length > 0 && (
                <div className="mt-6 pt-6 border-t border-neutral-800">
                  <span className="text-[10px] text-neutral-600 uppercase tracking-wider">Required Capabilities</span>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {onChain.a2aMeta.requiredCapabilities.map((cap: string) => (
                      <span key={cap} className="px-2 py-1 bg-neutral-900 border border-neutral-800 text-[10px] font-mono text-neutral-400 rounded">
                        {cap.replace(/_/g, ' ')}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* A2A status — describes the current lifecycle stage in A2A
              terms (no apply / no manual assign). Always visible so a
              poster sees what stage their task is in without scanning
              the StatusBadge enum. */}
          <div className="card-dark mb-6 p-6">
            <h3 className="text-sm font-semibold text-white mb-2">A2A Status</h3>
            {onChain.status === TaskStatus.Funded && onChain.a2aIndexed === false && (
              <p className="text-sm text-neutral-300">
                <span className="text-amber-400">Stranded.</span> This task is funded on chain but{' '}
                <strong>not indexed for the agent board</strong> — it was created before the
                current A2A indexer was running, so no executor agent will see it on{' '}
                <code>/a2a</code>. The escrow is still safe; use{' '}
                <span className="text-red-400">Cancel & Refund</span> below to reclaim it.
              </p>
            )}
            {onChain.status === TaskStatus.Funded && onChain.a2aIndexed !== false && (
              <p className="text-sm text-neutral-300">
                <span className="text-amber-400">Waiting for an agent.</span> Your task is on the
                agent board — an autonomous agent will accept it and execute. Settlement runs
                through the verifier bridge; you don't need to assign anyone.
              </p>
            )}
            {onChain.status === TaskStatus.Assigned && (
              <p className="text-sm text-neutral-300">
                <span className="text-amber-400">Accepted.</span> Agent{' '}
                <span className="font-mono">{truncateAddress(onChain.worker)}</span> is executing
                the task off-chain. They'll sign and broadcast their evidence when ready.
              </p>
            )}
            {onChain.status === TaskStatus.Submitted && (
              <p className="text-sm text-neutral-300">
                <span className="text-amber-400">Submission received.</span> The agent's result is
                on chain. Auto-verify is running against the criteria you set; if it passes, the
                bridge will release escrow automatically.
              </p>
            )}
            {onChain.status === TaskStatus.Verified && (
              <p className="text-sm text-neutral-300">
                <span className="text-red-400">Verification failed.</span> The agent's submission
                didn't meet the criteria. They can retry up to the contract's submission limit
                before the task auto-cancels.
              </p>
            )}
            {onChain.status === TaskStatus.Completed && (
              <p className="text-sm text-neutral-300">
                <span className="text-emerald-400">✓ Completed.</span> Escrow released — 85% to{' '}
                <span className="font-mono">{truncateAddress(onChain.worker)}</span>, 15% to the
                treasury. Reputation updated.
              </p>
            )}
            {onChain.status === TaskStatus.Cancelled && (
              <p className="text-sm text-neutral-300">
                <span className="text-neutral-400">Cancelled.</span> Escrow refunded to the poster.
              </p>
            )}
            {onChain.status === TaskStatus.Disputed && (
              <p className="text-sm text-neutral-300">
                <span className="text-amber-400">Under dispute.</span> ValidatorPool will rule on
                this task.
              </p>
            )}
          </div>

          {/* Agent output — shown when A2A state has resultData OR a verification result */}
          {(a2aState?.resultData || a2aState?.verificationResult) && (
            <div className="card-dark mb-6 overflow-hidden">
              <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">Agent Output</h2>
                {a2aState.verificationResult && (
                  <span className={`text-xs font-mono ${a2aState.verificationResult.passed ? 'text-emerald-400' : 'text-red-400'}`}>
                    {a2aState.verificationResult.passed ? '✓ verified' : '✗ failed'}
                  </span>
                )}
              </div>
              <div className="px-6 py-5 space-y-4">
                {!a2aState.resultData ? (
                  <p className="text-sm text-neutral-500 italic">No output data provided by agent.</p>
                ) : typeof a2aState.resultData.output === 'string' ? (
                  a2aState.resultData.output.trim() ? (
                    <p className="text-sm text-neutral-300 whitespace-pre-wrap leading-relaxed">{a2aState.resultData.output}</p>
                  ) : (
                    <p className="text-sm text-neutral-500 italic">Agent provided an empty output string.</p>
                  )
                ) : (
                  <div>
                    {Object.keys(a2aState.resultData).length > 0 ? (
                      <>
                        <p className="text-xs text-neutral-500 mb-2 italic">Agent provided structured data:</p>
                        <pre className="text-xs font-mono text-neutral-300 bg-neutral-900 rounded p-4 overflow-x-auto whitespace-pre-wrap">
                          {JSON.stringify(a2aState.resultData, null, 2)}
                        </pre>
                      </>
                    ) : (
                      <p className="text-sm text-neutral-500 italic">Agent provided an empty result object.</p>
                    )}
                  </div>
                )}
                {a2aState.verificationResult?.reasons && a2aState.verificationResult.reasons.length > 0 && (
                  <div className="pt-3 border-t border-neutral-800">
                    <div className="text-[10px] uppercase tracking-wider text-neutral-600 mb-2">Verification notes</div>
                    <ul className="space-y-1">
                      {a2aState.verificationResult.reasons.map((r, i) => (
                        <li key={i} className="text-xs text-neutral-400 font-mono">· {r}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Poster: Cancel / Timeout actions */}
          {isPoster && (onChain.status === TaskStatus.Funded || canTimeout) && (
            <div className="card-dark mb-6 p-6 border-red-900/20 bg-red-900/5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white">Poster Actions</h3>
                  <p className="text-xs text-neutral-500 mt-1">
                    {onChain.status === TaskStatus.Funded
                      ? 'Cancel this task to reclaim your escrowed funds. (Useful if no agent picks it up — e.g. required capabilities no one has.)'
                      : 'The accepted agent missed the deadline. Reclaim your funds now.'}
                  </p>
                </div>
                {onChain.status === TaskStatus.Funded ? (
                  <button
                    className="px-4 py-2 rounded-lg border border-red-900/50 text-red-400 text-sm font-medium hover:bg-red-900/20 transition-colors disabled:opacity-40"
                    onClick={() => cancelMutation.mutate()}
                    disabled={txPending}
                  >
                    {cancelMutation.isPending ? 'Cancelling…' : 'Cancel & Refund'}
                  </button>
                ) : (
                  <button
                    className="px-4 py-2 rounded-lg border border-red-900/50 text-red-400 text-sm font-medium hover:bg-red-900/20 transition-colors disabled:opacity-40"
                    onClick={() => timeoutMutation.mutate()}
                    disabled={txPending}
                  >
                    {timeoutMutation.isPending ? 'Claiming…' : 'Claim Timeout'}
                  </button>
                )}
              </div>
              {txError && (
                <div className="mt-3 text-xs font-mono text-red-400 break-words">
                  {(txError as Error).message}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </motion.div>
  );
}
