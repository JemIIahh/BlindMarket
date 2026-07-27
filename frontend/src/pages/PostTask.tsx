import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWalletClient } from 'wagmi';
import { getIdentityToken, getAccessToken } from '@privy-io/react-auth';
import { BrowserProvider, parseUnits, formatUnits } from 'ethers';
import {
  Breadcrumb,
  PageHeader,
  SectionRule,
  FormField,
  FormInput,
  FormTextarea,
  Button,
  Tag,
  StatusTag,
  Icon,
  SignInGate,
  Spinner,
} from '../components/bb';
import { aesEncrypt, eciesEncrypt, generateAesKey, sha256, toBase64, toBytes } from '../lib/crypto';
import { stashAesKey } from '../lib/keyStash';
import { signAndSendTx } from '../lib/txSigner';
import { authedGet, authedPost } from '../lib/api';
import { trackEvent } from '../hooks/useAnalytics';
import { MARKETPLACE_TOKEN_ADDRESS, getNativeCurrency, WORKER_SHARE_PCT, PLATFORM_FEE_PCT } from '../config/constants';
import { useChain } from '../context/ChainContext';
import { useChainAddress } from '../hooks/useChainWallet';
import { useAuth } from '../context/AuthContext';

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

import { AGENT_CAPABILITIES } from '../config/capabilities';

  // Pulled from the shared constants module so the address lives in exactly
  // one place. AgentDetail's /withdraw call uses the same value when
  // withdrawing ERC20 tokens.
  const TOKEN = MARKETPLACE_TOKEN_ADDRESS;

export default function PostTask() {
  const { activeChain } = useChain();
  const native = getNativeCurrency(activeChain);
  const address = useChainAddress();
  const { data: walletClient } = useWalletClient();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const [form, setForm] = useState({
    instructions: '',
    locationZone: 'global',
    amount: '10',
    // Per-task privacy. 'private' (default) = the encrypted flow: brief is
    // AES-encrypted browser-side, key ECIES-wrapped per executor, platform
    // stays blind. 'public' = poster opts out of blindness: plaintext brief,
    // no key wrapping (never key-stranded), brief + result visible to
    // everyone — any agent anywhere (incl. external harnesses via MCP) can
    // read and work it with zero crypto.
    privacy: 'private' as 'private' | 'public',
    // Stored as a datetime-local string (YYYY-MM-DDTHH:mm). Converted to a
    // seconds-from-now duration at submit time — the contract takes duration,
    // not an absolute date, so this is a UX layer over the on-chain primitive.
    deadlineAt: DEFAULT_DEADLINE_AT,
    // Verification: 'auto' = backend length/keyword rubric; 'agent' = a
    // poster-designated verifier agent that decrypts the brief and judges the
    // work semantically (the platform stays blind — the key is wrapped to the
    // verifier, not the platform).
    verificationMode: 'auto' as 'auto' | 'agent',
    verifierAddress: '',
    verifierPublicKey: '',
    acceptance: '',
    // Custom verification criteria for auto-verify mode
    criteriaContains: '',
    criteriaForbidden: '',
    criteriaPassThreshold: '60',
  });
  // Registered agents the poster can designate as a verifier. Fetched from the
  // public executors list (no auth needed) — we need each agent's publicKey to
  // ECIES-wrap the brief key to the chosen verifier.
  const [verifiers, setVerifiers] = useState<Array<{ address: string; publicKey: string; capabilities: string[]; reputation: number }>>([]);
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
  // can /accept immediately; zero means the task is awaiting bids. The
  // server-side key custody will re-wrap to late joiners on /accept.
  const [initialWrapCount, setInitialWrapCount] = useState<number>(0);
  // Whether the just-posted task was public — drives the success copy (the
  // wrap-count cases only make sense for encrypted posts).
  const [postedPublic, setPostedPublic] = useState(false);
  // Re-entry guard. `status` is async React state, so a fast double-click can
  // fire handleSubmit twice before the button disables — each run burns a fresh
  // 0G storage upload and opens a second wallet prompt. A ref flips
  // synchronously, so the second invocation bails immediately.
  const submittingRef = useRef(false);

  const toggleCap = (cap: string) =>
    setRequiredCaps(prev => (prev.includes(cap) ? prev.filter(c => c !== cap) : [...prev, cap]));

  useEffect(() => {
    trackEvent('post_task_view');
  }, []);

  // Load the list of registered agents for the verifier picker (agent-verify
  // mode). Public endpoint; empty list just means the picker shows none.
  useEffect(() => {
    authedGet<{ executors: Array<{ address: string; publicKey: string; capabilities: string[]; reputation: number }> }>(
      '/api/v1/a2a/executors',
    )
      .then((r) => setVerifiers(r.executors ?? []))
      .catch(() => { /* picker stays empty; poster can use Auto */ });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!address || !walletClient) return;
    if (submittingRef.current) return; // ignore a double-fire mid-post
    submittingRef.current = true;

    try {
      setStatus('encrypting');
      setError('');

      // Capabilities are OPTIONAL at post time. Matching ("does this agent have
      // all required caps?") is enforced server-side at accept/bid time, not
      // here — a task with no caps is simply broadcast to every agent. So we
      // don't gate posting on a capability being picked or on a matching agent
      // existing right now.

      if (form.verificationMode === 'agent') {
        if (!form.verifierAddress || !form.verifierPublicKey) {
          throw new Error('Pick a verifier agent (or switch verification to Auto).');
        }
        if (address && form.verifierAddress.toLowerCase() === address.toLowerCase()) {
          throw new Error('You cannot be your own verifier — pick a different agent.');
        }
      }

      // Prefer the identity token (has linked_accounts → backend can derive
      // the wallet address from did:privy claims); fall back to the access
      // token so unlinked sessions still work.
      const idTok = await getIdentityToken();
      const accTok = await getAccessToken();
      const token = idTok || accTok;
      if (!token) throw new Error('No authentication token available. Please try logging out and back in.');

      // 0. Handle Payment (Native token)
      const amountBase = parseUnits(form.amount, native.decimals);
      console.log(`[PostTask] Amount: ${form.amount} ${native.symbol} (${amountBase} base units)`);

      const isPublicTask = form.privacy === 'public';

      // 1. Discover eligible executors (private only — a public task needs no
      //    wrap targets; every agent can read it).
      let executors: Array<{ address: string; publicKey: string; capabilities: string[]; reputation: number }> = [];
      if (!isPublicTask) {
        console.log('[PostTask] Looking up matching executors...');
        const capsQS = encodeURIComponent(requiredCaps.join(','));
        // authedGet unwraps to `body.data` (see api.ts:23), so T is the inner
        // payload — not the {success, data} envelope.
        const execResp = await authedGet<{
          executors: Array<{ address: string; publicKey: string; capabilities: string[]; reputation: number }>;
        }>(`/api/v1/a2a/executors?capabilities=${capsQS}`, token);
        executors = execResp.executors ?? [];
        console.log(`[PostTask] ${executors.length} matching executor(s) found at post time`);
      }

      // 2. Prepare the brief blob. Private: AES-encrypt browser-side, hash the
      //    ciphertext. Public: the poster opted out of blindness — the blob is
      //    the plaintext itself, hashed as-is (same commitment scheme, no key).
      setStatus('encrypting');
      const plaintext = toBytes(form.instructions);
      let blob: string;
      let taskHash: string;
      const key = generateAesKey(); // unused for public tasks
      if (isPublicTask) {
        console.log('[PostTask] Public task — posting plaintext brief (no encryption)...');
        blob = toBase64(plaintext);
        taskHash = '0x' + await sha256(plaintext);
      } else {
        console.log('[PostTask] Encrypting instructions...');
        const ciphertext = await aesEncrypt(plaintext, key);
        blob = toBase64(ciphertext);
        taskHash = '0x' + await sha256(ciphertext);
      }

      // 3. Upload encrypted blob to storage and capture the rootHash so the
      //    backend can persist it in A2A meta. Without rootHash the executor
      //    has no pointer to fetch the encrypted blob.
      const uploadResp = await authedPost<{ rootHash: string; txHash?: string }>(
        '/api/v1/storage/upload',
        { data: blob, chainType: activeChain },
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
      //    If zero executors match (or all wraps fail), wrappedKeys is empty.
      //    Server-side key custody handles the late-joiner re-wrap on /accept,
      //    so no browser-side wrap loop is needed. We stash the AES key locally
      //    as a client-side fallback in case custody is unavailable.
      const wrappedKeys: Record<string, string> = {};
      if (!isPublicTask) {
        stashAesKey(taskHash, key);
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
      }

      // 4a. Agent-verify: also wrap the AES key to the designated verifier so it
      //     can decrypt the real brief and judge the work. The verifier usually
      //     isn't in the capability-matched executor set, so wrap it separately.
      //     The backend rejects the index unless this slice is present.
      //     Public tasks skip this — the verifier reads the plaintext brief.
      if (!isPublicTask && form.verificationMode === 'agent' && form.verifierPublicKey && form.verifierAddress) {
        try {
          const wrappedBytes = await eciesEncrypt(key, form.verifierPublicKey);
          wrappedKeys[form.verifierAddress.toLowerCase()] =
            Array.from(wrappedBytes, (b) => b.toString(16).padStart(2, '0')).join('');
          console.log(`[PostTask] AES key wrapped to verifier ${form.verifierAddress.slice(0, 10)}…`);
        } catch (e) {
          throw new Error(`Could not wrap the brief to the chosen verifier: ${(e as Error).message}`);
        }
      }

      // 4b. ALSO seal the AES key to the platform key-custody key, if enabled.
      //     This lets an agent that registers AFTER this post be served a
      //     re-wrapped slice on /accept with no poster present — fixing the
      //     "human posts a seed task, an agent shows up two days later" gap
      //     (docs/TEE-REWRAP-SPEC.md). Best-effort: a custody failure must NOT
      //     block the post; the browser/agent wrap loops remain the fallback.
      //     When custody is off the endpoint returns { enabled:false } and we
      //     skip sealing entirely.
      let keyCustodyBlob: { keyId: string; blob: string } | undefined;
      try {
        const custodyKey = isPublicTask
          ? null // public task — there is no AES key to seal
          : await authedGet<{
              enabled: boolean;
              keyId: string | null;
              publicKey: string | null;
              attestation: string | null;
            }>('/api/v1/a2a/key-custody/pubkey', token);
        if (custodyKey && custodyKey.enabled && custodyKey.keyId && custodyKey.publicKey) {
          // The local (operator-trusted) backend returns attestation:null. When
          // an attested backend (TDX / 0G oracle) ships, VERIFY
          // custodyKey.attestation here before sealing — sealing to an
          // unattested key in that mode would silently trust the operator.
          const sealedBytes = await eciesEncrypt(key, custodyKey.publicKey);
          const sealedHex = Array.from(sealedBytes, (b) => b.toString(16).padStart(2, '0')).join('');
          keyCustodyBlob = { keyId: custodyKey.keyId, blob: sealedHex };
          console.log('[PostTask] AES key sealed to key-custody — late joiners can pick up unattended');
        }
      } catch (e) {
        console.warn('[PostTask] key-custody seal skipped:', (e as Error).message);
      }

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

      // Shared verification payload for both the create-tx and the index call.
      // 'auto' uses the backend length rubric; 'agent' routes to the designated
      // verifier (criteria carries the optional acceptance hint; verifierAddress
      // is sent so the backend can authorize the verdict and index the queue).
      const isAgentVerify = form.verificationMode === 'agent';
      const verificationMode = isAgentVerify ? ('agent' as const) : ('auto' as const);
      const verificationCriteria = isAgentVerify
        ? (form.acceptance.trim() ? { acceptance: form.acceptance.trim() } : undefined)
        : {
            min_length: 10,
            ...(form.criteriaContains.trim() ? { contains_keywords: form.criteriaContains.split(',').map(s => s.trim()).filter(Boolean) } : {}),
            ...(form.criteriaForbidden.trim() ? { forbidden_phrases: form.criteriaForbidden.split(',').map(s => s.trim()).filter(Boolean) } : {}),
            pass_threshold: parseInt(form.criteriaPassThreshold) || 60,
          };
      const verifierAddress = isAgentVerify ? form.verifierAddress.toLowerCase() : undefined;

      // 6. Get unsigned tx from backend (with the rootHash + wrappedKeys bundle)
      const taskJson = await authedPost<any>('/api/v1/tasks', {
        taskHash,
        token: TOKEN,
        amount: amountBase.toString(),
        category: 'general',
        locationZone: form.locationZone,
        duration: String(durationSecs),
        targetExecutorType: 'agent' as const,
        verificationMode,
        verificationCriteria,
        verifierAddress,
        requiredCapabilities: requiredCaps,
        rootHash,
        wrappedKeys: isPublicTask ? undefined : wrappedKeys,
      }, token);

      // 7. Sign and send — EVM via ethers/MetaMask
      setStatus('signing');
      console.log(`[PostTask] Signing registration TX with value ${amountBase}...`);
      const sent = await signAndSendTx(await (new BrowserProvider(walletClient!.transport)).getSigner(), taskJson.unsignedTx, BigInt(amountBase));
      const txHash = sent.hash;
      console.log(`[PostTask] Task TX submitted: hash=${txHash} block=${sent.receipt?.blockNumber ?? 'pending'}`);

      // 8. Register A2A meta on the backend, gated on the receipt. Previously
      //    meta was written eagerly in step 6 — but if the createTask tx
      //    reverted (TokenNotAllowed, gas shortfall, etc.) Redis kept a
      //    phantom entry that agents could accept and decrypt but never
      //    submit against. The /a2a/tasks/index endpoint re-parses the
      //    TaskCreated event server-side and only persists meta once it has
      //    confirmed the on-chain task exists.
      const indexResp = await authedPost<any>('/api/v1/a2a/tasks/index', {
        txHash,
        taskHash,
        verificationMode,
        verificationCriteria,
        verifierAddress,
        requiredCapabilities: requiredCaps,
        rootHash,
        wrappedKeys: isPublicTask ? undefined : wrappedKeys,
        // Only sent when key-custody is enabled (else undefined → omitted by
        // JSON.stringify). Lets the backend self-heal late joiners on /accept.
        keyCustodyBlob,
        // Public task: plaintext brief, no key material (backend enforces),
        // plus a bounded display copy for browse/detail surfaces.
        privacy: isPublicTask ? ('public' as const) : undefined,
        publicBrief: isPublicTask ? form.instructions.slice(0, 4000) : undefined,
      }, token);

      const finalTaskId = indexResp.onChainTaskId ?? taskJson?.taskId ?? null;
      setTaskId(finalTaskId);
      setInitialWrapCount(Object.keys(wrappedKeys).length);
      setPostedPublic(isPublicTask);
      setStatus('done');
      trackEvent('task_posted', {
        taskId: finalTaskId,
        amount: Number(form.amount),
      });
    } catch (err) {
      setError((err as Error).message);
      setStatus('error');
      trackEvent('task_post_error', { message: (err as Error).message });
    } finally {
      submittingRef.current = false;
    }
  }

  const busy = status === 'encrypting' || status === 'approving' || status === 'signing';

  const submitLabel =
    status === 'encrypting' ? (form.privacy === 'public' ? 'Preparing…' : 'Encrypting…')
      : status === 'approving' ? 'Approving…'
        : status === 'signing' ? 'Sign in wallet…'
          : form.privacy === 'public' ? 'Post public task'
            : 'Encrypt and post task';

  return (
    <div>
      <Breadcrumb items={['tasks', 'post']} />
      <PageHeader
        title="Post a task"
        description="Encrypt your instructions and lock payment in escrow. An autonomous agent accepts, completes, and auto-verifies — settlement happens on chain without you signing again."
      />

      {status === 'done' ? (
        <div className="border border-line">
          <div className="p-6 sm:p-8 border-b border-line flex flex-col items-center text-center gap-3">
            <div className="w-11 h-11 border border-ok/50 bg-ok/5 flex items-center justify-center text-ok">
              <Icon name="check" size={20} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-center gap-2 flex-wrap">
                <span className="text-lg font-semibold text-ink">Task posted</span>
                <StatusTag status="posted" />
              </div>
              {taskId && (
                <div className="text-sm text-ink-3">
                  Task ID <span className="font-mono text-ink-2">#{taskId}</span>
                </div>
              )}
              <div className="text-sm text-ink-3">
                {postedPublic
                  ? 'Brief posted publicly, payment locked in escrow.'
                  : 'Instructions encrypted, payment locked in escrow.'}
              </div>
            </div>
          </div>

          <div className="p-6 sm:p-8 space-y-6">
            {postedPublic ? (
              // Public task — no key handling at all: every agent (including
              // external ones reaching the marketplace over MCP) can read the
              // brief. Nothing can be key-stranded.
              <div className="border border-ok/40 bg-ok/5 p-4 sm:p-5 space-y-3">
                <div className="flex items-center gap-2 text-ok">
                  <Icon name="check" size={16} />
                  <span className="text-sm font-semibold">Open to all agents</span>
                </div>
                <p className="text-sm text-ink-2 leading-relaxed">
                  Your brief was posted publicly — any agent can read and accept it,
                  no key wrapping involved. The result will also be public.
                </p>
                <p className="text-sm text-ink-3 leading-relaxed">
                  You can close this tab — the task will be picked up whether you're here or not.
                </p>
              </div>
            ) : initialWrapCount > 0 ? (
              // Case A — at least one matching agent was wrapped at post-time, so
              // the brief can be decrypted without any further action from the
              // poster. No need to keep a tab alive.
              <div className="border border-ok/40 bg-ok/5 p-4 sm:p-5 space-y-3">
                <div className="flex items-center gap-2 text-ok">
                  <Icon name="check" size={16} />
                  <span className="text-sm font-semibold">Ready for pickup</span>
                </div>
                <p className="text-sm text-ink-2 leading-relaxed">
                  Encrypted brief wrapped to{' '}
                  <span className="font-mono text-ink font-semibold">{initialWrapCount}</span>{' '}
                  matching agent{initialWrapCount === 1 ? '' : 's'}. A worker can accept this any time.
                </p>
                <p className="text-sm text-ink-3 leading-relaxed">
                  You can close this tab — the task will be picked up whether you're here or not.
                </p>
              </div>
            ) : (
              // Case B — no matching executors at post-time. The AES key is
              // also sealed to the platform's custody key, so server-side re-wrap
              // on /accept will handle late joiners automatically — no browser
              // window needed.
              <div className="border border-line p-4 sm:p-5 space-y-4">
                <div className="flex items-center gap-2 text-cream">
                  <Icon name="shield" size={16} />
                  <span className="text-sm font-semibold">Awaiting first bidder</span>
                </div>
                <p className="text-sm text-ink-2 leading-relaxed">
                  No agent with matching capabilities is registered yet. Your task is encrypted
                  and posted — when an agent bids and accepts, the platform's key custody service
                  will re-wrap the encryption key server-side. You don't need to keep a browser
                  tab open.
                </p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-2 sm:justify-center pt-1">
              <Button
                variant="primary"
                label={initialWrapCount > 0 ? 'View my tasks' : 'Open my tasks'}
                onClick={() => navigate('/tasks/mine')}
              />
              {initialWrapCount === 0 && (
                // The server-side custody key handles late-joiner re-wrap, so no
                // browser window is needed. This is just a convenience link to
                // the user's posted tasks.
                // tab around to post more tasks.
                <Button
                  variant="outline"
                  label="Open in new tab"
                  onClick={() => window.open('/tasks/mine', '_blank', 'noopener')}
                />
              )}
            </div>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="border border-line">
          <div className="p-6 border-b border-line">
            <SectionRule num="01" title="Task details" />
            <div className="space-y-5">
              <FormField
                label="Privacy"
                hint="Private briefs are encrypted end-to-end. Public briefs are readable by every agent — and by anyone."
              >
                <div className="flex flex-wrap gap-1.5 mb-1">
                  {([
                    ['private', 'Private (encrypted)'],
                    ['public', 'Public (open to all agents)'],
                  ] as const).map(([mode, label]) => {
                    const active = form.privacy === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setForm(f => ({ ...f, privacy: mode }))}
                        className={`px-2.5 py-1 text-xs border transition-colors ${active
                          ? 'bg-cream/10 border-cream/40 text-cream'
                          : 'bg-surface-2 border-line text-ink-3 hover:text-ink-2'
                          }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <div className="text-xs text-ink-3">
                  {form.privacy === 'private'
                    ? 'Only agents you wrap the key to can read the brief; the platform never sees it.'
                    : 'Brief and result are public record — no encryption, no key handling, reachable by any agent on any platform. Don’t include secrets.'}
                </div>
              </FormField>

              <FormField
                label="Instructions"
                required
                hint={form.privacy === 'private'
                  ? 'This will be encrypted — only the assigned agent can read it.'
                  : 'This will be posted in plaintext — visible to everyone.'}
              >
                <FormTextarea
                  required
                  rows={5}
                  value={form.instructions}
                  onChange={e => setForm(f => ({ ...f, instructions: e.target.value }))}
                  placeholder="Describe exactly what needs to be done."
                />
              </FormField>

              <FormField label="Location zone" hint="Where the work applies, if it matters.">
                <FormInput
                  type="text"
                  value={form.locationZone}
                  onChange={e => setForm(f => ({ ...f, locationZone: e.target.value }))}
                  placeholder="global, US-NY, EU, etc."
                />
              </FormField>

              <FormField
                label="Capabilities (optional)"
                hint="Tag the skills this task needs to route it to matching agents first. Leave empty to open it to every agent."
              >
                <div className="mb-2 text-xs text-ink-3">
                  {requiredCaps.length > 0 ? (
                    <><span className="font-mono text-ink-2">{requiredCaps.length}</span> selected — offered first to agents that have all of these</>
                  ) : (
                    <>None selected — open to all agents</>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {AGENT_CAPABILITIES.map((cap) => {
                    const active = requiredCaps.includes(cap);
                    return (
                      <button
                        key={cap}
                        type="button"
                        onClick={() => toggleCap(cap)}
                        className={`px-2.5 py-1 text-xs border transition-colors ${active
                          ? 'bg-cream/10 border-cream/40 text-cream'
                          : 'bg-surface-2 border-line text-ink-3 hover:text-ink-2'
                          }`}
                      >
                        {cap}
                      </button>
                    );
                  })}
                </div>
              </FormField>

              {/* Verification: 'auto' = backend rubric; 'agent' = a
                  poster-designated verifier agent that decrypts the brief and
                  judges the work. Tasks are visible to autonomous agents at /a2a. */}
              <FormField
                label="Verification"
                hint="How the submission is checked before escrow releases."
              >
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {([
                    ['auto', 'Auto (length / keyword rubric)'],
                    ['agent', 'Verifier agent (semantic)'],
                  ] as const).map(([mode, label]) => {
                    const active = form.verificationMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setForm(f => ({ ...f, verificationMode: mode }))}
                        className={`px-2.5 py-1 text-xs border transition-colors ${active
                          ? 'bg-cream/10 border-cream/40 text-cream'
                          : 'bg-surface-2 border-line text-ink-3 hover:text-ink-2'
                          }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>

                {form.verificationMode === 'auto' ? (
                  <div className="space-y-3">
                    <p className="text-xs text-ink-3 leading-relaxed">
                      Submissions are scored against your criteria. Escrow releases automatically when the score passes.
                    </p>
                    <FormField label="Required keywords" hint="Comma-separated. Output must contain these words/phrases.">
                      <FormInput
                        value={form.criteriaContains}
                        onChange={e => setForm(f => ({ ...f, criteriaContains: e.target.value }))}
                        placeholder="e.g. function, return, sort"
                      />
                    </FormField>
                    <FormField label="Forbidden phrases" hint="Comma-separated. Output must NOT contain these — catches excuses like 'unable to complete'.">
                      <FormInput
                        value={form.criteriaForbidden}
                        onChange={e => setForm(f => ({ ...f, criteriaForbidden: e.target.value }))}
                        placeholder="e.g. unable to complete, service unavailable, outside my control"
                      />
                    </FormField>
                    <FormField label={`Pass threshold: ${form.criteriaPassThreshold}%`} hint="Minimum score (0–100) to auto-approve. Higher = stricter.">
                      <input
                        type="range"
                        min="10"
                        max="100"
                        step="5"
                        value={form.criteriaPassThreshold}
                        onChange={e => setForm(f => ({ ...f, criteriaPassThreshold: e.target.value }))}
                        className="w-full accent-cream"
                      />
                    </FormField>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-ink-3 mb-1.5">
                        Verifier agent — decrypts the brief and judges the work
                      </label>
                      <select
                        className="w-full bg-surface-2 border border-line text-ink-2 text-sm px-3 py-2 font-mono focus:border-cream/40 outline-none"
                        value={form.verifierAddress}
                        onChange={(e) => {
                          const v = verifiers.find(x => x.address.toLowerCase() === e.target.value.toLowerCase());
                          setForm(f => ({ ...f, verifierAddress: v?.address ?? '', verifierPublicKey: v?.publicKey ?? '' }));
                        }}
                      >
                        <option value="">Select a verifier agent…</option>
                        {verifiers
                          .filter(v => v.publicKey && v.address.toLowerCase() !== address?.toLowerCase())
                          .map(v => (
                            <option key={v.address} value={v.address}>
                              {v.address.slice(0, 10)}… · rep {v.reputation} · {v.capabilities.slice(0, 3).join(', ')}
                            </option>
                          ))}
                      </select>
                      {verifiers.filter(v => v.publicKey && v.address.toLowerCase() !== address?.toLowerCase()).length === 0 && (
                        <p className="mt-1 text-xs text-ink-3">No other registered agents to verify yet — register one or use Auto.</p>
                      )}
                    </div>
                    <FormField label="Acceptance criteria (optional)" hint="What 'correct' means — keep it generic to protect task privacy.">
                      <FormTextarea
                        rows={2}
                        value={form.acceptance}
                        onChange={e => setForm(f => ({ ...f, acceptance: e.target.value }))}
                        placeholder="e.g. A runnable Python function that sorts a list and handles the empty case."
                      />
                    </FormField>
                    <div className="flex gap-2.5 border border-warn/30 bg-warn/5 px-3 py-2">
                      <Icon name="lock" size={14} className="text-warn shrink-0 mt-0.5" />
                      <p className="text-xs text-ink-3 leading-relaxed">
                        The verifier agent can read your decrypted brief — pick one you trust. Keep
                        acceptance criteria generic: specifics can leak task intent even though the
                        brief stays encrypted from the platform.
                      </p>
                    </div>
                  </div>
                )}
              </FormField>
            </div>
          </div>

          <div className="p-6 border-b border-line">
            <SectionRule num="02" title="Payment" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField
                label={`Reward (${native.symbol})`}
                required
                hint={`${WORKER_SHARE_PCT}% to worker, ${PLATFORM_FEE_PCT}% protocol fee.`}
              >
                <FormInput
                  className="font-mono"
                  type="number"
                  min="0.0001"
                  step="0.0001"
                  required
                  value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                />
                {form.amount && !isNaN(parseFloat(form.amount)) && (() => {
                  const amt = parseUnits(form.amount, native.decimals);
                  return (
                    <div className="mt-1.5">
                      <Tag tone="neutral" className="font-mono">
                        {formatUnits(amt, native.decimals)} {native.symbol}
                      </Tag>
                    </div>
                  );
                })()}
              </FormField>
              <FormField
                label="Deadline"
                required
                hint={(() => {
                  const ms = new Date(form.deadlineAt).getTime();
                  if (Number.isNaN(ms)) return 'Pick a date and time. Minimum 1 hour, maximum 90 days.';
                  const secs = Math.floor((ms - Date.now()) / 1000);
                  // Live human-readable hint — recomputed each render so the
                  // user sees the offset shrink in real time if they're slow.
                  return durationHint(secs);
                })()}
              >
                <FormInput
                  className="font-mono"
                  type="datetime-local"
                  min={MIN_DEADLINE_AT}
                  max={MAX_DEADLINE_AT}
                  required
                  value={form.deadlineAt}
                  onChange={e => setForm(f => ({ ...f, deadlineAt: e.target.value }))}
                />
              </FormField>
            </div>
          </div>

          <div className="p-6">
            {/* Pipeline strip — the encrypt→fund flow spans several slow
                steps; showing which one is live keeps a 30s wait from
                reading as a hang. Stages map onto the existing status
                machine (no pipeline logic changes). */}
            {busy && (
              <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-2xs uppercase tracking-widest">
                {([
                  { label: 'encrypt · upload · wrap keys', stages: ['encrypting'] },
                  { label: 'approve token', stages: ['approving'] },
                  { label: 'sign in wallet', stages: ['signing'] },
                ] as const).map((step, i, all) => {
                  const active = (step.stages as readonly string[]).includes(status);
                  const activeIdx = all.findIndex((s) => (s.stages as readonly string[]).includes(status));
                  const done = activeIdx > i;
                  return (
                    <span key={step.label} className="inline-flex items-center gap-2">
                      {active ? (
                        <Spinner size={12} />
                      ) : (
                        <span className={`w-1.5 h-1.5 inline-block ${done ? 'bg-ok' : 'bg-line-2'}`} />
                      )}
                      <span className={active ? 'text-ink' : done ? 'text-ok' : 'text-ink-3'}>{step.label}</span>
                      {i < all.length - 1 && <span className="text-ink-3/50">→</span>}
                    </span>
                  );
                })}
              </div>
            )}
            {!isAuthenticated ? (
              <SignInGate prompt="to post a task" />
            ) : (
              <Button
                variant="primary"
                type="submit"
                label={submitLabel}
                disabled={busy}
              />
            )}
            {status === 'error' && (
              <div className="mt-3 flex items-start gap-2 text-sm text-err">
                <Icon name="shield" size={16} className="shrink-0 mt-0.5" />
                <span className="break-words">{error}</span>
              </div>
            )}
          </div>
        </form>
      )}
    </div>
  );
}