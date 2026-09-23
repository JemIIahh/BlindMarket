import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Contract, Interface, JsonRpcProvider, formatUnits, parseUnits } from 'ethers';
import type { McpConfig } from './config.js';
import type { WalletCtx } from './wallet.js';
import { aesDecrypt, aesEncrypt, derivePublicKeyHex, eciesDecrypt, eciesEncrypt, generateAesKey, sha256Hex } from './crypto.js';
import { createQuote, consumeQuote, getSpend, putSpend, updateSpend, type SpendRecord } from './state.js';
import { createSettlementResolver, type RelaySettlement, type Settlement } from './settlement.js';

// Read-only view of BlindEscrow.getTask, for reading a task's state directly
// from the chain that holds it. Field order matches contracts/BlindEscrow.sol;
// a post-#38 deployment appends disputedAt, which ABI decoding ignores.
const ESCROW_READ_ABI = [
  'function getTask(uint256) view returns (tuple(address agent,address worker,address token,uint256 amount,bytes32 taskHash,bytes32 evidenceHash,uint8 status,string category,string locationZone,uint256 createdAt,uint256 deadline,uint8 submissionAttempts))',
];

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
// Auto-verify releases the payment, so the bar can't be "one character" — but
// 40 made a correct 30-character URL unpayable. 20 is the platform floor
// (DEFAULT_MIN_CONTENT_CHARS in the backend's autoVerify, where min_length is a
// hard floor). Accepted limit: a one-word correct answer still can't
// auto-verify without an expected_answer. MUST match the web app's
// RENTAL_VERIFICATION_CRITERIA (frontend/src/components/UseServiceModal.tsx and
// UseFromAgentModal.tsx) so a rental is judged the same whichever client paid
// for it. The index route also rejects 'auto' with no real criterion (400
// AUTO_CRITERIA_REQUIRED).
const RENTAL_VERIFICATION_CRITERIA = { min_length: 20 };

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
    // Explicit, named timeout. Node's fetch otherwise fails after ~5 minutes
    // with a bare "fetch failed" — which is what post_task reported, twice,
    // for posts that had already landed on-chain while /a2a/tasks/index sat
    // behind a dead Redis socket server-side. 120s is above the slowest
    // healthy call (index polls for a receipt for ~1 min) and well below the
    // point where a caller assumes the money is lost.
    let res: Response;
    try {
      res = await fetch(`${cfg.apiBase}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.apiKey },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      // Node's fetch reports every socket-level failure as a bare "fetch
      // failed" and hides the real reason in `cause` (ECONNRESET, socket
      // hang up, ECONNREFUSED…). Surface it: "fetch failed" alone cost a
      // debugging session that ended in "the server restarted mid-request".
      const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
      const detail = cause?.code ?? cause?.message ?? (e as Error)?.message ?? String(e);
      const err: ApiError = new Error(
        (e as Error)?.name === 'TimeoutError'
          ? `${path} did not answer within 120s. The backend may be stalled (check its Redis connection); if this was a spend, retry with the SAME idempotencyKey — it resumes, never double-pays.`
          : `${path} unreachable (${detail}). If the backend restarted mid-request and this was a spend, retry with the SAME idempotencyKey — it resumes from the last persisted stage.`,
      );
      err.code = (e as Error)?.name === 'TimeoutError' ? 'BACKEND_TIMEOUT' : 'BACKEND_UNREACHABLE';
      throw err;
    }
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
   *  On a relay chain (Base) nothing signs locally — the relay signs from the
   *  API key's owner wallet — so a missing BLINDMARKET_PRIVATE_KEY is not an
   *  error there. */
  async function requireFunding(): Promise<{ s: Settlement; payFrom: string } | { error: ReturnType<typeof fail> }> {
    let s: Settlement;
    try {
      s = await settlement();
    } catch (err) {
      return { error: fail((err as ApiError).code ?? 'SETTLEMENT_UNKNOWN', (err as Error).message) };
    }
    if (s.payment === 'relay-erc20') return { s, payFrom: s.payFrom };
    if (!walletCtx) {
      return { error: fail('NO_WALLET', 'Spending on 0G needs a local funding wallet — set BLINDMARKET_PRIVATE_KEY (see wallet_status)') };
    }
    // The escrow address is compared before every send, but not the chain:
    // a testnet backend's escrow address, paid on the mainnet RPC, is some
    // other account there. A backend that names its 0G chain id settles it.
    if (s.chainId !== undefined && walletCtx.chainId !== s.chainId) {
      return {
        error: fail(
          'CHAIN_MISMATCH',
          `The backend settles 0G on chain ${s.chainId}, but BLINDMARKET_PRIVATE_KEY signs on chain ${walletCtx.chainId} (BLINDMARKET_RPC_URL / BLINDMARKET_CHAIN_ID). Native value sent there would not reach this backend's escrow. Point both at chain ${s.chainId}.`,
        ),
      };
    }
    return { s, payFrom: walletCtx.wallet.address };
  }

  /** A new escrow is funded where POST /api/v1/tasks builds: the backend's
   *  posting chain. A process forced onto another chain (to finish or refund
   *  tasks already there) cannot post. Unknown on an older backend. */
  function notPostingChain(s: Settlement): ApiError | null {
    if (s.postingChain === undefined || s.mode === s.postingChain) return null;
    const e: ApiError = new Error(
      `This process settles on ${s.mode} (BLINDMARKET_SETTLEMENT), but the backend posts new tasks on ${s.postingChain}, so a new escrow can only be funded there. Unset BLINDMARKET_SETTLEMENT (or set it to ${s.postingChain}) to post; ${s.mode} stays usable for tasks already on it.`,
    );
    e.code = 'NOT_POSTING_CHAIN';
    return e;
  }

  const ERC20 = new Interface([
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
  ]);
  function settlementToken(s: RelaySettlement): Contract {
    return new Contract(s.token.address, ERC20, s.provider);
  }

  /** Spendable balance of whoever pays, in the settlement token's units. */
  async function payFromBalance(s: Settlement, payFrom: string): Promise<string | null> {
    try {
      const raw: bigint = s.payment === 'relay-erc20'
        ? await settlementToken(s).balanceOf(payFrom)
        : await walletCtx!.provider.getBalance(payFrom);
      return formatUnits(raw, s.decimals);
    } catch {
      return null;
    }
  }

  /** The backend builds every unsigned tx for whichever chain it thinks holds
   *  the task, and the tx carries no chainId. Discovery is only a hint about
   *  that chain (see settlement.ts). So before broadcasting, check the tx
   *  targets the escrow THIS mode expects — otherwise native value goes to a
   *  relay chain's address on the 0G RPC, or a 0G refund is relayed onto
   *  another chain. A mismatch also drops the cached mode so the next call
   *  re-asks. */
  async function verifyTarget(s: Settlement, to: string, what: string): Promise<void> {
    const target = String(to).toLowerCase();
    const expected = s.escrowAddress;
    if (expected) {
      if (target === expected.toLowerCase()) return;
      settlement.invalidate();
      const e: ApiError = new Error(
        `backend built ${what} for ${to} but this process is in ${s.mode} mode expecting escrow ${expected}. ` +
        (s.escrowChains
          ? `This task is escrowed on another chain — set BLINDMARKET_SETTLEMENT to the chain that holds it (this backend has escrows on ${s.escrowChains.join(', ')}; 0G needs a local key), or use the web app.`
          : s.payment === 'relay-erc20'
            ? 'This task is escrowed on 0G — handle it with BLINDMARKET_SETTLEMENT=0g and a local key, or from the web app.'
            : 'The backend is building Base transactions — re-run and discovery will re-check, or set BLINDMARKET_SETTLEMENT=base.'),
      );
      e.code = 'ESCROW_MISMATCH';
      throw e;
    }
    // 0G with no escrow address to compare against (forced 0g, or a backend
    // that doesn't report one). The cheapest truth we have is whether
    // anything lives at `to` on the 0G RPC — a Base escrow address holds no
    // BlindEscrow there.
    const code = await walletCtx!.provider.getCode(to).catch(() => '0x');
    if (code === '0x') {
      settlement.invalidate();
      const e: ApiError = new Error(`backend built ${what} for ${to}, which holds no contract on the 0G RPC — it is almost certainly a Base transaction. Set BLINDMARKET_SETTLEMENT=base.`);
      e.code = 'ESCROW_MISMATCH';
      throw e;
    }
  }

  /** Hand a transaction to the backend relay: Privy signs it from payFrom with
   *  gas paid in USDC. Same wire shape as frontend/src/lib/txSigner.ts. */
  /** How the relay ended up paying for gas — reported by the backend, never
   *  inferred here. 'user-pays' is the product path (USDC); the other two are
   *  fallbacks the backend negotiated because Privy refused that rung. */
  type GasMode = 'user-pays' | 'app-pays' | 'wallet-pays';

  async function relaySend(s: RelaySettlement, tx: { to: string; data: string; value?: bigint }): Promise<{ hash: string; isUserOp: boolean; gas: GasMode }> {
    // gas:'auto' asks the backend to negotiate: user-pays (USDC) → app-pays →
    // wallet-pays, advancing only on Privy's exact refusal for each rung. The
    // negotiation lives server-side on purpose — that is the one place that
    // sees Privy's raw errors, and it is shared with the web app, so both
    // clients behave identically. An earlier version did the fallback here,
    // and it skipped app-pays entirely: the wallet kept paying its own ETH
    // even after sponsorship was switched on in the Privy dashboard.
    const r = await api<{ hash: string; isUserOp?: boolean; gas?: GasMode }>('POST', '/api/v1/tx/relay-tx', {
      walletAddress: s.payFrom,
      to: tx.to,
      data: tx.data,
      value: tx.value === undefined ? undefined : String(tx.value),
      chain: s.relayChain,
      asset: 'usdc',
      gas: 'auto',
    });

    if (!r?.hash) {
      const e: ApiError = new Error('relay-tx returned no hash');
      e.code = 'RELAY_NO_HASH';
      throw e;
    }
    // A backend older than the `gas` field answers without it. That backend
    // also has no negotiation, so the only way it succeeds is the explicit
    // default it applies to this body: user-pays.
    return { hash: r.hash, isUserOp: r.isUserOp === true, gas: r.gas ?? 'user-pays' };
  }

  /** Wait for a relayed tx to land. A plain hash can be polled for its receipt;
   *  a user-op hash cannot (getTransactionReceipt is always null for it), so
   *  that case returns at once and the caller confirms by on-chain STATE —
   *  see ensureAllowance and waitCancelled. */
  async function waitRelayed(s: RelaySettlement, hash: string, isUserOp: boolean): Promise<void> {
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

  /** Relay chains only: createTask pulls the ERC-20 via transferFrom, so the
   *  escrow needs an allowance first. Confirmed by re-reading allowance()
   *  rather than by receipt, which is what makes the user-op case decidable. */
  async function ensureAllowance(s: RelaySettlement, record: SpendRecord): Promise<void> {
    const need = BigInt(record.amountWei!);
    const token = settlementToken(s);
    if ((await token.allowance(s.payFrom, s.escrowAddress)) >= need) return;
    const approve = async () => {
      const data = ERC20.encodeFunctionData('approve', [s.escrowAddress, need]);
      const { hash } = await relaySend(s, { to: s.token.address, data });
      // Persist BEFORE waiting: a crash here must resume into the poll below.
      updateSpend(record.idempotencyKey, { stage: 'approved', approveTxHash: hash });
      record.stage = 'approved';
      record.approveTxHash = hash;
    };
    const settled = async () => {
      for (let i = 0; i < 30; i++) {
        if ((await token.allowance(s.payFrom, s.escrowAddress)) >= need) return true;
        await new Promise((r) => setTimeout(r, 3000));
      }
      return false;
    };

    if (record.stage === 'created') {
      await approve();
      if (await settled()) return;
    }
    // Resumed at 'approved' (or the fresh approve never landed): the earlier
    // approve was dropped or reverted. Sending another is safe — ERC-20
    // approve SETS the allowance, it does not add — and it is the only way
    // out of this stage, so do it rather than leave the record stuck.
    if (await settled()) return;
    await approve();
    if (await settled()) return;
    const e: ApiError = new Error(`${s.symbol} allowance still below ${formatUnits(need, s.decimals)} after two approves (last ${record.approveTxHash}) — check the relay wallet's ${s.symbol} balance and retry with the same idempotencyKey`);
    e.code = 'APPROVE_PENDING';
    throw e;
  }

  /** Fund escrow + index — the shared tail of rent_service and post_task.
   *  Resumable at every stage via the spend ledger.
   *
   *  Two funding paths, chosen by `payment`:
   *    local-native — native 0G from the local wallet, signed and sent here.
   *    relay-erc20  — the ERC-20 (USDC on Base) via transferFrom: approve
   *           first (ensureAllowance), then the createTask the backend built,
   *           both through the Privy relay with no local signing at all. The
   *           backend picks the escrow; we only check it is the one we approved. */
  async function fundAndIndex(record: SpendRecord): Promise<{ taskHash: string; txHash: string; gas?: GasMode }> {
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
      const refused = notPostingChain(s);
      if (refused) throw refused;
      if (s.payment === 'relay-erc20') await ensureAllowance(s, record);

      const { unsignedTx, chain: builtChain, chainId: builtChainId } = await api('POST', '/api/v1/tasks', {
        taskHash: record.taskHash,
        token: s.payment === 'relay-erc20' ? s.token.address : ZERO_TOKEN,
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

      // Either branch: the tx must target the escrow this mode expects. On a
      // relay chain that is also the escrow the allowance above was granted to.
      // A chain-aware backend also names the chain it built for (older ones
      // return only the tx, and are checked by address alone, as before).
      if (s.postingChain !== undefined && (
        (builtChain !== undefined && builtChain !== s.mode) ||
        (builtChainId !== undefined && s.chainId !== undefined && Number(builtChainId) !== s.chainId)
      )) {
        settlement.invalidate();
        const e: ApiError = new Error(`backend built createTask for ${builtChain ?? '?'} (chain ${builtChainId ?? '?'}) but this process settles on ${s.mode} (chain ${s.chainId ?? '?'}) — re-run and discovery will re-check`);
        e.code = 'ESCROW_MISMATCH';
        throw e;
      }
      await verifyTarget(s, unsignedTx.to, 'createTask');

      if (s.payment === 'relay-erc20') {
        const { hash, isUserOp, gas } = await relaySend(s, { to: unsignedTx.to, data: unsignedTx.data });
        // Persist BEFORE waiting, same reasoning as the 0G branch below.
        updateSpend(record.idempotencyKey, { stage: 'funded', txHash: hash, isUserOp, gas });
        record.gas = gas;
        txHash = hash;
        record.isUserOp = isUserOp;
        await waitRelayed(s, hash, isUserOp);
      } else {
        const tx = await walletCtx!.wallet.sendTransaction({
          to: unsignedTx.to,
          data: unsignedTx.data,
          value: BigInt(record.amountWei!),
          gasLimit: GAS_LIMIT,
          // ethers refuses to send when its provider is on another chain.
          ...(s.chainId !== undefined ? { chainId: s.chainId } : {}),
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
    return { taskHash: record.taskHash!, txHash: txHash!, gas: record.gas };
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

      const offPosting = notPostingChain(s);
      if (offPosting) return fail(offPosting.code!, offPosting.message);

      const service = await api<any>('GET', `/api/v1/marketplace/services/${serviceId}`);
      const isPublic = privacy === 'public';
      if (!isPublic && !service.agent_public_key) {
        return fail('NO_AGENT_PUBKEY', 'This service\'s agent has no encryption public key — only privacy=public calls are possible');
      }

      // price_raw is stored in the settlement token's base units (the backend
      // compares it against the on-chain amount as-is), so it is 6-decimal
      // USDC on Base and 18-decimal 0G otherwise — format it that way.
      const priceRaw = BigInt(service.price_raw);
      // A service priced in 18-decimal units on a 6-decimal chain would quote
      // as a trillion USDC and relay an approve for it before createTask
      // failed. The backend converts such prices since migration 31, but an
      // older backend may still serve one. 1,000,000 tokens per call is far
      // above any real listing — refuse.
      if (s.decimals < 18 && priceRaw > 1_000_000n * 10n ** BigInt(s.decimals)) {
        return fail('PRICE_UNITS_SUSPECT', `service ${serviceId} lists price_raw=${priceRaw} which is ${formatUnits(priceRaw, s.decimals)} ${s.symbol} — this looks like an 18-decimal 0G price on a ${s.symbol} chain. Not sending. Re-list the service in ${s.symbol} base units.`);
      }
      const price = formatUnits(priceRaw, s.decimals);

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
          verificationCriteria: RENTAL_VERIFICATION_CRITERIA,
          requiredCapabilities: [],
          amountWei: String(service.price_raw),
          settlement: s.mode,
          token: s.payment === 'relay-erc20' ? s.token.address : ZERO_TOKEN,
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

      const offPosting = notPostingChain(s);
      if (offPosting) return fail(offPosting.code!, offPosting.message);

      const isPublic = privacy === 'public';
      const amountStr = amount ?? amount0G;
      if (!amountStr) {
        return fail('AMOUNT_REQUIRED', `Pass \`amount\` — the escrow in ${s.symbol} (e.g. "2.5").`);
      }
      let amountWei: bigint;
      try {
        amountWei = parseUnits(amountStr, s.decimals);
      } catch {
        return fail('AMOUNT_INVALID', `"${amountStr}" is not a valid ${s.symbol} amount — at most ${s.decimals} decimal places.`);
      }

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
          token: s.payment === 'relay-erc20' ? s.token.address : ZERO_TOKEN,
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
  // Chain note: the backend resolves which chain holds the task
  // (resolveTaskChainById) and builds the unsigned tx for it; this side only
  // decides who signs — the local wallet on 0G, the Privy relay on a relay
  // chain (Base) — and
  // verifies the tx targets the escrow that mode expects before sending
  // (verifyTarget). Task state is read from the chain the mode names, not
  // from GET /tasks/:id, which is bound to the 0G escrow.

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
    /** On-chain resubmission counter. The contract allows a fresh
     *  submitEvidence from Verified(3) only while this is below 3. */
    submissionAttempts?: number;
  }

  /** Resolve a task id-or-hash to its live on-chain state.
   *
   *  GET /api/v1/tasks/:id accepts either form — but older backends read the
   *  0G escrow only (escrowService.getTask was bound to the 0G contract), so
   *  on a relay chain its struct is for whatever 0G task happens to share the
   *  id. On a relay chain we use it just to turn a hash into an id, then read
   *  the struct from that chain's escrow ourselves over the read-only
   *  provider. */
  async function loadTask(s: Settlement, task: string): Promise<TaskDetail> {
    /** The backend said the task is on another chain: its id means a different task here. */
    const onOtherChain = (taskId: string, chain: string): ApiError => {
      const label = s.chain === 'base' ? 'Base' : s.chain;
      const e: ApiError = new Error(`task ${taskId} is a ${chain} task, and this process settles on ${label} — handle it with BLINDMARKET_SETTLEMENT=${chain}`);
      // The code names the chain; on Base it is the TASK_NOT_ON_BASE it always was.
      e.code = `TASK_NOT_ON_${s.chain.toUpperCase().replace(/-/g, '_')}`;
      return e;
    };

    if (s.payment !== 'relay-erc20') {
      const detail = await api<TaskDetail & { chain?: string }>('GET', `/api/v1/tasks/${encodeURIComponent(task)}`);
      if (detail.chain && detail.chain !== s.chain) throw onOtherChain(detail.taskId, detail.chain);
      return detail;
    }

    // Relay chain: the escrow is the authority, and we can read it directly. Only ask
    // the backend when we need a hash resolved to an id — that endpoint makes
    // several Redis round trips and is the slowest thing in this path, so a
    // numeric id must not pay for it.
    let taskId: string;
    let backendChain: string | undefined;
    if (/^\d+$/.test(task)) {
      taskId = task;
    } else {
      const viaBackend = await api<TaskDetail & { chain?: string }>('GET', `/api/v1/tasks/${encodeURIComponent(task)}`);
      taskId = viaBackend.taskId;
      backendChain = viaBackend.chain;
      // The same id can exist on this chain's escrow too (another task of the
      // same poster): reading it would act on the wrong task.
      if (backendChain && backendChain !== s.chain) throw onOtherChain(taskId, backendChain);
    }

    const escrow = new Contract(s.escrowAddress, ESCROW_READ_ABI, s.provider);
    const t = await escrow.getTask(BigInt(taskId));
    if (String(t.agent).toLowerCase() === ZERO_TOKEN) {
      const label = s.chain === 'base' ? 'Base' : s.chain;
      const hint = s.escrowChains
          ? `it is on another chain; set BLINDMARKET_SETTLEMENT to the one that holds it (this backend has escrows on ${s.escrowChains.join(', ')})`
          : 'it is probably a 0G task; handle it with BLINDMARKET_SETTLEMENT=0g';
      const e: ApiError = new Error(`task ${taskId} does not exist on the ${label} escrow ${s.escrowAddress} — ${hint}`);
      // The code names the chain; on Base it is the TASK_NOT_ON_BASE it always was.
      e.code = `TASK_NOT_ON_${s.chain.toUpperCase().replace(/-/g, '_')}`;
      throw e;
    }
    return {
      taskId,
      taskHash: String(t.taskHash),
      status: Number(t.status),
      amount: String(t.amount),
      deadline: String(t.deadline),
      token: String(t.token),
      submissionAttempts: Number(t.submissionAttempts),
      decimals: s.decimals,
    };
  }

  /** Amount formatted against the task's OWN decimals — a relay-chain task
   *  settles in its ERC-20 (USDC: 6), not the wallet's native 18. */
  function refundAmount(detail: TaskDetail): string {
    return formatUnits(BigInt(detail.amount), detail.decimals ?? 18);
  }

  /** The refund has landed when the task reads Cancelled on-chain. Checking
   *  state rather than a receipt is what makes a relayed user-op decidable
   *  (there is no receipt to poll), and it is a cheap truth check for the
   *  local-signing path too. */
  async function waitCancelled(s: Settlement, taskId: number): Promise<void> {
    for (let i = 0; i < 30; i++) {
      const detail = await loadTask(s, String(taskId)).catch(() => null);
      if (detail && Number(detail.status) === 5) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
    const e: ApiError = new Error(`task ${taskId} still not Cancelled on-chain after 90s — retry with the same idempotencyKey to keep waiting`);
    e.code = 'REFUND_PENDING';
    throw e;
  }

  /** Broadcast the refund and wait for it — the shared tail of both tools.
   *  Resumable: a record past 'created' waits on the tx it already saved.
   *  Same two paths as fundAndIndex: local wallet on 0G, Privy relay on a relay chain.
   *  The backend resolves which chain holds the task and builds the tx for
   *  it; this only decides who signs. */
  async function sendRefund(record: SpendRecord): Promise<{ taskId: number; txHash: string; gas?: GasMode }> {
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
      // The backend resolves the chain that holds the task and builds for it;
      // the tx carries no chainId. If that chain is not the one this mode
      // broadcasts on, stop here — relaying a 0G refund onto another chain
      // lands on an address with no escrow and burns the gas.
      await verifyTarget(s, unsignedTx.to, `${route}Task`);

      if (s.payment === 'relay-erc20') {
        const { hash, isUserOp, gas } = await relaySend(s, { to: unsignedTx.to, data: unsignedTx.data });
        // Persist BEFORE waiting, same reasoning as the 0G branch below.
        updateSpend(record.idempotencyKey, { stage: 'sent', txHash: hash, isUserOp, gas });
        record.gas = gas;
        txHash = hash;
        record.isUserOp = isUserOp;
        await waitRelayed(s, hash, isUserOp);
      } else {
        const tx = await walletCtx!.wallet.sendTransaction({
          to: unsignedTx.to,
          data: unsignedTx.data,
          gasLimit: GAS_LIMIT,
          ...(s.chainId !== undefined ? { chainId: s.chainId } : {}),
        });
        // Persist the hash BEFORE waiting, same reasoning as fundAndIndex: a
        // crash mid-confirmation must resume onto THIS tx, not broadcast another.
        updateSpend(record.idempotencyKey, { stage: 'sent', txHash: tx.hash });
        txHash = tx.hash;
        await tx.wait();
      }
    } else if (txHash) {
      if (s.payment === 'relay-erc20') await waitRelayed(s, txHash, record.isUserOp ?? false);
      else await walletCtx!.provider.waitForTransaction(txHash);
    } else {
      throw new Error(`Spend record ${record.idempotencyKey} is at stage '${record.stage}' with no txHash — cannot resume safely`);
    }

    await waitCancelled(s, taskId);
    updateSpend(record.idempotencyKey, { stage: 'confirmed' });
    return { taskId, txHash: txHash!, gas: record.gas };
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
        detail = await loadTask(s, task);
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
        detail = await loadTask(s, task);
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


  // ── Executor side (Base) ─────────────────────────────────────────────────
  //
  // accept_task (tools.ts) already assigns you on-chain: the backend awaits
  // marketplaceAssign inside POST /accept. What was missing is everything
  // after: the worker must sign submitEvidence itself (onlyWorker), and the
  // platform worker (backend/agents/worker.js) only carries a 0G signer, so
  // a Base task could be accepted but never delivered. These two tools close
  // that gap for an MCP executor whose wallet is a Privy relay wallet — no
  // local key, gas negotiated by the backend like every other relayed send.

  /** Poll the escrow until the task reads `want`, or give up. */
  async function waitStatus(s: Settlement, taskId: string, want: number, label: string): Promise<number> {
    let last = -1;
    for (let i = 0; i < 30; i++) {
      last = Number((await loadTask(s, taskId)).status);
      if (last === want) return last;
      await new Promise((r) => setTimeout(r, 3000));
    }
    const e: ApiError = new Error(`task ${taskId} still reads ${statusName(last)} after 90s waiting for ${label} — re-call complete_task to resume from the chain's state`);
    e.code = 'STATE_PENDING';
    throw e;
  }

  server.registerTool(
    'fetch_brief',
    {
      title: 'Fetch a Task Brief',
      description: "Download a task's brief by rootHash (accept_task returns it). Public briefs come back as text. For a PRIVATE brief pass the wrappedKey accept_task returned: it is decrypted with BLINDMARKET_PRIVATE_KEY, which must be the key whose public half you registered (wallet_status shows it as executorPublicKey).",
      inputSchema: {
        rootHash: z.string().min(32).max(80).describe('rootHash from accept_task or list_open_tasks'),
        wrappedKey: z.string().optional().describe('ECIES-wrapped AES key from accept_task (hex, no 0x). Required for private briefs.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ rootHash, wrappedKey }) => {
      try {
        // Buffer.from(x, 'hex') stops silently at the first bad char, so a
        // pasted "0x…" or a truncated blob would otherwise surface as
        // WRONG_KEY after a storage round-trip. Validate first.
        // ECIES blob = 65-byte ephemeral pubkey + 12 IV + 16 tag + ciphertext.
        const keyHex = wrappedKey?.replace(/^0x/i, '');
        if (keyHex !== undefined && (!/^[0-9a-fA-F]+$/.test(keyHex) || keyHex.length % 2 !== 0 || keyHex.length < (65 + 12 + 16 + 1) * 2)) {
          return fail('INVALID_WRAPPED_KEY', 'wrappedKey must be the full hex ECIES blob from accept_task (even length, at least 94 bytes). Pass it exactly as returned.');
        }
        const { blob } = await api<{ blob: string }>('GET', `/api/v1/storage/${encodeURIComponent(rootHash)}`);
        const buf = Buffer.from(blob, 'base64');
        if (keyHex !== undefined) {
          if (!walletCtx) {
            return fail('NO_WALLET', 'A private brief is decrypted with BLINDMARKET_PRIVATE_KEY — set it to the key whose public half you registered as executor.');
          }
          let aesKey: Buffer;
          try {
            aesKey = eciesDecrypt(Buffer.from(keyHex, 'hex'), walletCtx.wallet.privateKey);
          } catch (e) {
            return fail('WRONG_KEY', `Could not unwrap the brief key with the local wallet ${walletCtx.wallet.address}: ${(e as Error).message}. The poster wrapped it to the pubkey on your executor registration — wallet_status shows the pubkey this process derives; they must match.`);
          }
          let brief: string;
          try {
            brief = aesDecrypt(buf, aesKey).toString('utf8');
          } catch (e) {
            // The key unwrapped fine, so the BLOB is the problem: a public
            // (plaintext) brief passed with a wrappedKey, or the wrong rootHash.
            return fail('BRIEF_DECRYPT_FAILED', `The wrapped key unwrapped, but the blob at ${rootHash} did not decrypt with it: ${(e as Error).message}. If the task is public, call fetch_brief without wrappedKey; otherwise check the rootHash came from the same accept_task response.`);
          }
          return ok({ rootHash, bytes: buf.length, brief, decrypted: true });
        }
        const text = buf.toString('utf8');
        if (text.includes('�')) {
          return fail('ENCRYPTED_BRIEF', 'This brief is encrypted (private task). Re-call fetch_brief with the wrappedKey from accept_task.');
        }
        return ok({ rootHash, bytes: buf.length, brief: text });
      } catch (err) {
        return fail((err as ApiError).code ?? 'BRIEF_FETCH_FAILED', (err as Error).message);
      }
    },
  );

  server.registerTool(
    'complete_task',
    {
      title: 'Deliver a Task Result and Settle',
      description: 'Executor side, after accept_task: submits your result, sends submitEvidence from YOUR wallet (Base: through the backend relay, gas in USDC; 0G: signed locally with BLINDMARKET_PRIVATE_KEY), then asks the backend to verify and release the escrow to you. This is the ONLY delivery tool — there is no separate submit step. If an earlier call died between submitting and broadcasting (task stuck "submitted" off-chain, Assigned on-chain), re-calling heals it via the /rebroadcast endpoint. If the last verification FAILED, calling this again resubmits — the contract allows up to 3 attempts before the deadline. Safe to re-call: it resumes from whatever stage the escrow shows.',
      inputSchema: {
        task: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe('The 0x task hash — A2A tasks are addressed by hash, not by numeric id'),
        output: z.string().min(1).max(200_000).describe('Your result. Verification judges this text (auto mode scores it against the poster\'s criteria).'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ task, output }) => {
      const f = await requireFunding();
      if ('error' in f) return f.error;
      const { s, payFrom } = f;
      // requireFunding returns an error on 0G without a wallet, so walletCtx is
      // non-null whenever s.payment is 'local-native' from here on.

      let detail: TaskDetail;
      try {
        detail = await loadTask(s, task);
      } catch (err) {
        return fail((err as ApiError).code ?? 'TASK_LOOKUP_FAILED', (err as Error).message);
      }
      // 0 Funded · 1 Assigned · 2 Submitted · 3 Verified · 4 Completed · 5 Cancelled · 6 Disputed
      let status = Number(detail.status);
      if (status === 0) {
        return fail('NOT_ASSIGNED', `Task ${detail.taskId} is still Funded — call accept_task("${task}") first; the backend assigns you on-chain as part of accept.`);
      }
      // Verified(3) = the last round FAILED and the escrow is still locked. The
      // contract lets the worker submitEvidence again from here, up to
      // MAX_SUBMISSION_ATTEMPTS (3) and before the deadline. The backend's
      // /submit enforces all three on-chain gates; check them here too so the
      // caller gets the reason instead of a relayed revert.
      const isRetry = status === 3;
      // The contract reverts DeadlineReached from Assigned as well as from a
      // retry. With an explicit gasLimit ethers skips estimateGas, so a
      // predictable revert would be mined and charged — refuse it here.
      if ((status === 1 || isRetry) && BigInt(Math.floor(Date.now() / 1000)) >= BigInt(detail.deadline)) {
        return fail('DEADLINE_REACHED', `Task ${detail.taskId} is past its deadline — no further submissions are accepted on-chain. The poster can reclaim the escrow with claim_timeout.`);
      }
      if (isRetry) {
        const attempts = detail.submissionAttempts ?? 0;
        if (attempts >= 3) {
          return fail('MAX_ATTEMPTS_REACHED', `Task ${detail.taskId} has used all 3 submission attempts (${attempts}/3). The escrow stays locked until the poster reclaims it after the deadline.`);
        }
      }
      if (status >= 4) {
        return ok({ taskId: detail.taskId, taskHash: detail.taskHash, onChainStatus: statusName(status), hint: 'Already settled — nothing to do.' });
      }

      let submitTxHash: string | undefined;
      let gas: GasMode | undefined;
      let healed = false;
      try {
        if (status === 1 || isRetry) {
          type Built = { onChainTaskId: number; evidenceHash: string; chain?: string; unsignedSubmitEvidence: { to: string; data: string; from?: string; chainId?: number } };
          let sub: Built;
          try {
            sub = await api<Built>('POST', `/api/v1/a2a/tasks/${task}/submit`, { resultData: { output } });
          } catch (err) {
            // Stranded 'submitted': /submit flips the off-chain state when the
            // tx is BUILT, so an earlier call that died before broadcasting
            // leaves the chain at Assigned(1) while /submit refuses a rebuild.
            // /rebroadcast rebuilds the same tx from the stored result — the
            // FIRST output is what gets delivered, not this call's.
            if ((err as ApiError).code !== 'INVALID_STATE' || status !== 1) throw err;
            sub = await api<Built>('POST', `/api/v1/a2a/tasks/${task}/rebroadcast`);
            healed = true;
          }
          const tx = sub.unsignedSubmitEvidence;
          await verifyTarget(s, tx.to, 'submitEvidence');
          if (s.payment === 'relay-erc20') {
            const sent = await relaySend(s, { to: tx.to, data: tx.data });
            submitTxHash = sent.hash;
            gas = sent.gas;
            await waitRelayed(s, sent.hash, sent.isUserOp);
          } else {
            // submitEvidence is onlyWorker: the backend built the tx for the
            // API key's wallet (tx.from). If BLINDMARKET_PRIVATE_KEY is a
            // different wallet the tx reverts on-chain — with gasLimit set,
            // that revert is mined and paid for. Refuse before sending.
            if (tx.from && tx.from.toLowerCase() !== walletCtx!.wallet.address.toLowerCase()) {
              return fail('WALLET_MISMATCH', `The backend assigned this task to ${tx.from} (the wallet behind BLINDMARKET_API_KEY), but BLINDMARKET_PRIVATE_KEY is ${walletCtx!.wallet.address}. submitEvidence is worker-only — set the private key of ${tx.from}.`);
            }
            // 0G: sign locally, exactly as fundAndIndex does for createTask.
            // The backend pins chainId onto the tx; ethers refuses to send it
            // if this wallet's provider is on a different network — the guard
            // against a Base tx reaching a 0G signer.
            const tx0g = await walletCtx!.wallet.sendTransaction({
              to: tx.to, data: tx.data, gasLimit: GAS_LIMIT,
              ...(tx.chainId !== undefined ? { chainId: tx.chainId } : {}),
            });
            submitTxHash = tx0g.hash;
            await tx0g.wait();
          }
          status = await waitStatus(s, detail.taskId, 2, 'Submitted');
        }

        // Backend runs the verification for this task's mode and, on a pass,
        // sends completeVerification from the marketplace signer — which is
        // what releases the USDC to payFrom. The call awaits that tx.
        const fin = await api<{ status: string; verificationResult?: { passed: boolean; score?: number; reasons?: string[] }; awaitingPosterApproval?: boolean }>(
          'POST', `/api/v1/a2a/tasks/${task}/finalize`,
        );
        const after = await loadTask(s, detail.taskId);
        const done = Number(after.status) === 4;
        return ok({
          taskId: detail.taskId,
          taskHash: detail.taskHash,
          submitTxHash,
          gas,
          ...(healed ? { rebroadcast: true, note: 'An earlier submission for this task never reached the chain; its stored result was re-broadcast. The output passed to THIS call was not used.' } : {}),
          verification: fin.verificationResult ?? null,
          backendStatus: fin.status,
          onChainStatus: statusName(Number(after.status)),
          paidTo: done ? payFrom : undefined,
          submissionAttempts: after.submissionAttempts,
          hint: done
            ? `Escrow released: ${formatUnits(BigInt(after.amount), after.decimals ?? s.decimals)} ${s.symbol} minus the marketplace fee is now in ${payFrom}.`
            : fin.awaitingPosterApproval
              ? 'Manual-verification task: the poster must approve via verify_task before the escrow releases.'
              : `Verification did not pass (${(fin.verificationResult?.reasons ?? []).join('; ') || 'no reasons given'}). ` +
                ((after.submissionAttempts ?? 0) < 3
                  ? `Revise and call complete_task again — ${3 - (after.submissionAttempts ?? 0)} attempt(s) left before the deadline.`
                  : 'No attempts left; the escrow stays locked until the poster reclaims it.'),
        });
      } catch (err) {
        return fail((err as ApiError).code ?? 'COMPLETE_FAILED', (err as Error).message);
      }
    },
  );

  // ── deploy_agent ──────────────────────────────────────────────────────────

  /** The env var each provider's API key is read from, so the key never passes through the conversation. */
  const PROVIDER_KEY_ENV: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    groq: 'GROQ_API_KEY',
    gemini: 'GEMINI_API_KEY',
  };
  /** Public RPCs by chain id, for a chain with no BLINDMARKET_<CHAIN>_RPC_URL set. */
  const PUBLIC_RPC: Record<number, string> = { 5042002: 'https://rpc.testnet.arc.io' };

  type TransferTerms = { required: true; method: 'transfer'; chain: string; token: string; recipient: string; amountRaw: string; decimals: number };
  type FeeTerms = { required: false } | TransferTerms | { required: true; method: 'factory'; chain: string; factory: string | null };
  interface DeployedAgent { id: string; name: string; walletAddress: string; started?: boolean }

  const coded = (code: string, message: string): ApiError => Object.assign(new Error(message), { code });

  /** The local wallet on `chain`, over BLINDMARKET_<CHAIN>_RPC_URL, checked against the chain id the backend names. */
  async function walletOn(chain: string) {
    const res = await fetch(`${cfg.apiBase}/health/bridge`, { signal: AbortSignal.timeout(30_000) });
    const bridge: any = await res.json().catch(() => ({}));
    const entry = (bridge?.data ?? bridge)?.chains?.find((c: { chain?: string }) => c.chain === chain);
    const chainId = Number(entry?.chainId);
    if (!Number.isInteger(chainId) || chainId <= 0) throw coded('SETTLEMENT_UNKNOWN', `The backend lists no chain id for ${chain}.`);
    const envName = `BLINDMARKET_${chain.toUpperCase().replace(/-/g, '_')}_RPC_URL`;
    const rpcUrl = process.env[envName] ?? PUBLIC_RPC[chainId];
    if (!rpcUrl) throw coded('RPC_UNKNOWN', `No RPC known for ${chain} (chainId ${chainId}) — set ${envName}.`);
    const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
    const served = Number(BigInt(await provider.send('eth_chainId', [])));
    if (served !== chainId) throw coded('WRONG_RPC', `${envName} serves chain ${served}, not ${chain} (${chainId}). Nothing was paid.`);
    return walletCtx!.wallet.connect(provider);
  }

  server.registerTool(
    'deploy_agent',
    {
      title: 'Deploy a Hosted Agent',
      description: "Deploy a hosted agent that runs on BlindMarket and takes tasks, owned by the API key's wallet. Deploying costs a fee (1 USDC on Arc on production), paid as one USDC transfer on Arc from the local wallet (BLINDMARKET_PRIVATE_KEY), which must be the API key's owner. The model provider's key is read from this server's environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY or GEMINI_API_KEY; none for 0g-compute), never passed as an argument. TWO-STEP quote/confirm like post_task; requires a unique idempotencyKey, and a retry with the same key never pays twice.",
      inputSchema: {
        name: z.string().min(1).max(80).describe('Agent name'),
        instructions: z.string().min(1).max(100_000).describe("The agent's instructions: what it does and how"),
        provider: z.enum(['openai', 'anthropic', 'groq', 'gemini', '0g-compute']).describe("LLM provider. '0g-compute' needs no API key: inference is billed to the agent's own wallet"),
        model: z.string().min(1).describe('Model id, e.g. gpt-4o-mini or claude-sonnet-4-5'),
        skillSlugs: z.array(z.string()).max(10).optional().describe('Public skills to install at deploy, by slug'),
        idempotencyKey: z.string().min(8).max(128).describe('Unique key for this deploy — reuse it on retries'),
        confirm: z.boolean().optional().describe('Set true (with quoteId) to pay the fee and deploy'),
        quoteId: z.string().optional().describe('From the quote step'),
      },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, instructions, provider, model, skillSlugs, idempotencyKey, confirm, quoteId }) => {
      if (!walletCtx) {
        return fail('NO_WALLET', 'deploy_agent pays the fee from, and encrypts the agent key to, the local wallet — set BLINDMARKET_PRIVATE_KEY to the key of the wallet that owns BLINDMARKET_API_KEY.');
      }
      let apiKey = '';
      if (provider !== '0g-compute') {
        const envName = PROVIDER_KEY_ENV[provider];
        apiKey = process.env[envName] ?? '';
        if (!apiKey) return fail('PROVIDER_KEY_MISSING', `Set ${envName} in this server's environment: the agent calls ${provider} with it. It is read there so it never passes through the conversation.`);
      }
      const body = {
        name, instructions, provider, model, apiKey,
        capabilities: [],
        skillSlugs: skillSlugs ?? [],
        // The agent's private key is encrypted to the local wallet's key.
        ownerPublicKey: derivePublicKeyHex(walletCtx.wallet.privateKey),
      };
      const summary = (a: DeployedAgent) => ({ agentId: a.id, name: a.name, walletAddress: a.walletAddress, started: a.started === true });
      /** POST /agents/deploy, asking again while the backend has not seen the fee confirm. */
      const deploy = async (feeTxHash?: string): Promise<DeployedAgent> => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await api<DeployedAgent>('POST', '/api/v1/agents/deploy', feeTxHash ? { ...body, feeTxHash } : body);
          } catch (err) {
            if ((err as ApiError).code !== 'DEPLOY_FEE_NOT_FOUND' || attempt >= 3) throw err;
            await new Promise((r) => setTimeout(r, Number(process.env.BLINDMARKET_DEPLOY_POLL_MS ?? 5000)));
          }
        }
      };
      const paidNote = () => {
        const rec = getSpend(idempotencyKey);
        return rec?.stage === 'sent' && rec.txHash
          ? ` The fee is paid (${rec.txHash}): retry with the SAME idempotencyKey to deploy without paying again.`
          : '';
      };

      const existing = getSpend(idempotencyKey);
      if (existing && existing.kind !== 'deploy') {
        return fail('IDEMPOTENCY_KEY_IN_USE', `idempotencyKey ${idempotencyKey} belongs to a ${existing.kind} spend — use a new key for this deploy.`);
      }
      if (existing?.stage === 'confirmed') {
        return ok({ resumed: true, agentId: existing.agentId, feeTxHash: existing.txHash, hint: 'Already deployed with this idempotencyKey.' });
      }
      if (existing?.stage === 'sent' && existing.txHash) {
        // Paid before: finish the deploy with that payment.
        try {
          const agent = await deploy(existing.txHash);
          updateSpend(idempotencyKey, { stage: 'confirmed', agentId: agent.id });
          return ok({ resumed: true, ...summary(agent), feeTxHash: existing.txHash });
        } catch (err) {
          return fail((err as ApiError).code ?? 'DEPLOY_FAILED', `${(err as Error).message}.${paidNote()}`);
        }
      }

      let terms: FeeTerms;
      try {
        terms = await api<FeeTerms>('GET', '/api/v1/agents/deploy-fee');
      } catch (err) {
        return fail((err as ApiError).code ?? 'DEPLOY_FEE_UNKNOWN', (err as Error).message);
      }
      if (terms.required && terms.method !== 'transfer') {
        return fail('UNSUPPORTED_FEE_METHOD', 'This backend takes the deploy fee through AgentFactory only, which this server does not pay. Deploy from the web app.');
      }
      const fee = terms.required ? terms as TransferTerms : null;
      const feeText = fee ? `${formatUnits(BigInt(fee.amountRaw), fee.decimals).replace(/\.0$/, '')} USDC` : 'none';

      if (!confirm) {
        let walletBalance: string | undefined;
        if (fee) {
          try {
            const w = await walletOn(fee.chain);
            const bal = await new Contract(fee.token, ['function balanceOf(address) view returns (uint256)'], w).balanceOf(w.address);
            walletBalance = formatUnits(bal, fee.decimals);
          } catch (err) {
            if (['RPC_UNKNOWN', 'WRONG_RPC', 'SETTLEMENT_UNKNOWN'].includes((err as ApiError).code ?? '')) {
              return fail((err as ApiError).code!, (err as Error).message);
            }
          }
        }
        const quote = createQuote('deploy', { name, provider, model, fee: feeText });
        return ok({
          quote: {
            agent: { name, provider, model, skills: skillSlugs ?? [] },
            fee: feeText,
            chain: fee?.chain,
            payTo: fee?.recipient,
            payFrom: walletCtx.wallet.address,
            walletBalance,
            quoteId: quote.quoteId,
          },
          next: `Re-call deploy_agent with confirm=true, quoteId="${quote.quoteId}", and the SAME idempotencyKey to ${fee ? 'pay the fee and ' : ''}deploy.`,
        });
      }
      if (!quoteId || !consumeQuote(quoteId, 'deploy')) {
        return fail('QUOTE_REQUIRED', 'Get a quote first (call without confirm), then re-call with confirm=true and the returned quoteId (quotes are single-use and expire after 10 minutes)');
      }

      try {
        const now = new Date().toISOString();
        let feeTxHash: string | undefined;
        if (fee) {
          // The backend counts a fee only from the API key's owner: check before paying.
          const { address: owner } = await api<{ address: string }>('GET', '/api/v1/api-keys/whoami');
          if (String(owner).toLowerCase() !== walletCtx.wallet.address.toLowerCase()) {
            return fail('OWNER_MISMATCH', `BLINDMARKET_API_KEY belongs to ${owner} but BLINDMARKET_PRIVATE_KEY is ${walletCtx.wallet.address}. Nothing was paid: the backend counts a deploy fee only from the API key's owner.`);
          }
          const w = await walletOn(fee.chain);
          putSpend({ idempotencyKey, kind: 'deploy', stage: 'created', settlement: fee.chain, token: fee.token, amountWei: fee.amountRaw, createdAt: now, updatedAt: now });
          const data = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])
            .encodeFunctionData('transfer', [fee.recipient, BigInt(fee.amountRaw)]);
          const tx = await w.sendTransaction({ to: fee.token, data });
          // Recorded the moment it is broadcast: a retry resumes from here and never pays twice.
          updateSpend(idempotencyKey, { stage: 'sent', txHash: tx.hash });
          try {
            await tx.wait();
          } catch (err) {
            if ((err as ApiError).code === 'CALL_EXCEPTION') {
              updateSpend(idempotencyKey, { stage: 'created', txHash: undefined });
              return fail('FEE_REVERTED', `The fee transfer ${tx.hash} reverted, so nothing was paid. Check the wallet's USDC on ${fee.chain} and retry.`);
            }
            // Not confirmed yet: the backend waits for the receipt itself.
          }
          feeTxHash = tx.hash;
        } else {
          putSpend({ idempotencyKey, kind: 'deploy', stage: 'created', createdAt: now, updatedAt: now });
        }
        const agent = await deploy(feeTxHash);
        updateSpend(idempotencyKey, { stage: 'confirmed', agentId: agent.id });
        return ok({
          ...summary(agent),
          feeTxHash,
          hint: agent.started ? 'The agent is running.' : 'The agent was created but did not start — start it with start_agent.',
        });
      } catch (err) {
        return fail((err as ApiError).code ?? 'DEPLOY_FAILED', `${(err as Error).message}.${paidNote()}`);
      }
    },
  );

  return { settlement };
}
