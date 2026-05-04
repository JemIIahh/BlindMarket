import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccount, useWalletClient } from 'wagmi';
import { getIdentityToken, getAccessToken } from '@privy-io/react-auth';
import { BrowserProvider, Contract, parseUnits } from 'ethers';
import { Breadcrumb, PageHeader, SectionRule } from '../components/bb';
import { aesEncrypt, generateAesKey, sha256, toBase64, toBytes } from '../lib/crypto';
import { signAndSendTx } from '../lib/txSigner';
import { authedPost } from '../lib/api';
import { trackEvent } from '../hooks/useAnalytics';
import { BLIND_ESCROW_ADDRESS } from '../config/constants';

const CATEGORIES = ['photography', 'research', 'verification', 'data-collection', 'transcription', 'other'];
const TOKEN = import.meta.env.VITE_MOCK_ERC20_ADDRESS ?? '0x3af9232009C5da30AdA366B6E09849A040162A1a';

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
  'function balanceOf(address account) public view returns (uint256)',
];

export default function PostTask() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    instructions: '',
    category: 'photography',
    locationZone: 'global',
    amount: '10',
    duration: '86400',
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
      const token = (await getIdentityToken()) || (await getAccessToken());
      if (!token) throw new Error('No authentication token available. Please try logging out and back in.');

      // 0. Handle Token Approval if needed
      console.log('[PostTask] Initializing provider for approval check...');
      const provider = new BrowserProvider(walletClient.transport);
      const signer = await provider.getSigner();
      const tokenContract = new Contract(TOKEN, ERC20_ABI, signer);
      const amountWei = parseUnits(form.amount, 18);

      try {
        console.log(`[PostTask] Checking allowance for ${address} on token ${TOKEN}...`);
        const allowance = await tokenContract.allowance(address, BLIND_ESCROW_ADDRESS);
        console.log(`[PostTask] Current allowance: ${allowance.toString()}`);
        
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
      }, token);

      // 4. Sign and send via MetaMask
      setStatus('signing');
      console.log(`[PostTask] Signing registration TX...`);
      const receipt = await signAndSendTx(signer, taskJson.unsignedTx);
      const taskExplorerLink = `https://chainscan-galileo.0g.ai/tx/${receipt.hash}`;
      console.log(`[PostTask] Task TX confirmed: ${receipt.hash}`);
      console.log(`[PostTask] Track it here: ${taskExplorerLink}`);
      console.log('[PostTask] Task creation confirmed.');

      setTaskId(taskJson.taskId ?? null);
      setStatus('done');
      trackEvent('task_posted', {
        taskId: taskJson.taskId ?? null,
        category: form.category,
        amount: Number(form.amount),
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
                  <select
                    value={form.category}
                    onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                    className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink focus:outline-none focus:border-cream"
                  >
                    {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
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
