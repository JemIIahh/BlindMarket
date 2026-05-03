import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import {
  Breadcrumb,
  PageHeader,
  SectionRule,
  Button,
  Tag,
  FormField,
} from '../components/bb';
import { useWallet } from '../context/WalletContext';
import { useReputation } from '../hooks/useReputation';
import { OG_CHAIN_ID } from '../config/constants';

const NOTIF_KEYS = {
  payout: 'bb.notify.payout',
  assignment: 'bb.notify.assignment',
  dispute: 'bb.notify.dispute',
} as const;

function loadBool(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  const v = window.localStorage.getItem(key);
  return v == null ? fallback : v === '1';
}

function saveBool(key: string, v: boolean) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(key, v ? '1' : '0');
}

export default function Settings() {
  const { chainId, isCorrectChain, switchChain } = useWallet();
  const { address, isConnected } = useAccount();
  const { data: reputation } = useReputation(address ?? null);

  const [notifyPayouts, setNotifyPayouts] = useState(() => loadBool(NOTIF_KEYS.payout, true));
  const [notifyAssignments, setNotifyAssignments] = useState(() => loadBool(NOTIF_KEYS.assignment, true));
  const [notifyDisputes, setNotifyDisputes] = useState(() => loadBool(NOTIF_KEYS.dispute, false));

  useEffect(() => saveBool(NOTIF_KEYS.payout, notifyPayouts), [notifyPayouts]);
  useEffect(() => saveBool(NOTIF_KEYS.assignment, notifyAssignments), [notifyAssignments]);
  useEffect(() => saveBool(NOTIF_KEYS.dispute, notifyDisputes), [notifyDisputes]);

  const walletDisplay = address
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : 'not connected';

  const reputationDisplay = reputation
    ? `${reputation.decayedScore.toFixed(1)} · ${reputation.tasksCompleted} tasks · ${reputation.disputes} disputes`
    : 'no reputation yet';

  return (
    <div>
      <Breadcrumb items={['account', 'settings']} />
      <PageHeader title="Settings" />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-0 border border-line">
        {/* Left column */}
        <div className="p-6 space-y-8">
          {/* Identity */}
          <div className="space-y-5">
            <SectionRule num="01" title="identity" />

            <FormField label="wallet_address">
              <div className="px-3 py-2.5 bg-surface-2 border border-line text-ink-3 text-sm font-mono flex items-center gap-2">
                <span>{walletDisplay}</span>
                {isConnected ? <Tag tone="ok">connected</Tag> : <Tag tone="warn">disconnected</Tag>}
              </div>
            </FormField>

            <FormField label="reputation" hint="decayed on-chain + off-chain score">
              <div className="px-3 py-2.5 bg-surface-2 border border-line text-sm font-mono text-ink-3">
                {address ? reputationDisplay : 'connect wallet to view reputation'}
              </div>
            </FormField>

            <FormField label="social_oauth" hint="coming soon — link accounts for optional identity verification">
              <div className="flex gap-2">
                <Button variant="outline" label="github (soon)" size="sm" disabled />
                <Button variant="outline" label="twitter (soon)" size="sm" disabled />
                <Button variant="outline" label="google (soon)" size="sm" disabled />
              </div>
            </FormField>
          </div>

          {/* Network */}
          <div className="space-y-5">
            <SectionRule num="02" title="network" />

            <FormField label="supported_chain" hint="BlindMarket runs on 0G Galileo (16602)">
              <div className="px-3 py-2.5 bg-surface-2 border border-line text-sm font-mono flex items-center gap-2">
                <Tag tone={isCorrectChain ? 'ok' : 'warn'}>0g_galileo · 16602</Tag>
                {chainId != null && chainId !== OG_CHAIN_ID && (
                  <>
                    <span className="text-ink-3">currently on chain {chainId}</span>
                    <button
                      onClick={switchChain}
                      className="ml-auto text-[11px] underline underline-offset-2 text-amber-200 hover:text-amber-100"
                    >
                      switch
                    </button>
                  </>
                )}
                {isCorrectChain && <span className="text-ok">● active</span>}
              </div>
            </FormField>
          </div>

          {/* Notifications */}
          <div className="space-y-5">
            <SectionRule num="03" title="notifications · saved to this browser" />

            {[
              { label: 'payout_received', value: notifyPayouts, set: setNotifyPayouts },
              { label: 'task_assigned', value: notifyAssignments, set: setNotifyAssignments },
              { label: 'dispute_opened', value: notifyDisputes, set: setNotifyDisputes },
            ].map((toggle) => (
              <div key={toggle.label} className="flex items-center justify-between py-2 border-b border-line last:border-b-0">
                <span className="text-xs font-mono text-ink">{toggle.label}</span>
                <button
                  onClick={() => toggle.set(!toggle.value)}
                  className={`w-10 h-5 border transition-colors flex items-center ${
                    toggle.value ? 'bg-cream/20 border-cream/40' : 'bg-surface-2 border-line'
                  }`}
                >
                  <div
                    className={`w-3 h-3 transition-all ${
                      toggle.value ? 'bg-cream ml-5' : 'bg-ink-3 ml-1'
                    }`}
                  />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Right column */}
        <div className="border-l border-line p-6 space-y-6">
          {/* Session state */}
          <div className="space-y-4">
            <SectionRule num="I" title="session state" />

            <div className="space-y-2">
              {[
                { label: 'wallet', value: isConnected ? '● connected' : '○ disconnected', color: isConnected ? 'text-ok' : 'text-ink-3' },
                { label: 'chain_id', value: chainId != null ? String(chainId) : '—', color: isCorrectChain ? 'text-ok' : 'text-warn' },
                { label: 'rpc', value: 'evmrpc-testnet.0g.ai', color: 'text-ink-3' },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between py-1.5">
                  <span className="text-[11px] font-mono text-ink-3">{item.label}</span>
                  <span className={`text-[11px] font-mono ${item.color}`}>{item.value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Privacy explainer */}
          <div className="space-y-3">
            <div className="text-[11px] font-mono text-ink-3">▸ privacy</div>
            <div className="bg-surface-2 border border-line p-4 space-y-2">
              <p className="text-[11px] font-mono text-ink-3 leading-relaxed">
                ● ecies keys are generated in-browser and never transmitted.
              </p>
              <p className="text-[11px] font-mono text-ink-3 leading-relaxed">
                ● aes-256-gcm keys are ephemeral — one per task.
              </p>
              <p className="text-[11px] font-mono text-ink-3 leading-relaxed">
                ● private keys exist only in browser memory. closing the tab destroys them.
              </p>
              <p className="text-[11px] font-mono text-ink-3 leading-relaxed">
                ● the platform never sees plaintext instructions or evidence.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
