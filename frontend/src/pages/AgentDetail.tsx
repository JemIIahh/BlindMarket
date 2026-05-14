import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAccount, useBalance, useWalletClient } from 'wagmi';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BrowserProvider, parseEther } from 'ethers';
import { Breadcrumb, PageHeader, SectionRule, Tag, StatCard } from '../components/bb';
import { truncateAddress } from '../lib/utils';
import { get, post, patch, authedPost } from '../lib/api';
import { API_BASE_URL, MARKETPLACE_TOKEN_ADDRESS } from '../config/constants';

// Top-up amount when the agent runs low on gas. Same default as the deploy
// funding step — round trip + LLM call + submitEvidence costs ~0.0004 0G, so
// 0.005 0G covers ~125 tasks before the next top-up.
const TOP_UP_AMOUNT = '0.005';

// Below this the agent can't reliably pay for a submitEvidence + a USDC sweep
// tx. UI surfaces a "Top Up Gas" call to action when balance is under this.
const LOW_GAS_THRESHOLD = 0.005;

interface AgentTool { type: string; name: string; description: string; url?: string; endpointUrl?: string; method?: string; toolName?: string; }
interface AgentDetails {
  id: string; name: string; provider: string; model: string; status: string;
  ownerAddress: string; deployedAt: string; instructions: string;
  walletAddress?: string; publicKey?: string; inftTokenId?: number;
  tasksCompleted?: number; totalEarned?: string; tools?: AgentTool[];
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'err' | 'neutral'> = {
  running: 'ok', idle: 'neutral', paused: 'warn', stopped: 'err', error: 'err',
};

export default function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const qc = useQueryClient();

  const [agent, setAgent] = useState<AgentDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<string[]>([]);
  const [tab, setTab] = useState<'logs' | 'tools' | 'tasks' | 'edit'>('logs');

  // Edit state
  const [editInstructions, setEditInstructions] = useState('');
  const [editModel, setEditModel] = useState('');

  // Gas-management UI state — separate from the agent's start/pause/stop
  // actions so the buttons can show their own progress without interfering.
  const [topUpStatus, setTopUpStatus] = useState<'idle' | 'sending' | 'error'>('idle');
  const [topUpError, setTopUpError] = useState('');
  const [recoverStatus, setRecoverStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [recoverInfo, setRecoverInfo] = useState<{ txHash: string; amount: string } | null>(null);
  const [recoverError, setRecoverError] = useState('');
  // USDC sweep state — same shape as the 0G recovery flow, separate so the
  // two operations can run independently and show their own status.
  const [sweepStatus, setSweepStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [sweepInfo, setSweepInfo] = useState<{ txHash: string; amount: string } | null>(null);
  const [sweepError, setSweepError] = useState('');

  const { data: balance, refetch: refetchBalance } = useBalance({
    address: agent?.walletAddress as `0x${string}` | undefined,
    query: { enabled: !!agent?.walletAddress },
  });
  const balanceEther = balance ? parseFloat(balance.formatted) : 0;
  const isLowGas = !!balance && balanceEther < LOW_GAS_THRESHOLD;

  useEffect(() => {
    if (!id) return;
    get<AgentDetails>(`/api/v1/agents/${id}`)
      .then(data => {
        setAgent(data);
        setEditInstructions(data.instructions ?? '');
        setEditModel(data.model ?? '');
      })
      .catch(() => { /* not found / server error */ })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`${API_BASE_URL}/api/v1/agents/${id}/logs`);
    es.onmessage = e => {
      try { setLogs(prev => [...prev.slice(-199), JSON.parse(e.data)]); } catch { }
    };
    return () => es.close();
  }, [id]);

  const action = useMutation({
    mutationFn: (act: 'start' | 'pause' | 'stop') =>
      post<AgentDetails>(`/api/v1/agents/${id}/${act}`),
    onSuccess: (data) => { setAgent(data); qc.invalidateQueries({ queryKey: ['my-agents'] }); },
  });

  const save = useMutation({
    mutationFn: () =>
      patch<AgentDetails>(`/api/v1/agents/${id}`, {
        ownerAddress: address,
        instructions: editInstructions,
        model: editModel,
      }),
    onSuccess: (data) => { setAgent(data); setTab('logs'); },
  });

  // Owner-signed 0G transfer from owner wallet → agent wallet. No backend
  // involvement; same primitive as the deploy-funding step. We refresh the
  // useBalance hook after the tx confirms so the UI tile updates immediately
  // instead of waiting on a poll cycle.
  async function handleTopUp() {
    if (!address || !walletClient || !agent?.walletAddress) return;
    setTopUpStatus('sending');
    setTopUpError('');
    try {
      const provider = new BrowserProvider(walletClient.transport);
      const signer = await provider.getSigner();
      const tx = await signer.sendTransaction({
        to: agent.walletAddress,
        value: parseEther(TOP_UP_AMOUNT),
      });
      await tx.wait();
      await refetchBalance();
      setTopUpStatus('idle');
    } catch (err) {
      setTopUpError((err as Error).message || 'top-up failed');
      setTopUpStatus('error');
    }
  }

  // Backend signs the sweep tx using the agent's stored rawPrivateKey and
  // sends the wallet's balance (minus a small gas reserve) back to the owner.
  // Only valid when the agent is stopped — sweeping a running agent would
  // race with its in-flight submitEvidence txs.
  //
  // Uses authedPost so the JWT (Privy identity) flows to the backend, where
  // requireAuth + authorizeOwner verify the caller is the agent's owner. The
  // previous "ownerAddress in body" claim is no longer trusted server-side.
  async function handleRecoverFunds() {
    if (!address || !id) return;
    if (!confirm(`Recover remaining 0G from this agent's wallet back to ${address.slice(0, 8)}…? This cannot be undone.`)) return;
    setRecoverStatus('sending');
    setRecoverError('');
    try {
      const data = await authedPost<{ txHash: string; amountSent: string; recipient: string }>(`/api/v1/agents/${id}/recover-funds`, {});
      setRecoverInfo({ txHash: data.txHash, amount: data.amountSent });
      setRecoverStatus('done');
      await refetchBalance();
    } catch (err) {
      setRecoverError((err as Error).message || 'recover failed');
      setRecoverStatus('error');
    }
  }

  // Sweep accumulated marketplace-token (USDC) earnings from the agent wallet
  // back to the owner. Same auth model as handleRecoverFunds — backend gates
  // on the authenticated wallet matching agent.ownerAddress, and refuses while
  // the agent is running (could race with an in-flight payout from escrow).
  async function handleSweepToken() {
    if (!address || !id) return;
    if (!confirm(`Withdraw all USDC earnings from this agent's wallet back to ${address.slice(0, 8)}…? This cannot be undone.`)) return;
    setSweepStatus('sending');
    setSweepError('');
    try {
      // Pass tokenAddress explicitly so the endpoint works regardless of
      // whether the backend's MOCK_ERC20_ADDRESS env var is set. The
      // canonical address lives in constants.ts; same value the post-task
      // approve flow uses.
      const data = await authedPost<{
        txHash: string;
        amountFormatted: string;
        amountRaw: string;
        recipient: string;
      }>(`/api/v1/agents/${id}/sweep-token`, { tokenAddress: MARKETPLACE_TOKEN_ADDRESS });
      setSweepInfo({ txHash: data.txHash, amount: data.amountFormatted });
      setSweepStatus('done');
      // Refresh agent record so the earned/totalEarned display picks up the
      // post-sweep balance on next render.
      try {
        const fresh = await get<AgentDetails>(`/api/v1/agents/${id}`);
        setAgent(fresh);
      } catch { /* non-blocking */ }
    } catch (err) {
      setSweepError((err as Error).message || 'sweep failed');
      setSweepStatus('error');
    }
  }

  if (loading) return <div className="text-xs font-mono text-ink-3 py-20 text-center">loading…</div>;
  if (!agent) return <div className="text-xs font-mono text-ink-3 py-20 text-center">agent not found</div>;

  const isOwner = address?.toLowerCase() === agent.ownerAddress?.toLowerCase();

  return (
    <div>
      <Breadcrumb items={['marketplace', 'agents', 'mine', agent.name]} />
      <PageHeader
        title={agent.name}
        description={`${agent.provider} · ${agent.model}`}
        right={
          <div className="flex items-center gap-3">
            <Tag tone={STATUS_TONE[agent.status] ?? 'neutral'}>{action.isPending ? `${action.variables}…` : agent.status}</Tag>
            {isOwner && (
              <div className="flex gap-2 text-[11px] font-mono">
                {agent.status !== 'running' && <button disabled={action.isPending} onClick={() => action.mutate('start')} className="px-3 py-1 border border-green-400 text-green-400 hover:bg-green-400 hover:text-bg transition-colors disabled:opacity-40">start</button>}
                {agent.status === 'running' && <button disabled={action.isPending} onClick={() => action.mutate('pause')} className="px-3 py-1 border border-yellow-400 text-yellow-400 hover:bg-yellow-400 hover:text-bg transition-colors disabled:opacity-40">pause</button>}
                <button disabled={action.isPending} onClick={() => action.mutate('stop')} className="px-3 py-1 border border-line text-ink-3 hover:border-red-400 hover:text-red-400 transition-colors disabled:opacity-40">stop</button>
              </div>
            )}
          </div>
        }
      />
      {action.isError && (
        <div className="mb-4 px-3 py-2 border border-red-900/40 bg-red-900/10 text-[11px] font-mono text-red-400">
          {action.variables} failed: {(action.error as Error).message}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-0 border border-line mb-2">
        <StatCard label="tasks completed" value={String(agent.tasksCompleted ?? 0)} sub="all time" />
        <div className="border-t sm:border-t-0 sm:border-l border-line"><StatCard label="earned" value={`$${parseFloat(agent.totalEarned ?? '0').toFixed(2)}`} sub="USDC" subColor="ok" /></div>
        <div className="border-t sm:border-t-0 sm:border-l border-line"><StatCard label="wallet balance" value={balance ? parseFloat(balance.formatted).toFixed(4) : '—'} sub={isLowGas ? 'low gas — top up' : (balance?.symbol ?? '0G')} subColor={isLowGas ? 'warn' : undefined} /></div>
      </div>

      {/* Gas management — only relevant to the agent owner. Top Up nudges any
          agent whose wallet is below threshold; Recover Funds sweeps remaining
          balance back to the owner once the agent is stopped. */}
      {isOwner && agent.walletAddress && (
        <div className="border border-line border-t-0 mb-8 px-4 py-3 flex flex-wrap items-center gap-3 text-[11px] font-mono">
          <span className="text-ink-3">gas:</span>
          <button
            onClick={handleTopUp}
            disabled={topUpStatus === 'sending'}
            className={`px-3 py-1.5 border transition-colors disabled:opacity-40 ${isLowGas
              ? 'border-yellow-400 text-yellow-400 hover:bg-yellow-400 hover:text-bg'
              : 'border-line text-ink-3 hover:border-cream hover:text-cream'
              }`}>
            {topUpStatus === 'sending' ? `sending ${TOP_UP_AMOUNT} 0G…` : `top up gas (+${TOP_UP_AMOUNT} 0G)`}
          </button>
          {topUpStatus === 'error' && <span className="text-red-400">{topUpError}</span>}

          {/* 0G recovery — show whenever the agent isn't actively running.
              Paused agents have their child process killed and aren't polling
              for new tasks, so they're safe to sweep too. The backend's
              /recover-funds endpoint enforces the same `!= running` rule, so
              this gate just matches it instead of being stricter for no
              reason. */}
          {agent.status !== 'running' && (
            <button
              onClick={handleRecoverFunds}
              disabled={recoverStatus === 'sending' || balanceEther < 0.0015}
              className="px-3 py-1.5 border border-line text-ink-3 hover:border-red-400 hover:text-red-400 transition-colors disabled:opacity-40">
              {recoverStatus === 'sending' ? 'sweeping…' : 'recover 0G → owner'}
            </button>
          )}
          {recoverStatus === 'done' && recoverInfo && (
            <span className="text-green-400">
              swept {parseFloat(recoverInfo.amount).toFixed(4)} 0G · tx {recoverInfo.txHash.slice(0, 10)}…
            </span>
          )}
          {recoverStatus === 'error' && <span className="text-red-400">{recoverError}</span>}

          {/* USDC withdrawal — same `!= running` rule, with the additional
              guard that the agent must have actually earned something. The
              backend separately rejects the sweep with NO_GAS if the wallet
              can't afford the ERC20 transfer's own gas (~50k). */}
          {agent.status !== 'running' && parseFloat(agent.totalEarned ?? '0') > 0 && (
            <button
              onClick={handleSweepToken}
              disabled={sweepStatus === 'sending' || balanceEther < 0.0002}
              className="px-3 py-1.5 border border-cream text-cream hover:bg-cream hover:text-bg transition-colors disabled:opacity-40">
              {sweepStatus === 'sending' ? 'withdrawing…' : `withdraw USDC → owner`}
            </button>
          )}
          {sweepStatus === 'done' && sweepInfo && (
            <span className="text-green-400">
              withdrew ${parseFloat(sweepInfo.amount).toFixed(2)} USDC · tx {sweepInfo.txHash.slice(0, 10)}…
            </span>
          )}
          {sweepStatus === 'error' && <span className="text-red-400">{sweepError}</span>}

          {isLowGas && agent.status !== 'stopped' && (
            <span className="text-yellow-400">⚠ agent will fail to submit evidence below {LOW_GAS_THRESHOLD} 0G</span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
        {/* Identity */}
        <div className="border border-line p-5">
          <SectionRule num="01" title="identity" />
          <div className="mt-4 space-y-4 text-xs font-mono">
            <div><div className="text-ink-3 mb-1">owner</div><div className="text-ink">{truncateAddress(agent.ownerAddress)}</div></div>
            <div><div className="text-ink-3 mb-1">deployed</div><div className="text-ink">{new Date(agent.deployedAt).toLocaleString()}</div></div>
            {agent.walletAddress && <div><div className="text-ink-3 mb-1">agent wallet</div><div className="text-ink break-all text-[11px]">{agent.walletAddress}</div></div>}
            {agent.inftTokenId !== undefined && <div><div className="text-ink-3 mb-1">INFT token</div><div className="text-cream">#{agent.inftTokenId}</div></div>}
            {agent.publicKey && <div><div className="text-ink-3 mb-1">public key</div><div className="text-ink">{agent.publicKey.slice(0, 18)}…{agent.publicKey.slice(-6)}</div></div>}
          </div>
        </div>

        {/* Tabbed right panel */}
        <div className="border border-line flex flex-col">
          {/* Tabs — single-row scroll on narrow viewports so they never wrap into
              a broken-looking two-line bar. snap-x keeps tap targets aligned. */}
          <div className="flex border-b border-line overflow-x-auto snap-x scrollbar-thin">
            {(['logs', 'tools', 'tasks', ...(isOwner ? ['edit'] : [])] as const).map(t => (
              <button key={t} onClick={() => setTab(t as typeof tab)}
                className={`flex-1 sm:flex-1 shrink-0 snap-start min-w-[88px] px-4 sm:px-5 py-3 text-[11px] font-mono uppercase tracking-widest border-r border-line transition-colors ${tab === t ? 'text-cream bg-surface-2' : 'text-ink-3 hover:text-ink hover:bg-surface-2'}`}>
                {t}
              </button>
            ))}
          </div>

          <div className="flex-1 p-5 overflow-y-auto max-h-[520px]">
            {tab === 'logs' && (
              logs.length > 0 ? logs.map((line, i) => {
                // Strip any leftover ANSI escape sequences from older buffered
                // log lines (the worker no longer emits them when forked, but
                // Redis may still hold pre-fix entries until the ring rotates).
                const clean = line.replace(/\x1b\[[0-9;]*m/g, '');

                // Worker emits each line as `YYYY-MM-DDTHH:MM:SSZ ...`. Pull
                // out the timestamp so we can render it dimmed and aligned,
                // making the actual message easier to scan. Lines without a
                // timestamp (startup errors, legacy entries) just render whole.
                const tsMatch = clean.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+(.*)$/);
                const isErr = clean.includes('[err]');
                return (
                  <div key={i} className={`px-3 py-1.5 text-xs font-mono flex gap-3 ${isErr ? 'text-red-400 bg-red-900/10' : 'text-ink-3 hover:bg-surface-2'}`}>
                    {tsMatch ? (
                      <>
                        {/* Local-time render of the UTC stamp so the time the
                            user reads matches the wall clock they're looking
                            at. We keep the iso form in the title for the
                            "what time was this in UTC?" power use case. */}
                        <span className="text-ink-3/60 shrink-0" title={tsMatch[1]}>
                          {new Date(tsMatch[1]).toLocaleTimeString([], { hour12: false })}
                        </span>
                        <span className="break-all">{tsMatch[2]}</span>
                      </>
                    ) : (
                      <span className="break-all">{clean}</span>
                    )}
                  </div>
                );
              }) : (
                <div className="text-center py-16 text-xs font-mono text-ink-3">
                  {agent.status === 'running' ? 'waiting for logs…' : 'start the agent to see logs'}
                </div>
              )
            )}

            {tab === 'tools' && (
              <div className="space-y-3">
                {(agent.tools ?? []).length === 0 ? (
                  <div className="text-xs font-mono text-ink-3 py-8 text-center">no tools configured</div>
                ) : (agent.tools ?? []).map((t, i) => (
                  <div key={i} className="border border-line p-4 text-xs font-mono">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-cream">{t.name}</span>
                      <span className="text-ink-3 border border-line px-2 py-0.5 text-[10px]">{t.type}</span>
                    </div>
                    <div className="text-ink-3">{t.description}</div>
                    {(t.url || t.endpointUrl) && <div className="text-ink-3 mt-1 text-[11px]">{t.url ?? t.endpointUrl}</div>}
                  </div>
                ))}
              </div>
            )}

            {tab === 'tasks' && (
              <AgentTasks agentWallet={agent.walletAddress} />
            )}

            {tab === 'edit' && isOwner && (
              <div className="space-y-4">
                <div>
                  <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">instructions</label>
                  <textarea rows={6} value={editInstructions} onChange={e => setEditInstructions(e.target.value)}
                    className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink focus:outline-none focus:border-cream resize-none" />
                </div>
                <div>
                  <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">model</label>
                  <input value={editModel} onChange={e => setEditModel(e.target.value)}
                    className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink focus:outline-none focus:border-cream" />
                </div>
                <button onClick={() => save.mutate()} disabled={save.isPending}
                  className="px-6 py-3 border border-cream text-xs font-mono text-cream hover:bg-cream hover:text-bg disabled:opacity-40 transition-colors">
                  {save.isPending ? 'saving…' : 'save changes →'}
                </button>
                {save.isError && <div className="text-xs font-mono text-red-400">save failed</div>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentTasks({ agentWallet }: { agentWallet?: string }) {
  type Execution = {
    meta: { taskId: string; requiredCapabilities?: string[] };
    state: { status: string; acceptedAt?: string; verificationResult?: { passed: boolean } };
  };
  const [executions, setExecutions] = useState<Execution[]>([]);

  useEffect(() => {
    if (!agentWallet) return;
    // Hits /a2a/executions filtered by agent wallet (not the owner EOA). The
    // old code queried /api/v1/tasks which only returns currently-open tasks,
    // so completed runs by this agent never appeared.
    get<{ executions?: Execution[] }>(`/api/v1/a2a/executions?address=${agentWallet}`)
      .then(data => setExecutions(data.executions ?? []))
      .catch(() => { /* leave empty */ });
  }, [agentWallet]);

  if (executions.length === 0) return <div className="text-xs font-mono text-ink-3 py-8 text-center">no tasks yet</div>;

  // Most-recent first by acceptedAt; falls back to insertion order when
  // timestamps are missing (older state rows pre-acceptedAt field).
  const sorted = [...executions].sort((a, b) => {
    const ta = a.state.acceptedAt ? Date.parse(a.state.acceptedAt) : 0;
    const tb = b.state.acceptedAt ? Date.parse(b.state.acceptedAt) : 0;
    return tb - ta;
  });

  return (
    <div className="space-y-2">
      {sorted.map(e => (
        <div key={e.meta.taskId} className="flex items-center justify-between border border-line px-4 py-3 text-xs font-mono">
          <span className="text-ink-3">{e.meta.taskId.slice(0, 10)}…</span>
          <span className="text-ink">{(e.meta.requiredCapabilities ?? []).join(', ') || '—'}</span>
          <span className={e.state.status === 'verified' ? 'text-ok' : e.state.status === 'failed' ? 'text-red-400' : 'text-ink-3'}>
            {e.state.status}
          </span>
        </div>
      ))}
    </div>
  );
}
