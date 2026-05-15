import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAccount, useWalletClient } from 'wagmi';
import { getIdentityToken, getAccessToken } from '@privy-io/react-auth';
import { BrowserProvider, Contract, parseUnits, formatUnits } from 'ethers';
import { Breadcrumb, PageHeader, SectionRule } from '../components/bb';
import { MintTestTokensCard } from '../components/MintTestTokensCard';
import { aesEncrypt, eciesEncrypt, generateAesKey, sha256, toBase64, toBytes } from '../lib/crypto';
import { stashAesKey } from '../lib/keyStash';
import { signAndSendTx } from '../lib/txSigner';
import { authedGet, authedPost } from '../lib/api';
import { trackEvent } from '../hooks/useAnalytics';
import { BLIND_ESCROW_ADDRESS, MARKETPLACE_TOKEN_ADDRESS } from '../config/constants';

// Suggested categories surfaced via <datalist> on the category input — these
// are popular hints, not the full set. The category field is free-text
// (backend accepts any string 1..64 chars) so the poster can describe whatever
// their task actually is rather than being forced into "other".
// BlindEscrow contract's hard bounds on `duration` (seconds).
// Source: BlindEscrow.sol:64-65 — MIN_DEADLINE = 1 hours, MAX_DEADLINE = 90 days.
const MIN_DURATION_SECONDS = 60 * 60;          // 1 hour
const MAX_DURATION_SECONDS = 90 * 24 * 60 * 60; // 90 days

/** Format a Date as the value `<input type="datetime-local">` expects: YYYY-MM-DDTHH:mm in local TZ. */
function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Default deadline: 24h from now. Calculated once at module load — fine
 *  since the page is short-lived. */
const DEFAULT_DEADLINE_AT = toDatetimeLocal(new Date(Date.now() + 24 * 60 * 60 * 1000));
const MIN_DEADLINE_AT = toDatetimeLocal(new Date(Date.now() + MIN_DURATION_SECONDS * 1000));
const MAX_DEADLINE_AT = toDatetimeLocal(new Date(Date.now() + MAX_DURATION_SECONDS * 1000));

/** Human-readable "expires in 2 hours" / "expires in 3 days" hint. */
function durationHint(secs: number): string {
  if (secs <= 0) return 'in the past — pick a later time';
  if (secs < 60 * 60) return `${Math.round(secs / 60)} minutes from now`;
  if (secs < 24 * 60 * 60) return `${Math.round(secs / 3600)} hours from now`;
  return `${Math.round(secs / 86400)} days from now`;
}

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

import { AGENT_CAPABILITIES } from '../config/capabilities';

// Pulled from the shared constants module so the address lives in exactly
// one place. AgentDetail's sweep-token call uses the same value.
const TOKEN = MARKETPLACE_TOKEN_ADDRESS;

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
    // Stored as a datetime-local string (YYYY-MM-DDTHH:mm). Converted to a
    // seconds-from-now duration at submit time — the contract takes duration,
    // not an absolute date, so this is a UX layer over the on-chain primitive.
    deadlineAt: DEFAULT_DEADLINE_AT,
  });
  // Pure A2A surface — every task posted from this UI is an agent-targeted
  // task that auto-verifies on submission. The executor toggle and
  // verification-mode picker are removed; we hardcode the values that drive
  // the autonomous flow. The H2A manual-approval path still lives in the
  // backend (/a2a/verify) for the A2H roadmap; it's just not exposed here.
  const [status, setStatus] = useState<'idle' | 'encrypting' | 'approving' | 'signing' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [requiredCaps, setRequiredCaps] = useState<string[]>([]);
  // Snapshot of how many executors the AES key was wrapped to at post time.
  // Drives the post-success copy: a non-zero count means at least one agent
  // can /accept immediately; zero means the task is awaiting bids and the
  // poster has to revisit /my_tasks for useBidWatcher() to ship slices.
  const [initialWrapCount, setInitialWrapCount] = useState<number>(0);

  const toggleCap = (cap: string) =>
    setRequiredCaps(prev => (prev.includes(cap) ? prev.filter(c => c !== cap) : [...prev, cap]));

  useEffect(() => {
    trackEvent('post_task_view');
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!address || !walletClient) return;

    try {
      setStatus('encrypting');
      setError('');

      if (requiredCaps.length === 0) {
        throw new Error('Pick at least one required capability so executor agents can match your task.');
      }

      // Prefer the identity token (has linked_accounts → backend can derive
      // the wallet address from did:privy claims); fall back to the access
      // token so unlinked sessions still work.
      const idTok = await getIdentityToken();
      const accTok = await getAccessToken();
      const token = idTok || accTok;
      if (!token) throw new Error('No authentication token available. Please try logging out and back in.');

      // 0. Handle Token Approval if needed (skip for native 0G)
      console.log('[PostTask] Initializing provider for payment setup...');
      const provider = new BrowserProvider(walletClient.transport);
      const signer = await provider.getSigner();

      const isNative = TOKEN === '0x0000000000000000000000000000000000000000';
      const decimals = isNative ? 18 : await (async () => {
        const tokenContract = new Contract(TOKEN, ERC20_ABI, signer);
        return Number(await tokenContract.decimals().catch(() => 18));
      })();
      const amountWei = parseUnits(form.amount, decimals);

      if (!isNative) {
        const tokenContract = new Contract(TOKEN, ERC20_ABI, signer);
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
            const explorerLink = `https://chainscan.0g.ai/tx/${tx.hash}`;
            console.log(`[PostTask] Approval TX sent: ${tx.hash}`);
            await tx.wait();
            console.log('[PostTask] Approval confirmed.');
          } else {
            console.log('[PostTask] Sufficient allowance already exists.');
          }
        } catch (err: any) {
          console.error('[PostTask] Approval error:', err);
          throw new Error(`Failed to check/approve tokens: ${err.message || 'Unknown error'}. Is the token address ${TOKEN} correct for this network?`);
        }
      } else {
        console.log('[PostTask] Using native 0G — skipping ERC20 approval.');
        const balance = await provider.getBalance(address);
        if (balance < amountWei) {
          throw new Error(`Insufficient balance. You need ${form.amount} 0G, but only have ${formatUnits(balance, 18)} 0G.`);
        }
      }

      // 1. Discover eligible executors so we can wrap the AES key to anyone
      //    who's *already* registered. Zero matches is OK now — the task
      //    posts with an empty wrappedKeys map, the AES key persists in this
      //    browser's localStorage, and useBidWatcher() wraps to new agents
      //    as they /bid. Trade-off: poster must revisit /my_tasks (or stay
      //    on /a2a) for the wrap to happen. Documented in PITCH.md.
      console.log('[PostTask] Looking up matching executors...');
      const capsQS = encodeURIComponent(requiredCaps.join(','));
      // authedGet unwraps to `body.data` (see api.ts:23), so T is the inner
      // payload — not the {success, data} envelope.
      const execResp = await authedGet<{
        executors: Array<{ address: string; publicKey: string; capabilities: string[]; reputation: number }>;
      }>(`/api/v1/a2a/executors?capabilities=${capsQS}`, token);
      const executors = execResp.executors ?? [];
      console.log(`[PostTask] ${executors.length} matching executor(s) found at post time`);

      // 2. Encrypt instructions browser-side
      setStatus('encrypting');
      console.log('[PostTask] Encrypting instructions...');
      const key = generateAesKey();
      const plaintext = toBytes(form.instructions);
      const ciphertext = await aesEncrypt(plaintext, key);
      const blob = toBase64(ciphertext);
      const taskHash = '0x' + await sha256(ciphertext);

      // 3. Upload encrypted blob to storage and capture the rootHash so the
      //    backend can persist it in A2A meta. Without rootHash the executor
      //    has no pointer to fetch the encrypted blob.
      const uploadResp = await authedPost<{ rootHash: string; txHash?: string }>(
        '/api/v1/storage/upload',
        { data: blob },
        token,
      );
      const rootHash = uploadResp.rootHash;
      if (!rootHash) throw new Error('Storage upload returned no rootHash');
      console.log(`[PostTask] Encrypted blob uploaded — rootHash ${rootHash.slice(0, 12)}…`);

      // 4. ECIES-wrap the AES key to every currently-matching executor. The
      //    backend stores this bundle so /accept can return the slice the
      //    accepting executor needs — and only that slice — for decryption.
      //    The marketplace never sees the AES key in plaintext: privacy
      //    invariant from PITCH.md preserved.
      //
      //    If zero executors match (or all wraps fail), wrappedKeys is empty
      //    and the task posts as "awaiting bids" — useBidWatcher() will wrap
      //    to new bidders as they /bid. We stash the AES key locally first
      //    so the watcher has something to wrap *with* on the next tick.
      stashAesKey(taskHash, key);
      const wrappedKeys: Record<string, string> = {};
      for (const exec of executors) {
        try {
          const wrappedBytes = await eciesEncrypt(key, exec.publicKey);
          const wrappedHex = Array.from(wrappedBytes, (b) => b.toString(16).padStart(2, '0')).join('');
          wrappedKeys[exec.address.toLowerCase()] = wrappedHex;
        } catch (e) {
          // Skip an executor with a malformed pubkey rather than fail the
          // entire post — log so we can flag the bad registration later.
          console.warn(`[PostTask] Skipped ${exec.address} (wrap failed):`, (e as Error).message);
        }
      }
      console.log(
        `[PostTask] AES key wrapped to ${Object.keys(wrappedKeys).length}/${executors.length} executor(s); ` +
        `stashed locally for post-hoc bidders`,
      );

      // 5. Compute duration (seconds from now) from the chosen deadline.
      //    Re-evaluate at submit time so the value is accurate even if the
      //    form sat open for a while between picking the deadline and clicking
      //    submit.
      const deadlineMs = new Date(form.deadlineAt).getTime();
      if (Number.isNaN(deadlineMs)) throw new Error('Invalid deadline — pick a date and time.');
      const durationSecs = Math.floor((deadlineMs - Date.now()) / 1000);
      if (durationSecs < MIN_DURATION_SECONDS) {
        throw new Error(`Deadline must be at least 1 hour from now (got ${durationSecs}s).`);
      }
      if (durationSecs > MAX_DURATION_SECONDS) {
        throw new Error('Deadline cannot be more than 90 days out.');
      }

      // 6. Get unsigned tx from backend (with the rootHash + wrappedKeys bundle)
      const taskJson = await authedPost<any>('/api/v1/tasks', {
        taskHash,
        token: TOKEN,
        amount: amountWei.toString(),
        category: form.category,
        locationZone: form.locationZone,
        duration: String(durationSecs),
        // Hardcoded A2A: every task posted from this UI targets agents and
        // auto-verifies on submission. Settlement bridge closes the on-chain
        // loop without further input. Posters who want manual review or
        // human-targeted tasks would call /api/v1/tasks directly.
        targetExecutorType: 'agent' as const,
        verificationMode: 'auto' as const,
        verificationCriteria: { min_length: 10 },
        requiredCapabilities: requiredCaps,
        rootHash,
        wrappedKeys,
      }, token);

      // 7. Sign and send via MetaMask
      setStatus('signing');
      console.log(`[PostTask] Signing registration TX...`);
      const receipt = await signAndSendTx(signer, taskJson.unsignedTx);
      const txHash = receipt?.hash ?? taskJson.unsignedTx?.hash ?? '';
      console.log(`[PostTask] Task TX submitted: ${txHash}`);
      console.log('[PostTask] Task creation confirmed.');

      setTaskId(taskJson.taskId ?? null);
      setInitialWrapCount(Object.keys(wrappedKeys).length);
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
        title="Post a task for agent execution"
        description="Encrypt your instructions, lock payment in escrow. An autonomous agent accepts, completes, and auto-verifies — settlement happens on chain without you signing again."
      />

      <MintTestTokensCard />

      {status === 'done' ? (
        <div className="border border-line p-6 sm:p-8 space-y-5">
          <div className="text-center space-y-2">
            <div className="text-xs font-mono text-green-400 uppercase tracking-widest">✓ task posted</div>
            {taskId && <div className="text-xs font-mono text-ink-3">task #{taskId}</div>}
            <div className="text-xs font-mono text-ink-3">instructions encrypted · payment locked in escrow</div>
          </div>

          {initialWrapCount > 0 ? (
            // Case A — at least one matching agent was wrapped at post-time, so
            // the brief can be decrypted without any further action from the
            // poster. No need to keep a tab alive.
            <div className="border border-ok/40 bg-ok/5 px-4 py-3 space-y-2">
              <div className="text-[11px] font-mono uppercase tracking-widest text-ok">ready for pickup</div>
              <div className="text-[12px] font-mono text-ink-2 leading-relaxed">
                Encrypted brief wrapped to <span className="text-ink font-semibold">{initialWrapCount}</span>{' '}
                matching agent{initialWrapCount === 1 ? '' : 's'}. A worker can accept this any time.
              </div>
              <div className="text-[11px] font-mono text-ink-3 leading-relaxed">
                You can close this tab — the task will be picked up whether you're here or not.
              </div>
            </div>
          ) : (
            // Case B — no matching executors at post-time. The AES key lives
            // only in this browser; wraps to future bidders are issued by
            // useBidWatcher() running on /tasks/mine. Make the obligation
            // explicit so users don't post tasks and walk away expecting them
            // to be picked up unattended.
            <div className="border border-warn/50 bg-warn/5 px-4 py-4 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-warn text-base">⚠</span>
                <span className="text-[11px] font-mono uppercase tracking-widest text-warn">
                  awaiting first bidder
                </span>
              </div>
              <div className="text-[12px] font-mono text-ink-2 leading-relaxed">
                No agent with matching capabilities is registered yet. Your task is encrypted and posted,
                but when an agent bids we need <span className="text-ink font-semibold">your browser</span>{' '}
                to ship the encryption key — the platform can't see it.
              </div>
              <div className="text-[12px] font-mono text-ink-2 leading-relaxed space-y-1">
                <div className="flex gap-2">
                  <span className="text-cream shrink-0">▸</span>
                  <span>
                    <span className="text-ink font-semibold">Keep My Tasks open in a background tab.</span>{' '}
                    It auto-wraps as bids arrive (every 8s). You can do anything else in your browser.
                  </span>
                </div>
                <div className="flex gap-2">
                  <span className="text-cream shrink-0">▸</span>
                  <span>
                    Or just come back later. One visit to My Tasks unblocks every pending bid in a few seconds.
                  </span>
                </div>
              </div>
              <div className="text-[11px] font-mono text-ink-3 leading-relaxed pt-1 border-t border-warn/20">
                Closing your browser entirely will pause new pickups until you return.
              </div>
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2 sm:justify-center pt-1">
            <button
              onClick={() => navigate('/tasks/mine')}
              className="px-4 py-2 border border-cream text-xs font-mono text-cream hover:bg-cream hover:text-bg transition-colors uppercase tracking-widest"
            >
              {initialWrapCount > 0 ? 'view my tasks →' : 'open my tasks ↗'}
            </button>
            {initialWrapCount === 0 && (
              // Power-user shortcut: opens /tasks/mine in a new tab so the user
              // can leave it running as a background watcher while keeping this
              // tab around to post more tasks.
              <button
                onClick={() => window.open('/tasks/mine', '_blank', 'noopener')}
                className="px-4 py-2 border border-line text-xs font-mono text-ink-3 hover:border-ink-2 hover:text-ink transition-colors uppercase tracking-widest"
              >
                open in new tab
              </button>
            )}
          </div>
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

              {/* Stack category + location on phones — at 2-col on a 439px
                  viewport the placeholder ("describe it — or pi…") gets
                  clipped. Side-by-side returns at sm. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                  {/* Auto-fill grid keeps suggestion chips on a regular column
                      rhythm instead of the ragged wrap a plain flex produces.
                      Each cell is ≥90px and stretches to fill, so a row of
                      chips like "research" + "transcription" sit at equal width. */}
                  <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(90px,1fr))] gap-1.5">
                    {CATEGORY_SUGGESTIONS.map(c => {
                      const active = form.category === c;
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setForm(f => ({ ...f, category: c }))}
                          className={`px-2 py-1 text-[10px] font-mono border transition-colors text-center ${
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
                <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">
                  required capabilities <span className="text-cream">*</span>
                  <span className="ml-2 normal-case tracking-normal text-ink-3/70">
                    ({requiredCaps.length} selected — at least one required)
                  </span>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {AGENT_CAPABILITIES.map((cap) => {
                    const active = requiredCaps.includes(cap);
                    return (
                      <button
                        key={cap}
                        type="button"
                        onClick={() => toggleCap(cap)}
                        className={`px-2.5 py-1 text-[11px] font-mono border transition-colors ${
                          active
                            ? 'bg-cream/10 border-cream/40 text-cream'
                            : 'bg-surface-2 border-line text-ink-3 hover:text-ink-2'
                        }`}
                      >
                        {cap}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-1 text-[11px] font-mono text-ink-3">
                  pick every skill your task needs. an executor agent matches if it has any one.
                </div>
              </div>

              {/* A2A-only flow — explicit info banner replaces the old
                  executor + verification pickers. Every task posted here
                  targets an agent and auto-verifies on submission. */}
              <div className="border border-line bg-surface-2 px-4 py-3 text-[11px] font-mono text-ink-3 leading-relaxed">
                <span className="text-cream">a2a · auto-verify:</span> tasks
                posted here are visible to autonomous agents at <code className="text-ink-2">/a2a</code>.
                Submissions are checked against built-in criteria (min length, required fields)
                and escrow releases automatically — no further input from you.
              </div>
            </div>
          </div>

          <div className="p-6 border-b border-line">
            <SectionRule num="02" title="payment" />
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">
                  bounty ({isNative ? '0G' : 'USDC'}) <span className="text-cream">*</span>
                </label>
                <input
                  type="number"
                  min="0.0001"
                  step="0.0001"
                  required
                  value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink focus:outline-none focus:border-cream"
                />
                <div className="mt-1 text-[11px] font-mono text-ink-3">85% to worker · 15% protocol fee</div>
              </div>
              <div>
                <label className="block text-[11px] font-mono uppercase tracking-widest text-ink-3 mb-2">deadline</label>
                <input
                  type="datetime-local"
                  min={MIN_DEADLINE_AT}
                  max={MAX_DEADLINE_AT}
                  required
                  value={form.deadlineAt}
                  onChange={e => setForm(f => ({ ...f, deadlineAt: e.target.value }))}
                  className="w-full bg-surface-2 border border-line px-4 py-3 text-xs font-mono text-ink focus:outline-none focus:border-cream"
                />
                {/* Live human-readable hint — recomputed each render so the
                    user sees the offset shrink in real time if they're slow. */}
                <div className="mt-1 text-[11px] font-mono text-ink-3">
                  {(() => {
                    const ms = new Date(form.deadlineAt).getTime();
                    if (Number.isNaN(ms)) return 'pick a date and time · min 1 hour · max 90 days';
                    const secs = Math.floor((ms - Date.now()) / 1000);
                    return durationHint(secs);
                  })()}
                </div>
              </div>
            </div>
          </div>

          <div className="p-6">
            {!address ? (
              <div className="text-xs font-mono text-ink-3">connect wallet to post a task</div>
            ) : (
              <button
                type="submit"
                disabled={busy || requiredCaps.length === 0}
                title={requiredCaps.length === 0 ? 'select at least one required capability above' : undefined}
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
