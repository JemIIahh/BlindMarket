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
import { buildAssignTask, buildCancelTask } from '../services/tasks';
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

  const handleApply = () => {
    if (!id) return;
    applyMutation.mutate({ taskId: id, message: applyMessage || undefined });
    setShowApplyForm(false);
    setApplyMessage('');
  };

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
                {showApplyForm ? (
                  <div className="space-y-4">
                    <Textarea
                      label="Application Message (optional)"
                      placeholder="Why are you a good fit for this task?"
                      value={applyMessage}
                      onChange={(e) => setApplyMessage(e.target.value)}
                      rows={3}
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        loading={applyMutation.isPending}
                        onClick={handleApply}
                      >
                        Submit Application
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setShowApplyForm(false)}>
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

          {/* Agent: Applications list + Assign (with staking) */}
          {isAgent && applications && applications.length > 0 && (
            <div className="card-dark mb-6 overflow-hidden">
              <div className="px-6 py-4 border-b border-neutral-800">
                <h2 className="text-sm font-semibold text-white">Applications ({applications.length})</h2>
              </div>
              <div className="divide-y divide-neutral-800">
                {applications.map((app) => (
                  <div key={app.id} className="flex items-center justify-between px-6 py-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-neutral-300 font-mono">{truncateAddress(app.applicant)}</p>
                        <ReputationBadge address={app.applicant} />
                      </div>
                      {app.message && (
                        <p className="text-sm text-neutral-500 mt-0.5">{app.message}</p>
                      )}
                    </div>
                    {onChain.status === TaskStatus.Funded && (
                      <button
                        className="btn-accent text-xs py-1.5 px-4"
                        onClick={() => handleApplyWithStake(app.applicant)}
                        disabled={txSend.isPending}
                      >
                        Assign
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Agent: Cancel */}
          {isAgent && onChain.status === TaskStatus.Funded && (
            <div className="flex justify-end">
              <button
                className="px-4 py-2 rounded-lg border border-red-900/50 text-red-400 text-sm font-medium hover:border-red-700 hover:text-red-300 transition-colors disabled:opacity-50"
                onClick={handleCancel}
                disabled={txSend.isPending}
              >
                Cancel Task & Refund
              </button>
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
