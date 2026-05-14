import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccount, useWalletClient, useBalance } from 'wagmi';
import { recoverPublicKey, hashMessage } from 'viem';
import { BrowserProvider, parseEther, formatEther } from 'ethers';
import { Breadcrumb, PageHeader, SectionRule } from '../components/bb';
import { get, post } from '../lib/api';
import { AGENT_CAPABILITIES } from '../config/capabilities';

// How much native 0G to send to a freshly-deployed agent wallet so it can pay
// gas for its on-chain actions (submitEvidence, USDC sweep, etc). 0.005 0G
// covers ~125 submitEvidence txs at current gas prices — enough for a
// reasonable demo session without burning a full faucet drip.
const DEPLOY_FUND_AMOUNT = '0.005';

// Minimum owner balance to even attempt deploy: fund amount + buffer for the
// transfer's own gas cost. If the owner's wallet is below this we disable the
// Deploy button and direct them to the faucet first — better than letting
// them deploy an agent that immediately fails for lack of gas.
const MIN_OWNER_BALANCE = '0.06';

type Provider = 'openai' | 'anthropic' | 'groq' | 'gemini';
type ProviderModels = Record<Provider, string[]>;

interface Tool {
  type: 'http' | 'mcp';
  name: string;
  description: string;
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  toolName?: string; // for mcp
  authType?: 'none' | 'bearer' | 'api-key' | 'basic';
  authValue?: string;
  authHeader?: string; // custom header name for api-key auth
}

export default function DeployAgentForm() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const navigate = useNavigate();

  const [providers, setProviders] = useState<ProviderModels>({
    openai: ['gpt-4o', 'gpt-4o-mini'],
    anthropic: ['claude-sonnet-4-5', 'claude-opus-4-5', 'claude-3-haiku-20240307'],
    groq: ['llama-3.3-70b-versatile', 'llama3-8b-8192'],
    gemini: ['gemini-2.0-flash', 'gemini-1.5-pro'],
  });

  const [form, setForm] = useState({
    name: '',
    instructions: '',
    provider: 'anthropic' as Provider,
    model: 'claude-sonnet-4-5',
    apiKey: '',
  });

  const [tools, setTools] = useState<Tool[]>([]);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [newTool, setNewTool] = useState<Tool>({ type: 'http', name: '', description: '', url: '', method: 'POST', authType: 'none', authValue: '', authHeader: 'X-API-Key' });
  const [showToolForm, setShowToolForm] = useState(false);

  const [status, setStatus] = useState<'idle' | 'deploying' | 'funding' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const [agentId, setAgentId] = useState('');
  const [fundingSkipped, setFundingSkipped] = useState(false);

  // Owner balance gates the deploy button. Without enough 0G to fund the new
  // agent the whole flow stalls at step 2, so we check up front instead of
  // letting the user discover the problem after they've signed step 1.
  const { data: ownerBalance } = useBalance({
    address: address as `0x${string}` | undefined,
    query: { enabled: !!address },
  });
  const ownerBalanceEther = ownerBalance ? parseFloat(formatEther(ownerBalance.value)) : 0;
  const hasEnoughForDeploy = ownerBalanceEther >= parseFloat(MIN_OWNER_BALANCE);

  useEffect(() => {
    get<ProviderModels>('/api/v1/agents/providers')
      .then(setProviders)
      .catch(() => { });
  }, []);

  function set(k: keyof typeof form, v: string) {
    setForm(f => {
      const next = { ...f, [k]: v };
      if (k === 'provider') next.model = providers[v as Provider]?.[0] ?? '';
      return next;
    });
  }

  function addTool() {
    if (!newTool.name || !newTool.url) return;
    setTools(t => [...t, newTool]);
    setNewTool({ type: 'http', name: '', description: '', url: '', method: 'POST' });
    setShowToolForm(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!address || !walletClient) return;
    setStatus('deploying');
    setError('');
    setFundingSkipped(false);
    try {
      // Step 1 — derive owner's secp256k1 pubkey via message signature. Used by
      // the backend to ECIES-encrypt the agent's private key for at-rest
      // storage. Free (no gas), just one wallet popup.
      const msg = `BlindMarket agent deployment\nOwner: ${address}`;
      const sig = await walletClient.signMessage({ message: msg });
      const recovered = await recoverPublicKey({ hash: hashMessage(msg), signature: sig });
      // viem returns 0x04... — strip 0x for backend
      const ownerPublicKey = recovered.replace(/^0x/, '');

      // Step 2 — register the agent server-side. Backend mints the agent's
      // wallet + INFT and returns walletAddress so we can fund it.
      const data = await post<{ id: string; walletAddress?: string }>('/api/v1/agents/deploy', {
        ...form,
        ownerAddress: address,
        ownerPublicKey,
        capabilities,
        tools: tools.map(t => {
          const headers: Record<string, string> = {};
          if (t.authType === 'bearer') headers['Authorization'] = `Bearer ${t.authValue}`;
          else if (t.authType === 'api-key') headers[t.authHeader ?? 'X-API-Key'] = t.authValue ?? '';
          else if (t.authType === 'basic') headers['Authorization'] = `Basic ${btoa(t.authValue ?? '')}`;
          return t.type === 'mcp'
            ? { type: 'mcp', name: t.name, description: t.description, endpointUrl: t.url, toolName: t.toolName ?? t.name }
            : { type: 'http', name: t.name, description: t.description, url: t.url, method: t.method ?? 'POST', headers };
        }),
      });
      setAgentId(data.id);

      // Step 3 — fund the new agent wallet with native 0G so it can pay gas
      // for its own on-chain actions. The owner signs and broadcasts this
      // directly — no platform treasury involved. If they reject we still
      // consider the deploy successful and just flag the agent as unfunded;
      // they can Top Up later from the agent detail page.
      if (!data.walletAddress) {
        // Backend didn't return walletAddress — older API or response shape
        // changed. Treat as success-but-unfunded.
        console.warn('[deploy] no walletAddress in deploy response, skipping funding step');
        setFundingSkipped(true);
        setStatus('done');
        return;
      }

      setStatus('funding');
      try {
        const provider = new BrowserProvider(walletClient.transport);
        const signer = await provider.getSigner();
        const tx = await signer.sendTransaction({
          to: data.walletAddress,
          value: parseEther(DEPLOY_FUND_AMOUNT),
        });
        await tx.wait();
      } catch (fundErr) {
        // Funding rejection is non-fatal — agent record already persists. Let
        // the user finish the flow and surface the unfunded state on the
        // success screen so they can Top Up manually.
        console.warn('[deploy] funding step failed:', (fundErr as Error).message);
        setFundingSkipped(true);
      }
      setStatus('done');
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <div>
        <Breadcrumb items={['marketplace', 'agents', 'deploy', 'ui']} />
        <div className="border border-line p-10 text-center space-y-4 mt-8">
          <div className="text-xs font-mono text-green-400 uppercase tracking-widest">✓ agent deployed</div>
          <div className="text-xs font-mono text-ink-3">agent id: {agentId}</div>
          <div className="text-xs font-mono text-ink-3">on-chain wallet minted · INFT identity created</div>
          {fundingSkipped ? (
            <div className="mx-auto max-w-md border border-yellow-600/40 bg-yellow-900/10 px-4 py-3 text-[11px] font-mono text-yellow-400 text-left space-y-1">
              <div className="font-semibold">⚠ agent is unfunded</div>
              <div className="text-ink-3">
                this agent's wallet has 0 0G and can't submit evidence on-chain. open the
                agent's page and click "top up gas" to send {DEPLOY_FUND_AMOUNT} 0G from
                your wallet.
              </div>
            </div>
          ) : (
            <div className="text-xs font-mono text-green-400">
              ✓ funded with {DEPLOY_FUND_AMOUNT} 0G for gas
            </div>
          )}
          <div className="flex justify-center gap-4 mt-6">
            <button onClick={() => navigate(`/agents/${agentId}`)} className="px-4 py-2 border border-cream text-xs font-mono text-cream hover:bg-cream hover:text-bg transition-colors">
              view agent →
            </button>
            <button onClick={() => navigate('/agents/mine')} className="px-4 py-2 border border-line text-xs font-mono text-ink-3 hover:bg-surface-2">
              my agents
            </button>
            <button onClick={() => { setStatus('idle'); setAgentId(''); setFundingSkipped(false); }} className="px-4 py-2 border border-line text-xs font-mono text-ink-3 hover:bg-surface-2">
              deploy another
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <Breadcrumb items={['marketplace', 'agents', 'deploy', 'ui']} />
      <PageHeader title="Deploy agent" description="Configure your agent — it will autonomously pick up and complete tasks." />

      <form onSubmit={handleSubmit} className="border border-line">
        {/* Identity */}
        <div className="p-6 border-b border-line">
          <SectionRule num="01" title="identity" />
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="min-w-0">
              <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">agent name <span className="text-cream">*</span></label>
              <input required value={form.name} onChange={e => set('name', e.target.value)}
                placeholder="research-agent"
                className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink placeholder-ink-3 focus:outline-none focus:border-cream" />
            </div>
            <div className="min-w-0">
              <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">owner wallet</label>
              <div className="bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink-3 truncate">{address ?? 'connect wallet'}</div>
            </div>
          </div>
          <div className="mt-4">
            <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">instructions <span className="text-cream">*</span></label>
            <textarea required rows={4} value={form.instructions} onChange={e => set('instructions', e.target.value)}
              placeholder="Describe what this agent does, how it should behave, and what tasks it should pick up."
              className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink placeholder-ink-3 focus:outline-none focus:border-cream resize-none" />
          </div>
        </div>

        {/* Model */}
        <div className="p-6 border-b border-line">
          <SectionRule num="02" title="model" />
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">provider</label>
              <select value={form.provider} onChange={e => set('provider', e.target.value)}
                className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink focus:outline-none focus:border-cream">
                {Object.keys(providers).map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">model</label>
              <select value={form.model} onChange={e => set('model', e.target.value)}
                className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink focus:outline-none focus:border-cream">
                {(providers[form.provider] ?? []).map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">api key <span className="text-cream">*</span></label>
              <input required type="password" value={form.apiKey} onChange={e => set('apiKey', e.target.value)}
                placeholder="sk-..."
                className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink placeholder-ink-3 focus:outline-none focus:border-cream" />
            </div>
          </div>
        </div>

        {/* Capabilities */}
        <div className="p-6 border-b border-line">
          <SectionRule num="03" title="capabilities" side="required — what tasks can this agent do?" />
          <div className="mt-4 flex flex-wrap gap-2">
            {AGENT_CAPABILITIES.map(cap => (
              <button key={cap} type="button"
                onClick={() => setCapabilities(cs => cs.includes(cap) ? cs.filter(c => c !== cap) : [...cs, cap])}
                className={`px-3 py-1 text-[11px] font-mono border transition-colors ${capabilities.includes(cap)
                  ? 'border-cream text-cream bg-cream/10'
                  : 'border-line text-ink-3 hover:border-ink hover:text-ink'
                  }`}>
                {cap.replace(/_/g, ' ')}
              </button>
            ))}
          </div>
          {capabilities.length === 0 ? (
            <div className="mt-3 border border-err/40 bg-err/5 px-3 py-2 text-[11px] font-mono text-err">
              ⚠ pick at least one. agents with no declared capabilities can't accept any task that
              requires one — they'll register and idle forever.
            </div>
          ) : (
            <div className="mt-2 text-[11px] font-mono text-ink-3">
              {capabilities.length} selected
            </div>
          )}
        </div>

        {/* Tools */}
        <div className="p-6 border-b border-line">
          <SectionRule num="04" title="tools & mcp servers" side="optional" />
          <div className="mt-4 space-y-2">
            {tools.map((t, i) => (
              <div key={i} className="flex items-center justify-between border border-line px-4 py-3 text-xs font-mono">
                <span className="text-cream">{t.name}</span>
                <span className="text-ink-3">{t.type} · {t.url}</span>
                <button type="button" onClick={() => setTools(ts => ts.filter((_, j) => j !== i))} className="text-ink-3 hover:text-red-400">remove</button>
              </div>
            ))}

            {showToolForm ? (
              <div className="border border-line p-4 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-1">type</label>
                    <select value={newTool.type} onChange={e => setNewTool(t => ({ ...t, type: e.target.value as 'http' | 'mcp' }))}
                      className="w-full bg-surface-2 border border-line px-3 py-2 text-xs font-mono text-ink focus:outline-none focus:border-cream">
                      <option value="http">HTTP</option>
                      <option value="mcp">MCP</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-1">name</label>
                    <input value={newTool.name} onChange={e => setNewTool(t => ({ ...t, name: e.target.value }))}
                      placeholder="web-search" className="w-full bg-surface-2 border border-line px-3 py-2 text-xs font-mono text-ink placeholder-ink-3 focus:outline-none focus:border-cream" />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px] gap-3">
                  <div>
                    <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-1">url / endpoint</label>
                    <input value={newTool.url} onChange={e => setNewTool(t => ({ ...t, url: e.target.value }))}
                      placeholder="https://..." className="w-full bg-surface-2 border border-line px-3 py-2 text-xs font-mono text-ink placeholder-ink-3 focus:outline-none focus:border-cream" />
                  </div>
                  {newTool.type === 'http' && (
                    <div>
                      <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-1">method</label>
                      <select value={newTool.method ?? 'POST'} onChange={e => setNewTool(t => ({ ...t, method: e.target.value as Tool['method'] }))}
                        className="w-full bg-surface-2 border border-line px-3 py-2 text-xs font-mono text-ink focus:outline-none focus:border-cream">
                        {['GET', 'POST', 'PUT', 'DELETE'].map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-1">description</label>
                  <input value={newTool.description} onChange={e => setNewTool(t => ({ ...t, description: e.target.value }))}
                    placeholder="What this tool does" className="w-full bg-surface-2 border border-line px-3 py-2 text-xs font-mono text-ink placeholder-ink-3 focus:outline-none focus:border-cream" />
                </div>
                {newTool.type === 'http' && (
                  <div className="space-y-2">
                    <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3">auth</label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <select value={newTool.authType ?? 'none'} onChange={e => setNewTool(t => ({ ...t, authType: e.target.value as Tool['authType'] }))}
                        className="w-full bg-surface-2 border border-line px-3 py-2 text-xs font-mono text-ink focus:outline-none focus:border-cream">
                        <option value="none">none</option>
                        <option value="bearer">bearer token</option>
                        <option value="api-key">api key header</option>
                        <option value="basic">basic auth</option>
                      </select>
                      {newTool.authType !== 'none' && (
                        <input type="password" value={newTool.authValue ?? ''} onChange={e => setNewTool(t => ({ ...t, authValue: e.target.value }))}
                          placeholder={newTool.authType === 'basic' ? 'user:password' : 'token / key'}
                          className="w-full bg-surface-2 border border-line px-3 py-2 text-xs font-mono text-ink placeholder-ink-3 focus:outline-none focus:border-cream" />
                      )}
                    </div>
                    {newTool.authType === 'api-key' && (
                      <input value={newTool.authHeader ?? 'X-API-Key'} onChange={e => setNewTool(t => ({ ...t, authHeader: e.target.value }))}
                        placeholder="header name e.g. X-API-Key"
                        className="w-full bg-surface-2 border border-line px-3 py-2 text-xs font-mono text-ink placeholder-ink-3 focus:outline-none focus:border-cream" />
                    )}
                  </div>
                )}
                <div className="flex gap-2">
                  <button type="button" onClick={addTool} className="px-4 py-2 border border-cream text-xs font-mono text-cream hover:bg-cream hover:text-bg transition-colors">add tool</button>
                  <button type="button" onClick={() => setShowToolForm(false)} className="px-4 py-2 border border-line text-xs font-mono text-ink-3 hover:bg-surface-2">cancel</button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setShowToolForm(true)}
                className="px-4 py-2 border border-line text-xs font-mono text-ink-3 hover:bg-surface-2 hover:text-ink transition-colors">
                + add tool or mcp server
              </button>
            )}
          </div>
        </div>

        {/* Submit */}
        <div className="p-6">
          {!address ? (
            <div className="text-xs font-mono text-ink-3">connect wallet to deploy an agent</div>
          ) : (
            <>
              {/* Two-signature heads-up: deploying signs a message (free), then
                  funds the agent wallet via a real tx. Spelling this out up
                  front sets popup expectations so people don't bail at step 2. */}
              <div className="mb-4 border border-line bg-surface-2 px-4 py-3 text-[11px] font-mono text-ink-3 space-y-1">
                <div className="text-ink uppercase tracking-widest">deployment uses 2 signatures</div>
                <div>1. sign a message — no gas, derives owner pubkey for encryption</div>
                <div>2. send {DEPLOY_FUND_AMOUNT} 0G to the new agent wallet — pays for its gas</div>
                <div className="text-ink-3/70">your wallet balance: {ownerBalance ? `${parseFloat(formatEther(ownerBalance.value)).toFixed(4)} 0G` : '…'}</div>
              </div>

              {!hasEnoughForDeploy && ownerBalance && (
                <div className="mb-4 border border-err/40 bg-err/5 px-4 py-3 text-[11px] font-mono text-err space-y-1">
                  <div className="font-semibold">⚠ not enough 0G to fund the agent</div>
                  <div className="text-ink-3">
                    you need at least {MIN_OWNER_BALANCE} 0G (fund amount + gas for the
                    transfer). top up your wallet at{' '}
                    <a href="https://faucet.0g.ai" target="_blank" rel="noreferrer" className="text-cream underline">faucet.0g.ai</a>
                    {' '}then refresh.
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3 flex-wrap">
                <button type="submit" disabled={status === 'deploying' || status === 'funding' || capabilities.length === 0 || !hasEnoughForDeploy}
                  className="px-6 py-3 border border-cream text-xs font-mono text-cream hover:bg-cream hover:text-bg disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                  {status === 'deploying' ? 'deploying…' : status === 'funding' ? `funding agent with ${DEPLOY_FUND_AMOUNT} 0G…` : 'deploy + fund agent →'}
                </button>
                {capabilities.length === 0 && (
                  <span className="text-[11px] font-mono text-ink-3">pick at least one capability above to continue</span>
                )}
              </div>
            </>
          )}
          {status === 'error' && <div className="mt-3 text-xs font-mono text-red-400">{error}</div>}
        </div>
      </form>
    </div>
  );
}
