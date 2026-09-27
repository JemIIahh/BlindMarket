import { useState } from 'react';
import { useCustodyChain, useAuditLog } from '../hooks/useCustody';
import { verifyIntegrity } from '../services/custody';
import type { IntegrityResult } from '../services/custody';
import { truncateAddress } from '../lib/utils';
import { useAuth } from '../context/AuthContext';
import { Button, Tag, Icon, LoadingState } from './bb';

// Audit actions → semantic Tag tones (the same ok/warn/err/info scale the
// rest of the app uses — no bespoke colour system here).
const ACTION_TONE: Record<string, 'ok' | 'warn' | 'err' | 'info' | 'neutral'> = {
  submitted: 'info',
  viewed: 'neutral',
  verified: 'ok',
  exported: 'warn',
  integrity_check: 'info',
};

export function CustodyChain({ taskId }: { taskId: string }) {
  const { isAuthenticated } = useAuth();
  const { data: chainData, isLoading: chainLoading } = useCustodyChain(taskId);
  const { data: auditData, isLoading: auditLoading } = useAuditLog(taskId);
  const [integrityResult, setIntegrityResult] = useState<IntegrityResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [activeTab, setActiveTab] = useState<'chain' | 'audit'>('chain');

  const handleVerify = async () => {
    setVerifying(true);
    try {
      const result = await verifyIntegrity(taskId);
      setIntegrityResult(result);
    } catch (err) {
      console.error('Integrity check failed:', err);
    } finally {
      setVerifying(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="py-8 text-center space-y-3">
        <div className="w-12 h-12 rounded-full bg-surface-2 border border-line flex items-center justify-center mx-auto mb-2">
          <Icon name="lock" size={22} className="text-ink-3" />
        </div>
        <p className="text-sm text-ink-2">Sign in required</p>
        <p className="text-xs text-ink-3 max-w-xs mx-auto">
          Sign in to view the cryptographic evidence chain and audit log for this task.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Tab selector — same treatment as TaskDetail's page tabs */}
      <div role="tablist" className="flex gap-6 border-b border-line">
        {([
          { id: 'chain', label: 'Evidence chain' },
          { id: 'audit', label: 'Audit log' },
        ] as const).map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`pb-2.5 -mb-px text-xs border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'text-ink font-medium border-ink'
                : 'text-ink-3 border-transparent hover:text-ink-2'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Verify integrity */}
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={handleVerify}
          disabled={verifying}
          label={verifying ? 'Checking…' : 'Verify integrity'}
        />
        {integrityResult && (
          <Tag tone={integrityResult.valid ? 'ok' : 'err'}>
            {integrityResult.valid ? 'PASS' : 'FAIL'}
          </Tag>
        )}
      </div>

      {/* Chain tab */}
      {activeTab === 'chain' && (
        <div className="relative">
          {chainLoading ? (
            <LoadingState label="Loading evidence chain…" />
          ) : !chainData?.chain?.length ? (
            <div className="text-sm text-ink-3">No evidence entries yet.</div>
          ) : (
            <div className="space-y-0">
              {chainData.chain.map((entry, i) => (
                <div key={entry.id} className="flex gap-3">
                  {/* Timeline dots & line */}
                  <div className="flex flex-col items-center">
                    <div className="w-2.5 h-2.5 rounded-full bg-accent mt-1.5 z-10" />
                    {i < chainData.chain.length - 1 && <div className="w-px flex-1 bg-line" />}
                  </div>
                  {/* Entry card */}
                  <div className="flex-1 pb-4">
                    <div className="rounded-xl border border-line bg-surface-2 p-3.5">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-2xs text-ink-3">
                          #{entry.id} &middot; {new Date(entry.created_at).toLocaleString()}
                        </span>
                      </div>
                      <p className="text-xs text-ink-2 font-mono break-all">{entry.evidence_hash}</p>
                      <p className="text-2xs text-ink-3 mt-1">
                        Submitter: {truncateAddress(entry.submitter)}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Audit tab */}
      {activeTab === 'audit' && (
        <div>
          {auditLoading ? (
            <LoadingState label="Loading audit log…" />
          ) : !auditData?.audit?.length ? (
            <div className="text-sm text-ink-3">No audit events yet.</div>
          ) : (
            <div className="space-y-2">
              {auditData.audit.map((event) => (
                <div key={event.id} className="flex items-start gap-3 py-2">
                  <Tag tone={ACTION_TONE[event.action] ?? 'neutral'}>{event.action.replace(/_/g, ' ')}</Tag>
                  <div className="flex-1">
                    <p className="text-xs text-ink-2 font-mono">{truncateAddress(event.actor)}</p>
                    {event.detail && <p className="text-2xs text-ink-3 mt-0.5">{event.detail}</p>}
                  </div>
                  <span className="text-2xs text-ink-3">{new Date(event.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
