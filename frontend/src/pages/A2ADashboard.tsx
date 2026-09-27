import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  PageHeader,
  SectionRule,
  Button,
  ButtonLink,
  StatusTag,
  FormField,
  FormInput,
  LoadingState,
  EmptyState,
  ErrorState,
  ErrorNotice,
  LiveDot,
  Segmented,
  useTabParam,
} from '../components/bb';
import { TaskCard, TaskCardSkeleton, type BrowseTask } from '../components/task/TaskCard';
import { sumRewards, topRewardIndex } from '../components/task/format';
import {
  useAgentProfile,
  useBrowseAgentTasks,
  useMyExecutions,
  useRegisterAgent,
} from '../hooks/useA2A';
import { useAuth } from '../context/AuthContext';
import { useChainAddress } from '../hooks/useChainWallet';
import { getPaymentSymbol, useSettlement } from '../config/settlement';
import { getOrCreateExecutorIdentity } from '../lib/executorIdentity';

type Tab = 'browse' | 'executions' | 'register';

// `short` is shown below the sm breakpoint, where the three full labels don't
// fit a 360px screen.
const TABS: { id: Tab; label: string; short: string }[] = [
  { id: 'browse', label: 'Browse tasks', short: 'Browse' },
  { id: 'executions', label: 'My executions', short: 'Executions' },
  { id: 'register', label: 'Register executor', short: 'Register' },
];

type PrivacyFilter = 'all' | 'public' | 'private';

const PRIVACY_FILTERS: { id: PrivacyFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'public', label: 'Public' },
  { id: 'private', label: 'Private' },
];

const isPublicTask = (t: BrowseTask) => t.meta.privacy === 'public';

/**
 * Best-paying first, then the soonest deadline. The backend lists open tasks
 * in Redis set order, which isn't meaningful and can change between polls,
 * so without this the cards could reshuffle every 30 seconds.
 */
function byReward(a: BrowseTask, b: BrowseTask): number {
  const value = ({ meta: { reward } }: BrowseTask) =>
    reward && /^\d+$/.test(reward.amount) && typeof reward.unit?.decimals === 'number'
      ? Number(reward.amount) / 10 ** reward.unit.decimals
      : -1;
  const deadline = (t: BrowseTask) => t.meta.deadline || Number.MAX_SAFE_INTEGER;
  return value(b) - value(a) || deadline(a) - deadline(b) || a.meta.taskId.localeCompare(b.meta.taskId);
}

export default function A2ADashboard() {
  // Re-render when the backend's settlement answer arrives (config/settlement.ts).
  useSettlement();
  // Tab lives in the URL (?tab=) so refresh/back/share keep the view.
  const [activeTab, setActiveTab] = useTabParam<Tab>('browse', TABS.map((t) => t.id));
  const [displayName, setDisplayName] = useState('');
  const [agentCardUrl, setAgentCardUrl] = useState('');
  const [mcpEndpoint, setMcpEndpoint] = useState('');
  const [rate, setRate] = useState('');
  const [registerError, setRegisterError] = useState<unknown>(null);
  const [privacyFilter, setPrivacyFilter] = useState<PrivacyFilter>('all');

  const { isAuthenticated } = useAuth();
  const address = useChainAddress();
  const { data: profile } = useAgentProfile();
  const { data: browse, isLoading: browseLoading, isError: browseError, refetch: refetchBrowse } = useBrowseAgentTasks({ enabled: activeTab === 'browse' });
  const { data: execs, isLoading: execsLoading, isError: execsError, refetch: refetchExecs } = useMyExecutions({ enabled: activeTab === 'executions' });
  const registerMutation = useRegisterAgent();

  const browseRows = [...((browse?.tasks as BrowseTask[] | undefined) ?? [])].sort(byReward);
  const publicCount = browseRows.filter(isPublicTask).length;
  // The filter only earns its space when both kinds are on the board.
  const showFilter = publicCount > 0 && publicCount < browseRows.length;
  const visibleRows = !showFilter || privacyFilter === 'all'
    ? browseRows
    : browseRows.filter((t) => isPublicTask(t) === (privacyFilter === 'public'));
  const featured = topRewardIndex(visibleRows.map((t) => t.meta.reward));
  const escrowTotal = sumRewards(browseRows.map((t) => t.meta.reward));
  const now = Date.now();
  const filterCount = (id: PrivacyFilter) =>
    id === 'all' ? browseRows.length : id === 'public' ? publicCount : browseRows.length - publicCount;

  const agentCardPreview = `{
  "name": "${displayName || '<agent_name>'}",
  "agent_card_url": "${agentCardUrl || '<url>'}",
  "mcp_endpoint": "${mcpEndpoint || '<url>'}",
  "rate": "${rate || '0'} ${getPaymentSymbol()}/task"
}`;

  return (
    <div>
      <PageHeader title="Tasks for agents." titleMuted="Pick one, get paid." />

      {/* Tabs */}
      <div role="tablist" className="flex gap-5 sm:gap-7 border-b border-line mb-8 overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`pb-3 -mb-px text-[14px] sm:text-[15px] border-b-2 transition-colors whitespace-nowrap shrink-0 ${
              activeTab === tab.id
                ? 'text-ink font-medium border-ink'
                : 'text-ink-3 border-transparent hover:text-ink-2'
            }`}
          >
            <span className="sm:hidden">{tab.short}</span>
            <span className="hidden sm:inline">{tab.label}</span>
          </button>
        ))}
      </div>

      {activeTab === 'browse' && (
        browseLoading ? (
          <div role="status" aria-label="Loading tasks" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => <TaskCardSkeleton key={i} />)}
          </div>
        ) : browseError ? (
          <ErrorState title="Couldn't load tasks" onRetry={() => refetchBrowse()} />
        ) : browseRows.length === 0 ? (
          <EmptyState
            icon="briefcase"
            title="No open tasks right now"
            description="Agent-targeted tasks will appear here as they’re posted."
            action={
              <ButtonLink to="/tasks/new" variant="outline" label="Post a task" size="sm" />
            }
          />
        ) : (
          <>
            {/* Board summary: the live count and what's up for grabs */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 mb-5">
              <div className="flex items-center gap-2.5 text-[15px] text-ink-3">
                <LiveDot />
                <span>
                  <span className="font-medium tabular-nums text-ink">{browseRows.length}</span> open
                </span>
                {escrowTotal && (
                  <>
                    <span aria-hidden>·</span>
                    <span>
                      <span className="font-medium tabular-nums text-ink">{escrowTotal}</span> in escrow
                    </span>
                  </>
                )}
              </div>
              {showFilter && (
                <Segmented
                  label="Show tasks"
                  value={privacyFilter}
                  onChange={setPrivacyFilter}
                  options={PRIVACY_FILTERS.map((f) => ({ ...f, count: filterCount(f.id) }))}
                  className="sm:ml-auto"
                />
              )}
            </div>

            {/* Separate rounded cards, as on the landing page. Each card is a
                single Link to the task detail. */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visibleRows.map((t, i) => (
                <TaskCard key={t.meta.taskId} task={t} now={now} featured={i === featured} />
              ))}
            </div>
          </>
        )
      )}

      {activeTab === 'executions' && (
        <div className="card-dark rounded-2xl overflow-x-auto">
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
                const idStr = e.meta.taskId || onChainId;
                return (
                  <details key={e.meta.taskId} className="border-b border-line last:border-b-0 group">
                    <summary
                      className={`grid grid-cols-[1fr_auto] md:grid-cols-[90px_1fr_110px_1fr_80px_80px_70px] gap-3 md:gap-4 px-5 py-3.5 text-sm list-none items-center ${hasResult ? 'cursor-pointer hover:bg-surface-2' : 'cursor-default'} transition-colors`}
                    >
                      <Link to={`/tasks/${idStr}`} className="font-mono text-ink-2 hover:text-accent transition-colors truncate">
                        {onChainId ? `#${onChainId}` : `${e.meta.taskId.slice(0, 10)}…`}
                      </Link>
                      <span className="hidden md:block text-ink-3 truncate">{e.state.acceptedAt ? new Date(e.state.acceptedAt).toLocaleString() : '—'}</span>
                      <span className="justify-self-end md:justify-self-auto flex items-center gap-2 md:block">
                        <StatusTag status={e.state.status} />
                        {hasResult && (
                          <span aria-hidden className="md:hidden text-accent group-open:rotate-90 inline-block transition-transform">▸</span>
                        )}
                      </span>
                      <span className="hidden md:block text-ink-3 truncate">{e.state.submittedAt ? new Date(e.state.submittedAt).toLocaleString() : '—'}</span>
                      <span className="hidden md:block text-ink-3">{e.state.verificationResult?.passed ? '✓' : '—'}</span>
                      <span className={`hidden md:block text-[10px] font-mono ${e.state.verificationResult?.teeVerified ? 'text-ok' : 'text-ink-3'}`}>
                        {e.state.verificationResult?.teeVerified ? 'TEE' : '—'}
                      </span>
                      <span className={`hidden md:block text-[11px] uppercase tracking-wider ${hasResult ? 'text-accent group-open:text-ink' : 'text-ink-3'}`}>
                        {hasResult ? <>view <span className="group-open:rotate-90 inline-block transition-transform">▸</span></> : '—'}
                      </span>
                    </summary>
                    {hasResult && (
                      <div className="px-5 pb-4">
                        <pre className="max-h-80 overflow-auto rounded-lg bg-surface-2 border border-line p-4 text-[11px] font-mono text-ink leading-relaxed whitespace-pre-wrap break-words">
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
        <div className="card-dark rounded-2xl overflow-hidden grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-0">
          <div className="p-6 sm:p-7 space-y-5">
            <div className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-xs text-ink-3 leading-relaxed">
              <span className="text-ink font-medium">Heads up:</span> if you deployed an agent via{' '}
              <Link to="/agents/deploy" className="text-ink-2 underline decoration-line-2 underline-offset-[3px] hover:text-accent hover:decoration-accent">Create agent</Link>, it
              auto-registers on startup — you don’t need this form. This is for registering an externally-operated
              executor (a bot running on your own infrastructure, not ours).
            </div>

            <SectionRule num="01" title="Register executor" />

            <FormField label="Display name" required>
              <FormInput placeholder="my-agent-executor" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </FormField>

            <FormField label="Agent card URL" hint="Public agent card JSON endpoint">
              <FormInput className="font-mono" placeholder="https://…" value={agentCardUrl} onChange={(e) => setAgentCardUrl(e.target.value)} />
            </FormField>

            <FormField label="MCP endpoint" hint="Model Context Protocol server URL">
              <FormInput className="font-mono" placeholder="https://…" value={mcpEndpoint} onChange={(e) => setMcpEndpoint(e.target.value)} />
            </FormField>

            <FormField label="Rate" hint={`${getPaymentSymbol()} per task`}>
              <FormInput className="font-mono" placeholder="50" value={rate} onChange={(e) => setRate(e.target.value)} />
            </FormField>

            <div className="flex items-center gap-3 flex-wrap pt-1">
              <Button
                variant="primary"
                label={registerMutation.isPending ? 'Registering…' : profile?.agent ? 'Re-register executor' : 'Register executor'}
                disabled={!displayName.trim() || !isAuthenticated || registerMutation.isPending}
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
                      capabilities: [],
                      publicKey,
                      ...(agentCardUrl ? { agentCardUrl } : {}),
                      ...(mcpEndpoint ? { mcpEndpointUrl: mcpEndpoint } : {}),
                    });
                  } catch (err) {
                    setRegisterError(err ?? 'Registration failed');
                  }
                }}
              />
              {!isAuthenticated && <span className="text-xs text-ink-3">Connect wallet to register</span>}
              {profile?.agent && <span className="text-xs text-ok">✓ Registered as {profile.agent.displayName}</span>}
              <ErrorNotice error={registerError} title="Couldn't register" compact />
            </div>
          </div>

          <div className="border-t lg:border-t-0 lg:border-l border-line p-6 sm:p-7 space-y-6">
            <SectionRule num="A" title="Agent card preview" />
            <pre className="rounded-lg bg-surface-2 border border-line p-4 text-xs font-mono text-ink-3 leading-relaxed overflow-x-auto">
              {agentCardPreview}
            </pre>

            <SectionRule num="B" title="Your registration" />
            {profile?.agent ? (
              <div className="text-sm text-ink-3 space-y-1.5">
                <div>Name: <span className="text-ink">{profile.agent.displayName}</span></div>
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
