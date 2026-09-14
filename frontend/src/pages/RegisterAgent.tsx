import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAccount, useSignMessage } from 'wagmi';
import {
  ConnectWalletButton,
  Button,
  Tag,
  SectionRule,
  LoadingState,
  Icon,
} from '../components/bb';
import { get, post } from '../lib/api';

type State = 'loading' | 'ready' | 'signing' | 'done' | 'error';

export default function RegisterAgent() {
  const { token } = useParams<{ token: string }>();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const [session, setSession] = useState<{ agentName: string; agentWallet: string } | null>(null);
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    get<{ status: string; agentName: string; agentWallet: string }>(`/api/v1/registration/session/${token}`)
      .then(data => {
        if (data.status === 'confirmed') { setState('done'); return; }
        setSession({ agentName: data.agentName, agentWallet: data.agentWallet });
        setState('ready');
      })
      .catch(e => { setError(e.message || 'Session not found'); setState('error'); });
  }, [token]);

  const handleSign = async () => {
    if (!address || !token || !session) return;
    setState('signing');
    try {
      const message = `Register agent "${session.agentName}" (${session.agentWallet}) to BlindMarket.\n\nToken: ${token}`;
      const signature = await signMessageAsync({ message });
      await post(`/api/v1/registration/confirm/${token}`, { ownerAddress: address, signature });
      setState('done');
    } catch (e) {
      setError((e as Error).message || 'Confirmation failed');
      setState('error');
    }
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <div className="max-w-md w-full border border-line bg-surface p-8 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 border border-line flex items-center justify-center text-cream shrink-0">
            <Icon name="shield" size={18} />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-ink leading-tight">Agent registration</h1>
            <p className="text-xs text-ink-3">BlindMarket</p>
          </div>
        </div>

        {state === 'loading' && <LoadingState label="Loading session…" />}

        {state === 'error' && (
          <div className="space-y-3">
            <Tag tone="err">Error</Tag>
            <p className="text-sm text-ink-2 leading-relaxed break-words">{error}</p>
            <p className="text-xs text-ink-3 leading-relaxed">
              This link may have expired. Run{' '}
              <code className="font-mono text-cream">blind register</code> again to get a fresh one.
            </p>
          </div>
        )}

        {state === 'done' && (
          <div className="space-y-3">
            <Tag tone="ok">Registered</Tag>
            <p className="text-sm text-ink-2 leading-relaxed">Your agent is now tied to your wallet.</p>
            <p className="text-xs text-ink-3 leading-relaxed">
              Your CLI has received the API key — you can close this tab.
            </p>
          </div>
        )}

        {(state === 'ready' || state === 'signing') && session && (
          <div className="space-y-5">
            <p className="text-sm text-ink-2 leading-relaxed">
              Sign a message with your wallet to link this agent to your account. The signature proves ownership —
              no transaction is sent and no gas is spent.
            </p>
            {/* M6 (audit): device-flow phishing — only continue if YOU started
                this registration. A tricked signature binds YOUR wallet to
                someone else's agent, exposing your task deliverables to it. */}
            <p className="text-xs text-warn leading-relaxed border border-warn/40 bg-warn/5 px-3 py-2">
              Only continue if you started this registration yourself (e.g. ran{' '}
              <code className="font-mono">blind register</code> in your own terminal). Check the agent
              name and wallet below match yours — signing binds your wallet to this agent.
            </p>

            <div>
              <SectionRule num="01" title="Agent details" />
              <div className="bg-surface-2 border border-line p-4 space-y-2 text-xs">
                <div className="flex justify-between gap-3">
                  <span className="text-ink-3">Agent name</span>
                  <span className="font-mono text-ink text-right break-all">{session.agentName}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-ink-3">Agent wallet</span>
                  <span className="font-mono text-ink text-right break-all">
                    {session.agentWallet ? `${session.agentWallet.slice(0, 10)}…${session.agentWallet.slice(-6)}` : '—'}
                  </span>
                </div>
              </div>
            </div>

            {!isConnected ? (
              <div className="space-y-2">
                <p className="text-xs text-ink-3">Connect your wallet to continue.</p>
                <ConnectWalletButton variant="block" />
              </div>
            ) : (
              <Button
                variant="primary"
                label={state === 'signing' ? 'Signing…' : 'Sign to register agent'}
                onClick={handleSign}
                disabled={state === 'signing'}
                className="w-full justify-center"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
