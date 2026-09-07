import { useState, useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { formatUnits } from 'ethers';
import {
  Tag,
  Button,
  FormField,
  FormInput,
  FormTextarea,
  LoadingState,
  EmptyState,
  useTabParam,
} from '../bb';
import { authedGet, authedPatch, authedPost, getAuthHeaders } from '../../lib/api';
import { API_BASE_URL, getPaymentSymbol } from '../../config/constants';
import { AGENT_CAPABILITIES } from '../../config/capabilities';
import { ToolManager, type AnyTool } from '../bb/ToolManager';
import AgentMetricsPanel from '../AgentMetricsPanel';
import { AgentTasks } from './AgentTasks';
import { ChoiceChip } from './ChoiceChip';
import { SkillsManager } from './SkillsManager';
import { WebhooksPanel } from './WebhooksPanel';
import type { AgentDetails, InstalledSkillMeta } from './types';

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

  // Edit form — seeded from the loaded agent; the page remounts this
  // component when the agent changes, so no re-sync effect is needed.
  const [editInstructions, setEditInstructions] = useState(agent.instructions ?? '');
  const [editModel, setEditModel] = useState(agent.model ?? '');
  const [editCapabilities, setEditCapabilities] = useState<string[]>(agent.capabilities ?? []);
  const [editMinReward, setEditMinReward] = useState(
    // Decimal-preserving: integer BigInt division floored a fractional
    // minReward (0.5 0G -> '0'), which Save then persisted as 0, silently
    // disabling the min-reward gate so the agent accepted 0-reward tasks.
    agent.minReward ? formatUnits(agent.minReward, 18) : '',
  );
  const [editTools, setEditTools] = useState<AnyTool[]>((agent.tools ?? []) as AnyTool[]);
  const [toolsSaved, setToolsSaved] = useState(false);
  const [installedSkills, setInstalledSkills] = useState<InstalledSkillMeta[]>(agent.skills ?? []);

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
  const save = useMutation({
    mutationFn: () =>
      authedPatch<AgentDetails>(`/api/v1/agents/${agentId}`, {
        instructions: editInstructions,
        model: editModel,
        capabilities: editCapabilities,
        minReward: editMinReward
          ? (BigInt(Math.round(Number(editMinReward) * 1e18))).toString()
          : undefined,
      }),
    onSuccess: (data) => { onAgentUpdated(data); setTab('logs'); },
  });

  const saveTools = useMutation({
    mutationFn: () =>
      authedPatch<AgentDetails>(`/api/v1/agents/${agentId}`, {
        tools: editTools,
      }),
    onSuccess: (data) => { onAgentUpdated(data); setToolsSaved(true); },
  });

  return (
    <div className={`border border-line flex flex-col min-w-0 ${className}`}>
      {/* Tabs — clean sans tab bar with a cream underline on the active tab,
          matching the marketplace dashboard. Horizontal scroll on narrow
          viewports so they never wrap into a broken two-line bar. */}
      <div role="tablist" className="flex gap-6 border-b border-line px-5 overflow-x-auto scrollbar-thin">
        {TABS.map(t => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`pt-4 pb-3 -mb-px text-sm whitespace-nowrap border-b-2 transition-colors ${
              tab === t
                ? 'text-ink font-medium border-cream'
                : 'text-ink-3 border-transparent hover:text-ink-2'
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="flex-1 relative">
        {/* The 520px clamp belongs to the streams only — it was sized for the
            log console and used to squash every other panel with it. */}
        {tab === 'logs' && (
          <div
            className="p-5 overflow-y-auto max-h-[520px]"
            ref={logContainerRef}
            onScroll={handleLogScroll}
          >
            {logsError ? (
              <div className="flex flex-col items-center gap-3 py-8">
                <EmptyState icon="lock" title="Not authorised" description={logsError} />
              </div>
            ) : logs.length > 0 ? logs.map((line, i) => {
              const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
              const tsMatch = clean.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:Z|))\s+(.*)$/);
              const isErr = clean.includes('[err]');
              return (
                <div key={i} className={`px-3 py-1.5 text-xs font-mono flex gap-3 ${isErr ? 'text-err bg-err/10' : 'text-ink-3 hover:bg-surface-2'}`}>
                  {tsMatch ? (
                    <>
                      <span className="text-ink-3/60 shrink-0" title={tsMatch[1]}>
                        {new Date(tsMatch[1].replace('Z', '').replace(' ', 'T') + 'Z').toLocaleString([], { hour12: false })}
                      </span>
                      <span className="break-all">{tsMatch[2]}</span>
                    </>
                  ) : (
                    <span className="break-all">{clean}</span>
                  )}
                </div>
              );
            }) : (
              <div className="flex flex-col items-center gap-3 py-8">
                <EmptyState
                  icon="list"
                  title={agent.status === 'running' ? 'Waiting for logs' : 'No logs yet'}
                  description={agent.status === 'running'
                    ? 'Live output will stream here as the agent works.'
                    : 'Start the agent to begin streaming its logs.'}
                />
                <button
                  onClick={refreshLogs}
                  className="text-xs text-ink-3 hover:text-ink transition-colors flex items-center gap-1"
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
                    authedPost(`/api/v1/tools/error-logs`, { agentId })
                      .then(() => { setErrorLogs([]); setErrorLogsTotal(0); })
                      .catch(() => {});
                  }}
                  className="text-xs text-ink-3 hover:text-ink transition-colors"
                >
                  Clear all
                </button>
              )}
            </div>
            {errorLogsLoading ? (
              <LoadingState />
            ) : errorLogs.length === 0 ? (
              <EmptyState
                icon="check"
                title="No errors"
                description="Tool executions are running cleanly."
              />
            ) : (
              <div className="space-y-3">
                {errorLogs.map((e: any) => (
                  <div key={e.id} className="border border-line p-4 space-y-2">
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-ink">{e.toolName}</span>
                      <Tag tone="neutral">{e.toolType}</Tag>
                      {e.statusCode != null && (
                        <Tag tone={e.statusCode >= 400 ? 'warn' : 'neutral'}>
                          HTTP {e.statusCode}
                        </Tag>
                      )}
                      <span className="text-xs text-ink-3 ml-auto">{new Date(e.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="text-sm text-ink-3">{e.error}</div>
                    {e.method && e.url && (
                      <div className="text-xs font-mono text-ink-3 break-all">
                        {e.method} {e.url}
                      </div>
                    )}
                    {e.requestInput && e.requestInput !== '{}' && (
                      <details className="text-xs text-ink-3">
                        <summary className="cursor-pointer hover:text-ink-2">Request input</summary>
                        <pre className="mt-1 p-2 bg-surface-2 border border-line overflow-x-auto whitespace-pre-wrap">{e.requestInput}</pre>
                      </details>
                    )}
                    {e.responseOutput && (
                      <details className="text-xs text-ink-3">
                        <summary className="cursor-pointer hover:text-ink-2">Response output</summary>
                        <pre className="mt-1 p-2 bg-surface-2 border border-line overflow-x-auto whitespace-pre-wrap">{e.responseOutput}</pre>
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
              <div className="border border-cream/30 bg-cream/5 p-4 text-sm text-ink-2">
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

            <FormField label="Model">
              <FormInput className="font-mono" value={editModel} onChange={e => setEditModel(e.target.value)} />
            </FormField>

            <FormField
              label="Capabilities"
              required
              hint="What tasks this agent can accept. Changes take effect on the next agent restart (stop then start)."
            >
              <div className="flex flex-wrap gap-2">
                {AGENT_CAPABILITIES.map(cap => (
                  <ChoiceChip
                    key={cap}
                    selected={editCapabilities.includes(cap)}
                    onClick={() => setEditCapabilities(cs => cs.includes(cap) ? cs.filter(c => c !== cap) : [...cs, cap])}
                  >
                    {cap.replace(/_/g, ' ')}
                  </ChoiceChip>
                ))}
              </div>
              {editCapabilities.length === 0 && (
                <div className="mt-2 text-xs text-err">
                  Pick at least one — without capabilities the agent can't accept any task.
                </div>
              )}
            </FormField>

            <FormField label="Min reward" hint={`${getPaymentSymbol()} per task — tasks below this threshold won't be offered to this agent (requires restart)`}>
              <FormInput className="font-mono" placeholder="0" value={editMinReward} onChange={e => setEditMinReward(e.target.value)} />
            </FormField>

            <div className="flex items-center gap-3 flex-wrap">
              <Button
                variant="primary"
                onClick={() => save.mutate()}
                disabled={save.isPending || editCapabilities.length === 0}
                label={save.isPending ? 'Saving…' : 'Save changes'}
              />
              {save.isError && <span className="text-xs text-err">Save failed</span>}
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
          </div>
        )}

        {tab === 'logs' && logs.length > 0 && (
          <div className="absolute bottom-3 right-3 z-10 flex flex-col gap-1.5">
            <button
              onClick={refreshLogs}
              className="w-8 h-8 flex items-center justify-center bg-surface-2 hover:bg-bg text-ink border border-line shadow-lg transition-all hover:scale-110"
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
              className="w-8 h-8 flex items-center justify-center bg-surface-2 hover:bg-bg text-ink border border-line shadow-lg transition-all hover:scale-110"
              title="Scroll to top"
              aria-label="Scroll logs to top"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 10l5-5 5 5" />
              </svg>
            </button>
            <button
              onClick={scrollToBottom}
              className={`w-8 h-8 flex items-center justify-center border shadow-lg transition-all hover:scale-110 ${autoScroll ? 'bg-cream/20 text-cream border-cream/40' : 'bg-surface-2 hover:bg-bg text-ink border-line'}`}
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
