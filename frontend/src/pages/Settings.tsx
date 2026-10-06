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
  ErrorNotice,
} from '../components/bb';
import { useReputation } from '../hooks/useReputation';
import { useWallet } from '../context/WalletContext';
import {
  OG_CHAIN_ID, OG_RPC_URL, PRIVY_RELAY_SIGNER_ID, DISPLAY_MAINNET,
} from '../config/constants';
import { useSettlement } from '../config/settlement';
import { authedGet, authedPost, authedDelete } from '../lib/api';
import { copyToClipboard } from '../lib/utils';
import { YourAvatarField } from '../components/avatar/AvatarEditor';
import { TelegramAlerts } from '../components/settings/TelegramAlerts';

// The landing's shapes: each section is its own rounded card, values sit in
// soft rounded panels, and lists get a rounded hairline frame.
const CARD = 'card-dark rounded-3xl p-6 sm:p-7';
const VALUE_BOX = 'rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-sm';
const LIST_BOX = 'overflow-hidden rounded-2xl border border-line divide-y divide-line';
const DANGER_TEXT_BUTTON =
  'shrink-0 rounded-full px-3 py-1 text-xs font-medium text-err transition-colors duration-200 hover:bg-[color:color-mix(in_srgb,var(--bb-err)_10%,transparent)]';

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
  const [relaySignerError, setRelaySignerError] = useState<unknown>(null);
  const [exporting, setExporting] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);

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
      setRelaySignerError(err);
      setRelaySignerStatus('error');
    } finally {
      setRelaySignerLoading(false);
    }
  };
  const chainLabel = `0G ${DISPLAY_MAINNET ? 'Mainnet' : 'Testnet'}`;
  // Where new tasks are escrowed and paid, as the backend reports it.
  const settlement = useSettlement();
  const postingInfo = settlement.chains[settlement.postingChain];
  const ogRpcDisplay = OG_RPC_URL.replace(/^https?:\/\//, '');

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

  return (
    <div>
      <Breadcrumb items={['account', 'settings']} />
      <PageHeader title="Settings." titleMuted="Your identity, wallets and alerts." />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-5 items-start">
        {/* Left column */}
        <div className="space-y-5 min-w-0">
          {/* Identity */}
          <section className={`${CARD} space-y-5`}>
            <SectionRule num="01" title="Identity" />

            <FormField label="Your avatar">
              <YourAvatarField />
            </FormField>

            <FormField label="Wallet address">
              <div className={`${VALUE_BOX} flex items-center gap-2 flex-wrap`}>
                <span className="font-mono text-ink-2">{walletDisplay}</span>
                {isConnected ? <Tag tone="ok">Connected</Tag> : <Tag tone="warn">Disconnected</Tag>}
              </div>
            </FormField>

            <FormField
              label="Export wallet"
              hint="Opens your private key in a Privy window this app can't read, so you can move the wallet to MetaMask or another wallet."
            >
              <Button
                variant="outline"
                size="sm"
                label={exporting ? 'Opening…' : 'Export wallet'}
                onClick={handleExportWallet}
                disabled={exporting || !embeddedAddress}
              />
            </FormField>

            <FormField label="Reputation" hint="On-chain and off-chain score, decaying over time.">
              <div className={`${VALUE_BOX} font-mono text-ink-2`}>
                {address ? reputationDisplay : 'Connect a wallet to see your reputation'}
              </div>
            </FormField>

            <FormField label="Social verification" hint="Coming soon: link accounts to verify your identity.">
              <div className="flex gap-2 flex-wrap">
                <Button variant="outline" label="GitHub (soon)" size="sm" disabled />
                <Button variant="outline" label="Twitter (soon)" size="sm" disabled />
                <Button variant="outline" label="Google (soon)" size="sm" disabled />
              </div>
            </FormField>
          </section>

          {/* Linked Wallets */}
          <section className={`${CARD} space-y-5`}>
            <SectionRule num="02" title="Linked wallets" side="All wallets in your Privy account" />

            <div className={LIST_BOX}>
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
                          type="button"
                          onClick={() => setUnlinkTarget(w.address)}
                          className={DANGER_TEXT_BUTTON}
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
              Your BlindMarket wallet pays for tasks and receives payouts. Link an external wallet, like MetaMask, to
              bridge funds in from another chain.
            </p>

            <Button
              variant="outline"
              label="Link wallet"
              size="sm"
              onClick={() => linkWallet()}
            />
          </section>

          {/* Network */}
          <section className={`${CARD} space-y-5`}>
            <SectionRule num="03" title="Network" />

            <FormField
              label="Settlement chain"
              hint={`New tasks are escrowed and paid in ${postingInfo.token.unit.symbol} on ${postingInfo.label}.`}
            >
              <div className={`${VALUE_BOX} flex items-center gap-2 flex-wrap`}>
                <Tag tone="ok">
                  {postingInfo.label} · <span className="font-mono">{postingInfo.chainId}</span>
                </Tag>
                <span className="ml-auto text-xs text-ink-2">{(postingInfo.tier === 'mainnet' || DISPLAY_MAINNET) ? 'Mainnet' : 'Testnet'}</span>
              </div>
            </FormField>

            <FormField
              label="Agent infra chain (0G)"
              hint="Agent identity and reputation live on 0G."
            >
              <div className={`${VALUE_BOX} flex items-center gap-2 flex-wrap`}>
                <Tag tone="neutral">
                  0G · <span className="font-mono">{OG_CHAIN_ID}</span>
                </Tag>
                <span className="ml-auto text-xs text-ink-2">{chainLabel}</span>
              </div>
            </FormField>

            <FormField
              label="Server relay access"
              hint="One-time setup that lets the backend sign transactions for you."
            >
              {relaySignerStatus === 'done' ? (
                <div className={`${VALUE_BOX} flex items-center gap-2`}>
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
                    <ErrorNotice error={relaySignerError ?? 'Failed. Try again.'} title="Couldn't enable relay access" compact />
                  )}
                </div>
              )}
            </FormField>
          </section>

          {/* API Keys */}
          <section className={`${CARD} space-y-5`}>
            <SectionRule num="04" title="API keys" side="Revocable · stored as hash" />

            <div className={LIST_BOX}>
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
                        type="button"
                        onClick={() => setRevokeTarget(k.id)}
                        className={DANGER_TEXT_BUTTON}
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
          </section>

          {/* Notifications */}
          <section className={`${CARD} space-y-5`}>
            <SectionRule num="05" title="Notifications" />

            <TelegramAlerts />
          </section>
        </div>

        {/* Right column */}
        <div className="space-y-5 min-w-0">
          {/* Session state */}
          <section className={`${CARD} space-y-4`}>
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
          </section>

          {/* Privacy explainer */}
          <section className={`${CARD} space-y-3`}>
            <SectionRule num="07" title="Privacy" />
            <div className="rounded-2xl border border-line bg-surface-2 p-4 space-y-2.5">
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
          </section>
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
      <Modal open={!!createdKey} onClose={() => { setCreatedKey(null); setKeyCopied(false); }} title="Key created" dismissable={false}>
        <div className="space-y-4">
          <p className="text-xs text-ink-3 leading-relaxed">
            Copy this key now. For security reasons, it will not be shown again.
          </p>
          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5">
            <code className="flex-1 text-xs font-mono text-accent break-all select-all">{createdKey}</code>
            <button
              type="button"
              onClick={async () => { if (createdKey) setKeyCopied(await copyToClipboard(createdKey)); }}
              className="shrink-0 rounded-full border border-line px-3 py-1 text-xs text-ink-2 transition-colors duration-200 hover:border-accent hover:text-ink"
            >
              {keyCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="flex justify-end">
            <Button variant="outline" size="sm" label="Done" onClick={() => { setCreatedKey(null); setKeyCopied(false); }} />
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