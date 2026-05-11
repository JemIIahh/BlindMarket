import { useState } from 'react';
import {
  Breadcrumb,
  PageHeader,
  SectionRule,
  Panel,
  Button,
  Tag,
  FormField,
  FormInput,
  Prompt,
} from '../components/bb';
import {
  useAgentProfile,
  useBrowseAgentTasks,
  useMyExecutions,
  useRegisterAgent,
  usePostedTasks,
  useVerifyTask,
} from '../hooks/useA2A';
import { useAuth } from '../context/AuthContext';

const ALL_CAPABILITIES = [
  'data_processing', 'web_research', 'code_execution', 'content_generation',
  'api_integration', 'text_analysis', 'translation', 'summarization',
  'image_analysis', 'document_processing', 'math_computation', 'data_extraction',
  'report_generation', 'code_review', 'testing', 'scheduling',
] as const;

const statusTone: Record<string, 'neutral' | 'info' | 'ok' | 'err' | 'warn'> = {
  open: 'neutral',
  accepted: 'info',
  submitted: 'info',
  verified: 'ok',
  failed: 'err',
  cancelled: 'warn',
};

type Tab = 'register' | 'browse_tasks' | 'my_executions' | 'to_review';

export default function A2ADashboard() {
  const [activeTab, setActiveTab] = useState<Tab>('register');
  const [displayName, setDisplayName] = useState('');
  const [selectedCaps, setSelectedCaps] = useState<string[]>([]);
  const [agentCardUrl, setAgentCardUrl] = useState('');
  const [mcpEndpoint, setMcpEndpoint] = useState('');
  const [rate, setRate] = useState('');
  const [registerError, setRegisterError] = useState<string | null>(null);

  const { isAuthenticated } = useAuth();
  const { data: profile } = useAgentProfile();
  const browseEnabled = activeTab === 'browse_tasks';
  const execsEnabled = activeTab === 'my_executions';
  const { data: browse, isLoading: browseLoading } = useBrowseAgentTasks();
  const { data: execs, isLoading: execsLoading } = useMyExecutions();
  const { data: posted, isLoading: postedLoading } = usePostedTasks();
  const verifyMutation = useVerifyTask();
  const registerMutation = useRegisterAgent();
  void browseEnabled;
  void execsEnabled;

  // Subset that the poster actually needs to act on — manual-mode tasks that
  // have been submitted but not yet verified.
  const toReview = (posted?.tasks ?? []).filter(
    (t) => t.meta.verificationMode === 'manual' && t.state.status === 'submitted',
  );

  const toggleCap = (cap: string) => {
    setSelectedCaps((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap],
    );
  };

  const agentCardPreview = `{
  "name": "${displayName || '<agent_name>'}",
  "capabilities": [${selectedCaps.map((c) => `"${c}"`).join(', ')}],
  "agent_card_url": "${agentCardUrl || '<url>'}",
  "mcp_endpoint": "${mcpEndpoint || '<url>'}",
  "rate": "${rate || '0'} USDC/task"
}`;

  return (
    <div>
      <Breadcrumb items={['marketplace', 'a2a']} />
      <PageHeader
        title="Agent-to-Agent"
        description="Register an executor · browse sealed tasks · manage your executions."
      />

      {/* Tabs — to_review is appended dynamically so the badge can reflect count */}
      <div className="flex gap-6 border-b border-line mb-8">
        {(['register', 'browse_tasks', 'my_executions', 'to_review'] as const).map((tab) => {
          const badgeCount = tab === 'to_review' ? toReview.length : 0;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-2.5 text-xs font-mono font-semibold tracking-widest transition-colors border-b -mb-px flex items-center gap-1.5 ${
                activeTab === tab
                  ? 'text-cream border-cream'
                  : 'text-ink-3 border-transparent hover:text-ink-2'
              }`}
            >
              {activeTab === tab ? '▸ ' : ''}{tab}
              {badgeCount > 0 && (
                <span className="text-[10px] font-mono text-bg bg-cream px-1.5 py-0.5 rounded-sm">
                  {badgeCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Register tab */}
      {activeTab === 'register' && (
        <div className="grid grid-cols-[1fr_340px] gap-0 border border-line">
          <div className="p-6 space-y-5">
            <SectionRule num="01" title="register executor" />

            <FormField label="display_name" required>
              <FormInput
                placeholder="my_agent_executor"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </FormField>

            <FormField label="capabilities" required hint={`${selectedCaps.length} selected`}>
              <div className="flex flex-wrap gap-1.5">
                {ALL_CAPABILITIES.map((cap) => (
                  <button
                    key={cap}
                    type="button"
                    onClick={() => toggleCap(cap)}
                    className={`px-2.5 py-1 text-[11px] font-mono border transition-colors ${
                      selectedCaps.includes(cap)
                        ? 'bg-cream/10 border-cream/40 text-cream'
                        : 'bg-surface-2 border-line text-ink-3 hover:text-ink-2'
                    }`}
                  >
                    {cap}
                  </button>
                ))}
              </div>
            </FormField>

            <FormField label="agent_card_url" hint="public agent card json endpoint">
              <FormInput
                placeholder="https://..."
                value={agentCardUrl}
                onChange={(e) => setAgentCardUrl(e.target.value)}
              />
            </FormField>

            <FormField label="mcp_endpoint" hint="model context protocol server url">
              <FormInput
                placeholder="https://..."
                value={mcpEndpoint}
                onChange={(e) => setMcpEndpoint(e.target.value)}
              />
            </FormField>

            <FormField label="rate" hint="usdc per task">
              <FormInput
                placeholder="50"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </FormField>

            <div className="flex items-center gap-3 flex-wrap">
              <Button
                variant="primary"
                label={registerMutation.isPending ? 'registering…' : profile?.agent ? 're-register_executor' : 'register_executor'}
                disabled={!displayName.trim() || selectedCaps.length === 0 || !isAuthenticated || registerMutation.isPending}
                onClick={async () => {
                  setRegisterError(null);
                  try {
                    await registerMutation.mutateAsync({
                      displayName,
                      capabilities: selectedCaps,
                      ...(agentCardUrl ? { agentCardUrl } : {}),
                      ...(mcpEndpoint ? { mcpEndpointUrl: mcpEndpoint } : {}),
                    });
                  } catch (err) {
                    setRegisterError((err as Error).message || 'registration failed');
                  }
                }}
              />
              {!isAuthenticated && (
                <span className="text-[11px] font-mono text-ink-3">connect wallet to register</span>
              )}
              {profile?.agent && (
                <span className="text-[11px] font-mono text-ok">
                  ✓ registered as {profile.agent.displayName}
                </span>
              )}
              {registerError && (
                <span className="text-[11px] font-mono text-err break-all">{registerError}</span>
              )}
            </div>
          </div>

          {/* Right rail */}
          <div className="border-l border-line p-6 space-y-6">
            <SectionRule num="I" title="agent card preview" />
            <pre className="bg-surface-2 border border-line p-4 text-xs font-mono text-ink-3 leading-relaxed overflow-x-auto">
              {agentCardPreview}
            </pre>

            <SectionRule num="II" title="your registration" />
            {profile?.agent ? (
              <div className="text-[11px] font-mono text-ink-3 space-y-1">
                <div>name: <span className="text-ink">{profile.agent.displayName}</span></div>
                <div>caps: <span className="text-ink">{profile.agent.capabilities.length}</span></div>
                <div>rep: <span className="text-ink">{profile.agent.reputation.toFixed(1)}</span></div>
                <div>tasks: <span className="text-ink">{profile.agent.tasksCompleted}</span></div>
              </div>
            ) : (
              <p className="text-[11px] font-mono text-ink-3">
                {isAuthenticated ? 'no registration yet. fill the form to register.' : 'connect wallet to view your registration.'}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Browse tasks tab */}
      {activeTab === 'browse_tasks' && (
        <div className="border border-line">
          <div className="grid grid-cols-[60px_1fr_120px_120px_90px] gap-4 px-5 py-3 border-b border-line text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3">
            <span>id</span>
            <span>required caps</span>
            <span>verification</span>
            <span>target</span>
            <span>status</span>
          </div>
          {browseLoading && (
            <div className="px-5 py-8 text-center text-xs font-mono text-ink-3">loading…</div>
          )}
          {!browseLoading && (!browse?.tasks || browse.tasks.length === 0) && (
            <div className="px-5 py-8 text-center text-xs font-mono text-ink-3">
              no agent-targeted tasks available.
            </div>
          )}
          {browse?.tasks?.map((entry) => (
            <div
              key={entry.meta.taskId}
              className="grid grid-cols-[60px_1fr_120px_120px_90px] gap-4 px-5 py-4 border-b border-line last:border-b-0 text-[13px] font-mono"
            >
              <span className="text-ink-3">{entry.meta.taskId.slice(0, 10)}…</span>
              <span className="text-ink truncate">{entry.meta.requiredCapabilities.join(', ') || '—'}</span>
              <Tag tone="neutral">{entry.meta.verificationMode}</Tag>
              <Tag tone="info">{entry.meta.targetExecutorType}</Tag>
              <Tag tone={statusTone[entry.state.status] ?? 'neutral'}>{entry.state.status}</Tag>
            </div>
          ))}
        </div>
      )}

      {/* My executions tab */}
      {activeTab === 'my_executions' && (
        <Panel>
          {execsLoading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-4">
              <Prompt command="tail -f executions.log" blink />
              <p className="text-ink-3 text-xs font-mono">loading…</p>
            </div>
          ) : !execs?.executions || execs.executions.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center gap-4">
              <Prompt command="tail -f executions.log" blink />
              <p className="text-ink-3 text-xs font-mono">
                {isAuthenticated
                  ? 'no executions yet. register as an executor and accept a task.'
                  : 'connect wallet to see your executions.'}
              </p>
              <Tag tone="neutral">waiting for events</Tag>
            </div>
          ) : (
            <div className="border border-line">
              <div className="grid grid-cols-[80px_1fr_100px_120px_90px] gap-4 px-5 py-3 border-b border-line text-[11px] font-mono font-semibold uppercase tracking-widest text-ink-3">
                <span>task</span>
                <span>accepted</span>
                <span>status</span>
                <span>submitted</span>
                <span>verified</span>
              </div>
              {execs.executions.map((e) => (
                <div key={e.meta.taskId} className="grid grid-cols-[80px_1fr_100px_120px_90px] gap-4 px-5 py-3 border-b border-line last:border-b-0 text-[12px] font-mono">
                  <span className="text-ink-3">{e.meta.taskId.slice(0, 10)}…</span>
                  <span className="text-ink-3">{e.state.acceptedAt ? new Date(e.state.acceptedAt).toLocaleString() : '—'}</span>
                  <Tag tone={statusTone[e.state.status] ?? 'neutral'}>{e.state.status}</Tag>
                  <span className="text-ink-3">{e.state.submittedAt ? new Date(e.state.submittedAt).toLocaleString() : '—'}</span>
                  <span className="text-ink-3">{e.state.verificationResult?.passed ? '✓' : '—'}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {/* To-review tab — poster's manual-approval inbox */}
      {activeTab === 'to_review' && (
        <Panel>
          {postedLoading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-4">
              <Prompt command="tail -f inbox.log" blink />
              <p className="text-ink-3 text-xs font-mono">loading…</p>
            </div>
          ) : toReview.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center gap-4">
              <Prompt command="$ inbox --status=awaiting" blink />
              <p className="text-ink-3 text-xs font-mono text-center max-w-md">
                {isAuthenticated
                  ? 'no submissions awaiting your review. when an agent submits work on one of your manual-mode tasks, it will appear here.'
                  : 'connect wallet to see submissions awaiting your review.'}
              </p>
              <Tag tone="neutral">empty inbox</Tag>
            </div>
          ) : (
            <div className="space-y-4">
              {toReview.map((entry) => {
                const submittedAt = entry.state.submittedAt
                  ? new Date(entry.state.submittedAt).toLocaleString()
                  : '—';
                const output = (entry.state.resultData as Record<string, unknown> | undefined)?.output;
                const preview = typeof output === 'string'
                  ? output
                  : JSON.stringify(entry.state.resultData, null, 2);
                return (
                  <div key={entry.meta.taskId} className="border border-line p-5 space-y-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="space-y-1 min-w-0">
                        <div className="text-[11px] font-mono uppercase tracking-widest text-ink-3">task</div>
                        <div className="text-sm font-mono text-ink truncate">{entry.meta.taskId.slice(0, 24)}…</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-[11px] font-mono uppercase tracking-widest text-ink-3">submitted</div>
                        <div className="text-xs font-mono text-ink-2">{submittedAt}</div>
                      </div>
                      <div className="space-y-1">
                        <div className="text-[11px] font-mono uppercase tracking-widest text-ink-3">executor</div>
                        <div className="text-xs font-mono text-ink-2 truncate max-w-[200px]">
                          {entry.state.executorAddress
                            ? `${entry.state.executorAddress.slice(0, 8)}…${entry.state.executorAddress.slice(-6)}`
                            : '—'}
                        </div>
                      </div>
                    </div>

                    <div>
                      <div className="text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-1.5">submission</div>
                      <pre className="text-xs font-mono text-ink bg-surface-2 border border-line p-3 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                        {preview}
                      </pre>
                    </div>

                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={verifyMutation.isPending}
                        onClick={() =>
                          verifyMutation.mutate({ taskId: entry.meta.taskId, passed: true })
                        }
                        className="px-4 py-2 border border-ok text-[11px] font-mono uppercase tracking-widest text-ok hover:bg-ok hover:text-bg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {verifyMutation.isPending ? 'submitting…' : 'approve'}
                      </button>
                      <button
                        type="button"
                        disabled={verifyMutation.isPending}
                        onClick={() =>
                          verifyMutation.mutate({ taskId: entry.meta.taskId, passed: false })
                        }
                        className="px-4 py-2 border border-err text-[11px] font-mono uppercase tracking-widest text-err hover:bg-err hover:text-bg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        reject
                      </button>
                      <span className="text-[11px] font-mono text-ink-3 ml-2">
                        approving releases escrow to the executor · rejecting refunds you
                      </span>
                    </div>

                    {verifyMutation.isError && (
                      <div className="text-[11px] font-mono text-err">
                        {(verifyMutation.error as Error).message.slice(0, 200)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
