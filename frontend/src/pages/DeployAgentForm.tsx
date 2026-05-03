import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccount, useWalletClient } from 'wagmi';
import { recoverPublicKey, hashMessage } from 'viem';
import { Breadcrumb, PageHeader, SectionRule } from '../components/bb';

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
  const [newTool, setNewTool] = useState<Tool>({ type: 'http', name: '', description: '', url: '', method: 'POST', authType: 'none', authValue: '', authHeader: 'X-API-Key' });
  const [showToolForm, setShowToolForm] = useState(false);

  const [status, setStatus] = useState<'idle' | 'deploying' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const [agentId, setAgentId] = useState('');

  useEffect(() => {
    fetch('/api/v1/agents/providers')
      .then(r => r.json())
      .then(j => j.success && setProviders(j.data))
      .catch(() => {});
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
    try {
      // Derive the secp256k1 public key by recovering it from a signed message
      const msg = `BlindMarket agent deployment\nOwner: ${address}`;
      const sig = await walletClient.signMessage({ message: msg });
      const recovered = await recoverPublicKey({ hash: hashMessage(msg), signature: sig });
      // viem returns 0x04... — strip 0x for backend
      const ownerPublicKey = recovered.replace(/^0x/, '');

      const res = await fetch('/api/v1/agents/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          ownerAddress: address,
          ownerPublicKey,
          capabilities: [],
          tools: tools.map(t => {
            const headers: Record<string, string> = {};
            if (t.authType === 'bearer') headers['Authorization'] = `Bearer ${t.authValue}`;
            else if (t.authType === 'api-key') headers[t.authHeader ?? 'X-API-Key'] = t.authValue ?? '';
            else if (t.authType === 'basic') headers['Authorization'] = `Basic ${btoa(t.authValue ?? '')}`;
            return t.type === 'mcp'
              ? { type: 'mcp', name: t.name, description: t.description, endpointUrl: t.url, toolName: t.toolName ?? t.name }
              : { type: 'http', name: t.name, description: t.description, url: t.url, method: t.method ?? 'POST', headers };
          }),
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message ?? JSON.stringify(json.error));
      setAgentId(json.data.id);
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
          <div className="flex justify-center gap-4 mt-6">
            <button onClick={() => navigate('/agents/mine')} className="px-4 py-2 border border-cream text-xs font-mono text-cream hover:bg-cream hover:text-bg transition-colors">
              my agents →
            </button>
            <button onClick={() => { setStatus('idle'); setAgentId(''); }} className="px-4 py-2 border border-line text-xs font-mono text-ink-3 hover:bg-surface-2">
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
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">agent name <span className="text-cream">*</span></label>
              <input required value={form.name} onChange={e => set('name', e.target.value)}
                placeholder="research-agent"
                className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink placeholder-ink-3 focus:outline-none focus:border-cream" />
            </div>
            <div>
              <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">owner wallet</label>
              <div className="bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink-3">{address ?? 'connect wallet'}</div>
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
          <div className="mt-4 grid grid-cols-3 gap-4">
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

        {/* Tools */}
        <div className="p-6 border-b border-line">
          <SectionRule num="03" title="tools & mcp servers" side="optional" />
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
                <div className="grid grid-cols-2 gap-3">
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
                <div className="grid grid-cols-[1fr_120px] gap-3">
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
                        {['GET','POST','PUT','DELETE'].map(m => <option key={m} value={m}>{m}</option>)}
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
                    <div className="grid grid-cols-2 gap-3">
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
            <button type="submit" disabled={status === 'deploying'}
              className="px-6 py-3 border border-cream text-xs font-mono text-cream hover:bg-cream hover:text-bg disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {status === 'deploying' ? 'deploying…' : 'deploy agent →'}
            </button>
          )}
          {status === 'error' && <div className="mt-3 text-xs font-mono text-red-400">{error}</div>}
        </div>
      </form>
    </div>
  );
}
