import { useState, useRef, useEffect } from 'react';
import { useWalletClient } from 'wagmi';
import { getIdentityToken, getAccessToken } from '@privy-io/react-auth';
import { BrowserProvider, formatUnits } from 'ethers';
import { Button, FormField, FormTextarea, Modal, Spinner } from './bb';
import { aesEncrypt, eciesEncrypt, generateAesKey, sha256, toBase64, toBytes } from '../lib/crypto';
import { stashAesKey } from '../lib/keyStash';
import { signAndSendTx } from '../lib/txSigner';
import { authedGet, authedPost } from '../lib/api';
import { MARKETPLACE_TOKEN_ADDRESS } from '../config/constants';
import { useChain } from '../context/ChainContext';
import { useChainAddress } from '../hooks/useChainWallet';
import type { AgentService } from '../services/marketplace';

/**
 * "Use now" — a per-call rent of ONE agent's service (rent-your-agent Phase 2).
 * Reuses the PostTask encrypt→fund pipeline (PostTask.tsx:126-353) but pinned to
 * a single agent: the AES key is wrapped only to the service agent's pubkey, the
 * task carries targetExecutor + serviceId, and it auto-verifies instantly so the
 * agent is paid its listed price on completion.
 */

type Phase = 'input' | 'encrypting' | 'signing' | 'running' | 'done' | 'error';

const POLL_MS = 4000;
const MAX_POLLS = 75; // ~5 min

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export default function UseServiceModal({
  service,
  symbol,
  onClose,
  onSettled,
}: {
  service: AgentService;
  symbol: string;
  onClose: () => void;
  onSettled?: () => void;
}) {
  const { activeChain } = useChain();
  const address = useChainAddress();
  const { data: walletClient } = useWalletClient();

  const [prompt, setPrompt] = useState('');
  // Per-call privacy: private (default) encrypts the prompt to the agent;
  // public posts it in plaintext (prompt + result become public record).
  const [privacy, setPrivacy] = useState<'private' | 'public'>('private');
  const [phase, setPhase] = useState<Phase>('input');
  const [error, setError] = useState('');
  const [output, setOutput] = useState<string | null>(null);
  const submittingRef = useRef(false);

  // The poll loop can run ~5 min; if the parent unmounts this modal (user
  // navigates away), stop polling and stop touching state.
  const abortedRef = useRef(false);
  useEffect(() => () => { abortedRef.current = true; }, []);

  // formatUnits throws on malformed input — never let a bad listing price
  // crash the modal (and with it the whole agent page).
  const priceLabel = (() => {
    try {
      return `${formatUnits(service.price_raw, 18)} ${symbol}`;
    } catch {
      return `— ${symbol}`;
    }
  })();
  const busy = phase === 'encrypting' || phase === 'signing' || phase === 'running';

  // Elapsed-time counter for the long "agent is working" wait (up to ~5 min):
  // a static label reads as hung; a ticking clock reads as alive.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (phase !== 'running') { setElapsed(0); return; }
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);
  const elapsedLabel = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  async function pollForResult(taskHash: string, token: string) {
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (abortedRef.current) return;
      try {
        const { tasks } = await authedGet<{
          tasks: Array<{ meta: { taskId: string }; state: { status: string; resultData?: Record<string, unknown> } }>;
        }>('/api/v1/a2a/tasks/posted', token);
        const t = tasks.find((x) => x.meta.taskId?.toLowerCase() === taskHash.toLowerCase());
        if (t && (t.state.status === 'verified' || t.state.status === 'completed') && t.state.resultData) {
          const out = t.state.resultData.output;
          setOutput(typeof out === 'string' ? out : JSON.stringify(t.state.resultData, null, 2));
          setPhase('done');
          onSettled?.();
          return;
        }
        if (t && t.state.status === 'failed') {
          setError('The agent could not complete this call. Your escrow can be reclaimed from My tasks.');
          setPhase('error');
          return;
        }
      } catch { /* transient — keep polling */ }
    }
    setError('Timed out waiting for the agent. It may still be running — check My tasks for the result and settlement.');
    setPhase('error');
  }

  async function handleUse() {
    if (submittingRef.current) return;
    if (!address || !walletClient) { setError('Connect your wallet first.'); setPhase('error'); return; }
    const isPublic = privacy === 'public';
    if (!isPublic && !service.agent_public_key) { setError('This agent has no encryption key available.'); setPhase('error'); return; }
    if (prompt.trim().length < 1) { setError('Enter a prompt for the agent.'); return; }
    submittingRef.current = true;
    setError('');
    try {
      setPhase('encrypting');
      const token = (await getIdentityToken()) || (await getAccessToken());
      if (!token) throw new Error('No auth token — try logging out and back in.');

      // 1. Prepare the brief blob. Private: encrypt browser-side. Public: the
      //    plaintext itself is the blob (no key, no wrapping).
      const agentAddr = service.agent_address.toLowerCase();
      const plainBytes = toBytes(prompt);
      let blobBytes: Uint8Array;
      let wrappedKeys: Record<string, string> | undefined;
      if (isPublic) {
        blobBytes = plainBytes;
      } else {
        const key = generateAesKey();
        blobBytes = await aesEncrypt(plainBytes, key);
        wrappedKeys = { [agentAddr]: toHex(await eciesEncrypt(key, service.agent_public_key!)) };
        stashAesKey('0x' + (await sha256(blobBytes)), key);
      }
      const taskHash = '0x' + (await sha256(blobBytes));

      // 2. Upload the blob → rootHash.
      const { rootHash } = await authedPost<{ rootHash: string }>(
        '/api/v1/storage/upload',
        { data: toBase64(blobBytes), chainType: activeChain },
        token,
      );
      if (!rootHash) throw new Error('Storage upload returned no rootHash');

      // 4. Build the funding tx — priced at the service, instant auto-verify.
      const taskJson = await authedPost<{ unsignedTx: Parameters<typeof signAndSendTx>[1] }>('/api/v1/tasks', {
        taskHash,
        token: MARKETPLACE_TOKEN_ADDRESS,
        amount: service.price_raw,
        category: 'general',
        locationZone: 'global',
        duration: '3600',
        targetExecutorType: 'agent',
        verificationMode: 'auto',
        verificationCriteria: { min_length: 1 },
        requiredCapabilities: [],
        rootHash,
        wrappedKeys,
      }, token);

      // 4. Sign + fund from the buyer's wallet.
      setPhase('signing');
      const signer = await new BrowserProvider(walletClient.transport).getSigner();
      const sent = await signAndSendTx(signer, taskJson.unsignedTx, BigInt(service.price_raw));

      // 5. Index the meta — pinned to the agent + linked to the service.
      await authedPost('/api/v1/a2a/tasks/index', {
        txHash: sent.hash,
        taskHash,
        verificationMode: 'auto',
        verificationCriteria: { min_length: 1 },
        requiredCapabilities: [],
        rootHash,
        wrappedKeys,
        targetExecutor: agentAddr,
        serviceId: service.id,
        privacy: isPublic ? 'public' : undefined,
        publicBrief: isPublic ? prompt.slice(0, 4000) : undefined,
      }, token);

      // 6. Wait for the agent to run + settle, then show the result.
      setPhase('running');
      await pollForResult(taskHash, token);
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    } finally {
      submittingRef.current = false;
    }
  }

  const phaseLabel =
    phase === 'encrypting' ? 'Encrypting your input…'
      : phase === 'signing' ? 'Confirm the payment in your wallet…'
        : phase === 'running' ? 'Agent is working — this can take up to a few minutes…'
          : '';

  return (
    <Modal
      open
      onClose={onClose}
      dismissable={!busy}
      title={service.name}
      subtitle={`${priceLabel} / call`}
      size="lg"
    >
      <>
        {(phase === 'input' || phase === 'error') && (
          <div className="space-y-4">
            <FormField
              label="Your input"
              hint={privacy === 'private'
                ? 'This prompt is encrypted to the agent — the platform never sees it.'
                : 'This prompt is posted in plaintext — it and the result will be publicly visible.'}
            >
              <FormTextarea rows={4} placeholder="What do you want this agent to do?" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </FormField>
            <div className="flex flex-wrap gap-1.5">
              {([['private', 'Private (encrypted)'], ['public', 'Public']] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPrivacy(mode)}
                  className={`px-2.5 py-1 text-xs border transition-colors ${privacy === mode
                    ? 'bg-cream/10 border-cream/40 text-cream'
                    : 'bg-surface-2 border-line text-ink-3 hover:text-ink-2'
                    }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="text-xs text-ink-3 border border-line bg-surface-2 p-3">
              You pay <span className="font-mono text-ink">{priceLabel}</span> per call. Payment is released to the
              agent on completion (90% agent / 10% platform) regardless of the output — you're paying for the
              invocation, like any per-call API.
            </div>
            {error && <div className="text-xs text-err">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" label="Cancel" onClick={onClose} />
              <Button variant="primary" size="sm" label={`Pay ${priceLabel} & run`} onClick={handleUse} />
            </div>
          </div>
        )}

        {busy && (
          <div className="py-8 text-center space-y-3">
            <div className="flex justify-center"><Spinner size={22} /></div>
            <div className="text-sm text-ink">{phaseLabel}</div>
            {phase === 'running' && (
              <div className="font-mono text-xs text-ink-3 tabular-nums">{elapsedLabel} elapsed</div>
            )}
            <div className="text-xs text-ink-3">Don't close this window.</div>
          </div>
        )}

        {phase === 'done' && (
          <div className="space-y-4">
            <div className="text-xs uppercase tracking-wider text-ink-3">Result</div>
            <pre className="whitespace-pre-wrap break-words text-sm text-ink border border-line bg-surface-2 p-3 max-h-80 overflow-y-auto">{output}</pre>
            <div className="flex justify-end">
              <Button variant="primary" size="sm" label="Done" onClick={onClose} />
            </div>
          </div>
        )}
      </>
    </Modal>
  );
}
