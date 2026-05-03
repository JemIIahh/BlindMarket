import { useState } from 'react';
import {
  Breadcrumb,
  PageHeader,
  SectionRule,
  Panel,
  StatCard,
  Button,
  Tag,
  FormField,
  FormInput,
  FormTextarea,
} from '../components/bb';
import { useTriggerVerification, useVerificationStatus } from '../hooks/useVerification';
import { useAuth } from '../context/AuthContext';
import type { VerificationResult } from '../types/api';

export default function VerificationStatus() {
  const [activeTab, setActiveTab] = useState<'trigger' | 'result'>('trigger');
  const [taskId, setTaskId] = useState('');
  const [taskCategory, setTaskCategory] = useState('');
  const [requirements, setRequirements] = useState('');
  const [evidenceSummary, setEvidenceSummary] = useState('');

  const { isAuthenticated } = useAuth();
  const { data: teeStatus } = useVerificationStatus();
  const trigger = useTriggerVerification();
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const handleTrigger = async () => {
    setTriggerError(null);
    setResult(null);
    try {
      const res = await trigger.mutateAsync({
        taskId: parseInt(taskId, 10),
        taskCategory,
        taskRequirements: requirements,
        evidenceSummary,
      });
      setResult(res);
      setActiveTab('result');
    } catch (err) {
      setTriggerError((err as Error).message || 'verification failed');
    }
  };

  return (
    <div>
      <Breadcrumb items={['account', 'verification']} />
      <PageHeader
        title="Verification"
        description="TEE-attested evidence verification · cryptographic custody chain."
      />

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 border border-line mb-8">
        <StatCard
          label="sealed inference"
          value={teeStatus?.configured ? 'ONLINE' : 'OFFLINE'}
          sub={teeStatus?.configured ? '0g compute ready' : 'not configured'}
          subColor={teeStatus?.configured ? 'ok' : 'warn'}
        />
        <div className="border-l border-line">
          <StatCard label="status" value="—" sub="connect to view" />
        </div>
        <div className="border-l border-line">
          <StatCard label="last result" value={result ? (result.passed ? 'PASS' : 'FAIL') : '—'} sub={result ? `${(result.confidence * 100).toFixed(1)}% conf` : 'no run yet'} subColor={result ? (result.passed ? 'ok' : 'err') : undefined} />
        </div>
        <div className="border-l border-line">
          <StatCard label="network" value="0g" sub="galileo testnet" subColor="ok" />
        </div>
      </div>

      {teeStatus && !teeStatus.configured && (
        <div className="mb-6 px-4 py-3 border border-warn/40 bg-warn/10 text-xs font-mono text-warn">
          {teeStatus.message}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-6 border-b border-line mb-8">
        {(['trigger', 'result'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`pb-2.5 text-xs font-mono font-semibold tracking-widest transition-colors border-b -mb-px ${
              activeTab === tab
                ? 'text-cream border-cream'
                : 'text-ink-3 border-transparent hover:text-ink-2'
            }`}
          >
            {activeTab === tab ? '▸ ' : ''}{tab}
          </button>
        ))}
      </div>

      {/* Trigger tab */}
      {activeTab === 'trigger' && (
        <div className="grid grid-cols-[1fr_340px] gap-0 border border-line">
          <div className="p-6 space-y-5">
            <SectionRule num="01" title="trigger sealed verification" />

            <FormField label="task_id" required>
              <FormInput
                placeholder="e.g., 1847"
                value={taskId}
                onChange={(e) => setTaskId(e.target.value)}
              />
            </FormField>

            <FormField label="category">
              <FormInput
                placeholder="e.g., knowledge_access"
                value={taskCategory}
                onChange={(e) => setTaskCategory(e.target.value)}
              />
            </FormField>

            <FormField label="requirements" hint="what was the worker asked to do?">
              <FormTextarea
                rows={3}
                placeholder="describe task requirements..."
                value={requirements}
                onChange={(e) => setRequirements(e.target.value)}
              />
            </FormField>

            <FormField label="evidence_summary" hint="summary of submitted evidence">
              <FormTextarea
                rows={4}
                placeholder="summary of the worker's submitted evidence..."
                value={evidenceSummary}
                onChange={(e) => setEvidenceSummary(e.target.value)}
              />
            </FormField>

            <div className="flex items-center gap-3 flex-wrap">
              <Button
                variant="primary"
                label={trigger.isPending ? 'verifying…' : 'seal_and_verify'}
                disabled={!taskId || !requirements || !evidenceSummary || !isAuthenticated || trigger.isPending}
                onClick={handleTrigger}
              />
              <Button
                variant="ghost"
                label="reset"
                onClick={() => {
                  setTaskId('');
                  setTaskCategory('');
                  setRequirements('');
                  setEvidenceSummary('');
                  setResult(null);
                  setTriggerError(null);
                }}
              />
              {!isAuthenticated && (
                <span className="text-[11px] font-mono text-ink-3">connect wallet to verify</span>
              )}
              {triggerError && (
                <span className="text-[11px] font-mono text-err break-all">{triggerError}</span>
              )}
            </div>
          </div>

          {/* Right rail */}
          <div className="border-l border-line p-6 space-y-6">
            <SectionRule num="I" title="what the enclave checks" />

            <div className="space-y-4">
              {[
                { n: '01', desc: 'fetch encrypted evidence blob from 0g storage' },
                { n: '02', desc: 'decrypt inside intel tdx enclave — data never leaves' },
                { n: '03', desc: 'run sealed inference model on plaintext evidence' },
                { n: '04', desc: 'compare against task requirements — output pass/fail + confidence' },
                { n: '05', desc: 'sign attestation with enclave key — post to 0g chain' },
              ].map((step) => (
                <div key={step.n} className="flex gap-3">
                  <span className="text-cream font-mono text-xs font-bold mt-0.5">[{step.n}]</span>
                  <p className="text-xs font-mono text-ink-3 leading-relaxed">{step.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Result tab */}
      {activeTab === 'result' && (
        <Panel>
          <SectionRule num="02" title="last verification result" />
          {result ? (
            <div className="mt-4 space-y-4">
              <div className="flex items-center gap-3">
                <Tag tone={result.passed ? 'ok' : 'err'}>{result.passed ? 'PASSED' : 'FAILED'}</Tag>
                <span className="text-xs font-mono text-ink">confidence {(result.confidence * 100).toFixed(1)}%</span>
                {result.model && <span className="text-[11px] font-mono text-ink-3">model: {result.model}</span>}
              </div>
              {result.reasoning && (
                <div>
                  <div className="text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3 mb-2">tee reasoning</div>
                  <pre className="bg-surface-2 border border-line p-4 text-xs font-mono text-ink-3 leading-relaxed whitespace-pre-wrap">
                    {result.reasoning}
                  </pre>
                </div>
              )}
              {result.attestation && (
                <div>
                  <div className="text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3 mb-2">attestation</div>
                  <div className="bg-surface-2 border border-line p-3 text-[11px] font-mono text-ink-3 break-all">
                    {result.attestation}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="py-12 text-center text-xs font-mono text-ink-3">
              no result yet. trigger a verification from the first tab.
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
