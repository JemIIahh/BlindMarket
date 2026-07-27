import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  PageHeader,
  SectionRule,
  Button,
  Tag,
  StatusTag,
  FormField,
  FormInput,
  LoadingState,
  EmptyState,
  ErrorState,
  useTabParam,
} from '../components/bb';
import {
  useAgentProfile,
  useBrowseAgentTasks,
  useMyExecutions,
  useRegisterAgent,
} from '../hooks/useA2A';
import { useAuth } from '../context/AuthContext';
import { useChainAddress } from '../hooks/useChainWallet';
import { getOrCreateExecutorIdentity } from '../lib/executorIdentity';
import { AGENT_CAPABILITIES as ALL_CAPABILITIES } from '../config/capabilities';

type Tab = 'browse' | 'executions' | 'register';

const TABS: { id: Tab; label: string }[] = [
  { id: 'browse', label: 'Browse tasks' },
  { id: 'executions', label: 'My executions' },
  { id: 'register', label: 'Register executor' },
];

type BrowseRow = {
  meta: {
    taskId: string;
    requiredCapabilities: string[];
    verificationMode: string;
    targetExecutorType: string;
    // Present only on public tasks — poster opted out of blindness, so the
    // brief itself is browsable (see backend projectPublicMeta).
    privacy?: 'public';
    publicBrief?: string;
  };
  state: { status: string };
  onChain?: { taskId?: string };
};

export default function A2ADashboard() {
  // Tab lives in the URL (?tab=) so refresh/back/share keep the view.
  const [activeTab, setActiveTab] = useTabParam<Tab>('browse', TABS.map((t) => t.id));
  const [displayName, setDisplayName] = useState('');
  const [selectedCaps, setSelectedCaps] = useState<string[]>([]);
  const [agentCardUrl, setAgentCardUrl] = useState('');
  const [mcpEndpoint, setMcpEndpoint] = useState('');
  const [rate, setRate] = useState('');
  const [registerError, setRegisterError] = useState<string | null>(null);

  const { isAuthenticated } = useAuth();
  const address = useChainAddress();
  const { data: profile } = useAgentProfile();
  const { data: browse, isLoading: browseLoading, isError: browseError, refetch: refetchBrowse } = useBrowseAgentTasks({ enabled: activeTab === 'browse' });
  const { data: execs, isLoading: execsLoading, isError: execsError, refetch: refetchExecs } = useMyExecutions({ enabled: activeTab === 'executions' });
  const registerMutation = useRegisterAgent();

  const toggleCap = (cap: string) =>
    setSelectedCaps((prev) => (prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]));

  const taskId = (e: { meta: { taskId: string }; onChain?: { taskId?: string } }) => e.onChain?.taskId || e.meta.taskId;
  const taskLabel = (e: { meta: { taskId: string }; onChain?: { taskId?: string } }) =>
    e.onChain?.taskId ? `#${e.onChain.taskId}` : `${e.meta.taskId.slice(0, 10)}…`;

  const browseRows = (browse?.tasks as BrowseRow[] | undefined) ?? [];

  const agentCardPreview = `{
  "name": "${displayName || '<agent_name>'}",
  "capabilities": [${selectedCaps.map((c) => `"${c}"`).join(', ')}],
  "agent_card_url": "${agentCardUrl || '<url>'}",
  "mcp_endpoint": "${mcpEndpoint || '<url>'}",
  "rate": "${rate || '0'} 0G/task"
}`;

  return (
    <div>
      <PageHeader
        title="Marketplace"
        description="Browse open agent tasks, accept and execute, and track your runs. Auto-verified and settled on-chain — no human in the loop."
      />

      {/* Tabs */}
      <div role="tablist" className="flex gap-6 border-b border-line mb-8 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`pb-3 -mb-px text-sm border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === tab.id
                ? 'text-ink font-medium border-cream'
                : 'text-ink-3 border-transparent hover:text-ink-2'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'browse' && (
        browseLoading ? (
          <LoadingState label="Loading tasks…" />
        ) : browseError ? (
          <ErrorState title="Couldn't load tasks" onRetry={() => refetchBrowse()} />
        ) : browseRows.length === 0 ? (
          <EmptyState
            icon="briefcase"
            title="No open tasks right now"
            description="Agent-targeted tasks will appear here as they’re posted."
            action={
              <Link to="/tasks/new">
                <Button variant="outline" label="Post a task" size="sm" />
              </Link>
            }
          />
        ) : (
          /* Connected card grid — shared 1px borders, sharp corners (BlindMarket
             grid idiom). Each card is a single Link to the task detail. */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 border-t border-l border-line">
            {browseRows.map((r) => (
              <Link
                key={r.meta.taskId}
                to={`/tasks/${taskId(r)}`}
                className="group flex flex-col gap-4 border-b border-r border-line p-5 min-h-[180px] hover:bg-surface-2 transition-colors"
              >
                {/* identifier + status */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-2xs uppercase tracking-wider text-ink-3">Task</div>
                    <div className="font-mono text-sm text-ink truncate group-hover:text-cream transition-colors">
                      {taskLabel(r)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {r.meta.privacy === 'public' && <Tag tone="neutral">public</Tag>}
                    <StatusTag status={r.state.status} />
                  </div>
                </div>

                {/* public tasks: the brief IS the pitch — show it */}
                {r.meta.privacy === 'public' && r.meta.publicBrief && (
                  <p className="text-xs text-ink-2 leading-relaxed line-clamp-2">
                    {r.meta.publicBrief}
                  </p>
                )}

                {/* required capabilities */}
                <div className="flex flex-wrap gap-1.5">
                  {r.meta.requiredCapabilities.length > 0 ? (
                    r.meta.requiredCapabilities.map((c) => (
                      <Tag key={c} tone="neutral">{c}</Tag>
                    ))
                  ) : (
                    <span className="text-xs text-ink-3">No specific capabilities</span>
                  )}
                </div>

                <div className="flex-1" />

                {/* footer: meta + view affordance */}
                <div className="flex items-end justify-between border-t border-line -mx-5 px-5 pt-3">
                  <div className="flex gap-5">
                    <div>
                      <div className="text-2xs uppercase tracking-wider text-ink-3">Verify</div>
                      <div className="text-xs text-ink-2 capitalize">{r.meta.verificationMode}</div>
                    </div>
                    <div>
                      <div className="text-2xs uppercase tracking-wider text-ink-3">Target</div>
                      <div className="text-xs text-ink-2 capitalize">{r.meta.targetExecutorType}</div>
                    </div>
                  </div>
                  <span className="text-2xs uppercase tracking-wider text-ink-3 group-hover:text-cream transition-colors">
                    View →
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )
      )}

      {activeTab === 'executions' && (
        <div className="border border-line overflow-x-auto">
          {execsLoading ? (
            <LoadingState label="Loading executions…" />
          ) : execsError ? (
            <ErrorState title="Couldn't load executions" onRetry={() => refetchExecs()} />
          ) : !execs?.executions || execs.executions.length === 0 ? (
            <EmptyState
              icon="list"
              title={isAuthenticated ? 'No executions yet' : 'Connect your wallet'}
              description={
                isAuthenticated
                  ? 'Register as an executor and accept a task to see your runs here.'
                  : 'Connect a wallet to see the tasks your agents have executed.'
              }
            />
          ) : (
            <>
                  <div className="hidden md:grid grid-cols-[90px_1fr_110px_1fr_80px_80px_70px] gap-4 px-5 py-3 border-b border-line text-[11px] font-medium uppercase tracking-wider text-ink-3">
                <span>Task</span><span>Accepted</span><span>Status</span><span>Submitted</span><span>Verified</span><span>TEE</span><span>Result</span>
              </div>
              {execs.executions.map((e) => {
                const hasResult = !!e.state.resultData;
                const onChainId = (e as any).onChain?.taskId;
                const idStr = onChainId || e.meta.taskId;
                return (
                  <details key={e.meta.taskId} className="border-b border-line last:border-b-0 group">
                    <summary
                      className={`grid grid-cols-[1fr_auto] md:grid-cols-[90px_1fr_110px_1fr_80px_80px_70px] gap-3 md:gap-4 px-5 py-3.5 text-sm list-none items-center ${hasResult ? 'cursor-pointer hover:bg-surface-2' : 'cursor-default'} transition-colors`}
                    >
                      <Link to={`/tasks/${idStr}`} className="font-mono text-ink-2 hover:text-cream transition-colors truncate">
                        {onChainId ? `#${onChainId}` : `${e.meta.taskId.slice(0, 10)}…`}
                      </Link>
                      <span className="hidden md:block text-ink-3 truncate">{e.state.acceptedAt ? new Date(e.state.acceptedAt).toLocaleString() : '—'}</span>
                      <span className="justify-self-end md:justify-self-auto"><StatusTag status={e.state.status} /></span>
                      <span className="hidden md:block text-ink-3 truncate">{e.state.submittedAt ? new Date(e.state.submittedAt).toLocaleString() : '—'}</span>
                      <span className="hidden md:block text-ink-3">{e.state.verificationResult?.passed ? '✓' : '—'}</span>
                      <span className={`hidden md:block text-[10px] font-mono ${e.state.verificationResult?.teeVerified ? 'text-ok' : 'text-ink-3/40'}`}>
                        {e.state.verificationResult?.teeVerified ? 'TEE' : '—'}
                      </span>
                      <span className={`hidden md:block text-[11px] uppercase tracking-wider ${hasResult ? 'text-cream group-open:text-ink' : 'text-ink-3/50'}`}>
                        {hasResult ? <>view <span className="group-open:rotate-90 inline-block transition-transform">▸</span></> : '—'}
                      </span>
                    </summary>
                    {hasResult && (
                      <div className="px-5 pb-4">
                        <pre className="max-h-80 overflow-auto bg-surface-2 border border-line p-4 text-[11px] font-mono text-ink leading-relaxed whitespace-pre-wrap break-words">
                          {JSON.stringify(e.state.resultData, null, 2)}
                        </pre>
                      </div>
                    )}
                  </details>
                );
              })}
            </>
          )}
        </div>
      )}

      {activeTab === 'register' && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-0 border border-line">
          <div className="p-6 space-y-5">
            <div className="border border-line bg-surface-2 px-4 py-3 text-xs text-ink-3 leading-relaxed">
              <span className="text-cream font-medium">Heads up:</span> if you deployed an agent via{' '}
              <Link to="/agents/deploy" className="text-ink-2 underline hover:text-cream">Create agent</Link>, it
              auto-registers on startup — you don’t need this form. This is for registering an externally-operated
              executor (a bot running on your own infrastructure, not ours).
            </div>

            <SectionRule num="01" title="Register executor" />

            <FormField label="Display name" required>
              <FormInput placeholder="my-agent-executor" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </FormField>

            <FormField label="Capabilities" required hint={`${selectedCaps.length} selected`}>
              <div className="flex flex-wrap gap-1.5">
                {ALL_CAPABILITIES.map((cap) => (
                  <button
                    key={cap}
                    type="button"
                    onClick={() => toggleCap(cap)}
                    className={`px-2.5 py-1 text-xs border transition-colors ${
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

            <FormField label="Agent card URL" hint="Public agent card JSON endpoint">
              <FormInput className="font-mono" placeholder="https://…" value={agentCardUrl} onChange={(e) => setAgentCardUrl(e.target.value)} />
            </FormField>

            <FormField label="MCP endpoint" hint="Model Context Protocol server URL">
              <FormInput className="font-mono" placeholder="https://…" value={mcpEndpoint} onChange={(e) => setMcpEndpoint(e.target.value)} />
            </FormField>

            <FormField label="Rate" hint="0G per task">
              <FormInput className="font-mono" placeholder="50" value={rate} onChange={(e) => setRate(e.target.value)} />
            </FormField>

            <div className="flex items-center gap-3 flex-wrap pt-1">
              <Button
                variant="primary"
                label={registerMutation.isPending ? 'Registering…' : profile?.agent ? 'Re-register executor' : 'Register executor'}
                disabled={!displayName.trim() || selectedCaps.length === 0 || !isAuthenticated || registerMutation.isPending}
                onClick={async () => {
                  setRegisterError(null);
                  if (!address) {
                    setRegisterError('Connect a wallet before registering');
                    return;
                  }
                  try {
                    const { publicKey } = getOrCreateExecutorIdentity(address);
                    await registerMutation.mutateAsync({
                      displayName,
                      capabilities: selectedCaps,
                      publicKey,
                      ...(agentCardUrl ? { agentCardUrl } : {}),
                      ...(mcpEndpoint ? { mcpEndpointUrl: mcpEndpoint } : {}),
                    });
                  } catch (err) {
                    setRegisterError((err as Error).message || 'Registration failed');
                  }
                }}
              />
              {!isAuthenticated && <span className="text-xs text-ink-3">Connect wallet to register</span>}
              {profile?.agent && <span className="text-xs text-ok">✓ Registered as {profile.agent.displayName}</span>}
              {registerError && <span className="text-xs text-err break-all">{registerError}</span>}
            </div>
          </div>

          <div className="border-t lg:border-t-0 lg:border-l border-line p-6 space-y-6">
            <SectionRule num="A" title="Agent card preview" />
            <pre className="bg-surface-2 border border-line p-4 text-xs font-mono text-ink-3 leading-relaxed overflow-x-auto">
              {agentCardPreview}
            </pre>

            <SectionRule num="B" title="Your registration" />
            {profile?.agent ? (
              <div className="text-sm text-ink-3 space-y-1.5">
                <div>Name: <span className="text-ink">{profile.agent.displayName}</span></div>
                <div>Capabilities: <span className="text-ink font-mono">{profile.agent.capabilities.length}</span></div>
                <div>Reputation: <span className="text-ink font-mono">{profile.agent.reputation.toFixed(1)}</span></div>
                <div>Tasks: <span className="text-ink font-mono">{profile.agent.tasksCompleted}</span></div>
              </div>
            ) : (
              <p className="text-sm text-ink-3">
                {isAuthenticated ? 'No registration yet. Fill the form to register.' : 'Connect wallet to view your registration.'}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
