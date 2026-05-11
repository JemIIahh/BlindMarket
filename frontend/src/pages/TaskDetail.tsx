import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useTask, useApplications, useApplyToTask } from '../hooks/useTasks';
import { useTxSend } from '../hooks/useTxSend';
import { useWallet } from '../context/WalletContext';
import { useAuth } from '../context/AuthContext';
import { StatusBadge } from '../components/ui/StatusBadge';
import { Card, CardBody, CardHeader, Button, Textarea, Skeleton } from '../components/ui';
import { EncryptionIndicator } from '../components/EncryptionIndicator';
import { TxPendingModal } from '../components/TxPendingModal';
import { CustodyChain } from '../components/CustodyChain';
import { ReputationBadge } from '../components/DecayIndicator';
import { truncateAddress, formatCurrency, formatDate } from '../lib/utils';
import { buildAssignTask, buildCancelTask, buildClaimTimeout } from '../services/tasks';
import { lockStake } from '../services/staking';
import { TaskStatus } from '../types/api';

const fadeUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5 } },
};

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useTask(id);
  const { data: applications } = useApplications(id);
  const { address } = useWallet();
  const { isAuthenticated } = useAuth();
  const applyMutation = useApplyToTask();
  const txSend = useTxSend();
  const [applyMessage, setApplyMessage] = useState('');
  const [showApplyForm, setShowApplyForm] = useState(false);
  const [activeTab, setActiveTab] = useState<'details' | 'custody'>('details');
  const [showStakeModal, setShowStakeModal] = useState(false);
  const [pendingWorker, setPendingWorker] = useState<string | null>(null);

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
  const isAgent = address?.toLowerCase() === onChain.agent?.toLowerCase();
  const isWorker = address?.toLowerCase() === onChain.worker?.toLowerCase();
  const decimals = (meta as any).decimals ?? 18;
  const reward = Number(meta.reward) / (10 ** decimals);
  const stakeAmount = Math.round(reward * 0.10 * 100) / 100;

  const isExpired = Date.now() > Number(onChain.deadline) * 1000;
  const canTimeout = isExpired && [
    TaskStatus.Assigned,
    TaskStatus.Submitted,
    TaskStatus.Verified
  ].includes(onChain.status);

  // Source of truth for "have I already applied" — driven by the applications
  // list itself, which the apply mutation invalidates on success. Avoids any
  // local boolean drifting out of sync with backend state.
  const hasApplied = !!address && (applications ?? []).some(
    (a) => a.applicant?.toLowerCase() === address.toLowerCase(),
  );

  const handleApply = () => {
    if (!id || hasApplied) return;
    // Don't close synchronously — keep the form mounted so the button can
    // render loading state and any error surfaces inline. Once the mutation
    // succeeds, the applications query refetches, hasApplied flips true, and
    // the form is replaced by the "already applied" panel.
    applyMutation.mutate(
      { taskId: id, message: applyMessage || undefined },
      {
        onSuccess: () => {
          setShowApplyForm(false);
          setApplyMessage('');
        },
      },
    );
  };

  // Friendly error rendering — the backend's 409 maps to ALREADY_APPLIED, but
  // raw fetch errors arrive as JSON-stringified payloads. Pull the most useful
  // piece out without showing the user a wall of JSON.
  const applyErrorMessage = applyMutation.error
    ? (() => {
        const msg = (applyMutation.error as Error).message ?? String(applyMutation.error);
        if (msg.includes('ALREADY_APPLIED')) return 'You\'ve already applied to this task.';
        if (msg.includes('UNAUTHORIZED') || msg.includes('401')) return 'Sign in to apply.';
        // Strip leading "HTTP 4xx: " noise if present
        return msg.replace(/^HTTP \d+:\s*/, '').slice(0, 200);
      })()
    : null;

  const handleAssign = async (worker: string) => {
    if (!id) return;
    const unsignedTx = await buildAssignTask(id, worker);
    txSend.mutate(unsignedTx);
  };

  const handleCancel = async () => {
    if (!id) return;
    const unsignedTx = await buildCancelTask(id);
    txSend.mutate(unsignedTx);
  };

  const handleTimeout = async () => {
    if (!id) return;
    const unsignedTx = await buildClaimTimeout(id);
    txSend.mutate(unsignedTx);
  };

  const handleApplyWithStake = (worker: string) => {
    setPendingWorker(worker);
    setShowStakeModal(true);
  };

  const confirmStakeAndAccept = async () => {
    if (!id || !pendingWorker) return;
    try {
      await lockStake(id, reward);
    } catch (err) {
      console.warn('Stake lock failed (non-blocking):', err);
    }
    setShowStakeModal(false);
    await handleAssign(pendingWorker);
    setPendingWorker(null);
  };

  return (
    <motion.div initial="hidden" animate="visible" variants={fadeUp} className="max-w-3xl mx-auto">
      <TxPendingModal open={txSend.isPending} />

      {/* Staking confirmation modal */}
      {showStakeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="card-dark p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-semibold text-white mb-3">Confirm Stake</h3>
            <p className="text-sm text-neutral-400 mb-4">
              Accepting this task requires staking <span className="text-amber-400 font-semibold">{stakeAmount}</span> tokens
              (10% of {formatCurrency(reward)} reward). The stake is returned on successful completion, or slashed on failure.
            </p>
            <div className="flex gap-2">
              <button
                className="flex-1 btn-accent py-2 text-sm"
                onClick={confirmStakeAndAccept}
              >
                Stake & Accept
              </button>
              <button
                className="flex-1 px-4 py-2 rounded-lg border border-neutral-700 text-neutral-300 text-sm hover:border-neutral-500 transition-colors"
                onClick={() => { setShowStakeModal(false); setPendingWorker(null); }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-neutral-600 mb-8">
        <Link to="/tasks" className="hover:text-amber-400 transition-colors">Tasks</Link>
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-neutral-300">Task #{id}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="heading-display text-2xl sm:text-3xl">Task #{id}</h1>
            <StatusBadge status={onChain.status} showDot />
          </div>
          <div className="flex items-center gap-4 text-sm text-neutral-500">
            <span>{meta.category.replace('_', ' ')}</span>
            <span>{meta.locationZone || 'Global'}</span>
            <EncryptionIndicator encrypted={true} />
          </div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-bold text-amber-400">{formatCurrency(reward)}</div>
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
                  <span className="text-[10px] text-neutral-600 uppercase tracking-wider">Agent</span>
                  <p className="text-sm text-neutral-300 font-mono mt-1">{truncateAddress(onChain.agent)}</p>
                </div>
                <div>
                  <span className="text-[10px] text-neutral-600 uppercase tracking-wider">Worker</span>
                  <p className="text-sm text-neutral-300 font-mono mt-1">
                    {onChain.worker === '0x0000000000000000000000000000000000000000'
                      ? 'Unassigned'
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
              </div>
            </div>
          </div>

          {/* Worker: Apply section */}
          {isAuthenticated && !isAgent && onChain.status === TaskStatus.Funded && (
            <Card className="mb-6">
              <CardHeader title="Apply for this Task" bordered />
              <CardBody>
                {hasApplied ? (
                  // Already in the applications list — block re-apply and tell
                  // the user where they stand. The card stays visible (not
                  // hidden) so it's clear the apply action did register.
                  <div className="flex items-center gap-3 text-xs font-mono">
                    <span className="text-ok">✓</span>
                    <div>
                      <div className="text-ink">Application submitted</div>
                      <div className="text-ink-3 mt-0.5">
                        Waiting for the poster to assign a worker. You'll be notified if they pick you.
                      </div>
                    </div>
                  </div>
                ) : showApplyForm ? (
                  <div className="space-y-4">
                    <Textarea
                      label="Application Message (optional)"
                      placeholder="Why are you a good fit for this task?"
                      value={applyMessage}
                      onChange={(e) => setApplyMessage(e.target.value)}
                      rows={3}
                      disabled={applyMutation.isPending}
                    />
                    {applyErrorMessage && (
                      <div className="text-xs font-mono text-err border border-err/40 bg-err/5 px-3 py-2">
                        {applyErrorMessage}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        loading={applyMutation.isPending}
                        disabled={applyMutation.isPending}
                        onClick={handleApply}
                      >
                        {applyMutation.isPending ? 'Submitting…' : 'Submit Application'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={applyMutation.isPending}
                        onClick={() => {
                          setShowApplyForm(false);
                          applyMutation.reset();
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button className="btn-accent text-xs py-2" onClick={() => setShowApplyForm(true)}>
                    Apply
                  </button>
                )}
              </CardBody>
            </Card>
          )}

          {/* Agent: Actions (Cancel or Timeout) */}
          {isAgent && (onChain.status === TaskStatus.Funded || canTimeout) && (
            <div className="card-dark mb-6 p-6 border-red-900/20 bg-red-900/5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white">Agent Actions</h3>
                  <p className="text-xs text-neutral-500 mt-1">
                    {onChain.status === TaskStatus.Funded 
                      ? "Cancel this task to reclaim your escrowed funds." 
                      : "The worker missed the deadline. Reclaim your funds now."}
                  </p>
                </div>
                {onChain.status === TaskStatus.Funded ? (
                  <button
                    className="px-4 py-2 rounded-lg border border-red-900/50 text-red-400 text-sm font-medium hover:bg-red-900/20 transition-colors"
                    onClick={handleCancel}
                    disabled={txSend.isPending}
                  >
                    Cancel & Refund
                  </button>
                ) : (
                  <button
                    className="px-4 py-2 rounded-lg border border-red-900/50 text-red-400 text-sm font-medium hover:bg-red-900/20 transition-colors"
                    onClick={handleTimeout}
                    disabled={txSend.isPending}
                  >
                    Claim Timeout
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Agent: Applications list + Assign (with staking) */}
          {isAgent && onChain.status === TaskStatus.Funded && (
            <div className="card-dark overflow-hidden mb-6">
              <div className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">Applications</h2>
                <span className="px-2 py-0.5 rounded-full bg-neutral-800 text-[10px] text-neutral-400 font-mono">
                  {applications?.length || 0} Total
                </span>
              </div>
              <div className="divide-y divide-neutral-800">
                {!applications || applications.length === 0 ? (
                  <div className="px-6 py-10 text-center">
                    <p className="text-sm text-neutral-500 italic">No applications yet. Your task is being broadcast to the agent network.</p>
                  </div>
                ) : (
                  applications.map((app: any) => (
                    <div key={app.id} className="px-6 py-4 hover:bg-white/[0.02] transition-colors group">
                      <div className="flex items-start justify-between">
                        <div className="flex gap-4">
                          <div className="w-8 h-8 rounded-lg bg-neutral-800 border border-neutral-700 flex items-center justify-center text-neutral-400">
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                            </svg>
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-white font-mono">{truncateAddress(app.applicant)}</span>
                              <ReputationBadge address={app.applicant} />
                            </div>
                            <p className="text-xs text-neutral-500 mt-1 line-clamp-2 max-w-md">
                              {app.message || "No application message provided."}
                            </p>
                            <span className="text-[10px] text-neutral-700 mt-2 block italic">
                              Applied {formatDate(new Date(app.created_at))}
                            </span>
                          </div>
                        </div>
                        <button
                          className="btn-accent text-[10px] py-1.5 px-3 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap"
                          onClick={() => handleApplyWithStake(app.applicant)}
                          disabled={txSend.isPending}
                        >
                          Stake & Accept
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Worker: Already assigned */}
          {isWorker && onChain.status === TaskStatus.Assigned && (
            <div className="card-dark p-6 mb-6 border-amber-500/20">
              <div className="text-center">
                <div className="w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-3">
                  <svg className="w-5 h-5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-white font-semibold mb-1">You are assigned to this task</p>
                <p className="text-sm text-neutral-500">Go to your Worker Dashboard to decrypt instructions and submit evidence.</p>
              </div>
            </div>
          )}
        </>
      )}
    </motion.div>
  );
}
