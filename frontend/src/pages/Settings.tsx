import { useCallback, useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { useAuth } from '../context/AuthContext';
import { usePrivy, useUnlinkWallet, useSigners, useExportWallet } from '@privy-io/react-auth';
import {
  Breadcrumb,
  PageHeader,
  SectionRule,
  Button,
  Tag,
  FormField,
  FormInput,
  Modal,
  ConfirmDialog,
  Toggle,
} from '../components/bb';
import { useReputation } from '../hooks/useReputation';
import { useWallet } from '../context/WalletContext';
import {
  isMainnet, OG_CHAIN_ID, OG_RPC_URL, PRIVY_RELAY_SIGNER_ID,
} from '../config/constants';
import { useSettlement } from '../config/settlement';
import { authedGet, authedPost, authedDelete } from '../lib/api';
import { copyToClipboard } from '../lib/utils';

const NOTIF_KEYS = {
  payout: 'bb.notify.payout',
  assignment: 'bb.notify.assignment',
  dispute: 'bb.notify.dispute',
} as const;

// try/catch: with storage fully blocked (Safari "Block All Cookies",
// locked-down webviews) ANY localStorage access throws — and loadBool runs
// inside a useState initializer, so an unguarded throw kills the whole page.
function loadBool(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const v = window.localStorage.getItem(key);
    return v == null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function saveBool(key: string, v: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, v ? '1' : '0');
  } catch {}
}

export default function Settings() {
  const { isAuthenticated } = useAuth();
  const { address: evmAddress, isConnected: evmConnected } = useAccount();
  const isConnected = evmConnected;
  const address = evmAddress;
  const { data: reputation } = useReputation(address ?? null);
  const { user, linkWallet } = usePrivy();
  const { unlink } = useUnlinkWallet();
  const { addSigners } = useSigners();
  const { exportWallet } = useExportWallet();
  const { embeddedAddress } = useWallet();

  const [relaySignerLoading, setRelaySignerLoading] = useState(false);
  const [relaySignerStatus, setRelaySignerStatus] = useState<'idle' | 'done' | 'error'>('idle');
  const [exporting, setExporting] = useState(false);

  const handleExportWallet = async () => {
    if (!embeddedAddress) return;
    setExporting(true);
    try {
      await exportWallet({ address: embeddedAddress });
    } catch (err) {
      console.error('Failed to export wallet:', err);
    } finally {
      setExporting(false);
    }
  };

  // Always the embedded wallet: wagmi's active address may be a linked external wallet.
  const handleAddRelaySigner = async () => {
    if (!embeddedAddress) return;
    setRelaySignerLoading(true);
    try {
      await addSigners({
        address: embeddedAddress,
        signers: [{ signerId: PRIVY_RELAY_SIGNER_ID }],
      });
      setRelaySignerStatus('done');
    } catch (err) {
      console.error('Failed to add relay signer:', err);
      setRelaySignerStatus('error');
    } finally {
      setRelaySignerLoading(false);
    }
  };
  const chainLabel = `0G ${isMainnet ? 'Mainnet' : 'Testnet'}`;
  // Where new tasks are escrowed and paid, as the backend reports it.
  const settlement = useSettlement();
  const postingInfo = settlement.chains[settlement.postingChain];
  const ogRpcDisplay = OG_RPC_URL.replace(/^https?:\/\//, '');

  const [notifyPayouts, setNotifyPayouts] = useState(() => loadBool(NOTIF_KEYS.payout, true));
  const [notifyAssignments, setNotifyAssignments] = useState(() => loadBool(NOTIF_KEYS.assignment, true));
  const [notifyDisputes, setNotifyDisputes] = useState(() => loadBool(NOTIF_KEYS.dispute, false));

  useEffect(() => saveBool(NOTIF_KEYS.payout, notifyPayouts), [notifyPayouts]);
  useEffect(() => saveBool(NOTIF_KEYS.assignment, notifyAssignments), [notifyAssignments]);
  useEffect(() => saveBool(NOTIF_KEYS.dispute, notifyDisputes), [notifyDisputes]);

  const linkedWallets = ((user as any)?.linkedAccounts ?? (user as any)?.linked_accounts ?? []).filter(
    (a: any) => a.type === 'wallet' && a.chainType === 'ethereum' && a.address?.startsWith('0x'),
  ) as Array<{ type: 'wallet'; address: string; chainType: string; verifiedAt?: string; connectorType?: string }>;

  const [unlinkTarget, setUnlinkTarget] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const handleUnlink = async () => {
    if (!unlinkTarget) return;
    setUnlinking(true);
    try {
      await unlink({ address: unlinkTarget });
    } catch { /* ignore */ } finally {
      setUnlinking(false);
      setUnlinkTarget(null);
    }
  };

  // ── API Keys ──────────────────────────────────────────────────────────────

  interface ApiKeyView {
    id: number;
    name: string;
    prefix: string;
    capabilities: string[];
    agentAddress: string | null;
    lastUsedAt: string | null;
    createdAt: string;
  }

  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const loadKeys = useCallback(async () => {
    // /api/v1/api-keys is authed — without this the page 401s on open for a
    // signed-out (or still-signing-in) visitor.
    if (!isAuthenticated) { setKeys([]); setLoadingKeys(false); return; }
    try {
      setLoadingKeys(true);
      const data = await authedGet<ApiKeyView[]>('/api/v1/api-keys');
      setKeys(data);
    } catch { /* ignore */ } finally {
      setLoadingKeys(false);
    }
  }, [isAuthenticated]);

  useEffect(() => { loadKeys(); }, [loadKeys]);

  const handleCreate = async () => {
    if (!newKeyName.trim()) return;
    setCreating(true);
    try {
      const data = await authedPost<{ id: number; rawKey: string }>('/api/v1/api-keys', {
        name: newKeyName.trim(),
      });
      setCreatedKey(data.rawKey);
      setNewKeyName('');
      setShowCreate(false);
      await loadKeys();
    } catch { /* ignore */ } finally {
      setCreating(false);
    }
  };

  const [revokeTarget, setRevokeTarget] = useState<number | null>(null);
  const [revoking, setRevoking] = useState(false);
  const handleRevoke = async () => {
    if (revokeTarget == null) return;
    setRevoking(true);
    try {
      await authedDelete(`/api/v1/api-keys/${revokeTarget}`);
      setKeys(prev => prev.filter(k => k.id !== revokeTarget));
    } catch { /* ignore */ } finally {
      setRevoking(false);
      setRevokeTarget(null);
    }
  };

  const walletDisplay = address
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : 'Not connected';

  const reputationDisplay = reputation
    ? `${reputation.decayedScore.toFixed(1)} · ${reputation.tasksCompleted} tasks · ${reputation.disputes} disputes`
    : 'No reputation yet';

  const notifications: { label: string; description: string; value: boolean; set: (v: boolean) => void }[] = [
    { label: 'Payout received', description: 'When escrow settles a task in your favour.', value: notifyPayouts, set: setNotifyPayouts },
    { label: 'Task assigned', description: 'When one of your agents is matched to a task.', value: notifyAssignments, set: setNotifyAssignments },
    { label: 'Dispute opened', description: 'When a task you are involved in enters dispute.', value: notifyDisputes, set: setNotifyDisputes },
  ];

  return (
    <div>
      <Breadcrumb items={['account', 'settings']} />
      <PageHeader title="Settings" description="Manage your identity, network, and notification preferences." />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-0 border border-line">
        {/* Left column */}
        <div className="p-6 space-y-10">
          {/* Identity */}
          <div className="space-y-5">
            <SectionRule num="01" title="Identity" />

            <FormField label="Wallet address">
              <div className="px-3 py-2.5 bg-surface-2 border border-line text-sm flex items-center gap-2 flex-wrap">
                <span className="font-mono text-ink-2">{walletDisplay}</span>
                {isConnected ? <Tag tone="ok">Connected</Tag> : <Tag tone="warn">Disconnected</Tag>}
              </div>
            </FormField>

            <FormField
              label="Export wallet"
              hint="Reveals your BlindMarket wallet's private key / seed phrase in a Privy-hosted iframe this app can't read — for moving it into MetaMask or another wallet client."
            >
              <Button
                variant="outline"
                size="sm"
                label={exporting ? 'Opening…' : 'Export wallet'}
                onClick={handleExportWallet}
                disabled={exporting || !embeddedAddress}
              />
            </FormField>

            <FormField label="Reputation" hint="Decayed on-chain + off-chain score">
              <div className="px-3 py-2.5 bg-surface-2 border border-line text-sm font-mono text-ink-2">
                {address ? reputationDisplay : 'Connect wallet to view reputation'}
              </div>
            </FormField>

            <FormField label="Social verification" hint="Coming soon — link accounts for optional identity verification.">
              <div className="flex gap-2 flex-wrap">
                <Button variant="outline" label="GitHub (soon)" size="sm" disabled />
                <Button variant="outline" label="Twitter (soon)" size="sm" disabled />
                <Button variant="outline" label="Google (soon)" size="sm" disabled />
              </div>
            </FormField>
          </div>

          {/* Linked Wallets */}
          <div className="space-y-5">
            <SectionRule num="02" title="Linked Wallets" side="All wallets in your Privy account" />

            <div className="border border-line divide-y divide-line">
              {linkedWallets.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-ink-3">No wallets linked yet.</div>
              ) : (
                linkedWallets.map((w) => {
                  const isEmbedded = w.address.toLowerCase() === embeddedAddress?.toLowerCase();
                  const isActive = w.address.toLowerCase() === address?.toLowerCase();
                  return (
                    <div key={w.address} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-sm text-ink">
                          {w.address.slice(0, 6)}…{w.address.slice(-4)}
                        </span>
                        {isEmbedded ? <Tag tone="ok">BlindMarket wallet</Tag> : <Tag tone="neutral">External</Tag>}
                      </div>
                      {!isEmbedded && !isActive && (
                        <button
                          onClick={() => setUnlinkTarget(w.address)}
                          className="text-[10px] uppercase tracking-wider text-err hover:text-err/80 transition-colors shrink-0"
                        >
                          Unlink
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            <p className="text-xs text-ink-3 leading-relaxed">
              Your BlindMarket wallet is managed for you — it pays for tasks and receives payouts. Link an external
              wallet (e.g. MetaMask) if you want to bridge funds in from another chain.
            </p>

            <Button
              variant="outline"
              label="Link wallet"
              size="sm"
              onClick={() => linkWallet()}
            />
          </div>

          {/* Network */}
          <div className="space-y-5">
            <SectionRule num="03" title="Network" />

            <FormField
              label="Settlement chain"
              hint={`New tasks are escrowed and paid in ${postingInfo.token.unit.symbol} on ${postingInfo.label}.`}
            >
              <div className="px-3 py-2.5 bg-surface-2 border border-line text-sm flex items-center gap-2 flex-wrap">
                <Tag tone="ok">
                  {postingInfo.label} · <span className="font-mono">{postingInfo.chainId}</span>
                </Tag>
                <span className="ml-auto text-xs text-ok">{postingInfo.tier === 'mainnet' ? 'Mainnet' : 'Testnet'}</span>
              </div>
            </FormField>

            <FormField
              label="Agent infra chain (0G)"
              hint="Agent identity and reputation live on 0G."
            >
              <div className="px-3 py-2.5 bg-surface-2 border border-line text-sm flex items-center gap-2 flex-wrap">
                <Tag tone="neutral">
                  0G · <span className="font-mono">{OG_CHAIN_ID}</span>
                </Tag>
                <span className="ml-auto text-xs text-ink-2">{chainLabel}</span>
              </div>
            </FormField>

            <FormField
              label="Server relay access"
              hint="One-time setup: allows the backend to sign transactions on your behalf."
            >
              {relaySignerStatus === 'done' ? (
                <div className="px-3 py-2.5 bg-surface-2 border border-line text-sm text-ok flex items-center gap-2">
                  <Tag tone="ok">Enabled</Tag>
                  <span className="text-xs text-ink-3">Relay signer added to your wallet.</span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    label={relaySignerLoading ? 'Approve in wallet…' : 'Enable relay'}
                    onClick={handleAddRelaySigner}
                    disabled={relaySignerLoading || !embeddedAddress}
                  />
                  {relaySignerStatus === 'error' && (
                    <span className="text-xs text-err">Failed. Try again.</span>
                  )}
                </div>
              )}
            </FormField>
          </div>

          {/* API Keys */}
          <div className="space-y-5">
            <SectionRule num="04" title="API Keys" side="Revocable · stored as hash" />

            <div className="border border-line divide-y divide-line">
              {loadingKeys ? (
                <div className="px-4 py-6 text-center text-xs text-ink-3">Loading keys…</div>
              ) : keys.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-ink-3">No API keys yet.</div>
              ) : (
                keys.map((k) => (
                  <div key={k.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-sm text-ink">{k.name}</div>
                      <div className="text-xs font-mono text-ink-3 mt-0.5">{k.prefix}</div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-[10px] text-ink-3 hidden sm:inline">
                        {k.lastUsedAt
                          ? `Used ${new Date(k.lastUsedAt).toLocaleDateString()}`
                          : 'Never used'}
                      </span>
                      <button
                        onClick={() => setRevokeTarget(k.id)}
                        className="text-[10px] uppercase tracking-wider text-err hover:text-err/80 transition-colors"
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <Button
              variant="outline"
              label="Create key"
              size="sm"
              onClick={() => setShowCreate(true)}
            />
          </div>

          {/* Notifications */}
          <div className="space-y-5">
            <SectionRule num="05" title="Notifications" side="Saved to this browser" />

            <div className="border border-line">
              {notifications.map((toggle, i) => (
                <div
                  key={toggle.label}
                  className={`flex items-center justify-between gap-4 px-4 py-3.5 ${i > 0 ? 'border-t border-line' : ''}`}
                >
                  <div className="min-w-0">
                    <div className="text-sm text-ink">{toggle.label}</div>
                    <div className="text-xs text-ink-3 mt-0.5 leading-relaxed">{toggle.description}</div>
                  </div>
                  <Toggle
                    checked={toggle.value}
                    onChange={toggle.set}
                    label={toggle.label}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="border-t lg:border-t-0 lg:border-l border-line p-6 space-y-8">
          {/* Session state */}
          <div className="space-y-4">
            <SectionRule num="06" title="Session" />

            <div className="space-y-2">
              {[
                {
                  label: 'Wallet',
                  value: isConnected ? 'Connected' : 'Disconnected',
                  mono: false,
                  color: isConnected ? 'text-ok' : 'text-ink-3',
                },
                {
                  label: `${postingInfo.label} Chain ID`,
                  value: String(postingInfo.chainId),
                  mono: true,
                  color: 'text-ok',
                },
                {
                  label: '0G Chain ID',
                  value: String(OG_CHAIN_ID),
                  mono: true,
                  color: 'text-ink-2',
                },
                {
                  label: '0G RPC',
                  value: ogRpcDisplay,
                  mono: true,
                  color: 'text-ink-3',
                },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="text-xs text-ink-3">{item.label}</span>
                  <span className={`text-xs ${item.mono ? 'font-mono' : ''} ${item.color} truncate`}>
                    {item.value}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Privacy explainer */}
          <div className="space-y-3">
            <SectionRule num="07" title="Privacy" />
            <div className="bg-surface-2 border border-line p-4 space-y-2.5">
              <p className="text-xs text-ink-3 leading-relaxed">
                ECIES keys are generated in-browser and never transmitted.
              </p>
              <p className="text-xs text-ink-3 leading-relaxed">
                AES-256-GCM keys are ephemeral — one per task.
              </p>
              <p className="text-xs text-ink-3 leading-relaxed">
                Private keys exist only in browser memory. Closing the tab destroys them.
              </p>
              <p className="text-xs text-ink-3 leading-relaxed">
                The platform never sees plaintext instructions or evidence.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Create key modal ── */}
      <Modal
        open={showCreate}
        onClose={() => { setShowCreate(false); setNewKeyName(''); }}
        title="Create API key"
        size="sm"
      >
        <div className="space-y-4">
          <FormField label="Key name">
            <FormInput
              type="text"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="e.g. CI server"
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
            />
          </FormField>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              label="Cancel"
              onClick={() => { setShowCreate(false); setNewKeyName(''); }}
            />
            <Button
              variant="primary"
              size="sm"
              label={creating ? 'Creating…' : 'Create key'}
              onClick={handleCreate}
              disabled={creating || !newKeyName.trim()}
            />
          </div>
        </div>
      </Modal>

      {/* ── Show new key once — deliberately not dismissable via backdrop:
            the key is shown exactly once, so closing must be explicit. ── */}
      <Modal open={!!createdKey} onClose={() => setCreatedKey(null)} title="Key created" dismissable={false}>
        <div className="space-y-4">
          <p className="text-xs text-ink-3 leading-relaxed">
            Copy this key now. For security reasons, it will not be shown again.
          </p>
          <div className="flex items-center gap-2 bg-surface-2 border border-line px-3 py-2.5">
            <code className="flex-1 text-xs font-mono text-cream break-all select-all">{createdKey}</code>
            <button
              onClick={() => { if (createdKey) copyToClipboard(createdKey); }}
              className="text-[10px] uppercase tracking-wider text-ink-3 hover:text-ink shrink-0 transition-colors"
            >
              Copy
            </button>
          </div>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" label="Done" onClick={() => setCreatedKey(null)} />
          </div>
        </div>
      </Modal>

      {/* ── Confirmations ── */}
      <ConfirmDialog
        open={!!unlinkTarget}
        title="Unlink wallet"
        description={
          unlinkTarget
            ? `${unlinkTarget.slice(0, 6)}…${unlinkTarget.slice(-4)} will be removed from your account. You can link it again later.`
            : undefined
        }
        confirmLabel="Unlink wallet"
        danger
        loading={unlinking}
        onConfirm={handleUnlink}
        onCancel={() => setUnlinkTarget(null)}
      />
      <ConfirmDialog
        open={revokeTarget != null}
        title="Revoke API key"
        description="Any system using this key loses access immediately. This can't be undone."
        confirmLabel="Revoke key"
        danger
        loading={revoking}
        onConfirm={handleRevoke}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  );
}