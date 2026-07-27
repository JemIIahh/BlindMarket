import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatEther, parseEther } from 'ethers';
import type { McpConfig } from './config.js';
import type { WalletCtx } from './wallet.js';
import { aesEncrypt, eciesEncrypt, generateAesKey, sha256Hex } from './crypto.js';
import { createQuote, consumeQuote, getSpend, putSpend, updateSpend, type SpendRecord } from './state.js';

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

export function registerRentTools(server: McpServer, cfg: McpConfig, walletCtx: WalletCtx | null): void {
  async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
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

  function requireWallet(): WalletCtx | { error: ReturnType<typeof fail> } {
    if (!walletCtx) {
      return { error: fail('NO_WALLET', 'Spending tools need a local funding wallet — set BLINDMARKET_PRIVATE_KEY (see wallet_status)') };
    }
    return walletCtx;
  }

  /** Fund escrow + index — the shared tail of rent_service and post_task.
   *  Resumable at every stage via the spend ledger. */
  async function fundAndIndex(record: SpendRecord): Promise<{ taskHash: string; txHash: string }> {
    const ctx = walletCtx!;
    let { txHash } = record;

    if (record.stage === 'created') {
      const { unsignedTx } = await api('POST', '/api/v1/tasks', {
        taskHash: record.taskHash,
        token: ZERO_TOKEN,
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
      const tx = await ctx.wallet.sendTransaction({
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

    // stage 'funded' (fresh or resumed): index against the verified receipt.
    // /a2a/tasks/index itself polls for the receipt server-side.
    await api('POST', '/api/v1/a2a/tasks/index', {
      txHash,
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
      description: 'Hire a listed agent service for one call: encrypts your prompt locally (unless privacy=public), funds escrow from your local wallet, and pins the task to the provider agent. TWO-STEP: first call returns a price quote + quoteId; re-call with confirm=true and that quoteId to actually spend. Requires a unique idempotencyKey (safe to retry with the same key — it resumes, never double-pays).',
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
      const w = requireWallet();
      if ('error' in w) return w.error;

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

      if (!confirm) {
        const balance = await w.provider.getBalance(w.wallet.address).catch(() => null);
        const quote = createQuote('rent', { serviceId, price0G: formatEther(service.price_raw) });
        return ok({
          quote: {
            service: { id: service.id, name: service.name, agent: service.agent_address },
            price0G: formatEther(service.price_raw),
            payFrom: w.wallet.address,
            walletBalance0G: balance === null ? null : formatEther(balance),
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
          return fail(code, 'The API key\'s owner wallet does not match the funding wallet (BLINDMARKET_PRIVATE_KEY). Mint an sk_ key while signed in with the funding wallet. The escrow is funded but unindexed — retry with the same idempotencyKey after fixing the key, or cancel on-chain for a refund.');
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
      description: 'Post a task any matching agent can pick up: encrypts the brief locally and wraps its key to every registered matching executor (or posts it in plaintext with privacy=public), then funds escrow from your local wallet. TWO-STEP quote/confirm like rent_service; requires a unique idempotencyKey.',
      inputSchema: {
        instructions: z.string().min(1).max(100_000).describe('The task brief'),
        amount0G: z.string().regex(/^\d+(\.\d+)?$/).describe('Escrow amount in 0G (e.g. "2.5") — paid to the worker (90%) on verified completion'),
        idempotencyKey: z.string().min(8).max(128).describe('Unique key for this spend — reuse it on retries'),
        capabilities: z.array(z.string()).optional().describe('Optional capability tags to route to matching agents first; empty = every agent'),
        durationSeconds: z.number().int().min(3600).max(90 * 24 * 3600).optional().describe('Deadline seconds from now (default 86400 = 24h)'),
        privacy: z.enum(['private', 'public']).optional().describe("Default 'private': encrypted brief. 'public': plaintext brief + public result — readable/workable by any agent with zero crypto"),
        confirm: z.boolean().optional().describe('Set true (with quoteId) to execute the spend'),
        quoteId: z.string().optional().describe('From the quote step'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ instructions, amount0G, idempotencyKey, capabilities, durationSeconds, privacy, confirm, quoteId }) => {
      const w = requireWallet();
      if ('error' in w) return w.error;

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
      const amountWei = parseEther(amount0G);

      if (!confirm) {
        const balance = await w.provider.getBalance(w.wallet.address).catch(() => null);
        const quote = createQuote('post', { amount0G });
        return ok({
          quote: {
            escrow0G: amount0G,
            payFrom: w.wallet.address,
            walletBalance0G: balance === null ? null : formatEther(balance),
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
          return fail(code, 'The API key\'s owner wallet does not match the funding wallet (BLINDMARKET_PRIVATE_KEY). Mint an sk_ key while signed in with the funding wallet. The escrow is funded but unindexed — retry with the same idempotencyKey after fixing the key, or cancel on-chain for a refund.');
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
}
