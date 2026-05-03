import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAccount, useBalance } from 'wagmi';

interface AgentDetails {
  id: string;
  name: string;
  provider: string;
  model: string;
  status: string;
  ownerAddress: string;
  deployedAt: string;
  instructions: string;
  walletAddress?: string;
  publicKey?: string;
  inftTokenId?: number;
}

export default function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const { address } = useAccount();
  const navigate = useNavigate();
  const [agent, setAgent] = useState<AgentDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<string[]>([]);

  const { data: balance } = useBalance({
    address: agent?.walletAddress as `0x${string}` | undefined,
    query: { enabled: !!agent?.walletAddress },
  });

  useEffect(() => {
    fetch(`/api/v1/agents/${id}`)
      .then(r => r.json())
      .then(d => { if (d.success) setAgent(d.data); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/v1/agents/${id}/logs`);
    es.onmessage = (e) => {
      try { setLogs(prev => [...prev.slice(-199), JSON.parse(e.data)]); } catch {}
    };
    return () => es.close();
  }, [id]);

  if (loading) return <div className="text-center py-20 text-gray-500">Loading…</div>;

  if (!agent) return (
    <div className="text-center py-20">
      <p className="text-gray-500 mb-4">Agent not found</p>
      <button onClick={() => navigate('/agents')} className="text-blue-400 underline text-sm">Back</button>
    </div>
  );

  const isOwner = address?.toLowerCase() === agent.ownerAddress?.toLowerCase();

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button onClick={() => navigate('/agents/mine')} className="text-gray-500 hover:text-white text-sm transition-colors">
          ← Back to my agents
        </button>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-900/40 border border-blue-800/50 flex items-center justify-center text-blue-400 font-bold text-sm">
            {agent.name.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">{agent.name}</h1>
            <p className="text-gray-500 text-xs">{agent.provider} · {agent.model}</p>
          </div>
        </div>
        <div className="ml-auto">
          <span className={`px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1.5 ${
            agent.status === 'running' ? 'bg-green-900/40 text-green-400' :
            agent.status === 'paused'  ? 'bg-yellow-900/40 text-yellow-400' :
            'bg-gray-800 text-gray-500'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${
              agent.status === 'running' ? 'bg-green-400 animate-pulse' :
              agent.status === 'paused'  ? 'bg-yellow-400' : 'bg-gray-500'
            }`} />
            {agent.status}
          </span>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        {/* Left panel */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-gray-950 border border-gray-800 rounded-xl p-5">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4">Identity</p>
            <div className="space-y-4">
              <div>
                <p className="text-gray-500 text-xs mb-1">Owner</p>
                <p className="text-white font-mono text-xs">{agent.ownerAddress.slice(0, 6)}...{agent.ownerAddress.slice(-4)}</p>
              </div>
              <div>
                <p className="text-gray-500 text-xs mb-1">Deployed</p>
                <p className="text-white text-xs">{new Date(agent.deployedAt).toLocaleString()}</p>
              </div>
              {agent.walletAddress && (
                <div>
                  <p className="text-gray-500 text-xs mb-1">Agent Wallet</p>
                  <p className="text-white font-mono text-xs break-all">{agent.walletAddress}</p>
                  <p className="text-blue-400 text-xs mt-1 font-medium">
                    {balance ? `${parseFloat(balance.formatted).toFixed(4)} ${balance.symbol}` : 'loading...'}
                  </p>
                </div>
              )}
              {agent.inftTokenId !== undefined && (
                <div>
                  <p className="text-gray-500 text-xs mb-1">INFT Token</p>
                  <p className="text-white font-mono text-xs">#{agent.inftTokenId}</p>
                </div>
              )}
              {agent.publicKey && (
                <div>
                  <p className="text-gray-500 text-xs mb-1">Public Key</p>
                  <p className="text-white font-mono text-xs">{agent.publicKey.slice(0, 18)}…{agent.publicKey.slice(-6)}</p>
                </div>
              )}
            </div>
          </div>

          <div className="bg-gray-950 border border-gray-800 rounded-xl p-5">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Instructions</p>
            <p className="text-gray-300 text-xs leading-relaxed whitespace-pre-wrap">{agent.instructions}</p>
          </div>

          {isOwner && (
            <div className="bg-gray-950 border border-gray-800 rounded-xl p-5">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Controls</p>
              <button className="w-full text-xs font-medium py-2 rounded-lg bg-blue-900/30 text-blue-400 hover:bg-blue-900/50 transition-colors">
                ⚙ Manage Agent
              </button>
            </div>
          )}
        </div>

        {/* Logs panel */}
        <div className="lg:col-span-3">
          <div className="bg-gray-950 border border-gray-800 rounded-xl p-5 h-full">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Live Logs</p>
              {agent.status === 'running' && (
                <span className="flex items-center gap-1.5 text-xs text-green-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                  live
                </span>
              )}
            </div>
            <div className="space-y-0.5 max-h-[520px] overflow-y-auto font-mono">
              {logs.length > 0 ? logs.map((line, i) => (
                <div key={i} className={`text-xs px-3 py-1.5 rounded ${
                  line.includes('[err]') ? 'bg-red-900/20 text-red-400' : 'text-gray-300 hover:bg-gray-900'
                }`}>
                  {line}
                </div>
              )) : (
                <div className="text-center py-16 text-gray-600 text-sm">
                  {agent.status === 'running' ? 'Waiting for logs…' : 'Start the agent to see logs'}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
