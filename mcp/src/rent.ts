import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Contract, Interface, formatUnits, parseUnits } from 'ethers';
import type { McpConfig } from './config.js';
import type { WalletCtx } from './wallet.js';
import { aesEncrypt, eciesEncrypt, generateAesKey, sha256Hex } from './crypto.js';
import { createQuote, consumeQuote, getSpend, putSpend, updateSpend, type SpendRecord } from './state.js';
import { createSettlementResolver, type BaseSettlement, type Settlement } from './settlement.js';

/**
 * Tier-2 spending tools: the CURRENT encrypted post/rent flow, executed
 * entirely locally. This is a 1:1 port of the "Use from your agent" script
 * (frontend/src/components/UseFromAgentModal.tsx buildScript):
 *
 *   encrypt brief locally → POST /api/v1/storage/upload → ECIES-wrap the AES
 *   key to the provider pubkey(s) → POST /api/v1/tasks (unsigned escrow tx) →
 *   sign + send from the LOCAL wallet → POST /api/v1/a2a/tasks/index → poll
 *   GET /api/v1/a2a/tasks/posted for the result.
 *
 * Privacy: for privacy='private' (default) the platform only ever sees
 * ciphertext and a hash. privacy='public' posts the brief in plaintext — no
 * key handling at all, readable by every agent.
 *
 * Spend safety: two-step quote/confirm + a required idempotencyKey persisted
 * in ~/.blindmarket/mcp-state.json with a created→funded→indexed stage
 * machine, so retries resume instead of double-funding.
 */

const ZERO_TOKEN = '0x0000000000000000000000000000000000000000';
const GAS_LIMIT = 1000000n; // matches the canonical rent script

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(code: string, message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code, message } }) }] };
}

interface ApiError extends Error { code?: string }

export function registerRentTools(server: McpServer, cfg: McpConfig, walletCtx: WalletCtx | null): { settlement: () => Promise<Settlement> } {
  /** Every authenticated call funnels through api(), so this is the one place
   *  the missing-key case needs handling. Without it the caller gets the
   *  backend's generic "Authentication required", which never names the
   *  variable to set — an agent reading that cannot tell what to fix. Also the
   *  only consumer of cfg.authenticated, which was otherwise dead weight. */
  async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    if (!cfg.authenticated) {
      const err: ApiError = new Error(
        `${path} needs credentials — set BLINDMARKET_API_KEY. Mint one in the web app under Settings -> API keys.`,
      );
      err.code = 'NO_API_KEY';
      throw err;
    }
    const res = await fetch(`${cfg.apiBase}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.apiKey },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) {
      const err: ApiError = new Error(`${path} failed: ${json.error?.message || res.status}`);
      err.code = json.error?.code;
      throw err;
    }
    return json.data as T;
  }

  const settlement = createSettlementResolver({ apiBase: cfg.apiBase ?? 'https://api.blindmarket.xyz', api });

  /** How this process pays. On 0G that is the local wallet, which must exist.
   *  On Base nothing signs locally — the relay signs from the API key's owner
   *  wallet — so a missing BLINDMARKET_PRIVATE_KEY is not an error there. */
  async function requireFunding(): Promise<{ s: Settlement; payFrom: string } | { error: ReturnType<typeof fail> }> {
    let s: Settlement;
    try {
      s = await settlement();
    } catch (err) {
      return { error: fail((err as ApiError).code ?? 'SETTLEMENT_UNKNOWN', (err as Error).message) };
    }
    if (s.mode === 'base') return { s, payFrom: s.payFrom };
    if (!walletCtx) {
      return { error: fail('NO_WALLET', 'Spending on 0G needs a local funding wallet — set BLINDMARKET_PRIVATE_KEY (see wallet_status)') };
    }
    return { s, payFrom: walletCtx.wallet.address };
  }

  const ERC20 = new Interface([
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
  ]);
  function usdc(s: BaseSettlement): Contract {
    return new Contract(s.usdcAddress, ERC20, s.provider);
  }

  /** Spendable balance of whoever pays, in the settlement token's units. */
  async function payFromBalance(s: Settlement, payFrom: string): Promise<string | null> {
    try {
      const raw: bigint = s.mode === 'base'
        ? await usdc(s).balanceOf(payFrom)
        : await walletCtx!.provider.getBalance(payFrom);
      return formatUnits(raw, s.decimals);
    } catch {
      return null;
    }
  }

  /** Hand a transaction to the backend relay: Privy signs it from payFrom with
   *  gas paid in USDC. Same wire shape as frontend/src/lib/txSigner.ts. */
  async function relaySend(s: BaseSettlement, tx: { to: string; data: string; value?: bigint }): Promise<{ hash: string; isUserOp: boolean }> {
    const r = await api<{ hash: string; isUserOp?: boolean }>('POST', '/api/v1/tx/relay-tx', {
      walletAddress: s.payFrom,
      to: tx.to,
      data: tx.data,
      value: tx.value === undefined ? undefined : String(tx.value),
      chain: s.relayChain,
      asset: 'usdc',
    });
    if (!r?.hash) {
      const e: ApiError = new Error('relay-tx returned no hash');
      e.code = 'RELAY_NO_HASH';
      throw e;
    }
    return { hash: r.hash, isUserOp: r.isUserOp === true };
  }

  /** Wait for a relayed tx to land. A plain hash can be polled for its receipt;
   *  a user-op hash cannot (getTransactionReceipt is always null for it), so
   *  that case returns at once and the caller confirms by on-chain STATE —
   *  see ensureAllowance and waitCancelled. */
  async function waitRelayed(s: BaseSettlement, hash: string, isUserOp: boolean): Promise<void> {
    if (isUserOp) return;
    for (let i = 0; i < 30; i++) {
      const receipt = await s.provider.getTransactionReceipt(hash).catch(() => null);
      if (receipt) {
        if (receipt.status === 0) {
          const e: ApiError = new Error(`relayed tx ${hash} reverted`);
          e.code = 'TX_REVERTED';
          throw e;
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    const e: ApiError = new Error(`relayed tx ${hash} not confirmed after 90s — retry with the same idempotencyKey to resume`);
    e.code = 'TX_PENDING';
    throw e;
  }

  /** Base only: createTask pulls USDC via transferFrom, so the escrow needs an
   *  allowance first. Confirmed by re-reading allowance() rather than by
   *  receipt, which is what makes the user-op case decidable. */
  async function ensureAllowance(s: BaseSettlement, record: SpendRecord): Promise<void> {
    const need = BigInt(record.amountWei!);
    const token = usdc(s);
    if ((await token.allowance(s.payFrom, s.escrowAddress)) >= need) return;
    if (record.stage === 'created') {
      const data = ERC20.encodeFunctionData('approve', [s.escrowAddress, need]);
      const { hash, isUserOp } = await relaySend(s, { to: s.usdcAddress, data });
      // Persist BEFORE waiting: a crash here must resume into the poll below,
      // not send a second approve.
      updateSpend(record.idempotencyKey, { stage: 'approved', approveTxHash: hash });
      record.stage = 'approved';
      record.approveTxHash = hash;
    }
    for (let i = 0; i < 30; i++) {
      if ((await token.allowance(s.payFrom, s.escrowAddress)) >= need) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
    const e: ApiError = new Error(`USDC allowance still below ${formatUnits(need, s.decimals)} after 90s (approve ${record.approveTxHash}) — retry with the same idempotencyKey to keep waiting`);
    e.code = 'APPROVE_PENDING';
    throw e;
  }

  /** Fund escrow + index — the shared tail of rent_service and post_task.
   *  Resumable at every stage via the spend ledger.
   *
   *  Two funding paths, chosen by settlement mode:
   *    0g   — native value from the local wallet, signed and sent here.
   *    base — USDC via transferFrom: approve first (ensureAllowance), then the
   *           createTask the backend built, both through the Privy relay with
   *           no local signing at all. The backend picks the escrow; we only
   *           check it is the one we approved. */
  async function fundAndIndex(record: SpendRecord): Promise<{ taskHash: string; txHash: string }> {
    const s = await settlement();
    let { txHash } = record;

    // A record remembers the chain it started on. If the backend flips mode
    // between attempts, re-funding through the other path would double-fund
    // or send native value into a USDC transferFrom — refuse instead.
    if (record.settlement && record.settlement !== s.mode) {
      const e: ApiError = new Error(`spend ${record.idempotencyKey} started on ${record.settlement} but the backend now settles on ${s.mode} — finish or refund it from the web app`);
      e.code = 'SETTLEMENT_CHANGED';
      throw e;
    }

    if (record.stage === 'created' || record.stage === 'approved') {
      if (s.mode === 'base') await ensureAllowance(s, record);

      const { unsignedTx } = await api('POST', '/api/v1/tasks', {
        taskHash: record.taskHash,
        token: s.mode === 'base' ? s.usdcAddress : ZERO_TOKEN,
        amount: record.amountWei,
        locationZone: 'global',
        duration: String(record.durationSecs ?? 3600),
        targetExecutorType: 'agent',
        verificationMode: record.verificationMode,
        verificationCriteria: record.verificationCriteria,
        requiredCapabilities: record.requiredCapabilities ?? [],
        rootHash: record.rootHash,
        wrappedKeys: record.privacy === 'public' ? undefined : record.wrappedKeys,
      });

      if (s.mode === 'base') {
        // The allowance above was granted to the escrow health/bridge named.
        // If the backend built the tx for a different one, transferFrom would
        // revert and we would have burned an approve for nothing.
        if (String(unsignedTx.to).toLowerCase() !== s.escrowAddress.toLowerCase()) {
          const e: ApiError = new Error(`backend built createTask for ${unsignedTx.to} but /health/bridge reports escrow ${s.escrowAddress}`);
          e.code = 'ESCROW_MISMATCH';
          throw e;
        }
        const { hash, isUserOp } = await relaySend(s, { to: unsignedTx.to, data: unsignedTx.data });
        // Persist BEFORE waiting, same reasoning as the 0G branch below.
        updateSpend(record.idempotencyKey, { stage: 'funded', txHash: hash, isUserOp });
        txHash = hash;
        record.isUserOp = isUserOp;
        await waitRelayed(s, hash, isUserOp);
      } else {
        const tx = await walletCtx!.wallet.sendTransaction({
          to: unsignedTx.to,
          data: unsignedTx.data,
          value: BigInt(record.amountWei!),
          gasLimit: GAS_LIMIT,
        });
        // Persist the tx hash BEFORE waiting: if we crash mid-confirmation the
        // resume path re-runs /tasks/index with this hash instead of re-funding.
        updateSpend(record.idempotencyKey, { stage: 'funded', txHash: tx.hash });
        txHash = tx.hash;
        await tx.wait();
      }
    }

    // stage 'funded' (fresh or resumed): index against the verified receipt.
    // /a2a/tasks/index polls both chains for the receipt server-side, and with
    // isUserOp it skips the (always-null) receipt lookup and scans logs for the
    // TaskCreated event instead — that is how the user-op case is resolved.
    await api('POST', '/api/v1/a2a/tasks/index', {
      txHash,
      isUserOp: record.isUserOp ?? false,
      taskHash: record.taskHash,
      verificationMode: record.verificationMode,
      verificationCriteria: record.verificationCriteria,
      requiredCapabilities: record.requiredCapabilities ?? [],
      rootHash: record.rootHash,
      wrappedKeys: record.privacy === 'public' ? undefined : record.wrappedKeys,
      targetExecutor: record.targetExecutor,
      serviceId: record.serviceId,
      privacy: record.privacy === 'public' ? 'public' : undefined,
      publicBrief: record.privacy === 'public' ? record.publicBrief : undefined,
    });
    updateSpend(record.idempotencyKey, { stage: 'indexed' });
    return { taskHash: record.taskHash!, txHash: txHash! };
  }

  async function pollPosted(taskHash: string, waitSeconds: number) {
    const deadline = Date.now() + Math.min(60, Math.max(0, waitSeconds)) * 1000;
    const hashLc = taskHash.toLowerCase();
    for (;;) {
      const { tasks } = await api<{ tasks: any[] }>('GET', '/api/v1/a2a/tasks/posted');
      const t = tasks.find((x) => x.meta?.taskId?.toLowerCase() === hashLc);
      const status = t?.state?.status ?? 'unknown';
      if ((status === 'verified' || status === 'completed') && t.state.resultData) {
        return { status, result: t.state.resultData, done: true };
      }
      if (status === 'failed') {
        return { status, failedReason: t.state.failedReason ?? null, done: true, hint: 'The agent could not complete this task. If escrow is still Funded you can cancel for a refund.' };
      }
      if (Date.now() >= deadline) {
        return { status, done: false, hint: 'Still running — call poll_task_result again.' };
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  // ── rent_service ──────────────────────────────────────────────────────────

  server.registerTool(
    'rent_service',
    {
      title: 'Rent an Agent Service',
      description: 'Hire a listed agent service for one call: encrypts your prompt locally (unless privacy=public), funds escrow, and pins the task to the provider agent. Escrow is USDC on Base via the gas-sponsored relay when the backend settles there (no private key needed), else native 0G from the local wallet — see wallet_status. TWO-STEP: first call returns a price quote + quoteId; re-call with confirm=true and that quoteId to actually spend. Requires a unique idempotencyKey (safe to retry with the same key — it resumes, never double-pays).',
      inputSchema: {
        serviceId: z.number().int().positive().describe('Service id from browse_services / get_service'),
        prompt: z.string().min(1).max(100_000).describe('What you want the agent to do'),
        idempotencyKey: z.string().min(8).max(128).describe('Unique key for this spend — reuse it on retries'),
        privacy: z.enum(['private', 'public']).optional().describe("Default 'private': prompt encrypted end-to-end. 'public': prompt and result become public record"),
        confirm: z.boolean().optional().describe('Set true (with quoteId) to execute the spend'),
        quoteId: z.string().optional().describe('From the quote step'),
        waitSeconds: z.number().int().min(0).max(60).optional().describe('How long to wait for the result after posting (default 45; poll_task_result to keep waiting)'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ serviceId, prompt, idempotencyKey, privacy, confirm, quoteId, waitSeconds }) => {
      const f = await requireFunding();
      if ('error' in f) return f.error;
      const { s, payFrom } = f;

      // Resume path — this key already spent (or partially spent).
      const existing = getSpend(idempotencyKey);
      if (existing) {
        if (existing.stage === 'indexed') {
          const polled = await pollPosted(existing.taskHash!, waitSeconds ?? 45);
          return ok({ resumed: true, taskHash: existing.taskHash, txHash: existing.txHash, ...polled });
        }
        try {
          const done = await fundAndIndex(existing);
          const polled = await pollPosted(done.taskHash, waitSeconds ?? 45);
          return ok({ resumed: true, ...done, ...polled });
        } catch (err) {
          return fail((err as ApiError).code ?? 'RESUME_FAILED', (err as Error).message);
        }
      }

      const service = await api<any>('GET', `/api/v1/marketplace/services/${serviceId}`);
      const isPublic = privacy === 'public';
      if (!isPublic && !service.agent_public_key) {
        return fail('NO_AGENT_PUBKEY', 'This service\'s agent has no encryption public key — only privacy=public calls are possible');
      }

      // price_raw is stored in the settlement token's base units (the backend
      // compares it against the on-chain amount as-is), so it is 6-decimal
      // USDC on Base and 18-decimal 0G otherwise — format it that way.
      const price = formatUnits(BigInt(service.price_raw), s.decimals);

      if (!confirm) {
        const quote = createQuote('rent', { serviceId, price, currency: s.symbol });
        return ok({
          quote: {
            service: { id: service.id, name: service.name, agent: service.agent_address },
            price,
            currency: s.symbol,
            settlement: s.mode,
            payFrom,
            walletBalance: await payFromBalance(s, payFrom),
            privacy: isPublic ? 'public' : 'private',
            quoteId: quote.quoteId,
          },
          next: `Re-call rent_service with confirm=true, quoteId="${quote.quoteId}", and the SAME idempotencyKey to execute this spend.`,
        });
      }
      if (!quoteId || !consumeQuote(quoteId, 'rent')) {
        return fail('QUOTE_REQUIRED', 'Get a quote first (call without confirm), then re-call with confirm=true and the returned quoteId (quotes are single-use and expire after 10 minutes)');
      }

      try {
        // Prepare the brief blob (the canonical script's steps 1-3).
        const plaintext = Buffer.from(prompt, 'utf8');
        let blobB64: string;
        let taskHash: string;
        let wrappedKeys: Record<string, string> | undefined;
        let aesKeyHex: string | undefined;
        if (isPublic) {
          blobB64 = plaintext.toString('base64');
          taskHash = '0x' + sha256Hex(plaintext);
        } else {
          const aesKey = generateAesKey();
          const ciphertext = aesEncrypt(plaintext, aesKey);
          blobB64 = ciphertext.toString('base64');
          taskHash = '0x' + sha256Hex(ciphertext);
          wrappedKeys = { [service.agent_address.toLowerCase()]: eciesEncrypt(aesKey, service.agent_public_key).toString('hex') };
          aesKeyHex = aesKey.toString('hex');
        }
        const { rootHash } = await api<{ rootHash: string }>('POST', '/api/v1/storage/upload', { data: blobB64 });

        const record: SpendRecord = {
          idempotencyKey,
          kind: 'rent',
          stage: 'created',
          taskHash,
          rootHash,
          serviceId: service.id,
          targetExecutor: service.agent_address.toLowerCase(),
          privacy: isPublic ? 'public' : 'private',
          aesKeyHex,
          wrappedKeys,
          publicBrief: isPublic ? prompt.slice(0, 4000) : undefined,
          verificationMode: 'auto',
          verificationCriteria: { min_length: 1 },
          requiredCapabilities: [],
          amountWei: String(service.price_raw),
          settlement: s.mode,
          token: s.mode === 'base' ? s.usdcAddress : ZERO_TOKEN,
          durationSecs: 3600,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        putSpend(record);

        const done = await fundAndIndex(record);
        const polled = await pollPosted(done.taskHash, waitSeconds ?? 45);
        return ok({ ...done, ...polled });
      } catch (err) {
        const code = (err as ApiError).code;
        if (code === 'NOT_TASK_AGENT') {
          return fail(code, 'The API key\'s owner wallet does not match the wallet that funded escrow. On 0G, mint an sk_ key while signed in with the BLINDMARKET_PRIVATE_KEY wallet; on Base the relay signs from the key\'s own wallet, so this means the key was rotated mid-spend. The escrow is funded but unindexed — retry with the same idempotencyKey after fixing the key, or use cancel_task for a refund.');
        }
        return fail(code ?? 'RENT_FAILED', (err as Error).message);
      }
    },
  );

  // ── post_task ─────────────────────────────────────────────────────────────

  server.registerTool(
    'post_task',
    {
      title: 'Post a Task to the Open Market',
      description: 'Post a task any matching agent can pick up: encrypts the brief locally and wraps its key to every registered matching executor (or posts it in plaintext with privacy=public), then funds escrow. Escrow is USDC on Base via the gas-sponsored relay when the backend settles there (no private key needed), else native 0G from the local wallet — see wallet_status. TWO-STEP quote/confirm like rent_service; requires a unique idempotencyKey.',
      inputSchema: {
        instructions: z.string().min(1).max(100_000).describe('The task brief'),
        amount: z.string().regex(/^\d+(\.\d+)?$/).optional().describe('Escrow amount in the settlement token (e.g. "2.5" — USDC on Base, 0G on 0G) — paid to the worker (90%) on verified completion'),
        amount0G: z.string().regex(/^\d+(\.\d+)?$/).optional().describe('Deprecated alias of `amount` kept for existing callers — same meaning, same units as the settlement token'),
        idempotencyKey: z.string().min(8).max(128).describe('Unique key for this spend — reuse it on retries'),
        capabilities: z.array(z.string()).optional().describe('Optional capability tags to route to matching agents first; empty = every agent'),
        durationSeconds: z.number().int().min(3600).max(90 * 24 * 3600).optional().describe('Deadline seconds from now (default 86400 = 24h)'),
        privacy: z.enum(['private', 'public']).optional().describe("Default 'private': encrypted brief. 'public': plaintext brief + public result — readable/workable by any agent with zero crypto"),
        confirm: z.boolean().optional().describe('Set true (with quoteId) to execute the spend'),
        quoteId: z.string().optional().describe('From the quote step'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ instructions, amount, amount0G, idempotencyKey, capabilities, durationSeconds, privacy, confirm, quoteId }) => {
      const f = await requireFunding();
      if ('error' in f) return f.error;
      const { s, payFrom } = f;

      const existing = getSpend(idempotencyKey);
      if (existing) {
        if (existing.stage === 'indexed') {
          return ok({ resumed: true, taskHash: existing.taskHash, txHash: existing.txHash, hint: 'Already posted — use poll_task_result to check on it.' });
        }
        try {
          return ok({ resumed: true, ...(await fundAndIndex(existing)) });
        } catch (err) {
          return fail((err as ApiError).code ?? 'RESUME_FAILED', (err as Error).message);
        }
      }

      const isPublic = privacy === 'public';
      const amountStr = amount ?? amount0G;
      if (!amountStr) {
        return fail('AMOUNT_REQUIRED', `Pass \`amount\` — the escrow in ${s.symbol} (e.g. "2.5").`);
      }
      const amountWei = parseUnits(amountStr, s.decimals);

      if (!confirm) {
        const quote = createQuote('post', { amount: amountStr, currency: s.symbol });
        return ok({
          quote: {
            escrow: amountStr,
            currency: s.symbol,
            settlement: s.mode,
            payFrom,
            walletBalance: await payFromBalance(s, payFrom),
            privacy: isPublic ? 'public' : 'private',
            capabilities: capabilities ?? [],
            quoteId: quote.quoteId,
          },
          next: `Re-call post_task with confirm=true, quoteId="${quote.quoteId}", and the SAME idempotencyKey to execute this spend.`,
        });
      }
      if (!quoteId || !consumeQuote(quoteId, 'post')) {
        return fail('QUOTE_REQUIRED', 'Get a quote first (call without confirm), then re-call with confirm=true and the returned quoteId (quotes are single-use and expire after 10 minutes)');
      }

      try {
        const plaintext = Buffer.from(instructions, 'utf8');
        let blobB64: string;
        let taskHash: string;
        let wrappedKeys: Record<string, string> | undefined;
        let aesKeyHex: string | undefined;
        if (isPublic) {
          blobB64 = plaintext.toString('base64');
          taskHash = '0x' + sha256Hex(plaintext);
        } else {
          // Wrap to every currently-registered matching executor — same as the
          // PostTask UI. A late joiner relies on the platform's key custody (if
          // enabled) or the poster re-wrapping; consider privacy=public for
          // guaranteed pickup by anyone.
          const capsQS = encodeURIComponent((capabilities ?? []).join(','));
          const { executors } = await api<{ executors: Array<{ address: string; publicKey: string }> }>(
            'GET', `/api/v1/a2a/executors?capabilities=${capsQS}`,
          );
          const aesKey = generateAesKey();
          const ciphertext = aesEncrypt(plaintext, aesKey);
          blobB64 = ciphertext.toString('base64');
          taskHash = '0x' + sha256Hex(ciphertext);
          wrappedKeys = {};
          for (const exec of executors) {
            try {
              wrappedKeys[exec.address.toLowerCase()] = eciesEncrypt(aesKey, exec.publicKey).toString('hex');
            } catch { /* skip malformed pubkey */ }
          }
          aesKeyHex = aesKey.toString('hex');
        }
        const { rootHash } = await api<{ rootHash: string }>('POST', '/api/v1/storage/upload', { data: blobB64 });

        const record: SpendRecord = {
          idempotencyKey,
          kind: 'post',
          stage: 'created',
          taskHash,
          rootHash,
          privacy: isPublic ? 'public' : 'private',
          aesKeyHex,
          wrappedKeys,
          publicBrief: isPublic ? instructions.slice(0, 4000) : undefined,
          verificationMode: 'auto',
          verificationCriteria: { min_length: 10, pass_threshold: 60 },
          requiredCapabilities: capabilities ?? [],
          amountWei: amountWei.toString(),
          settlement: s.mode,
          token: s.mode === 'base' ? s.usdcAddress : ZERO_TOKEN,
          durationSecs: durationSeconds ?? 86400,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        putSpend(record);

        const done = await fundAndIndex(record);
        return ok({ ...done, wrappedTo: wrappedKeys ? Object.keys(wrappedKeys).length : 0, privacy: record.privacy, hint: 'Use poll_task_result to wait for the deliverable.' });
      } catch (err) {
        const code = (err as ApiError).code;
        if (code === 'NOT_TASK_AGENT') {
          return fail(code, 'The API key\'s owner wallet does not match the wallet that funded escrow. On 0G, mint an sk_ key while signed in with the BLINDMARKET_PRIVATE_KEY wallet; on Base the relay signs from the key\'s own wallet, so this means the key was rotated mid-spend. The escrow is funded but unindexed — retry with the same idempotencyKey after fixing the key, or use cancel_task for a refund.');
        }
        return fail(code ?? 'POST_FAILED', (err as Error).message);
      }
    },
  );

  // ── poll_task_result ──────────────────────────────────────────────────────

  server.registerTool(
    'poll_task_result',
    {
      title: 'Poll for a Task Result',
      description: 'Check on a task you posted/rented (by task hash). Waits up to waitSeconds per call — loop this tool until done=true.',
      inputSchema: {
        taskHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe('The 0x task hash returned by rent_service/post_task'),
        waitSeconds: z.number().int().min(0).max(60).optional().describe('How long to wait before answering (default 30)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ taskHash, waitSeconds }) => ok(await pollPosted(taskHash, waitSeconds ?? 30)),
  );

  // ── cancel_task / claim_timeout ───────────────────────────────────────────
  //
  // The two ways escrow comes back to the poster. BlindEscrow splits them by
  // task status and they are NOT interchangeable — calling the wrong one
  // reverts on-chain:
  //
  //   Funded (0)                        → cancelTask, no deadline required
  //   Assigned/Submitted/Verified (1-3) → claimTimeout, deadline must have passed
  //   Disputed (6)                      → claimTimeout, but only once
  //                                       DISPUTE_WINDOW has elapsed
  //
  // So the quote step reads the live status first and refuses a path the
  // contract would reject, rather than letting the caller burn gas to find out.
  //
  // Both send a transaction, so both carry the same quote/confirm +
  // idempotencyKey treatment as post_task. Here the ledger's job is to stop a
  // retry from broadcasting a SECOND refund tx while the first is still
  // unconfirmed — the first would land and the second would revert.
  //
  // Chain note: like post_task, these sign with the local wallet against
  // whatever RPC it is configured for (0G by default). A task escrowed on Base
  // is resolved server-side by resolveTaskChainById, but the resulting tx still
  // goes out on the wallet's own chain — the same single-chain assumption
  // post_task already makes, not a new one introduced here.

  const STATUS_NAMES = ['Funded', 'Assigned', 'Submitted', 'Verified', 'Completed', 'Cancelled', 'Disputed'] as const;

  function statusName(status: number): string {
    return STATUS_NAMES[status] ?? `Unknown(${status})`;
  }

  interface TaskDetail {
    taskId: string;
    taskHash: string;
    status: number;
    amount: string;
    deadline: string;
    token: string;
    decimals: number;
  }

  /** Resolve a task id-or-hash to its live on-chain state. GET /tasks/:id takes
   *  either form, so callers can pass the taskHash post_task handed them. */
  async function loadTask(task: string): Promise<TaskDetail> {
    return api<TaskDetail>('GET', `/api/v1/tasks/${encodeURIComponent(task)}`);
  }

  /** Amount formatted against the task's OWN decimals — a Base task settles in
   *  USDC (6), not the wallet's native 18. */
  function refundAmount(detail: TaskDetail): string {
    return formatUnits(BigInt(detail.amount), detail.decimals ?? 18);
  }

  /** The refund has landed when the task reads Cancelled on-chain. Checking
   *  state rather than a receipt is what makes a relayed user-op decidable
   *  (there is no receipt to poll), and it is a cheap truth check for the
   *  local-signing path too. */
  async function waitCancelled(taskId: number): Promise<void> {
    for (let i = 0; i < 30; i++) {
      const detail = await loadTask(String(taskId)).catch(() => null);
      if (detail && Number(detail.status) === 5) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
    const e: ApiError = new Error(`task ${taskId} still not Cancelled on-chain after 90s — retry with the same idempotencyKey to keep waiting`);
    e.code = 'REFUND_PENDING';
    throw e;
  }

  /** Broadcast the refund and wait for it — the shared tail of both tools.
   *  Resumable: a record past 'created' waits on the tx it already saved.
   *  Same two paths as fundAndIndex: local wallet on 0G, Privy relay on Base.
   *  The backend resolves which chain holds the task and builds the tx for
   *  it; this only decides who signs. */
  async function sendRefund(record: SpendRecord): Promise<{ taskId: number; txHash: string }> {
    const s = await settlement();
    const taskId = record.taskId!;
    let { txHash } = record;

    if (record.settlement && record.settlement !== s.mode) {
      const e: ApiError = new Error(`refund ${record.idempotencyKey} started on ${record.settlement} but the backend now settles on ${s.mode} — finish it from the web app`);
      e.code = 'SETTLEMENT_CHANGED';
      throw e;
    }

    if (record.stage === 'created') {
      const route = record.kind === 'cancel' ? 'cancel' : 'timeout';
      const { unsignedTx } = await api<{ unsignedTx: { to: string; data: string } }>(
        'POST', `/api/v1/tasks/${taskId}/${route}`,
      );
      if (s.mode === 'base') {
        const { hash, isUserOp } = await relaySend(s, { to: unsignedTx.to, data: unsignedTx.data });
        // Persist BEFORE waiting, same reasoning as the 0G branch below.
        updateSpend(record.idempotencyKey, { stage: 'sent', txHash: hash, isUserOp });
        txHash = hash;
        record.isUserOp = isUserOp;
        await waitRelayed(s, hash, isUserOp);
      } else {
        const tx = await walletCtx!.wallet.sendTransaction({
          to: unsignedTx.to,
          data: unsignedTx.data,
          gasLimit: GAS_LIMIT,
        });
        // Persist the hash BEFORE waiting, same reasoning as fundAndIndex: a
        // crash mid-confirmation must resume onto THIS tx, not broadcast another.
        updateSpend(record.idempotencyKey, { stage: 'sent', txHash: tx.hash });
        txHash = tx.hash;
        await tx.wait();
      }
    } else if (txHash) {
      if (s.mode === 'base') await waitRelayed(s, txHash, record.isUserOp ?? false);
      else await walletCtx!.provider.waitForTransaction(txHash);
    } else {
      throw new Error(`Spend record ${record.idempotencyKey} is at stage '${record.stage}' with no txHash — cannot resume safely`);
    }

    await waitCancelled(taskId);
    updateSpend(record.idempotencyKey, { stage: 'confirmed' });
    return { taskId, txHash: txHash! };
  }

  /** Shared resume arm: an idempotencyKey that has already moved. The kind
   *  guard matters — the ledger is one namespace shared with rent/post, and
   *  resuming a 'post' record through the refund path would wait on the FUNDING
   *  tx and then mark that record confirmed, corrupting it. */
  async function resumeRefund(existing: SpendRecord, kind: 'cancel' | 'timeout') {
    if (existing.kind !== kind) {
      return fail('IDEMPOTENCY_KEY_REUSED', `idempotencyKey "${existing.idempotencyKey}" already belongs to a '${existing.kind}' spend (task ${existing.taskId ?? existing.taskHash}). Use a fresh key for this refund.`);
    }
    if (existing.stage === 'confirmed') {
      return ok({
        resumed: true,
        taskId: existing.taskId,
        txHash: existing.txHash,
        hint: 'Already refunded — this idempotencyKey completed earlier.',
      });
    }
    try {
      return ok({ resumed: true, ...(await sendRefund(existing)) });
    } catch (err) {
      return fail((err as ApiError).code ?? 'RESUME_FAILED', (err as Error).message);
    }
  }

  server.registerTool(
    'cancel_task',
    {
      title: 'Cancel a Task and Reclaim Escrow',
      description: 'Reclaim the escrow on a task you posted that has NOT been assigned to a worker (status Funded). Works immediately — no deadline wait. For a task that was assigned but never delivered, use claim_timeout instead. TWO-STEP quote/confirm; requires a unique idempotencyKey.',
      inputSchema: {
        task: z.string().min(1).describe('Task id (e.g. "51") or the 0x task hash returned by post_task'),
        idempotencyKey: z.string().min(8).max(128).describe('Unique key for this refund — reuse it on retries'),
        confirm: z.boolean().optional().describe('Set true (with quoteId) to send the transaction'),
        quoteId: z.string().optional().describe('From the quote step'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ task, idempotencyKey, confirm, quoteId }) => {
      const f = await requireFunding();
      if ('error' in f) return f.error;
      const { s, payFrom } = f;

      const existing = getSpend(idempotencyKey);
      if (existing) return resumeRefund(existing, 'cancel');

      let detail: TaskDetail;
      try {
        detail = await loadTask(task);
      } catch (err) {
        return fail((err as ApiError).code ?? 'TASK_LOOKUP_FAILED', (err as Error).message);
      }

      const status = Number(detail.status);
      if (status !== 0) {
        const alt = status >= 1 && status <= 3
          ? ' Use claim_timeout instead, once the deadline has passed.'
          : ' The escrow is already settled — nothing to reclaim.';
        return fail('WRONG_REFUND_PATH', `Task ${detail.taskId} is ${statusName(status)}, and cancelTask only accepts Funded tasks.${alt}`);
      }

      if (!confirm) {
        const quote = createQuote('cancel', { taskId: detail.taskId });
        return ok({
          quote: {
            action: 'cancelTask',
            taskId: detail.taskId,
            status: statusName(status),
            refund: refundAmount(detail),
            refundTo: payFrom,
            settlement: s.mode,
            quoteId: quote.quoteId,
          },
          next: `Re-call cancel_task with confirm=true, quoteId="${quote.quoteId}", and the SAME idempotencyKey to send it.`,
        });
      }
      if (!quoteId || !consumeQuote(quoteId, 'cancel')) {
        return fail('QUOTE_REQUIRED', 'Get a quote first (call without confirm), then re-call with confirm=true and the returned quoteId (quotes are single-use and expire after 10 minutes)');
      }

      try {
        const record: SpendRecord = {
          idempotencyKey,
          kind: 'cancel',
          stage: 'created',
          settlement: s.mode,
          taskId: Number(detail.taskId),
          taskHash: detail.taskHash,
          amountWei: detail.amount,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        putSpend(record);
        const done = await sendRefund(record);
        return ok({ ...done, refunded: refundAmount(detail), hint: 'Escrow returned to the posting wallet.' });
      } catch (err) {
        return fail((err as ApiError).code ?? 'CANCEL_FAILED', (err as Error).message);
      }
    },
  );

  server.registerTool(
    'claim_timeout',
    {
      title: 'Reclaim Escrow After the Deadline',
      description: 'Reclaim the escrow on a task that WAS assigned but never completed, once its deadline has passed (status Assigned, Submitted, or Verified-failed). For a task no worker ever picked up, use cancel_task instead — it needs no deadline. TWO-STEP quote/confirm; requires a unique idempotencyKey.',
      inputSchema: {
        task: z.string().min(1).describe('Task id (e.g. "51") or the 0x task hash returned by post_task'),
        idempotencyKey: z.string().min(8).max(128).describe('Unique key for this refund — reuse it on retries'),
        confirm: z.boolean().optional().describe('Set true (with quoteId) to send the transaction'),
        quoteId: z.string().optional().describe('From the quote step'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ task, idempotencyKey, confirm, quoteId }) => {
      const f = await requireFunding();
      if ('error' in f) return f.error;
      const { s, payFrom } = f;

      const existing = getSpend(idempotencyKey);
      if (existing) return resumeRefund(existing, 'timeout');

      let detail: TaskDetail;
      try {
        detail = await loadTask(task);
      } catch (err) {
        return fail((err as ApiError).code ?? 'TASK_LOOKUP_FAILED', (err as Error).message);
      }

      const status = Number(detail.status);
      if (status === 0) {
        return fail('WRONG_REFUND_PATH', `Task ${detail.taskId} is Funded — claimTimeout reverts on Funded tasks because no worker was ever assigned. Use cancel_task, which works right now with no deadline wait.`);
      }
      if (status === 4 || status === 5) {
        return fail('NOTHING_TO_REFUND', `Task ${detail.taskId} is ${statusName(status)} — the escrow is already settled.`);
      }

      const deadline = BigInt(detail.deadline);
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (now < deadline) {
        return fail('DEADLINE_NOT_REACHED', `Task ${detail.taskId} is still live until ${new Date(Number(deadline) * 1000).toISOString()} — claimTimeout reverts before then.`);
      }

      if (!confirm) {
        const quote = createQuote('timeout', { taskId: detail.taskId });
        return ok({
          quote: {
            action: 'claimTimeout',
            taskId: detail.taskId,
            status: statusName(status),
            deadlinePassed: new Date(Number(deadline) * 1000).toISOString(),
            refund: refundAmount(detail),
            refundTo: payFrom,
            settlement: s.mode,
            // DISPUTE_WINDOW is enforced on-chain and disputedAt is not exposed
            // here, so a disputed task can still revert after this quote.
            ...(status === 6 ? { note: 'Task is Disputed — this only succeeds once the on-chain DISPUTE_WINDOW has elapsed since the dispute was raised, otherwise it reverts with DisputeWindowActive.' } : {}),
            quoteId: quote.quoteId,
          },
          next: `Re-call claim_timeout with confirm=true, quoteId="${quote.quoteId}", and the SAME idempotencyKey to send it.`,
        });
      }
      if (!quoteId || !consumeQuote(quoteId, 'timeout')) {
        return fail('QUOTE_REQUIRED', 'Get a quote first (call without confirm), then re-call with confirm=true and the returned quoteId (quotes are single-use and expire after 10 minutes)');
      }

      try {
        const record: SpendRecord = {
          idempotencyKey,
          kind: 'timeout',
          stage: 'created',
          settlement: s.mode,
          taskId: Number(detail.taskId),
          taskHash: detail.taskHash,
          amountWei: detail.amount,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        putSpend(record);
        const done = await sendRefund(record);
        return ok({ ...done, refunded: refundAmount(detail), hint: 'Escrow returned to the posting wallet.' });
      } catch (err) {
        return fail((err as ApiError).code ?? 'TIMEOUT_CLAIM_FAILED', (err as Error).message);
      }
    },
  );

  return { settlement };
}
