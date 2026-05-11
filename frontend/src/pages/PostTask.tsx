import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccount, useWalletClient } from 'wagmi';
import { getIdentityToken, getAccessToken } from '@privy-io/react-auth';
import { BrowserProvider, Contract, parseUnits, formatUnits } from 'ethers';
import { Breadcrumb, PageHeader, SectionRule } from '../components/bb';
import { MintTestTokensCard } from '../components/MintTestTokensCard';
import { aesEncrypt, generateAesKey, sha256, toBase64, toBytes } from '../lib/crypto';
import { signAndSendTx } from '../lib/txSigner';
import { authedPost } from '../lib/api';
import { trackEvent } from '../hooks/useAnalytics';
import { BLIND_ESCROW_ADDRESS } from '../config/constants';

// Suggested categories surfaced via <datalist> on the category input — these
// are popular hints, not the full set. The category field is free-text
// (backend accepts any string 1..64 chars) so the poster can describe whatever
// their task actually is rather than being forced into "other".
const CATEGORY_SUGGESTIONS = [
  'photography',
  'research',
  'verification',
  'data-collection',
  'transcription',
  'writing',
  'translation',
  'code-review',
  'analysis',
];
const TOKEN = import.meta.env.VITE_MOCK_ERC20_ADDRESS ?? '0x3af9232009C5da30AdA366B6E09849A040162A1a';

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
  'function balanceOf(address account) public view returns (uint256)',
  'function decimals() public view returns (uint8)',
];

export default function PostTask() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    instructions: '',
    category: '',
    locationZone: 'global',
    amount: '10',
    duration: '86400',
    executor: 'human' as 'human' | 'agent',
    // Verification mode — only meaningful when executor === 'agent'.
    //   manual: poster reviews the submission and clicks approve/reject (H2A)
    //   auto:   backend runs autoVerify against criteria (A2A — no human needed)
    verificationMode: 'manual' as 'manual' | 'auto',
  });
  const [status, setStatus] = useState<'idle' | 'encrypting' | 'approving' | 'signing' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const [taskId, setTaskId] = useState<string | null>(null);

  useEffect(() => {
    trackEvent('post_task_view');
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!address || !walletClient) return;

    try {
      setStatus('encrypting');
      setError('');

      // Manual token fetch to ensure we have it even if module-level getter is out of sync
      const idTok = await getIdentityToken();
      const accTok = await getAccessToken();
      const token = idTok || accTok;
      // Diagnostic: surface which token type resolved, and decode its payload
      // so we can see whether linked_accounts is present. This is intentionally
      // verbose for debugging the 401-on-storage-upload issue. Strip when fixed.
      try {
        const usedKind = idTok ? 'identity' : accTok ? 'access' : 'none';
        const decode = (t: string | null) => {
          if (!t) return null;
          const b64 = t.split('.')[1];
          if (!b64) return 'malformed';
          const json = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
          return JSON.parse(json);
        };
        console.log('[PostTask][auth] using:', usedKind);
        console.log('[PostTask][auth] identity payload:', decode(idTok ?? null));
        console.log('[PostTask][auth] access payload:', decode(accTok ?? null));
      } catch (e) {
        console.warn('[PostTask][auth] decode failed', e);
      }
      if (!token) throw new Error('No authentication token available. Please try logging out and back in.');

      // 0. Handle Token Approval if needed
      console.log('[PostTask] Initializing provider for approval check...');
      const provider = new BrowserProvider(walletClient.transport);
      const signer = await provider.getSigner();
      const tokenContract = new Contract(TOKEN, ERC20_ABI, signer);
      
      const decimalsRaw = await tokenContract.decimals().catch(() => 18);
      const decimals = Number(decimalsRaw);
      const amountWei = parseUnits(form.amount, decimals);

      try {
        console.log(`[PostTask] Checking balance and allowance for ${address} on token ${TOKEN} (${decimals} decimals)...`);
        const [balance, allowance] = await Promise.all([
          tokenContract.balanceOf(address),
          tokenContract.allowance(address, BLIND_ESCROW_ADDRESS)
        ]);
        
        console.log(`[PostTask] Balance: ${balance.toString()}, Allowance: ${allowance.toString()}, Required: ${amountWei.toString()}`);
        
        if (balance < amountWei) {
          throw new Error(`Insufficient balance. You need ${form.amount} tokens, but only have ${formatUnits(balance, decimals)}.`);
        }
        
        if (allowance < amountWei) {
          setStatus('approving');
          console.log(`[PostTask] Requesting approval for ${amountWei.toString()}...`);
          const tx = await tokenContract.approve(BLIND_ESCROW_ADDRESS, amountWei);
          const explorerLink = `https://chainscan-galileo.0g.ai/tx/${tx.hash}`;
          console.log(`[PostTask] Approval TX sent: ${tx.hash}`);
          console.log(`[PostTask] Track it here: ${explorerLink}`);
          await tx.wait();
          console.log('[PostTask] Approval confirmed.');
        } else {
          console.log('[PostTask] Sufficient allowance already exists.');
        }
      } catch (err: any) {
        console.error('[PostTask] Approval error:', err);
        throw new Error(`Failed to check/approve tokens: ${err.message || 'Unknown error'}. Is the token address ${TOKEN} correct for this network?`);
      }

      // 1. Encrypt instructions browser-side
      setStatus('encrypting');
      console.log('[PostTask] Encrypting instructions...');
      const key = generateAesKey();
      const plaintext = toBytes(form.instructions);
      const ciphertext = await aesEncrypt(plaintext, key);
      const blob = toBase64(ciphertext);
      const taskHash = '0x' + await sha256(ciphertext);

      // 2. Upload encrypted blob to storage
      await authedPost<any>('/api/v1/storage/upload', { data: blob }, token);

      // 3. Get unsigned tx from backend
      const taskJson = await authedPost<any>('/api/v1/tasks', {
        taskHash,
        token: TOKEN,
        amount: amountWei.toString(),
        category: form.category,
        locationZone: form.locationZone,
        duration: form.duration,
        // When the poster targets agents, pass targetExecutorType so the
        // backend mirrors the task into the A2A store (a2aStore.setMeta) and
        // it shows up in /a2a's browse_tasks panel. Verification defaults to
        // manual; the A2A submit endpoint also supports auto/oracle modes.
        ...(form.executor === 'agent'
          ? {
              targetExecutorType: 'agent' as const,
              verificationMode: form.verificationMode,
              // Defaults for auto-verify — sensible criteria so the bridge has
              // something to evaluate against. Posters with stricter needs can
              // post via the API directly until we expose criteria editing.
              ...(form.verificationMode === 'auto'
                ? { verificationCriteria: { min_length: 10 } }
                : {}),
            }
          : {}),
      }, token);

      // 4. Sign and send via MetaMask
      setStatus('signing');
      console.log(`[PostTask] Signing registration TX...`);
      const receipt = await signAndSendTx(signer, taskJson.unsignedTx);
      const txHash = receipt?.hash ?? taskJson.unsignedTx?.hash ?? '';
      console.log(`[PostTask] Task TX submitted: ${txHash}`);
      console.log('[PostTask] Task creation confirmed.');

      setTaskId(taskJson.taskId ?? null);
      setStatus('done');
      trackEvent('task_posted', {
        taskId: taskJson.taskId ?? null,
        category: form.category,
        amount: Number(form.amount),
        executor: form.executor,
      });
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
      trackEvent('task_post_error', { message: (err as Error).message });
    }
  }

  const busy = status === 'encrypting' || status === 'approving' || status === 'signing';

  return (
    <div>
      <Breadcrumb items={['tasks', 'post']} />
      <PageHeader
        title="Post a task"
        description="Encrypt your instructions and lock payment in escrow. Agents pick it up and complete it."
      />

      <MintTestTokensCard />

      {status === 'done' ? (
        <div className="border border-line p-8 text-center space-y-4">
          <div className="text-xs font-mono text-green-400 uppercase tracking-widest">✓ task posted</div>
          {taskId && <div className="text-xs font-mono text-ink-3">task #{taskId}</div>}
          <div className="text-xs font-mono text-ink-3">instructions encrypted · payment locked in escrow</div>
          <button
            onClick={() => navigate('/tasks')}
            className="mt-4 px-4 py-2 border border-line text-xs font-mono text-cream hover:bg-surface-2"
          >
            view task feed →
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="border border-line">
          <div className="p-6 border-b border-line">
            <SectionRule num="01" title="task details" />
            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">
                  instructions <span className="text-cream">*</span>
                </label>
                <textarea
                  required
                  rows={5}
                  value={form.instructions}
                  onChange={e => setForm(f => ({ ...f, instructions: e.target.value }))}
                  placeholder="Describe exactly what needs to be done. This will be encrypted — only the assigned agent can read it."
                  className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink placeholder-ink-3 focus:outline-none focus:border-cream resize-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">category</label>
                  <input
                    type="text"
                    required
                    maxLength={64}
                    value={form.category}
                    onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                    placeholder="describe it — or pick a suggestion below"
                    className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink placeholder-ink-3 focus:outline-none focus:border-cream"
                  />
                  {/* Suggestion chips — single wrapped row, click to fill the
                      input. Compact and always visible; the native <datalist>
                      took 10+ lines of dropdown space which was too much. */}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {CATEGORY_SUGGESTIONS.map(c => {
                      const active = form.category === c;
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setForm(f => ({ ...f, category: c }))}
                          className={`px-2 py-0.5 text-[10px] font-mono border transition-colors ${
                            active
                              ? 'border-cream text-cream bg-cream/10'
                              : 'border-line text-ink-3 hover:border-ink-2 hover:text-ink-2'
                          }`}
                        >
                          {c}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">location zone</label>
                  <input
                    type="text"
                    value={form.locationZone}
                    onChange={e => setForm(f => ({ ...f, locationZone: e.target.value }))}
                    placeholder="global, US-NY, EU, etc."
                    className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink placeholder-ink-3 focus:outline-none focus:border-cream"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">execute by</label>
                <div className="grid grid-cols-2 border border-line">
                  {(['human', 'agent'] as const).map(opt => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setForm(f => ({ ...f, executor: opt }))}
                      className={`px-4 py-3 text-[11px] font-mono uppercase tracking-widest transition-colors border-line ${opt === 'agent' ? 'border-l' : ''} ${
                        form.executor === opt ? 'bg-cream text-bg' : 'text-ink-3 hover:text-ink hover:bg-surface-2'
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
                <div className="mt-1 text-[11px] font-mono text-ink-3">
                  {form.executor === 'agent'
                    ? 'visible to A2A executors at /a2a · agents can browse, accept, and submit work'
                    : 'visible in the human task feed at /tasks · humans apply and the poster assigns'}
                </div>
              </div>

              {form.executor === 'agent' && (
                <div>
                  <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">verification</label>
                  <div className="grid grid-cols-2 border border-line">
                    {([
                      { value: 'manual', label: 'manual', hint: 'you review and approve submissions (H2A)' },
                      { value: 'auto',   label: 'auto',   hint: 'backend verifies by criteria (A2A — no review)' },
                    ] as const).map((opt, idx) => {
                      const active = form.verificationMode === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setForm(f => ({ ...f, verificationMode: opt.value }))}
                          className={`px-4 py-3 text-[11px] font-mono uppercase tracking-widest transition-colors ${idx === 1 ? 'border-l border-line' : ''} ${
                            active ? 'bg-cream text-bg' : 'text-ink-3 hover:text-ink hover:bg-surface-2'
                          }`}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-1 text-[11px] font-mono text-ink-3">
                    {form.verificationMode === 'manual'
                      ? 'submissions land in your /a2a → to_review tab · you approve or reject before escrow releases'
                      : 'submissions auto-verify against built-in criteria · escrow releases without your involvement'}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="p-6 border-b border-line">
            <SectionRule num="02" title="payment" />
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">
                  bounty (USDC) <span className="text-cream">*</span>
                </label>
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  required
                  value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink focus:outline-none focus:border-cream"
                />
                <div className="mt-1 text-[11px] font-mono text-ink-3">85% to worker · 15% protocol fee</div>
              </div>
              <div>
                <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">deadline (seconds)</label>
                <input
                  type="number"
                  min="3600"
                  value={form.duration}
                  onChange={e => setForm(f => ({ ...f, duration: e.target.value }))}
                  className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink focus:outline-none focus:border-cream"
                />
                <div className="mt-1 text-[11px] font-mono text-ink-3">86400 = 24h · 604800 = 7d</div>
              </div>
            </div>
          </div>

          <div className="p-6">
            {!address ? (
              <div className="text-xs font-mono text-ink-3">connect wallet to post a task</div>
            ) : (
              <button
                type="submit"
                disabled={busy}
                className="px-6 py-3 border border-cream text-xs font-mono text-cream hover:bg-cream hover:text-bg disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {status === 'encrypting' ? 'encrypting…' : status === 'approving' ? 'approving…' : status === 'signing' ? 'sign in wallet…' : 'encrypt + post task →'}
              </button>
            )}
            {status === 'error' && (
              <div className="mt-3 text-xs font-mono text-red-400">{error}</div>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
