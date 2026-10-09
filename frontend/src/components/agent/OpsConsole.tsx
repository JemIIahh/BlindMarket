import { useState, useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '../../context/AuthContext';
import {
  Tag,
  Button,
  Icon,
  FormField,
  FormInput,
  FormSelect,
  FormTextarea,
  LoadingState,
  Toggle,
  useTabParam,
  ErrorNotice,
} from '../bb';
import { authedDelete, authedGet, authedPatch, authedPost, getAuthHeaders } from '../../lib/api';
import { API_BASE_URL } from '../../config/constants';
import { getPaymentSymbol } from '../../config/settlement';
import { restartAgent, saveOwnerToggle } from '../../lib/ownerToggle';
import { useOpenSubmissionConfig } from '../../hooks/useOpenSubmission';
import { formatPaymentAmount, parsePaymentAmount } from '../../lib/paymentUnits';
import { ToolManager, type AnyTool } from '../bb/ToolManager';
import AgentMetricsPanel from '../AgentMetricsPanel';
import { UsagePanel } from './UsagePanel';
import { AgentTasks } from './AgentTasks';
import { SkillsManager } from './SkillsManager';
import { WebhooksPanel } from './WebhooksPanel';
import type { AgentDetails, InstalledSkillMeta } from './types';
import {
  CUSTOM_MODEL, isKeyed, isPriced, liveListError, liveListRequest, modelLabel, modelOptions,
  providerLabel, usdPer1M, withModel, type ModelOption,
} from '../../lib/llmModels';

type Tab = 'logs' | 'errors' | 'tasks' | 'tools' | 'webhooks' | 'edit' | 'metrics';

const TAB_LABELS: Record<Tab, string> = {
  logs: 'Logs',
  errors: 'Errors',
  tasks: 'Tasks',
  tools: 'Tools',
  webhooks: 'Webhooks',
  edit: 'Edit',
  metrics: 'Metrics',
};

const TAB_ICONS: Record<Tab, string> = {
  logs: 'list',
  errors: 'alert',
  tasks: 'briefcase',
  tools: 'settings',
  webhooks: 'send',
  edit: 'compose',
  metrics: 'chart',
};

const TABS = Object.keys(TAB_LABELS) as Tab[];

/**
 * Owner-only operations console. Everything a buyer has no use for lives
 * here — including the log stream, which visitors no longer open at all
 * because this component (and its live log connection) never mounts for them.
 *
 * Mount with key={agent.id} so the edit form re-initialises when the route
 * switches to a different agent.
 */
export function OpsConsole({
  agentId,
  agent,
  onAgentUpdated,
  className = '',
}: {
  agentId: string;
  agent: AgentDetails;
  onAgentUpdated: (agent: AgentDetails) => void;
  className?: string;
}) {
  const { isAuthenticated } = useAuth();
  const [tab, setTab] = useTabParam<Tab>('logs', TABS);

  // Logs (SSE, capped at 200 lines)
  const [logs, setLogs] = useState<string[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Tool error logs
  const [errorLogs, setErrorLogs] = useState<any[]>([]);
  const [errorLogsTotal, setErrorLogsTotal] = useState(0);
  const [errorLogsLoading, setErrorLogsLoading] = useState(false);
  const [clearErrorsFailed, setClearErrorsFailed] = useState<unknown>(null);

  // Edit form — seeded from the loaded agent; the page remounts this
  // component when the agent changes, so no re-sync effect is needed.
  const [editInstructions, setEditInstructions] = useState(agent.instructions ?? '');
  const [editProvider, setEditProvider] = useState(agent.provider ?? '');
  const [editModel, setEditModel] = useState(agent.model ?? '');
  const [editApiKey, setEditApiKey] = useState('');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [providers, setProviders] = useState<Record<string, string[]>>({});
  const [pricing, setPricing] = useState<Record<string, ModelOption[]>>({});
  // The provider's own list: with a new key once one is pasted, else with the
  // key the agent runs on. The catalog stands in until it answers.
  const [live, setLive] = useState<{ provider: string; models: ModelOption[] } | null>(null);
  const [liveStatus, setLiveStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [liveError, setLiveError] = useState('');
  // The new key as last pasted or blurred: a half-typed key is never sent.
  const [committedKey, setCommittedKey] = useState('');
  // An id the owner types, for a model the list doesn't have yet. Saving
  // checks it against the provider's list with the key.
  const [customModel, setCustomModel] = useState(false);
  // Capabilities deprecated — semantic KNN is the primary routing signal.
  // Removed from save payload; capabilities still stored as metadata for embeddings.
  const [editMinReward, setEditMinReward] = useState(
    // Decimal-preserving: integer BigInt division floored a fractional
    // minReward (0.5 -> '0'), which Save then persisted as 0, silently
    // disabling the min-reward gate so the agent accepted 0-reward tasks.
    // Stored in settlement-token base units (USDC: 6 decimals).
    agent.minReward ? formatPaymentAmount(agent.minReward) : '',
  );
  const [editTools, setEditTools] = useState<AnyTool[]>((agent.tools ?? []) as AnyTool[]);
  const [toolsSaved, setToolsSaved] = useState(false);
  const [installedSkills, setInstalledSkills] = useState<InstalledSkillMeta[]>(agent.skills ?? []);

  // Fetch available providers + models for the edit form (authed route).
  useEffect(() => {
    if (!isAuthenticated) return;
    authedGet<{ models?: Record<string, string[]>; pricing?: Record<string, ModelOption[]> }>('/api/v1/agents/providers')
      .then(r => {
        if (r.models) setProviders(r.models);
        if (r.pricing) setPricing(r.pricing);
      })
      .catch(() => {});
  }, [isAuthenticated]);

  // The live list, once the Edit tab is open (each lookup asks the provider).
  useEffect(() => {
    if (!isAuthenticated || tab !== 'edit') return;
    const request = liveListRequest({ provider: editProvider, newKey: committedKey, agentId, agentProvider: agent.provider });
    if (!request) { setLive(null); setLiveStatus('idle'); return; }
    let cancelled = false;
    setLiveStatus('loading');
    authedPost<{ provider: string; models: ModelOption[] }>(request.path, request.body)
      .then(d => {
        if (cancelled) return;
        setLive(d.models.length > 0 ? d : null);
        setLiveStatus(d.models.length > 0 ? 'ok' : 'error');
        setLiveError(d.models.length > 0 ? '' : `${providerLabel(editProvider)} listed no chat models for this key — showing our defaults`);
      })
      .catch((err: { code?: string; status?: number }) => {
        if (cancelled) return;
        setLive(null);
        setLiveStatus('error');
        setLiveError(liveListError(editProvider, err));
      });
    return () => { cancelled = true; };
  }, [isAuthenticated, tab, editProvider, committedKey, agentId, agent.provider]);

  // The agent's own model stays on the list even when the provider no longer lists it.
  const editModelOptions = withModel(modelOptions(editProvider, live, providers[editProvider] ?? [], pricing[editProvider]), editModel);
  const editModelPrice = editModelOptions.find(m => m.id === editModel.trim());

  // Log stream — a fetch-based SSE reader. The old browser SSE client could
  // not send an Authorization header, and the route is now owner-gated
  // (requireAuth + authorizeOwner). A 401/403 here is terminal (no retry) —
  // retrying an auth failure every 3s would hammer the API forever with no
  // visible error. Genuine network hiccups still reconnect with backoff.
  useEffect(() => {
    if (!agentId) return;
    const ctrl = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    function scheduleRetry() {
      if (cancelled) return;
      retryTimer = setTimeout(connect, 3000);
    }

    async function connect() {
      let res: Response;
      try {
        res = await fetch(`${API_BASE_URL}/api/v1/agents/${agentId}/logs`, {
          headers: await getAuthHeaders(),
          signal: ctrl.signal,
        });
      } catch {
        // Network error (offline, DNS, connection reset, or our own abort on
        // unmount) — retry with backoff; aborts no-op once cancelled is true.
        scheduleRetry();
        return;
      }

      if (res.status === 401 || res.status === 403) {
        // Terminal — do NOT retry, or an unauthorised viewer hammers the API
        // forever with no visible sign anything is wrong.
        setLogsError('Not authorised to view this agent\'s logs.');
        return;
      }

      if (!res.ok || !res.body) {
        // Any other failure (5xx, no body) is treated as transient.
        scheduleRetry();
        return;
      }

      setLogsError(null);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const payload = frame
              .split('\n')
              .filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).replace(/^ /, ''))
              .join('\n');
            if (!payload) continue;
            try { setLogs(prev => [...prev.slice(-199), JSON.parse(payload)]); } catch { }
          }
        }
      } catch {
        // Stream aborted (unmount) or dropped mid-read — fall through to the
        // reconnect below; a no-op once cancelled.
      }
      scheduleRetry();
    }
    connect();

    return () => {
      cancelled = true;
      ctrl.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [agentId]);

  // Fetch error logs for the errors tab
  useEffect(() => {
    if (!agentId || tab !== 'errors') return;
    let cancelled = false;
    setClearErrorsFailed(null);
    setErrorLogsLoading(true);
    authedGet<{ entries: any[]; total: number }>(`/api/v1/tools/error-logs?agentId=${agentId}`)
      .then((result) => {
        if (!cancelled) {
          setErrorLogs(result.entries);
          setErrorLogsTotal(result.total);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setErrorLogsLoading(false); });
    return () => { cancelled = true; };
  }, [agentId, tab]);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Auto-scroll to bottom when the logs tab is first opened
  useEffect(() => {
    if (tab === 'logs' && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [tab]);

  const refreshLogs = async () => {
    try {
      // authedGet already unwraps the {success, data} envelope (see
      // handleResponse in lib/api.ts), so the resolved value IS the line
      // array — typing it as the envelope and reading `res?.data` was always
      // undefined, silently blanking the pane on every Refresh click.
      const lines = await authedGet<string[]>(`/api/v1/agents/${agentId}/logs/json`);
      setLogs(Array.isArray(lines) ? lines.slice(-200) : []);
      setLogsError(null);
    } catch { }
  };

  const scrollToBottom = () => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      setAutoScroll(true);
    }
  };

  const scrollToTop = () => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = 0;
      setAutoScroll(false);
    }
  };

  const handleLogScroll = () => {
    if (!logContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logContainerRef.current;
    setAutoScroll(scrollTop + clientHeight >= scrollHeight - 20);
  };

  // authedPatch so the Privy JWT flows to the backend, where requireAuth +
  // authorizeOwner verify the caller (no more plaintext ownerAddress claim).
  // After saving, auto-restart the agent so instruction/provider/model changes
  // take effect immediately (the running worker holds spawn-time config). A
  // restart that fails after the save is reported as that, never as a failed
  // save (lib/ownerToggle.ts), and the page shows what was saved.
  const agentRunning = agent.status === 'running' || agent.status === 'active';
  const [saveRestartError, setSaveRestartError] = useState<unknown>(null);
  const save = useMutation({
    mutationFn: async () => {
      const data = await authedPatch<AgentDetails>(`/api/v1/agents/${agentId}`, {
        instructions: editInstructions,
        provider: editProvider,
        model: editModel.trim(),
        ...(editApiKey ? { apiKey: editApiKey } : {}),
        minReward: editMinReward.trim()
          ? parsePaymentAmount(editMinReward).toString()
          : undefined,
      });
      // Auto-restart if agent is running so changes take effect.
      if (!agentRunning) return { data, restartError: null };
      const restarted = await restartAgent<AgentDetails>(authedPost, agentId);
      return { data: restarted.agent ?? data, restartError: restarted.restartError };
    },
    onMutate: () => setSaveRestartError(null),
    onSuccess: ({ data, restartError }) => {
      onAgentUpdated(data);
      if (restartError) setSaveRestartError(restartError);
      else setTab('logs');
    },
  });

  // Verifier duty is the owner's opt-in: when on, posters may name this agent
  // as a task's verifier, and it judges and settles those rounds on this
  // agent's model and gas. Applied on restart, like the settings above.
  // The switch shows what the server stored; a restart that fails after the
  // save is reported as that, never as a failed save (lib/ownerToggle.ts).
  const [verifierEnabled, setVerifierEnabled] = useState(agent.verifierEnabled === true);
  const [verifierRestartError, setVerifierRestartError] = useState<unknown>(null);
  const saveVerifier = useMutation({
    mutationFn: (enabled: boolean) => saveOwnerToggle<AgentDetails>(authedPost, agentId, 'verifier', enabled, agentRunning),
    onMutate: (enabled) => { setVerifierEnabled(enabled); setVerifierRestartError(null); },
    onError: () => setVerifierEnabled(agent.verifierEnabled === true),
    onSuccess: ({ enabled, agent: latest, restartError }) => {
      setVerifierEnabled(enabled);
      setVerifierRestartError(restartError);
      onAgentUpdated({ ...agent, ...latest, verifierEnabled: enabled });
    },
  });

  // Delegation is the owner's opt-in too: when on, the agent can pay other
  // agents from its wallet for part of a task. A task's brief can ask it to,
  // so it is off by default. Applied on restart, like verifier duty.
  const [delegationEnabled, setDelegationEnabled] = useState(agent.delegationEnabled === true);
  const [delegationRestartError, setDelegationRestartError] = useState<unknown>(null);
  const saveDelegation = useMutation({
    mutationFn: (enabled: boolean) => saveOwnerToggle<AgentDetails>(authedPost, agentId, 'delegation', enabled, agentRunning),
    onMutate: (enabled) => { setDelegationEnabled(enabled); setDelegationRestartError(null); },
    onError: () => setDelegationEnabled(agent.delegationEnabled === true),
    onSuccess: ({ enabled, agent: latest, restartError }) => {
      setDelegationEnabled(enabled);
      setDelegationRestartError(restartError);
      onAgentUpdated({ ...agent, ...latest, delegationEnabled: enabled });
    },
  });

  // Open submission is the owner's opt-in as well: when on, the agent works
  // tasks many agents submit to, and each try spends its model and gas
  // whether or not it wins. Shown only when this server runs open
  // submission. Applied on restart, like the two above.
  const openSubmissionConfig = useOpenSubmissionConfig();
  const [openSubmissionEnabled, setOpenSubmissionEnabled] = useState(agent.openSubmissionEnabled === true);
  const [openSubmissionRestartError, setOpenSubmissionRestartError] = useState<unknown>(null);
  const saveOpenSubmission = useMutation({
    mutationFn: (enabled: boolean) => saveOwnerToggle<AgentDetails>(authedPost, agentId, 'open-submission', enabled, agentRunning),
    onMutate: (enabled) => { setOpenSubmissionEnabled(enabled); setOpenSubmissionRestartError(null); },
    onError: () => setOpenSubmissionEnabled(agent.openSubmissionEnabled === true),
    onSuccess: ({ enabled, agent: latest, restartError }) => {
      setOpenSubmissionEnabled(enabled);
      setOpenSubmissionRestartError(restartError);
      onAgentUpdated({ ...agent, ...latest, openSubmissionEnabled: enabled });
    },
  });

  const saveTools = useMutation({
    mutationFn: () =>
      authedPatch<AgentDetails>(`/api/v1/agents/${agentId}`, {
        tools: editTools,
      }),
    onSuccess: (data) => { onAgentUpdated(data); setToolsSaved(true); },
  });

  return (
    <div className={`card-dark overflow-hidden flex flex-col min-w-0 ${className}`}>
      {/* Tab strip — active tab tinted bg, visually attached to panel */}
      <div
        role="tablist"
        className="flex border-b border-line overflow-x-auto [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: 'none' }}
      >
        {TABS.map(t => {
          const active = tab === t;
          return (
            <button
              key={t}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t)}
              className={`flex items-center gap-2 px-4 pt-3 pb-3 -mb-px text-sm whitespace-nowrap border-b-2 transition-colors shrink-0 ${
                active
                  ? 'text-ink border-accent font-medium'
                  : 'text-ink-3 border-transparent hover:bg-surface-2 hover:text-ink-2'
              }`}
            >
              <Icon name={TAB_ICONS[t]} size={16} />
              {TAB_LABELS[t]}
            </button>
          );
        })}
      </div>

      <div className="flex-1 relative">
        {/* The 520px clamp belongs to the streams only — it was sized for the
            log console and used to squash every other panel with it. */}
        {tab === 'logs' && (
          <div
            className={`p-5 overflow-y-auto max-h-[520px] ${logs.length > 0 ? 'pr-12' : ''}`}
            ref={logContainerRef}
            onScroll={handleLogScroll}
          >
            {logsError ? (
              <div className="flex flex-col items-center gap-2 py-10">
                <Icon name="lock" size={20} className="text-ink-3" />
                <p className="text-xs text-ink-3">{logsError}</p>
              </div>
            ) : logs.length > 0 ? logs.map((line, i) => {
              const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
              const tsMatch = clean.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:Z|))\s+(.*)$/);
              const isErr = clean.includes('[err]');
              return (
                <div key={i} className={`px-3 py-1.5 text-xs font-mono flex flex-col gap-0.5 sm:flex-row sm:gap-3 ${isErr ? 'text-err bg-[color:color-mix(in_srgb,var(--bb-err)_8%,transparent)]' : 'text-ink-3 hover:bg-surface-2'}`}>
                  {tsMatch ? (
                    <>
                      <span className="text-ink-3 opacity-70 shrink-0" title={tsMatch[1]}>
                        {new Date(tsMatch[1].replace('Z', '').replace(' ', 'T') + 'Z').toLocaleString([], { hour12: false })}
                      </span>
                      <span className="break-all">{tsMatch[2]}</span>
                    </>
                  ) : (
                    <span className="break-all">{clean}</span>
                  )}
                </div>
              );
            }            ) : (
              <div className="flex flex-col items-center gap-2 py-10">
                <Icon name="list" size={20} className="text-ink-3" />
                <p className="text-xs text-ink-3">
                  {agent.status === 'running' ? 'Waiting for logs…' : 'No logs yet'}
                </p>
                <button
                  onClick={refreshLogs}
                  className="text-xs text-ink-3 hover:text-ink transition-colors flex items-center gap-1 mt-1"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 8a6 6 0 0 1 10.472-4M14 8a6 6 0 0 1-10.472 4" />
                    <path d="M14 2v4h-4M2 14v-4h4" />
                  </svg>
                  Refresh
                </button>
              </div>
            )}
          </div>
        )}

        {tab === 'errors' && (
          <div className="p-5 overflow-y-auto max-h-[520px]">
            <div className="flex items-center justify-between mb-4">
              <div className="text-xs text-ink-3">
                {errorLogsTotal > 0 ? `${errorLogsTotal} error(s) logged` : 'No errors'}
              </div>
              {errorLogsTotal > 0 && (
                <button
                  onClick={() => {
                    setClearErrorsFailed(null);
                    authedDelete(`/api/v1/tools/error-logs?agentId=${encodeURIComponent(agentId)}`)
                      .then(() => { setErrorLogs([]); setErrorLogsTotal(0); })
                      .catch((err) => setClearErrorsFailed(err ?? 'Could not clear the error log.'));
                  }}
                  className="px-2 py-1.5 -mx-2 -my-1.5 text-xs text-ink-3 hover:text-ink transition-colors"
                >
                  Clear all
                </button>
              )}
            </div>
            <ErrorNotice error={clearErrorsFailed} title="Couldn't clear the error log" compact className="mb-4" />
            {errorLogsLoading ? (
              <LoadingState />
            ) : errorLogs.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10">
                <Icon name="check" size={20} className="text-ink-3" />
                <p className="text-xs text-ink-3">No errors — tool executions are clean.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {errorLogs.map((e: any) => (
                  <div key={e.id} className="rounded-xl border border-line p-4 space-y-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-sm font-medium text-ink break-all">{e.toolName}</span>
                      <Tag tone="neutral">{e.toolType}</Tag>
                      {e.statusCode != null && (
                        <Tag tone={e.statusCode >= 400 ? 'warn' : 'neutral'}>
                          HTTP {e.statusCode}
                        </Tag>
                      )}
                      <span className="text-xs text-ink-3 ml-auto">{new Date(e.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="text-sm text-ink-3 break-words">{e.error}</div>
                    {e.method && e.url && (
                      <div className="text-xs font-mono text-ink-3 break-all">
                        {e.method} {e.url}
                      </div>
                    )}
                    {e.requestInput && e.requestInput !== '{}' && (
                      <details className="text-xs text-ink-3">
                        <summary className="cursor-pointer hover:text-ink-2">Request input</summary>
                        <pre className="mt-1 rounded-lg p-2.5 bg-surface-2 border border-line overflow-x-auto whitespace-pre-wrap">{e.requestInput}</pre>
                      </details>
                    )}
                    {e.responseOutput && (
                      <details className="text-xs text-ink-3">
                        <summary className="cursor-pointer hover:text-ink-2">Response output</summary>
                        <pre className="mt-1 rounded-lg p-2.5 bg-surface-2 border border-line overflow-x-auto whitespace-pre-wrap">{e.responseOutput}</pre>
                      </details>
                    )}
                    {e.durationMs > 0 && (
                      <div className="text-xs text-ink-3">Duration: {e.durationMs}ms</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'tasks' && (
          <div className="p-5">
            <AgentTasks agentWallet={agent.walletAddress} />
          </div>
        )}

        {tab === 'tools' && (
          <div className="p-5 space-y-4">
            {toolsSaved && (
              <div className="rounded-xl border border-line-2 bg-surface-2 p-4 text-sm text-ink-2">
                Tools saved. <strong>Restart the agent</strong> for changes to take effect — stop then start.
              </div>
            )}
            <ToolManager
              tools={editTools}
              onChange={setEditTools}
            />
            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                onClick={() => saveTools.mutate()}
                disabled={saveTools.isPending}
                label={saveTools.isPending ? 'Saving…' : 'Save tools'}
              />
              {saveTools.isError && <span className="text-xs text-err">Save failed</span>}
            </div>
          </div>
        )}

        {tab === 'webhooks' && (
          <div className="p-5">
            <WebhooksPanel agentId={agentId} />
          </div>
        )}

        {tab === 'edit' && (
          <div className="p-5 space-y-5">
            <FormField label="Instructions">
              <FormTextarea rows={6} value={editInstructions} onChange={e => setEditInstructions(e.target.value)} />
            </FormField>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label="Provider">
                <div className="flex items-center gap-2">
                  <FormSelect value={editProvider} onChange={e => {
                    const p = e.target.value;
                    setEditProvider(p);
                    // A key belongs to one provider: never send it to another.
                    setEditApiKey('');
                    setCommittedKey('');
                    setCustomModel(false);
                    const models = providers[p];
                    if (models?.length) setEditModel(models[0]);
                  }}>
                    {Object.keys(providers).length === 0 && <option value={editProvider}>{editProvider ? providerLabel(editProvider) : 'Loading…'}</option>}
                    {Object.keys(providers).map(p => <option key={p} value={p}>{providerLabel(p)}</option>)}
                  </FormSelect>
                  {editProvider === agent.provider && (
                    <span className="flex items-center gap-1 text-xs text-ok shrink-0">
                      <Icon name="check" size={14} /> configured
                    </span>
                  )}
                </div>
              </FormField>

              <FormField
                label="Model"
                hint={
                  customModel ? `Checked against ${providerLabel(editProvider)}'s model list with the key when you save.`
                  : liveStatus === 'loading' ? 'Checking which models the key can use…'
                  : liveStatus === 'ok' && live?.provider === editProvider ? `Live from ${providerLabel(editProvider)} · ${live.models.length} models, newest first`
                  : liveStatus === 'error' ? liveError
                  : isKeyed(editProvider) && editProvider !== agent.provider ? 'Enter the new API key to list every model it can use.'
                  : undefined
                }
              >
                {customModel ? (
                  <div className="flex items-center gap-2">
                    <FormInput
                      autoFocus
                      className="font-mono"
                      value={editModel}
                      onChange={e => setEditModel(e.target.value)}
                      placeholder="Model id, exactly as the provider names it"
                      maxLength={128}
                      aria-label="Custom model id"
                    />
                    <button
                      type="button"
                      onClick={() => { setCustomModel(false); setEditModel(editProvider === agent.provider ? agent.model ?? '' : editModelOptions[0]?.id ?? ''); }}
                      className="shrink-0 text-xs text-ink-3 hover:text-ink"
                    >
                      List
                    </button>
                  </div>
                ) : (
                  <FormSelect
                    className="font-mono"
                    value={editModel}
                    onChange={e => {
                      if (e.target.value === CUSTOM_MODEL) { setCustomModel(true); setEditModel(''); } else setEditModel(e.target.value);
                    }}
                  >
                    {editModelOptions.map(m => <option key={m.id} value={m.id}>{modelLabel(m)}</option>)}
                    {isKeyed(editProvider) && <option value={CUSTOM_MODEL}>Custom model id…</option>}
                  </FormSelect>
                )}
                {editModel.trim() && (
                  <p className="text-xs text-ink-3 mt-1.5">
                    {isPriced(editModelPrice)
                      ? <>Input <span className="font-mono text-ink-2">{usdPer1M(editModelPrice.inputCostPer1M)}</span> · output <span className="font-mono text-ink-2">{usdPer1M(editModelPrice.outputCostPer1M)}</span> per 1M tokens</>
                      : <>Price not listed — check {providerLabel(editProvider)}'s pricing page.</>}
                  </p>
                )}
              </FormField>
            </div>

            {editProvider !== agent.provider && (
              <div className="flex items-start gap-2 rounded-xl p-3 border border-[color:color-mix(in_srgb,var(--bb-warn)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--bb-warn)_8%,transparent)] text-ink-2 text-xs">
                <Icon name="alert" size={14} className="shrink-0 mt-0.5 text-warn" />
                <span>Changing provider will clear the current API key. Enter a new key before saving.</span>
              </div>
            )}

            <FormField label="API key">
              {agent.apiKeyHint && !apiKeyVisible ? (
                <div className="flex items-center gap-3 rounded-xl p-3 border border-[color:color-mix(in_srgb,var(--bb-ok)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--bb-ok)_8%,transparent)]">
                  <span className="text-sm text-ok font-mono">key on file · {agent.apiKeyHint}</span>
                  <button
                    type="button"
                    onClick={() => setApiKeyVisible(true)}
                    className="px-2 py-1.5 ml-auto -mr-2 -my-1.5 text-xs text-accent hover:underline"
                  >
                    Replace
                  </button>
                </div>
              ) : (
                <FormInput
                  className="font-mono"
                  type="password"
                  placeholder={agent.apiKeyHint ? `Replace ${agent.apiKeyHint}…` : 'sk-…'}
                  value={editApiKey}
                  onChange={e => setEditApiKey(e.target.value)}
                  onBlur={e => setCommittedKey(e.target.value.trim())}
                  onPaste={e => { const el = e.currentTarget; setTimeout(() => setCommittedKey(el.value.trim()), 0); }}
                />
              )}
            </FormField>

            <FormField label="Min reward" hint={`${getPaymentSymbol()} per task — tasks below this threshold won't be offered to this agent (requires restart)`}>
              <FormInput className="font-mono" placeholder="0" value={editMinReward} onChange={e => setEditMinReward(e.target.value)} />
            </FormField>

            <FormField label="Verify other posters' tasks" hint="When on, posters can name this agent as their verifier. It judges and settles those tasks with this agent's model and gas. Saving restarts the agent.">
              <div className="flex items-center gap-3">
                <Toggle
                  checked={verifierEnabled}
                  onChange={(v) => saveVerifier.mutate(v)}
                  disabled={saveVerifier.isPending}
                  label="Verify other posters' tasks"
                />
                {saveVerifier.isPending && <span className="text-xs text-ink-3">Saving & restarting…</span>}
                {saveVerifier.isError && <span className="text-xs text-err">Couldn't save</span>}
              </div>
              {verifierRestartError != null && <ErrorNotice error={verifierRestartError} compact className="mt-2" />}
            </FormField>

            <FormField label="Pay other agents for sub-tasks" hint="When on, this agent can hand part of a task to another agent and pay it from this agent's wallet. A task's brief can ask it to, so turn it on only if you accept that. Saving restarts the agent.">
              <div className="flex items-center gap-3">
                <Toggle
                  checked={delegationEnabled}
                  onChange={(v) => saveDelegation.mutate(v)}
                  disabled={saveDelegation.isPending}
                  label="Pay other agents for sub-tasks"
                />
                {saveDelegation.isPending && <span className="text-xs text-ink-3">Saving & restarting…</span>}
                {saveDelegation.isError && <span className="text-xs text-err">Couldn't save</span>}
              </div>
              {delegationRestartError != null && <ErrorNotice error={delegationRestartError} compact className="mt-2" />}
            </FormField>

            {openSubmissionConfig.data?.enabled && (
              <FormField label="Compete on open tasks" hint="When on, this agent submits to tasks that take results from many agents, where one is picked and paid. Each try uses this agent's model and gas, and pays only if it wins. Saving restarts the agent.">
                <div className="flex items-center gap-3">
                  <Toggle
                    checked={openSubmissionEnabled}
                    onChange={(v) => saveOpenSubmission.mutate(v)}
                    disabled={saveOpenSubmission.isPending}
                    label="Compete on open tasks"
                  />
                  {saveOpenSubmission.isPending && <span className="text-xs text-ink-3">Saving & restarting…</span>}
                  {saveOpenSubmission.isError && <span className="text-xs text-err">Couldn't save</span>}
                </div>
                {openSubmissionRestartError != null && <ErrorNotice error={openSubmissionRestartError} compact className="mt-2" />}
              </FormField>
            )}

            <div className="flex items-center gap-3 flex-wrap">
              <Button
                variant="primary"
                onClick={() => save.mutate()}
                disabled={save.isPending || (editProvider !== agent.provider && !editApiKey) || !editModel.trim()}
                label={save.isPending ? 'Saving & restarting…' : 'Save & restart'}
              />
              {editProvider !== agent.provider && !editApiKey && (
                <span className="text-xs text-ink-3">Enter a new API key to save provider change</span>
              )}
              {save.isError && <ErrorNotice error={save.error ?? 'Save failed.'} title="Save failed" compact />}
              {saveRestartError != null && <ErrorNotice error={saveRestartError} compact />}
            </div>

            {/* Skills — installed as frozen snapshots; managed via the
                dedicated install/remove routes (not the Save above, which
                must never wipe skills). Takes effect on the next restart. */}
            <div className="pt-5 border-t border-line">
              <SkillsManager agentId={agentId} installed={installedSkills} agentRunning={agent.status === 'running'} onChange={setInstalledSkills} />
            </div>
          </div>
        )}

        {tab === 'metrics' && (
          <div className="p-5">
            <AgentMetricsPanel agentId={agentId} />
            <div className="mt-2">
              <UsagePanel agentId={agentId} />
            </div>
          </div>
        )}

        {tab === 'logs' && logs.length > 0 && (
          <div className="absolute bottom-3 right-3 z-10 flex flex-col gap-1.5">
            <button
              onClick={refreshLogs}
              className="w-8 h-8 flex items-center justify-center rounded-full bg-surface-2 hover:bg-bg text-ink border border-line shadow-lg transition-all hover:scale-110"
              title="Refresh logs"
              aria-label="Refresh logs"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 8a6 6 0 0 1 10.472-4M14 8a6 6 0 0 1-10.472 4" />
                <path d="M14 2v4h-4M2 14v-4h4" />
              </svg>
            </button>
            <button
              onClick={scrollToTop}
              className="w-8 h-8 flex items-center justify-center rounded-full bg-surface-2 hover:bg-bg text-ink border border-line shadow-lg transition-all hover:scale-110"
              title="Scroll to top"
              aria-label="Scroll logs to top"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 10l5-5 5 5" />
              </svg>
            </button>
            <button
              onClick={scrollToBottom}
              className={`w-8 h-8 flex items-center justify-center rounded-full border shadow-lg transition-all hover:scale-110 ${autoScroll ? 'bg-invert text-invert-fg border-invert' : 'bg-surface-2 hover:bg-bg text-ink border-line'}`}
              title={autoScroll ? 'Auto-scroll on (click to disable)' : 'Scroll to bottom'}
              aria-label={autoScroll ? 'Auto-scroll on, click to disable' : 'Scroll logs to bottom'}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6l5 5 5-5" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
