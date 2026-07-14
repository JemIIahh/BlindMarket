import { useState, useRef } from 'react';
import { useWalletClient } from 'wagmi';
import { getIdentityToken, getAccessToken } from '@privy-io/react-auth';
import { BrowserProvider, formatUnits } from 'ethers';
import { Button, FormField, FormTextarea } from './bb';
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
  const [phase, setPhase] = useState<Phase>('input');
  const [error, setError] = useState('');
  const [output, setOutput] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const priceLabel = `${formatUnits(service.price_raw, 18)} ${symbol}`;
  const busy = phase === 'encrypting' || phase === 'signing' || phase === 'running';

  async function pollForResult(taskHash: string, token: string) {
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
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
    if (!service.agent_public_key) { setError('This agent has no encryption key available.'); setPhase('error'); return; }
    if (prompt.trim().length < 1) { setError('Enter a prompt for the agent.'); return; }
    submittingRef.current = true;
    setError('');
    try {
      setPhase('encrypting');
      const token = (await getIdentityToken()) || (await getAccessToken());
      if (!token) throw new Error('No auth token — try logging out and back in.');

      // 1. Encrypt the buyer's prompt (the brief) browser-side.
      const key = generateAesKey();
      const ciphertext = await aesEncrypt(toBytes(prompt), key);
      const taskHash = '0x' + (await sha256(ciphertext));

      // 2. Upload the encrypted blob → rootHash.
      const { rootHash } = await authedPost<{ rootHash: string }>(
        '/api/v1/storage/upload',
        { data: toBase64(ciphertext), chainType: activeChain },
        token,
      );
      if (!rootHash) throw new Error('Storage upload returned no rootHash');

      // 3. Wrap the AES key to ONLY the pinned service agent.
      stashAesKey(taskHash, key);
      const agentAddr = service.agent_address.toLowerCase();
      const wrappedKeys: Record<string, string> = {
        [agentAddr]: toHex(await eciesEncrypt(key, service.agent_public_key)),
      };

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

      // 5. Sign + fund from the buyer's wallet.
      setPhase('signing');
      const signer = await new BrowserProvider(walletClient.transport).getSigner();
      const sent = await signAndSendTx(signer, taskJson.unsignedTx, BigInt(service.price_raw));

      // 6. Index the meta — pinned to the agent + linked to the service.
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
      }, token);

      // 7. Wait for the agent to run + settle, then show the result.
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={() => { if (!busy) onClose(); }}
    >
      <div
        className="w-full max-w-lg border border-line bg-surface-1 p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="text-ink font-medium">{service.name}</div>
            <div className="font-mono text-xs text-ink-3 mt-0.5">{priceLabel} / call</div>
          </div>
          <button onClick={() => { if (!busy) onClose(); }} className="text-ink-3 hover:text-ink text-sm" disabled={busy}>✕</button>
        </div>

        {(phase === 'input' || phase === 'error') && (
          <div className="space-y-4">
            <FormField label="Your input" hint="This prompt is encrypted to the agent — the platform never sees it.">
              <FormTextarea rows={4} placeholder="What do you want this agent to do?" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </FormField>
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
            <div className="text-sm text-ink">{phaseLabel}</div>
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
      </div>
    </div>
  );
}
