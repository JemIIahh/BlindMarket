import { ethers } from 'ethers';
import { ApiError } from './apiError.js';
import {
  sendAndWait, assertSignerChain, ensureAllowance, tokenBalance, UnconfirmedTransactionError, DEFAULT_CONFIRM_TIMEOUT_MS,
} from './onchain.js';
import { generateAesKey, aesEncrypt, eciesEncrypt, sha256, bytesToHex } from './crypto/index.js';
import { checkEscrowCall, evidenceHashOf, taskIdOf } from './escrowCalls.js';
import type {
  Address, Hex, RootHash, HealthStatus, PlatformStats, OpenTask, TaskDetail,
  CreateTaskTx, ExecutorProfile, RegisterExecutorInput,
  DeployedAgentInfo, AgentWalletInfo, ReputationInfo, LeaderboardEntry,
  StorageUploadResult, Message, AgentSearchResult, TaskTemplate,
  VerifyTaskInput, A2ATaskEntry, AgentCapability,
  CreateAgentParams, CreateAgentResult, CreateTaskRequest,
} from './types.js';

// ── Public config ───────────────────────────────────────────────────────────

export interface BlindMarketConfig {
  /** Backend API base URL (default: https://api.blindmarket.xyz) */
  apiBase?: string;
  /** API key — shared AGENT_API_KEY or device-flow token */
  apiKey: string;
  /**
   * Executor signer: the private key of the wallet that owns `apiKey`, plus
   * the RPC(s) to broadcast `submitEvidence` on. Default for `createAgent()`
   * and `deliverResult()`, and what enables the `submit_result` tool — tools
   * never take a key as an argument. Stays in-process; never sent to the backend.
   */
  executor?: DeliverSigner;
}

// ── Agent deployment params ─────────────────────────────────────────────────

export interface DeployAgentParams {
  name: string;
  instructions: string;
  provider: 'openai' | 'anthropic' | 'groq' | 'gemini' | '0g-compute';
  model: string;
  /** The model provider's API key. Not needed for '0g-compute', which bills the agent's own wallet. */
  apiKey?: string;
  /** Uncompressed secp256k1 public key, hex without 0x: the agent's private key is encrypted to it. */
  ownerPublicKey: string;
  capabilities?: string[];
  tools?: object[];
  toolSecrets?: Record<string, string>;
  /** Public skills to install at deploy, by slug. */
  skillSlugs?: string[];
  /**
   * An Arc transaction that already paid the deploy fee (see getDeployFee()).
   * deployAgent() then pays nothing and names this payment instead.
   */
  feeTxHash?: string;
  /** @deprecated Ignored: the agent's owner is always the API key's wallet. */
  ownerAddress?: string;
}

export interface DeployAgentOptions {
  /**
   * Pay the deploy fee if the backend charges one. Off by default, so
   * deployAgent() never spends unless asked: without it (and without
   * `feeTxHash`) a backend that charges answers DEPLOY_FEE_REQUIRED.
   */
  payFee?: boolean;
  /**
   * Signs the fee payment on the fee's chain instead of the configured
   * executor (BlindMarketConfig.executor, whose rpcUrls must then name that
   * chain). Must be a wallet of the API key's owner: the backend counts a fee
   * from that wallet only.
   */
  payer?: ethers.Signer;
  /**
   * The most deployAgent() will pay, in the fee token's smallest unit (USDC
   * has 6 decimals). Default 1_000_000 (1 USDC, today's fee). A backend that
   * asks for more is refused with DEPLOY_FEE_ABOVE_MAX before anything is paid.
   */
  maxFeeRaw?: bigint | string;
  /**
   * Called with the fee transaction's hash the moment it is broadcast, before
   * any wait. Persist it: if this process dies before the deploy finishes,
   * pass it back as `params.feeTxHash` and nothing is paid twice. Not called
   * for an AgentFactory payment, whose credit the backend keeps for you.
   */
  onFeePaid?: (feeTxHash: string) => void | Promise<void>;
  /** How long to wait between checks while the backend confirms the payment. Default 5000 ms. */
  pollIntervalMs?: number;
  /** How long to wait for a payment to confirm on-chain. Default 180000 ms. */
  confirmTimeoutMs?: number;
}

/** What deploying an agent costs, from GET /api/v1/agents/deploy-fee. */
export type DeployFeeTerms =
  | { required: false }
  /**
   * One transfer of `amountRaw` of `token` to `recipient` on chain `chainId`,
   * named as feeTxHash. `factory` is the other way to pay. Backends before
   * the field existed leave `chainId` out; deployAgent() will not pay those.
   */
  | { required: true; method: 'transfer'; chain: string; chainId?: number; token: string; recipient: string; amountRaw: string; decimals: number; factory: string | null }
  /** Pay through AgentFactory.deployAgent(); its event becomes a credit the next deploy spends. */
  | { required: true; method: 'factory'; chain: string; chainId?: number; factory: string | null };

export interface DeployedAgent {
  id: string;
  name: string;
  walletAddress: string;
  publicKey: string;
  inftTokenId?: number;
  status: string;
  /** False when the agent was created but did not start; start it with startAgent(). */
  started?: boolean;
  /** The transaction that paid the deploy fee, when deployAgent() paid it or was given it. */
  feeTxHash?: string;
  /**
   * True when `feeTxHash` had already paid for this agent, one of yours: a
   * retry after a lost response returns the agent the first call created.
   */
  alreadyDeployed?: boolean;
}

// ── Task posting ────────────────────────────────────────────────────────────

export interface PostTaskParams {
  /** The brief. Encrypted here, before it leaves this process, unless `privacy` is 'public'. */
  instructions: string;
  /**
   * The escrow, in the settlement token's smallest unit: USDC has 6
   * decimals, so '2500000' is 2.5 USDC. Paid to the worker (90%) when the
   * result is verified; refundable while no one has taken the task.
   */
  amountRaw: string | bigint;
  /** Seconds until the deadline. Default 86400 (24h). The escrow allows 1 hour to 90 days. */
  durationSeconds?: number;
  /**
   * 'private' (default): the brief is encrypted and its key wrapped to each
   * registered executor on the posting chain. 'public': the brief and the
   * result are plaintext, readable by any agent.
   */
  privacy?: 'private' | 'public';
  /** Default 'auto', with `verificationCriteria` defaulting to `{ min_length: 10, pass_threshold: 60 }`. */
  verificationMode?: 'manual' | 'auto' | 'agent';
  verificationCriteria?: Record<string, unknown>;
  /** The designated verifier, with verificationMode 'agent'. */
  verifierAddress?: Address;
  /** Route to agents with these capabilities first. Empty (default) offers it to every agent. */
  requiredCapabilities?: AgentCapability[];
  /** Only this executor can take the task, and only it gets the brief's key. */
  targetExecutor?: Address;
  /** Default 'global'. */
  locationZone?: string;
}

export interface PostTaskOptions {
  /**
   * Signs the escrow funding on the posting chain instead of the configured
   * executor (BlindMarketConfig.executor, whose rpcUrls must name that chain).
   * Must be the API key's owner wallet: the task is posted as that wallet.
   */
  signer?: ethers.Signer;
  /**
   * The most postTask() will lock in escrow, in the token's smallest unit.
   * Refused with AMOUNT_ABOVE_MAX before anything is sent.
   */
  maxAmountRaw?: bigint | string;
  /**
   * Called the moment the funding transaction is broadcast, with its hash and
   * the complete listing body. Persist `indexParams`: if this process dies
   * before the task is listed, indexTask(indexParams) finishes it and the
   * escrow is not funded twice.
   */
  onFunded?: (funding: { txHash: string; taskHash: string; indexParams: IndexTaskParams }) => void | Promise<void>;
  /** How long to wait for each transaction to confirm. Default 180000 ms. */
  confirmTimeoutMs?: number;
}

export interface PostedTask {
  /** The task's id on the backend (the brief's sha256 commitment). */
  taskHash: string;
  /** The on-chain task id, for cancelAndRefund() and reclaimAfterTimeout(). */
  taskId?: string;
  /** The transaction that funded the escrow. */
  txHash: string;
  chain: string;
  chainId: number;
  rootHash: string;
  privacy: 'private' | 'public';
  /** How many executors can decrypt the brief. 0 for a public task. */
  wrappedTo: number;
  /**
   * The brief's AES key (hex), for a private task. Keep it to wrap the brief
   * to an executor that registers later; never send it anywhere.
   */
  aesKey?: string;
}

/** The body of POST /api/v1/a2a/tasks/index, which lists a funded task on the market. */
export interface IndexTaskParams {
  txHash: string;
  taskHash: string;
  rootHash?: string;
  wrappedKeys?: Record<string, string>;
  privacy?: 'private' | 'public';
  publicBrief?: string;
  verificationMode?: 'manual' | 'auto' | 'agent';
  verificationCriteria?: Record<string, unknown>;
  verifierAddress?: Address;
  requiredCapabilities?: AgentCapability[];
  targetExecutor?: Address;
}

/** A refund the client signed and sent: cancelAndRefund() or reclaimAfterTimeout(). */
export interface RefundResult {
  txHash: string;
  chain: string;
  chainId: number;
  /** Whether the backend took the task off the market. False leaves it listed until its deadline; the refund stands either way. */
  listingClosed: boolean;
}

export interface RefundOptions {
  /** Signs on the task's chain instead of the configured executor. */
  signer?: ethers.Signer;
  /** The task's chain (PostedTask.chain). Task ids repeat across chains, so naming it refunds that one. */
  chain?: string;
  confirmTimeoutMs?: number;
}

/** One settlement chain, as GET /health/settlement describes it. */
export interface SettlementChainInfo {
  chain: string;
  chainId: number;
  tier?: string;
  escrowAddress: string | null;
  token: { kind: 'native' | 'erc20'; address: string | null; symbol: string; decimals: number };
  relayChain?: string | null;
  gasSymbol?: string;
  postable?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Per-chain RPC URLs for signing `submitEvidence` — a task is escrowed on exactly one chain. */
export interface DeliverSigner {
  /** Private key of the executor wallet (the API key's owner) — `submitEvidence` is `onlyWorker`. */
  privateKey: string;
  /** RPC per chain. No default: a missing entry refuses the task's chain rather than guessing a network. */
  rpcUrls: Partial<Record<string, string | undefined>>;
}

/** A whole number of base units from a string or bigint; throws 400 INVALID_AMOUNT otherwise. */
function wholeNumber(value: string | bigint, name: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new ApiError(
    400,
    `${name} must be a whole number of the token's smallest unit (USDC has 6 decimals: '2500000' is 2.5 USDC), not ${JSON.stringify(value)}. Nothing was sent.`,
    undefined,
    'INVALID_AMOUNT',
  );
}

// ── Main client ─────────────────────────────────────────────────────────────

/**
 * BlindMarket REST API client.
 *
 * Two usage modes:
 * 1. **High-level (this class)** — talks to the BlindMarket backend over REST.
 *    Covers the full task lifecycle, agent management, A2A, and marketplace.
 * 2. **Low-level primitives** — `Agent`, `Worker`, `PrivateKeySigner`, etc.
 *    for on-chain + crypto operations when you need direct chain access.
 *
 * @example
 * ```ts
 * const bb = new BlindMarket({ apiKey: process.env.BLINDMARKET_API_KEY! });
 *
 * // Deploy an agent
 * const agent = await bb.deployAgent({ name: 'my-agent', ... });
 *
 * // Watch for status changes
 * const unsub = bb.watchTask(42, (state) => console.log(state.status));
 * ```
 */
export class BlindMarket {
  private apiBase: string;
  private apiKey: string;
  private executor?: DeliverSigner;

  constructor(config: BlindMarketConfig) {
    this.apiBase = config.apiBase ?? 'https://api.blindmarket.xyz';
    this.apiKey = config.apiKey;
    this.executor = config.executor;
  }

  /** True when an executor signer was configured (see BlindMarketConfig.executor). */
  get canSign(): boolean {
    return !!this.executor;
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  /**
   * Tool definitions for AI agent frameworks. Access framework-specific formats
   * via property — no need to remember adapter function names.
   *
   * IMPORTANT: due to ESM circular-dependency constraints this is a standalone
   * function rather than an instance getter. You pass `bb` once and reach the
   * format you need.
   *
   * @example
   * ```ts
   * import { BlindMarket, tools } from '@blindmarket/sdk';
   * const bb = new BlindMarket({ apiKey });
   *
   * // OpenAI (default — also works with Vercel AI SDK)
   * openai.chat.completions.create({ model: 'gpt-4', tools: tools(bb).definitions });
   *
   * // LangChain
   * createReactAgent({ llm, tools: tools(bb).langchain });
   *
   * // Claude
   * anthropic.messages.create({ model, tools: tools(bb).claude });
   *
   * // Vercel
   * generateText({ model, tools: tools(bb).vercel });
   * ```
   */

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json() as { success: boolean; data?: T; error?: { code?: string; message: string; reason?: string } };
    if (!json.success) {
      const err = new ApiError(res.status, json.error?.message ?? `HTTP ${res.status}`, json, json.error?.code);
      if (typeof json.error?.reason === 'string') err.reason = json.error.reason;
      throw err;
    }
    return json.data as T;
  }

  // ── Health & Stats ──────────────────────────────────────────────────────

  /** Backend liveness check. */
  async health(): Promise<HealthStatus> {
    return this.req<HealthStatus>('GET', '/health');
  }

  /** Live platform counts. */
  async stats(): Promise<PlatformStats> {
    return this.req<PlatformStats>('GET', '/api/v1/stats');
  }

  // ── Task lifecycle ──────────────────────────────────────────────────────

  /**
   * List open tasks from the legacy 0G TaskRegistry (numeric ids on the 0G
   * escrow). Tasks escrowed on Base or Arc are not in it: browseA2ATasks()
   * lists the work agents can take.
   */
  async listTasks(limit = 20): Promise<OpenTask[]> {
    const { tasks } = await this.req<{ tasks: OpenTask[] }>('GET', `/api/v1/tasks?limit=${limit}`);
    return tasks;
  }

  /** Get full task details (on-chain + A2A state). */
  async getTask(id: string): Promise<TaskDetail> {
    return this.req<TaskDetail>('GET', `/api/v1/tasks/${id}`);
  }

  /**
   * Build an unsigned `createTask` transaction.
   * You must sign and broadcast it with your wallet (the API key's owner is
   * the poster), then index it via `POST /api/v1/a2a/tasks/index` for A2A.
   * The deadline is set on-chain as now + `duration` seconds.
   */
  async createTask(params: CreateTaskRequest): Promise<CreateTaskTx> {
    return this.req<CreateTaskTx>('POST', '/api/v1/tasks', params);
  }

  /**
   * Build an unsigned `assignWorker` transaction.
   */
  async assignWorker(taskId: string, worker: Address): Promise<{ unsignedTx: object }> {
    return this.req('POST', `/api/v1/tasks/${taskId}/assign`, { worker });
  }

  /**
   * Build an unsigned `cancelTask` transaction (the refund of a task no one
   * has taken). `chain`/`chainId` name where to send it. cancelAndRefund()
   * builds, signs and sends it for you.
   */
  async cancelTask(taskId: string, chain?: string): Promise<{ unsignedTx: object; chain?: string; chainId?: number }> {
    // Task ids collide across chains: naming the chain builds for that one.
    return this.req('POST', `/api/v1/tasks/${taskId}/cancel`, chain ? { chain } : undefined);
  }

  /**
   * Build an unsigned `claimTimeout` transaction (the refund of a task whose
   * deadline passed). reclaimAfterTimeout() builds, signs and sends it for you.
   */
  async claimTimeout(taskId: string, chain?: string): Promise<{ unsignedTx: object; chain?: string; chainId?: number }> {
    return this.req('POST', `/api/v1/tasks/${taskId}/timeout`, chain ? { chain } : undefined);
  }

  /**
   * Build an unsigned `submitEvidence` transaction.
   */
  async submitEvidence(params: {
    taskId: string;
    evidenceHash: Hex;
  }): Promise<{ unsignedTx: object }> {
    return this.req('POST', '/api/v1/submissions/submit', params);
  }

  // ── Posting a task end to end ─────────────────────────────────────────────

  /**
   * Where new tasks are posted and what each chain settles in
   * (`GET /health/settlement`): no auth, no RPC reads on the backend.
   */
  async getSettlement(): Promise<{ postingChain: string | null; chains: SettlementChainInfo[] }> {
    return this.req('GET', '/health/settlement');
  }

  /**
   * `chain`'s entry in /health/settlement, with its escrow: every transaction
   * the backend builds for this client to sign must target that escrow.
   * Throws 409 CHAIN_UNKNOWN when the backend lists no escrow for it.
   */
  private async settlementEntry(
    chain: string,
    what: string,
    settlement?: { chains: SettlementChainInfo[] },
  ): Promise<SettlementChainInfo & { escrowAddress: string }> {
    const { chains } = settlement ?? await this.getSettlement();
    const entry = chains.find((c) => c.chain === chain);
    if (!entry?.escrowAddress || !Number.isInteger(entry.chainId)) {
      throw new ApiError(
        409,
        `${what}: the backend lists no escrow for ${chain} (GET /health/settlement), so a transaction built for it cannot be checked before signing. Nothing was sent.`,
        undefined,
        'CHAIN_UNKNOWN',
      );
    }
    return entry as SettlementChainInfo & { escrowAddress: string };
  }

  /**
   * Post a task end to end, from the API key's own wallet: encrypt the brief
   * (unless public) and wrap its key to the posting chain's executors, upload
   * it, build createTask, approve the escrow for the amount when the token is
   * an ERC-20, fund the escrow, and list the task (`POST /a2a/tasks/index`).
   *
   * The wallet signs locally, on the backend's posting chain (Arc on
   * production, where gas is paid in USDC). Before anything is sent it checks
   * the signer is the API key's owner, that its RPC is on the posting chain,
   * that the wallet holds the amount, and that the backend built exactly this
   * createTask (task hash, token, amount, zone, duration) for the escrow it
   * advertises, with no other value: 409 ESCROW_MISMATCH / TX_MISMATCH
   * otherwise. Only the tx's to and data are signed. The funding hash goes to `onFunded` as soon as
   * it is sent; an error after that carries it as `err.txHash`, and
   * indexTask() lists the funded task without paying again.
   *
   * @example
   * const task = await bb.postTask(
   *   { instructions: 'Summarise this paper in 5 bullets: …', amountRaw: '2000000' }, // 2 USDC
   *   { onFunded: ({ txHash }) => saveSomewhere(txHash) },
   * );
   */
  async postTask(params: PostTaskParams, opts: PostTaskOptions = {}): Promise<PostedTask> {
    const amount = wholeNumber(params.amountRaw, 'amountRaw');
    if (amount <= 0n) throw new ApiError(400, 'amountRaw must be above 0. Nothing was sent.', undefined, 'INVALID_AMOUNT');
    if (opts.maxAmountRaw !== undefined && amount > BigInt(opts.maxAmountRaw)) {
      throw new ApiError(402, `The escrow of ${amount} is above your limit of ${opts.maxAmountRaw}. Nothing was sent.`, undefined, 'AMOUNT_ABOVE_MAX');
    }
    const duration = params.durationSeconds ?? 86_400;
    if (!Number.isInteger(duration) || duration < 3_600 || duration > 90 * 86_400) {
      throw new ApiError(400, 'durationSeconds must be a whole number from 3600 (1 hour) to 7776000 (90 days): the escrow refuses anything else. Nothing was sent.', undefined, 'INVALID_DURATION');
    }
    const privacy = params.privacy ?? 'private';
    const locationZone = params.locationZone ?? 'global';
    const verificationMode = params.verificationMode ?? 'auto';
    const verificationCriteria = params.verificationCriteria
      ?? (verificationMode === 'auto' ? { min_length: 10, pass_threshold: 60 } : undefined);
    const requiredCapabilities = params.requiredCapabilities ?? [];

    // Where the escrow is funded, and in what.
    const { postingChain, chains } = await this.getSettlement();
    const entry = chains.find((c) => c.chain === postingChain);
    if (!postingChain || !entry || !entry.escrowAddress || !entry.token.address) {
      throw new ApiError(503, `The backend has no chain to post new tasks on right now (posting chain: ${postingChain ?? 'none'}). Nothing was sent.`, { postingChain, chains }, 'SETTLEMENT_NOT_POSTABLE');
    }
    const escrow = entry.escrowAddress;
    const token = entry.token.address;
    const isNative = entry.token.kind === 'native';

    const signer = opts.signer ?? this.signerOn(postingChain, 'Funding the escrow');
    const poster = await signer.getAddress();
    await this.assertSpender(poster, 'A task', true);
    await assertSignerChain(signer, entry.chainId, `Funding the escrow on ${postingChain}`);
    if (!isNative) {
      const balance = await tokenBalance(signer, token, poster);
      if (balance < amount) {
        const fmt = (v: bigint) => ethers.formatUnits(v, entry.token.decimals);
        throw new ApiError(
          402,
          `${poster} holds ${fmt(balance)} ${entry.token.symbol} on ${postingChain}; the escrow needs ${fmt(amount)}. Nothing was sent.`,
          undefined,
          'INSUFFICIENT_BALANCE',
        );
      }
    }

    // The brief: plaintext, or encrypted to the executors that can take it.
    const plaintext = new TextEncoder().encode(params.instructions);
    let blob: Uint8Array;
    let wrappedKeys: Record<string, string> | undefined;
    let aesKey: string | undefined;
    if (privacy === 'public') {
      blob = plaintext;
    } else {
      const qs = new URLSearchParams({ capabilities: requiredCapabilities.join(','), chain: postingChain });
      const { executors } = await this.req<{ executors: Array<{ address: string; publicKey?: string }> }>('GET', `/api/v1/a2a/executors?${qs}`);
      let targets = executors.filter((e) => typeof e.publicKey === 'string' && e.publicKey.length > 0);
      if (params.targetExecutor) {
        const want = params.targetExecutor.toLowerCase();
        targets = targets.filter((e) => e.address.toLowerCase() === want);
        if (targets.length === 0) {
          throw new ApiError(404, `${params.targetExecutor} is not a registered executor on ${postingChain} with a public key, so it could not read the brief. Nothing was sent.`, undefined, 'EXECUTOR_NOT_FOUND');
        }
      }
      if (targets.length > 200) {
        throw new ApiError(
          409,
          `${targets.length} executors match, more than the 200 a brief can be wrapped to. Narrow requiredCapabilities, name a targetExecutor, or post with privacy 'public'. Nothing was sent.`,
          undefined,
          'TOO_MANY_EXECUTORS',
        );
      }
      const key = await generateAesKey();
      blob = await aesEncrypt(plaintext, key);
      wrappedKeys = {};
      for (const e of targets) {
        try {
          wrappedKeys[e.address.toLowerCase()] = bytesToHex(await eciesEncrypt(key, e.publicKey!));
        } catch { /* a malformed public key: that executor can't be wrapped to */ }
      }
      if (Object.keys(wrappedKeys).length === 0) {
        throw new ApiError(
          409,
          `No executor on ${postingChain} can decrypt an encrypted brief right now, so no one could take the task. Post with privacy 'public', or wait for executors to register. Nothing was sent.`,
          undefined,
          'NO_EXECUTORS',
        );
      }
      aesKey = bytesToHex(key);
    }
    const taskHash = `0x${bytesToHex(await sha256(blob))}`;
    const { rootHash } = await this.uploadBlob(ethers.encodeBase64(blob));

    const built = await this.createTask({
      taskHash: taskHash as Hex,
      token: token as Address,
      amount: amount.toString(),
      locationZone,
      duration: String(duration),
      targetExecutorType: 'agent',
      verificationMode,
      ...(verificationCriteria ? { verificationCriteria } : {}),
      ...(params.verifierAddress ? { verifierAddress: params.verifierAddress } : {}),
      requiredCapabilities,
      rootHash,
      ...(wrappedKeys ? { wrappedKeys } : {}),
    });
    // The tx must go to the escrow and chain checked above: a backend whose
    // posting chain moved in between would otherwise have it signed blind.
    if ((built.chain !== undefined && built.chain !== postingChain) || (built.chainId !== undefined && Number(built.chainId) !== entry.chainId)) {
      throw new ApiError(409, `The backend built this task for ${built.chain} (chain ${built.chainId}), not ${postingChain}: its posting chain changed. Nothing was sent; try again.`, undefined, 'POSTING_CHAIN_CHANGED');
    }
    // And it must be exactly this createTask: the escrow, the task hash, the
    // token, the amount, the zone and the duration asked for (a verifier
    // commits through createTaskWithVerifier). Only its to and data are signed;
    // the value is the amount computed here.
    const withVerifier = verificationMode === 'agent' && !!params.verifierAddress && params.verifierAddress.toLowerCase() !== ethers.ZeroAddress;
    const createCall = checkEscrowCall(built.unsignedTx, {
      escrow,
      fn: withVerifier ? 'createTaskWithVerifier' : 'createTask',
      args: (a) => String(a[0]).toLowerCase() === taskHash.toLowerCase()
        && String(a[1]).toLowerCase() === token.toLowerCase()
        && a[2] === amount
        && a[4] === locationZone
        && a[5] === BigInt(duration)
        && (!withVerifier || String(a[6]).toLowerCase() === params.verifierAddress!.toLowerCase()),
      value: isNative ? amount : 0n,
      chainId: entry.chainId,
    }, `Funding the escrow on ${postingChain}`);

    const timeoutMs = opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    // createTask pulls an ERC-20 with transferFrom: approve the escrow first.
    const nonce = isNative ? undefined : await ensureAllowance(signer, token, escrow, amount, { timeoutMs });
    const indexParams: IndexTaskParams = {
      txHash: '',
      taskHash,
      rootHash,
      ...(wrappedKeys ? { wrappedKeys } : {}),
      privacy,
      ...(privacy === 'public' ? { publicBrief: params.instructions.slice(0, 4000) } : {}),
      verificationMode,
      ...(verificationCriteria ? { verificationCriteria } : {}),
      ...(params.verifierAddress ? { verifierAddress: params.verifierAddress } : {}),
      requiredCapabilities,
      ...(params.targetExecutor ? { targetExecutor: params.targetExecutor } : {}),
    };
    let txHash: string;
    try {
      ({ hash: txHash } = await sendAndWait(signer, createCall, {
        value: isNative ? amount : undefined,
        nonce,
        timeoutMs,
        onSent: (hash) => opts.onFunded?.({ txHash: hash, taskHash, indexParams: { ...indexParams, txHash: hash } }),
        unconfirmedHint: (hash) => `If it confirms, call indexTask() with txHash '${hash}' to list the task; do not fund it again.`,
      }));
    } catch (err) {
      if (err instanceof UnconfirmedTransactionError) {
        const out = new ApiError(0, err.message, { indexParams: { ...indexParams, txHash: err.hash } }, 'UNCONFIRMED');
        out.txHash = err.hash;
        throw out;
      }
      throw err;
    }

    indexParams.txHash = txHash;
    let indexed: { taskHash: string; onChainTaskId?: string };
    try {
      indexed = await this.indexTaskPatiently(indexParams);
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      const out = new ApiError(
        e.status ?? 0,
        `${e.message} — the escrow is funded (transaction ${txHash}) but the task is not listed yet. Call indexTask() with err.body.indexParams to list it, or cancelAndRefund() it; do not post it again.`,
        { indexParams },
        e.code,
      );
      out.txHash = txHash;
      throw out;
    }
    return {
      taskHash,
      ...(indexed.onChainTaskId !== undefined ? { taskId: String(indexed.onChainTaskId) } : {}),
      txHash,
      chain: postingChain,
      chainId: entry.chainId,
      rootHash,
      privacy,
      wrappedTo: wrappedKeys ? Object.keys(wrappedKeys).length : 0,
      ...(aesKey ? { aesKey } : {}),
    };
  }

  /**
   * List a funded task on the market (`POST /api/v1/a2a/tasks/index`), from
   * its funding transaction. Safe to call again for the same task: the
   * backend merges a repeat from the same poster. postTask() calls it; call
   * it yourself to finish a post whose funding confirmed but whose listing
   * failed (the error's `body.indexParams` holds the fields).
   */
  async indexTask(params: IndexTaskParams): Promise<{ taskHash: string; onChainTaskId?: string; indexed: boolean }> {
    return this.req('POST', '/api/v1/a2a/tasks/index', params);
  }

  /** indexTask(), asking again while the backend's RPC has not seen the receipt or the backend is briefly down. */
  private async indexTaskPatiently(params: IndexTaskParams): Promise<{ taskHash: string; onChainTaskId?: string }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.indexTask(params);
      } catch (err) {
        const transient = err instanceof ApiError
          ? err.code === 'RECEIPT_NOT_FOUND' || err.status >= 500
          : err instanceof TypeError; // fetch failed: the network, not the request
        if (!transient || attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
  }

  /**
   * Cancel a task no one has taken and get its escrow back: builds
   * cancelTask, checks the signer is on the task's chain, signs and sends it,
   * then takes the task off the market (`POST /tasks/:id/confirm-tx`).
   * `taskId` is the on-chain id (PostedTask.taskId); pass `chain`
   * (PostedTask.chain) too, since ids repeat across chains.
   *
   * Only a zero-value `cancelTask(taskId)` on the escrow /health/settlement
   * lists for the chain is signed (to and data only), and only on the chain
   * you named: 409 ESCROW_MISMATCH, TX_MISMATCH, CHAIN_MISMATCH or
   * CHAIN_UNKNOWN otherwise, with nothing sent. reclaimAfterTimeout() does
   * the same for `claimTimeout(taskId)`.
   */
  async cancelAndRefund(taskId: string, opts: RefundOptions = {}): Promise<RefundResult> {
    return this.sendRefund(taskId, await this.cancelTask(taskId, opts.chain), 'cancelTask', 'Cancelling the task', opts);
  }

  /** Reclaim the escrow of a task whose deadline passed undelivered (claimTimeout), signed and sent. */
  async reclaimAfterTimeout(taskId: string, opts: RefundOptions = {}): Promise<RefundResult> {
    return this.sendRefund(taskId, await this.claimTimeout(taskId, opts.chain), 'claimTimeout', 'Reclaiming the escrow', opts);
  }

  /**
   * Sign the refund the backend built, once it is checked to be exactly
   * `fn(taskId)` on the escrow of the chain it names (the one the caller
   * named, when it named one), with no value. Only its to and data are signed.
   */
  private async sendRefund(
    taskId: string,
    built: { unsignedTx: object; chain?: string; chainId?: number },
    fn: 'cancelTask' | 'claimTimeout',
    what: string,
    opts: RefundOptions,
  ): Promise<RefundResult> {
    const { chain, chainId } = built;
    if (!chain || chainId === undefined) {
      throw new ApiError(409, `${what}: the backend did not say which chain the task is on, so it cannot be signed safely here. Nothing was sent.`, built, 'CHAIN_UNKNOWN');
    }
    if (opts.chain && chain !== opts.chain) {
      throw new ApiError(409, `${what}: you asked for task ${taskId} on ${opts.chain}, but the backend built the refund for ${chain}. Nothing was sent.`, built, 'CHAIN_MISMATCH');
    }
    const entry = await this.settlementEntry(chain, what);
    if (Number(chainId) !== entry.chainId) {
      throw new ApiError(409, `${what}: the backend built the refund for chain ${chainId}, but lists ${chain} as chain ${entry.chainId}. Nothing was sent.`, built, 'CHAIN_MISMATCH');
    }
    const id = taskIdOf(taskId);
    const call = checkEscrowCall(built.unsignedTx, {
      escrow: entry.escrowAddress,
      fn,
      args: (a) => id !== undefined && a[0] === id,
      chainId: entry.chainId,
    }, what);
    const signer = opts.signer ?? this.signerOn(chain, what);
    await assertSignerChain(signer, entry.chainId, what);
    let hash: string;
    try {
      ({ hash } = await sendAndWait(signer, call, { timeoutMs: opts.confirmTimeoutMs }));
    } catch (err) {
      if (err instanceof UnconfirmedTransactionError) {
        const out = new ApiError(0, `${err.message} Check it before sending another.`, { txHash: err.hash }, 'UNCONFIRMED');
        out.txHash = err.hash;
        throw out;
      }
      throw err;
    }
    return { txHash: hash, chain, chainId, listingClosed: await this.confirmRefund(taskId, hash, chain) };
  }

  /**
   * Tell the backend a refund landed (`POST /api/v1/tasks/:id/confirm-tx`),
   * which checks the receipt and takes the task off the market. Without it a
   * refunded task keeps listing as open until its deadline. Best effort: the
   * money has already moved, so a failure here only reports false.
   */
  private async confirmRefund(taskId: string, txHash: string, chain: string): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.req('POST', `/api/v1/tasks/${taskId}/confirm-tx`, { txHash, chain });
        return true;
      } catch (err) {
        // The backend's RPC can lag the receipt the signer just saw.
        if (!(err instanceof ApiError && err.code === 'NOT_CONFIRMED') || attempt === 3) return false;
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    return false;
  }

  // ── Agent deployment & management ─────────────────────────────────────────

  /** What deploying an agent costs on this backend, and how to pay it. */
  async getDeployFee(): Promise<DeployFeeTerms> {
    return this.req<DeployFeeTerms>('GET', '/api/v1/agents/deploy-fee');
  }

  /**
   * Run every check POST /deploy makes before it takes a fee, with nothing
   * paid or saved. Throws the same ApiError the deploy would (400 with field
   * errors, 404 SKILL_NOT_FOUND, 400 INVALID_OWNER_PUBLIC_KEY). Returns false
   * when the backend predates the check and nothing could be checked.
   */
  async validateDeploy(params: DeployAgentParams): Promise<boolean> {
    const { ownerAddress: _ignored, ...body } = params;
    try {
      await this.req('POST', '/api/v1/agents/deploy/validate', body);
      return true;
    } catch (err) {
      if (err instanceof SyntaxError || (err instanceof ApiError && err.status === 404 && err.code !== 'SKILL_NOT_FOUND')) return false;
      throw err;
    }
  }

  /**
   * Deploy a new hosted agent. The backend generates its wallet, mints an
   * INFT, starts it, and returns the agent descriptor.
   *
   * Deploying costs a fee (1 USDC on Arc on production; getDeployFee() says).
   * An unspent AgentFactory credit pays first. Otherwise deployAgent() pays
   * only with `{ payFee: true }`, from the configured executor wallet (set
   * `rpcUrls.arc`) or `payer`, which must be the API key's owner. Before it
   * pays it checks the payer's chain, the fee against `maxFeeRaw`, and the
   * request itself, so nothing is paid for a deploy that would be refused.
   *
   * The fee's hash goes to `onFeePaid` as soon as it is sent, and onto any
   * error after that (`err.feeTxHash`): retry with `params.feeTxHash` set to
   * it and nothing is paid twice. A retry whose payment already created one
   * of your agents returns that agent, with `alreadyDeployed: true`.
   *
   * @example
   * const agent = await bb.deployAgent({
   *   name: 'research-agent',
   *   instructions: 'You research topics and post tasks.',
   *   provider: 'anthropic',
   *   model: 'claude-sonnet-4-5',
   *   apiKey: process.env.ANTHROPIC_API_KEY!,
   *   // Uncompressed, no 0x (`wallet` is an ethers Wallet; its `publicKey` is compressed).
   *   ownerPublicKey: wallet.signingKey.publicKey.slice(2),
   * }, { payFee: true, onFeePaid: (hash) => saveSomewhere(hash) });
   */
  async deployAgent(params: DeployAgentParams, opts: DeployAgentOptions = {}): Promise<DeployedAgent> {
    const { ownerAddress: _ignored, feeTxHash: given, ...rest } = params;
    const body: Omit<DeployAgentParams, 'ownerAddress'> = rest;
    const pollMs = opts.pollIntervalMs ?? 5_000;
    // A named payment: the backend may still be waiting for its receipt.
    if (given) return this.deployWithFee(body, given, pollMs);

    let terms: DeployFeeTerms;
    try {
      terms = await this.getDeployFee();
    } catch (err) {
      // A backend from before the fee route: deploy as the SDK always did.
      if (err instanceof SyntaxError || (err instanceof ApiError && err.status === 404)) return this.postDeploy(body, [], 1, pollMs);
      throw err;
    }
    if (!terms.required) return this.postDeploy(body, [], 1, pollMs);

    // An unspent AgentFactory credit pays before anything new is spent. This
    // POST also runs every check the deploy makes: a request it would refuse
    // fails here, before a payment.
    try {
      return await this.postDeploy(body, [], 1, pollMs);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'NO_DEPLOY_CREDIT')) throw err;
      if (!opts.payFee) {
        const cost = terms.method === 'transfer'
          ? `${ethers.formatUnits(BigInt(terms.amountRaw), terms.decimals).replace(/\.0$/, '')} USDC on ${terms.chain}`
          : `a fee through AgentFactory on ${terms.chain}`;
        throw new ApiError(
          402,
          `Deploying an agent costs ${cost}. Call deployAgent(params, { payFee: true }) to pay it from your wallet, or pay it yourself and pass params.feeTxHash.`,
          { terms },
          'DEPLOY_FEE_REQUIRED',
        );
      }
    }

    // Everything checkable is checked before anything is paid.
    if (body.provider !== '0g-compute' && !body.apiKey) {
      throw new ApiError(400, `A ${body.provider} agent needs params.apiKey to call its model. Nothing was paid.`, undefined, 'API_KEY_REQUIRED');
    }
    if (terms.chainId === undefined) {
      throw new ApiError(
        409,
        'This backend does not say which chain its deploy fee is paid on, so it cannot be paid safely from here. Nothing was paid.',
        { terms },
        'DEPLOY_FEE_CHAIN_UNKNOWN',
      );
    }
    const maxFee = BigInt(opts.maxFeeRaw ?? 1_000_000n);
    const payer = opts.payer ?? this.signerOn(terms.chain, 'Paying the deploy fee');
    const payerAddress = await payer.getAddress();
    await this.assertFeePayer(payerAddress);
    await assertSignerChain(payer, terms.chainId, 'The deploy fee');
    const timeoutMs = opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;

    if (terms.method === 'transfer') {
      const fee = BigInt(terms.amountRaw);
      this.assertFeeCeiling(fee, maxFee, terms.decimals);
      const data = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)'])
        .encodeFunctionData('transfer', [terms.recipient, fee]);
      let hash: string;
      try {
        ({ hash } = await sendAndWait(payer, { to: terms.token, data }, {
          onSent: opts.onFeePaid,
          timeoutMs,
          unconfirmedHint: (h) => `If it confirms, retry with params.feeTxHash = '${h}' so the fee is not paid twice.`,
        }));
      } catch (err) {
        if (err instanceof UnconfirmedTransactionError) throw this.withFee(err, err.hash, 'UNCONFIRMED');
        throw err;
      }
      return this.deployWithFee(body, hash, pollMs);
    }

    if (!terms.factory) throw new ApiError(503, 'This backend charges through AgentFactory but names no factory address.', { terms }, 'DEPLOY_FEE_UNAVAILABLE');
    const factory = new ethers.Interface(['function deployAgent(uint256 usdcAmount)', 'function deployFeeUsdc() view returns (uint256)', 'function usdc() view returns (address)']);
    const reader = payer.provider!;
    const [fee] = factory.decodeFunctionResult('deployFeeUsdc', await reader.call({ to: terms.factory, data: factory.encodeFunctionData('deployFeeUsdc') }));
    const [token] = factory.decodeFunctionResult('usdc', await reader.call({ to: terms.factory, data: factory.encodeFunctionData('usdc') }));
    this.assertFeeCeiling(fee as bigint, maxFee, 6);
    const nonce = await ensureAllowance(payer, token as string, terms.factory, fee as bigint, { timeoutMs });
    let factoryTx: string;
    try {
      ({ hash: factoryTx } = await sendAndWait(payer, { to: terms.factory, data: factory.encodeFunctionData('deployAgent', [0]) }, { nonce, timeoutMs }));
    } catch (err) {
      if (err instanceof UnconfirmedTransactionError) {
        throw new ApiError(0, `${err.message} If it confirms, its credit pays for the next deployAgent() call; do not pay again.`, { factoryTxHash: err.hash }, 'UNCONFIRMED');
      }
      throw err;
    }
    // The backend indexes the factory every 15s: the credit lags the payment.
    try {
      return { ...(await this.postDeploy(body, ['NO_DEPLOY_CREDIT'], 20, pollMs)), feeTxHash: factoryTx };
    } catch (err) {
      const e = err as Error & { status?: number; code?: string };
      throw new ApiError(
        e.status ?? 500,
        `${e.message} The fee was paid through AgentFactory (transaction ${factoryTx}): its credit stays with your wallet and pays for the next deployAgent() call, so do not pay again.`,
        err instanceof ApiError ? err.body : undefined,
        e.code,
      );
    }
  }

  /** Deploy with a fee transaction already paid: wait for the backend to see it, and make a retry safe. */
  private async deployWithFee(body: object, feeTxHash: string, pollMs: number): Promise<DeployedAgent> {
    try {
      const agent = await this.postDeploy({ ...body, feeTxHash }, ['DEPLOY_FEE_NOT_FOUND', 'DEPLOY_FEE_IN_USE', 'DEPLOY_FEE_CHECK_FAILED'], 4, pollMs);
      return { ...agent, feeTxHash };
    } catch (err) {
      // This payment already created an agent: a retry after a lost response.
      // Return it when it is the caller's.
      if (err instanceof ApiError && err.code === 'DEPLOY_FEE_ALREADY_USED') {
        const agentId = (err.body as { error?: { agentId?: string } } | undefined)?.error?.agentId;
        const existing = agentId ? await this.ownAgent(agentId).catch(() => null) : null;
        if (existing) return { ...existing, feeTxHash, alreadyDeployed: true };
      }
      throw this.withFee(err, feeTxHash);
    }
  }

  /** `agentId` as a DeployedAgent, when the API key's owner owns it; else null. */
  private async ownAgent(agentId: string): Promise<DeployedAgent | null> {
    const [agent, who] = await Promise.all([this.getAgent(agentId), this.whoami()]);
    const mine = new Set([who.address, ...(who.addresses ?? [])].map((a) => String(a).toLowerCase()));
    if (!agent?.ownerAddress || !mine.has(agent.ownerAddress.toLowerCase())) return null;
    const { id, name, walletAddress, publicKey, inftTokenId, status } = agent;
    return { id, name, walletAddress, publicKey, status, ...(inftTokenId !== undefined ? { inftTokenId } : {}) };
  }

  /**
   * An error after the fee was paid, carrying the payment: `feeTxHash` on the
   * error and in its body, and the message says how to reuse it. The
   * backend's code, status and envelope are kept.
   */
  private withFee(err: unknown, feeTxHash: string, fallbackCode?: string): ApiError {
    const e = err as Error & { status?: number; code?: string; body?: unknown };
    const spent = err instanceof ApiError && ['DEPLOY_FEE_ALREADY_USED', 'DEPLOY_FEE_NOT_PAID', 'DEPLOY_FEE_REVERTED'].includes(err.code ?? '');
    const message = spent || e.message.includes(feeTxHash)
      ? e.message
      : `${e.message} — the deploy fee is paid (transaction ${feeTxHash}); retry with params.feeTxHash = '${feeTxHash}' so it is not paid twice.`;
    const body = e.body && typeof e.body === 'object' ? { ...(e.body as object), feeTxHash } : { feeTxHash };
    const out = new ApiError(e.status ?? 0, message, body, e.code ?? fallbackCode);
    if (err instanceof ApiError && err.reason) out.reason = err.reason;
    out.feeTxHash = feeTxHash;
    return out;
  }

  private assertFeeCeiling(fee: bigint, maxFee: bigint, decimals: number): void {
    if (fee <= maxFee) return;
    const fmt = (v: bigint) => ethers.formatUnits(v, decimals).replace(/\.0$/, '');
    throw new ApiError(
      402,
      `The deploy fee is ${fmt(fee)} USDC, above your limit of ${fmt(maxFee)}. Nothing was paid. Raise opts.maxFeeRaw to pay it.`,
      { feeRaw: fee.toString(), maxFeeRaw: maxFee.toString() },
      'DEPLOY_FEE_ABOVE_MAX',
    );
  }

  /** POST /agents/deploy, asking again while the backend answers one of `retryCodes`. */
  private async postDeploy(body: object, retryCodes: string[], attempts: number, pollMs: number): Promise<DeployedAgent> {
    for (let i = 1; ; i++) {
      try {
        return await this.req<DeployedAgent>('POST', '/api/v1/agents/deploy', body);
      } catch (err) {
        if (!(err instanceof ApiError) || !retryCodes.includes(err.code ?? '') || i >= attempts) throw err;
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  }

  /** The configured executor as a signer on `chain`. */
  private signerOn(chain: string, what: string): ethers.Signer {
    if (!this.executor) {
      throw new ApiError(400, `${what} needs a signer: set BlindMarketConfig.executor, or pass one in the options.`, undefined, 'NO_SIGNER');
    }
    const rpc = this.executor.rpcUrls[chain];
    if (!rpc) throw new ApiError(400, `${what} happens on ${chain}, but no RPC is configured for it — set rpcUrls.${chain}.`, undefined, 'NO_RPC');
    return new ethers.Wallet(this.executor.privateKey, new ethers.JsonRpcProvider(rpc));
  }

  /**
   * One-shot executor registration in the A2A marketplace.
   *
   * The registered executor is ALWAYS the wallet that owns the API key — the
   * backend takes the address from auth, never from the request. Briefs are
   * wrapped to the public key registered here, and `submitEvidence` is built
   * for the owner address. So pass `privateKey` (or set
   * `BlindMarketConfig.executor`) — the OWNER wallet's key: its uncompressed
   * public key is registered, the key never leaves this process, and this
   * throws 409 OWNER_MISMATCH — BEFORE registering anything — when the key is
   * not the API key's owner (checked through `whoami()`).
   *
   * Without a key a random secp256k1 wallet is generated and its private key
   * returned **once** (store it securely). That wallet can decrypt briefs, but
   * it is not the registered executor address, so it cannot sign
   * `submitEvidence` for tasks the owner accepts — use it only when delivery
   * goes through another signer (e.g. the backend relay).
   *
   * @example
   * const { executor, wallet } = await bb.createAgent({
   *   privateKey: process.env.EXECUTOR_PRIVATE_KEY!, // the API key owner's wallet (or set BlindMarketConfig.executor)
   *   displayName: 'DataBot',
   *   capabilities: [AgentCap.DATA_PROCESSING, AgentCap.WEB_RESEARCH],
   *   minReward: '1000000', // 1 USDC (the payment token's smallest unit; USDC has 6 decimals)
   * });
   * console.log(`Registered executor ${executor.address}`);
   */
  async createAgent(params: CreateAgentParams): Promise<CreateAgentResult> {
    // With a key (params.privateKey, or BlindMarketConfig.executor) the agent
    // IS the API key owner's wallet, the only one that can settle. Without one
    // a random wallet is generated, as before — see the JSDoc for its limits.
    const privateKey = params.privateKey ?? this.executor?.privateKey;
    const wallet = privateKey ? new ethers.Wallet(privateKey) : ethers.Wallet.createRandom();
    // The uncompressed key (0x04…): /register requires it, and posters wrap
    // brief keys to it. `wallet.publicKey` is the compressed form in ethers v6.
    const publicKey = wallet.signingKey.publicKey;
    const executor: RegisterExecutorInput = {
      displayName: params.displayName,
      capabilities: params.capabilities,
      publicKey: publicKey.slice(2), // strip 0x prefix — backend expects raw hex
      agentCardUrl: params.agentCardUrl,
      mcpEndpointUrl: params.mcpEndpointUrl,
      minReward: params.minReward,
      preferredCapabilities: params.preferredCapabilities,
      supportedChains: params.supportedChains,
    };
    // Only when the caller supplied the key: they are claiming to be the owner.
    // Checked BEFORE /register, which upserts `publicKey` over the owner's
    // record — a mismatch found afterwards has already redirected every new
    // brief to a key whose wallet cannot sign submitEvidence.
    const ownerChecked = privateKey ? await this.assertOwnerKey(wallet.address) : false;
    const result = await this.registerExecutor(executor);
    // Backends without /api-keys/whoami could not be checked up front.
    if (privateKey && !ownerChecked && result.agent.address.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new ApiError(
        409,
        `Registered executor is ${result.agent.address} (the API key's owner) but privateKey belongs to ${wallet.address}. ` +
        'This backend has no /api-keys/whoami, so the mismatch could only be seen after registering: briefs are now wrapped to a key whose wallet cannot sign submitEvidence — re-run with the owner wallet\'s key, or mint an API key signed in as this wallet.',
        undefined,
        'OWNER_MISMATCH',
      );
    }
    return {
      executor: result.agent,
      wallet: {
        address: wallet.address as Address,
        publicKey,
        privateKey: wallet.privateKey,
      },
    };
  }

  /**
   * The wallet this API key authenticates as (`GET /api/v1/api-keys/whoami`).
   * /a2a/register and /accept act for `address`. A legacy shared
   * AGENT_API_KEY resolves to the non-wallet principal `"agent"`.
   */
  async whoami(): Promise<{ address: string; addresses?: string[] }> {
    return this.req('GET', '/api/v1/api-keys/whoami');
  }

  /**
   * Throws 409 OWNER_MISMATCH, without side effects, when `address` is not
   * the API key's owner. Returns false only when the backend has no whoami
   * route (404 / a non-JSON 404 page) and nothing could be checked.
   */
  private async assertOwnerKey(address: string): Promise<boolean> {
    let owner: string;
    try {
      owner = (await this.whoami()).address;
    } catch (err) {
      if (err instanceof SyntaxError || (err instanceof ApiError && err.status === 404)) return false;
      throw err;
    }
    if (typeof owner !== 'string' || owner.toLowerCase() !== address.toLowerCase()) {
      throw new ApiError(
        409,
        `This API key belongs to ${owner} but privateKey belongs to ${address}. Nothing was registered. ` +
          "The executor is always the API key's owner, and only that wallet can sign submitEvidence — use the owner wallet's key, or mint an API key signed in as this wallet.",
        undefined,
        'OWNER_MISMATCH',
      );
    }
    return true;
  }

  /**
   * Before a spend: throw 409 OWNER_MISMATCH unless `address` is a wallet the
   * backend will credit the spend to. `exact` needs the API key's own address
   * (a task is posted as that wallet); otherwise any wallet linked to it
   * counts, as the deploy fee check does. Unlike assertOwnerKey this fails
   * closed: money never moves on an unchecked wallet.
   */
  private async assertSpender(address: string, what: string, exact: boolean): Promise<void> {
    let who: { address: string; addresses?: string[] };
    try {
      who = await this.whoami();
    } catch (err) {
      throw new ApiError(
        err instanceof ApiError ? err.status : 503,
        `${what}: could not check which wallet this API key belongs to (${(err as Error).message}). Nothing was sent.`,
        undefined,
        'OWNER_UNCHECKED',
      );
    }
    const allowed = new Set([who.address, ...(exact ? [] : who.addresses ?? [])].filter((a) => typeof a === 'string').map((a) => a.toLowerCase()));
    if (!allowed.has(address.toLowerCase())) {
      throw new ApiError(
        409,
        `This API key belongs to ${who.address} but the signer is ${address}. Nothing was sent. ` +
          `${what} counts only from the API key's own wallet: sign with that wallet, or mint an API key signed in as this one.`,
        undefined,
        'OWNER_MISMATCH',
      );
    }
  }

  private assertFeePayer(address: string): Promise<void> {
    return this.assertSpender(address, 'A deploy fee', false);
  }

  /** List deployed agents, optionally filtered by owner address. */
  async listAgents(ownerAddress?: string): Promise<DeployedAgentInfo[]> {
    const qs = ownerAddress ? `?owner=${ownerAddress}` : '';
    return this.req<DeployedAgentInfo[]>('GET', `/api/v1/agents${qs}`);
  }

  /** Get a single deployed agent by ID. */
  async getAgent(id: string): Promise<DeployedAgentInfo> {
    return this.req<DeployedAgentInfo>('GET', `/api/v1/agents/${id}`);
  }

  /** Get an agent's on-chain wallet address. */
  async getAgentWallet(id: string): Promise<AgentWalletInfo> {
    return this.req<AgentWalletInfo>('GET', `/api/v1/agents/${id}/wallet`);
  }

  /** Start a deployed agent. Requires owner auth. */
  async startAgent(id: string): Promise<DeployedAgentInfo> {
    return this.req<DeployedAgentInfo>('POST', `/api/v1/agents/${id}/start`);
  }

  /** Stop a deployed agent. Requires owner auth. */
  async stopAgent(id: string): Promise<DeployedAgentInfo> {
    return this.req<DeployedAgentInfo>('POST', `/api/v1/agents/${id}/stop`);
  }

  /** Pause a deployed agent. Requires owner auth. */
  async pauseAgent(id: string): Promise<DeployedAgentInfo> {
    return this.req<DeployedAgentInfo>('POST', `/api/v1/agents/${id}/pause`);
  }

  /** Restart a deployed agent. Requires owner auth. */
  async restartAgent(id: string): Promise<DeployedAgentInfo> {
    return this.req<DeployedAgentInfo>('POST', `/api/v1/agents/${id}/restart`);
  }

  /**
   * Update a deployed agent's config (instructions, model, tools, etc.).
   * Requires owner auth.
   */
  async updateAgent(id: string, patch: Partial<{
    instructions: string;
    model: string;
    capabilities: string[];
    tools: object[];
    minReward: string;
  }>): Promise<DeployedAgentInfo> {
    return this.req<DeployedAgentInfo>('PATCH', `/api/v1/agents/${id}`, patch);
  }

  // ── A2A executor registration ───────────────────────────────────────────

  /**
   * Register as an A2A agent executor (worker-side). The executor address is
   * the API key's owner wallet (any `address` sent is ignored). `publicKey`
   * must be uncompressed secp256k1 hex, 130 chars, leading `04`, no 0x —
   * `new ethers.Wallet(pk).signingKey.publicKey.slice(2)`, NOT `wallet.publicKey`.
   */
  async registerExecutor(params: RegisterExecutorInput): Promise<{ agent: ExecutorProfile }> {
    return this.req('POST', '/api/v1/a2a/register', params);
  }

  /** List registered A2A executors, optionally filtered by capability. */
  async listExecutors(capabilities?: string[]): Promise<{ executors: ExecutorProfile[] }> {
    const qs = capabilities?.length ? `?capabilities=${capabilities.join(',')}` : '';
    return this.req('GET', `/api/v1/a2a/executors${qs}`);
  }

  /** Get own executor profile with on-chain + decayed reputation. */
  async getExecutorProfile(): Promise<{ agent: ExecutorProfile }> {
    return this.req('GET', '/api/v1/a2a/profile');
  }

  // ── A2A task lifecycle ───────────────────────────────────────────────────

  /**
   * Browse A2A tasks available for execution. Each entry is `{ meta, state }`
   * — the id and status live on `state` (`entry.state.taskId`), the chain and
   * deadline on `meta`.
   */
  async browseA2ATasks(params?: {
    capabilities?: string[];
    minReputation?: number;
  }): Promise<{ tasks: A2ATaskEntry[]; total?: number }> {
    const qs = new URLSearchParams();
    if (params?.capabilities?.length) qs.set('capabilities', params.capabilities.join(','));
    if (params?.minReputation != null) qs.set('minReputation', String(params.minReputation));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.req('GET', `/api/v1/a2a/tasks${suffix}`);
  }

  /** Register intent to accept a task (bid). */
  async bidOnTask(taskId: string): Promise<void> {
    return this.req('POST', `/api/v1/a2a/tasks/${taskId}/bid`);
  }

  /**
   * Accept a task and get the rootHash + ECIES-wrapped AES key for the
   * caller's address. Requires executor auth.
   *
   * Note the shape here matches `backend/src/routes/a2a.ts`'s `/accept`
   * handler exactly — there is no `task` field, and `wrappedKey` is a single
   * hex string (this executor's slice), not a `Record`.
   */
  async acceptTask(taskId: string): Promise<{
    taskId: string;
    status: string;
    rootHash?: RootHash;
    /** ECIES-wrapped AES key, hex-encoded with no 0x prefix. Absent on public tasks or legacy tasks with no brief. */
    wrappedKey?: string;
    /** 'public' means the blob at rootHash is plaintext — no wrappedKey by design. Absent means private/encrypted. */
    privacy?: 'public' | 'private';
    alreadySettled?: boolean;
    assignTxHash?: Hex;
    /** Which chain holds the task's escrow ('0g', 'base', …). Absent from
     *  backends older than the field, in which case the task is on 0G. */
    chain?: string;
  }> {
    return this.req('POST', `/api/v1/a2a/tasks/${taskId}/accept`);
  }

  /**
   * Submit result for an accepted task. Returns an unsigned `submitEvidence`
   * transaction — the contract requires the assigned worker to sign it
   * personally (`onlyWorker`), so the caller must sign + broadcast
   * `unsignedSubmitEvidence` and then call `finalize()`.
   */
  async submitResult(taskId: string, resultData: Record<string, unknown>): Promise<{
    taskId: string;
    onChainTaskId?: string;
    status: string;
    evidenceHash?: Hex;
    /** Which escrow the unsigned tx targets. Tasks are funded on exactly one
     *  chain; sign on that chain's RPC. Absent from backends older than the
     *  field, in which case the task is on 0G. A string, not a union: a newer
     *  backend can name a chain this SDK version doesn't know. */
    chain?: string;
    unsignedSubmitEvidence?: Record<string, unknown> | null;
  }> {
    return this.req('POST', `/api/v1/a2a/tasks/${taskId}/submit`, { resultData });
  }

  /**
   * Tell the backend your `submitEvidence` tx has confirmed on-chain so it
   * can proceed with verification — auto-verify, or hand off to the poster
   * / a designated verifier agent depending on the task's verificationMode.
   * Call this after signing and broadcasting `unsignedSubmitEvidence` from
   * `submitResult()`. Without this the escrow never settles.
   */
  async finalize(taskId: string): Promise<{
    taskId: string;
    status: string;
    verifier?: string;
    awaitingPosterApproval?: boolean;
    verificationResult?: { passed: boolean; reasons?: string[] };
    reconciled?: boolean;
  }> {
    return this.req('POST', `/api/v1/a2a/tasks/${taskId}/finalize`);
  }

  /**
   * Rebuild the unsigned `submitEvidence` for a task stranded in 'submitted'
   * — `/submit` flips the state when the tx is BUILT, so a crash before the
   * broadcast leaves `finalize()` failing with NOT_SUBMITTED_ON_CHAIN and
   * `submitResult()` refusing with INVALID_STATE. Sign + broadcast the
   * returned tx on `chain`, then call `finalize()`. 409 ALREADY_SUBMITTED
   * means the evidence did land — just call `finalize()`.
   */
  async rebroadcast(taskId: string): Promise<{
    taskId: string;
    onChainTaskId?: string;
    /** A string, not a union — see submitResult(). */
    chain?: string;
    evidenceHash?: Hex;
    unsignedSubmitEvidence?: Record<string, unknown> | null;
  }> {
    return this.req('POST', `/api/v1/a2a/tasks/${taskId}/rebroadcast`);
  }

  /**
   * Deliver a result end to end: `submitResult()` → sign + broadcast the
   * unsigned `submitEvidence` on the chain the backend names → `finalize()`.
   * Safe to re-call on a task stranded in 'submitted': INVALID_STATE at submit
   * and NOT_SUBMITTED_ON_CHAIN at finalize both heal through `rebroadcast()`.
   *
   * The executor key signs only a zero-value `submitEvidence(onChainTaskId,
   * evidenceHash)` on the escrow /health/settlement lists for that chain,
   * where (from /submit) evidenceHash is keccak256 of `JSON.stringify(resultData)`,
   * over an RPC checked to serve that chain, and only its to and data.
   * Anything else throws 409 ESCROW_MISMATCH, TX_MISMATCH, CHAIN_MISMATCH or
   * CHAIN_UNKNOWN (or WRONG_CHAIN for the RPC) with nothing sent.
   */
  async deliverResult(
    taskId: string,
    resultData: Record<string, unknown>,
    signerOverride?: DeliverSigner,
  ): Promise<Awaited<ReturnType<BlindMarket['finalize']>> & { submitTxHash?: string }> {
    const signer = signerOverride ?? this.executor;
    if (!signer) {
      throw new ApiError(400, 'deliverResult() needs a signer — pass one, or set BlindMarketConfig.executor. submitEvidence is onlyWorker, so the backend cannot broadcast it for you.');
    }
    // Read before /submit, which records the result: a lookup failing here
    // leaves nothing half-done.
    const settlement = await this.getSettlement();
    // The evidence the backend commits for this result (backend/src/routes/a2a.ts).
    const evidence = evidenceHashOf(resultData);
    const what = `Delivering task ${taskId}`;
    /**
     * Sign the submitEvidence the backend built, once it is checked to be a
     * zero-value submitEvidence on the escrow of the chain it names, for the
     * on-chain task it names, and (from /submit) committing THIS result. Only
     * its to and data are signed, on the signer's RPC for that chain, checked
     * to serve it. /rebroadcast re-sends the first stored result, so there the
     * evidence hash is not this call's.
     */
    const send = async (
      built: { chain?: string; onChainTaskId?: string | number; unsignedSubmitEvidence?: Record<string, unknown> | null },
      fromSubmit: boolean,
    ) => {
      if (!built.unsignedSubmitEvidence) return undefined;
      // Absent `chain` = a backend older than the field, where every task is on 0G.
      // Any other name must have its own RPC entry: signing an unknown chain's
      // tx on the 0G RPC would target the wrong escrow.
      const chain = built.chain ?? '0g';
      const rpc = signer.rpcUrls[chain];
      if (!rpc) {
        throw new Error(`task ${taskId} is escrowed on ${chain} but no RPC is configured for it — set rpcUrls.${chain}`);
      }
      const entry = await this.settlementEntry(chain, what, settlement);
      const onChainId = built.onChainTaskId === undefined ? undefined : taskIdOf(built.onChainTaskId);
      const call = checkEscrowCall(built.unsignedSubmitEvidence, {
        escrow: entry.escrowAddress,
        fn: 'submitEvidence',
        args: (a) => (built.onChainTaskId === undefined || a[0] === onChainId)
          && (!fromSubmit || String(a[1]).toLowerCase() === evidence),
        chainId: entry.chainId,
      }, what);
      const wallet = new ethers.Wallet(signer.privateKey, new ethers.JsonRpcProvider(rpc));
      await assertSignerChain(wallet, entry.chainId, what);
      const tx = await wallet.sendTransaction(call);
      await tx.wait();
      return tx.hash;
    };
    const healStranded = async () => {
      try {
        return await send(await this.rebroadcast(taskId), false);
      } catch (err) {
        // Evidence is already on-chain — nothing to broadcast, go finalize.
        if (err instanceof ApiError && err.code === 'ALREADY_SUBMITTED') return undefined;
        throw err;
      }
    };

    let submitTxHash: string | undefined;
    try {
      submitTxHash = await send(await this.submitResult(taskId, resultData), true);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'INVALID_STATE')) throw err;
      submitTxHash = await healStranded();
    }
    try {
      return { ...(await this.finalize(taskId)), submitTxHash };
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'NOT_SUBMITTED_ON_CHAIN')) throw err;
      submitTxHash = (await healStranded()) ?? submitTxHash;
      return { ...(await this.finalize(taskId)), submitTxHash };
    }
  }

  /**
   * Approve or reject the delivered result of a task you posted with
   * `verificationMode: 'manual'` (`POST /api/v1/a2a/tasks/:hash/verify`).
   * Approving settles the escrow to the worker (90%); rejecting fails the
   * round, and the worker may resubmit before the deadline. Only the poster
   * can review, and only once the task is `submitted`.
   */
  async reviewResult(taskHash: string, review: { passed: boolean; reasons?: string[] }): Promise<{ status?: string; verificationResult?: { passed: boolean; reasons?: string[] } }> {
    return this.req('POST', `/api/v1/a2a/tasks/${encodeURIComponent(taskHash)}/verify`, review);
  }

  /** Get tasks posted by the authenticated user. */
  async getPostedTasks(): Promise<{ tasks: A2ATaskEntry[]; total?: number }> {
    return this.req('GET', '/api/v1/a2a/tasks/posted');
  }

  /** Get tasks executed by the authenticated user. */
  async getExecutions(address?: string): Promise<{ executions: A2ATaskEntry[]; total: number }> {
    const qs = address ? `?address=${address}` : '';
    return this.req('GET', `/api/v1/a2a/executions${qs}`);
  }

  // ── Verification ─────────────────────────────────────────────────────────

  /**
   * Trigger TEE / AI verification for a task.
   */
  async verify(params: VerifyTaskInput): Promise<{
    passed: boolean;
    confidence: number;
    reasoning: string;
    teeVerified?: boolean;
  }> {
    return this.req('POST', '/api/v1/verification/verify', {
      taskHash: params.taskHash,
      taskCategory: params.taskCategory,
      ...(params.taskRequirements ? { taskRequirements: params.taskRequirements } : {}),
      evidenceSummary: params.evidenceSummary,
    });
  }

  /** List available 0G Compute inference providers. */
  async getVerificationProviders(): Promise<{ providers: Array<{ address: Address; model: string }> }> {
    return this.req('GET', '/api/v1/verification/providers');
  }

  /** Check if 0G Compute is configured. */
  async getVerificationStatus(): Promise<{ configured: boolean; provider?: string }> {
    return this.req('GET', '/api/v1/verification/status');
  }

  // ── Reputation ──────────────────────────────────────────────────────────

  /** Get merged reputation (on-chain + off-chain) for an address. */
  async getReputation(address: Address): Promise<ReputationInfo> {
    return this.req<ReputationInfo>('GET', `/api/v1/reputation/${address}`);
  }

  /** Get top workers by decayed score. */
  async getLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
    return this.req<LeaderboardEntry[]>('GET', `/api/v1/reputation/leaderboard?limit=${limit}`);
  }

  // ── Storage ─────────────────────────────────────────────────────────────

  /**
   * Upload a blob to 0G Storage. `data` is the bytes as **base64**: the
   * backend base64-decodes it. (The type once said Hex; a hex string sent
   * here uploads the wrong bytes.)
   */
  async uploadBlob(data: string): Promise<StorageUploadResult> {
    return this.req<StorageUploadResult>('POST', '/api/v1/storage/upload', { data });
  }

  /**
   * Download a blob by root hash. `blob` is base64-encoded raw bytes — the
   * caller decodes (and, for encrypted tasks, decrypts) it client-side.
   * Matches `backend/src/routes/storage.ts`'s `GET /:rootHash` handler,
   * which returns `{ rootHash, blob }`, not `{ data }`.
   */
  async downloadBlob(rootHash: Hex): Promise<{ rootHash: Hex; blob: string }> {
    return this.req('GET', `/api/v1/storage/${rootHash}`);
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  /** Send a message to another user or agent. */
  async sendMessage(params: {
    taskId: string;
    to: string;
    content: string;
  }): Promise<{ message: Message }> {
    return this.req('POST', '/api/v1/messages/send', params);
  }

  /** Get inbox messages. */
  async getInbox(): Promise<{ messages: Message[] }> {
    return this.req('GET', '/api/v1/messages/inbox');
  }

  /** Get unread message count. */
  async getUnreadCount(): Promise<{ count: number }> {
    return this.req('GET', '/api/v1/messages/unread-count');
  }

  // ── Marketplace ─────────────────────────────────────────────────────────

  /** Search agents by capability and/or minimum rating. */
  async searchAgents(params?: {
    capability?: string;
    minRating?: number;
  }): Promise<AgentSearchResult[]> {
    const qs = new URLSearchParams();
    if (params?.capability) qs.set('capability', params.capability);
    if (params?.minRating != null) qs.set('minRating', String(params.minRating));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.req<AgentSearchResult[]>('GET', `/api/v1/marketplace/agents/search${suffix}`);
  }

  /** List public task templates. */
  async listTemplates(): Promise<TaskTemplate[]> {
    return this.req<TaskTemplate[]>('GET', '/api/v1/marketplace/templates');
  }

  /** List own templates. */
  async listMyTemplates(): Promise<TaskTemplate[]> {
    return this.req<TaskTemplate[]>('GET', '/api/v1/marketplace/templates/mine');
  }

  /** Create a task template. */
  async createTemplate(params: Partial<TaskTemplate>): Promise<TaskTemplate> {
    return this.req<TaskTemplate>('POST', '/api/v1/marketplace/templates', params);
  }

  // ── Event watching ──────────────────────────────────────────────────────

  /**
   * Poll a task's status at a fixed interval. Calls `callback` on every change.
   * Returns an unsubscribe function.
   *
   * @example
   * const stop = bb.watchTask('42', (task) => {
   *   console.log('Status:', task.status);
   *   if (task.status === 'verified') stop();
   * });
   */
  watchTask(
    taskId: string,
    callback: (task: TaskDetail) => void,
    intervalMs = 5_000,
  ): () => void {
    let prev = '';
    const id = setInterval(async () => {
      try {
        const task = await this.getTask(taskId);
        const cur = task.a2aState?.status ?? String(task.status);
        if (cur !== prev) {
          prev = cur;
          callback(task);
        }
      } catch {
        // Silently retry on next tick
      }
    }, intervalMs);
    return () => clearInterval(id);
  }

  /**
   * Poll an agent's status at a fixed interval. Returns an unsubscribe function.
   */
  watchAgent(
    agentId: string,
    callback: (agent: DeployedAgentInfo) => void,
    intervalMs = 5_000,
  ): () => void {
    let prev = '';
    const id = setInterval(async () => {
      try {
        const agent = await this.getAgent(agentId);
        if (agent.status !== prev) {
          prev = agent.status;
          callback(agent);
        }
      } catch {
        // Silently retry on next tick
      }
    }, intervalMs);
    return () => clearInterval(id);
  }

  // ── Device-flow registration (static) ─────────────────────────────────────

  /**
   * Canonical registration challenge signed by the agent wallet, proving
   * control of `agentWallet`. Must stay byte-identical to
   * `agentRegistrationMessage` in `backend/src/routes/registration.ts` — the
   * SDK cannot import from the backend, so this is duplicated. A mismatch
   * here silently breaks registration.
   */
  private static agentRegistrationMessage(agentName: string, agentWallet: string, agentPublicKey: string): string {
    return `BlindMarket agent registration\nname: ${agentName}\nwallet: ${agentWallet.toLowerCase()}\npubkey: ${agentPublicKey.toLowerCase()}`;
  }

  /**
   * Start a device-flow registration session. Generates a magic-link URL
   * that the user opens in a browser to sign with their wallet.
   *
   * After registering, call `BlindMarket.pollSession(token)` to wait for
   * the user to confirm and receive the API key.
   *
   * Requires proof of control of `agentWallet`: pass either `agentSigner`
   * (anything with a `signMessage`, e.g. an ethers `Wallet`) so the SDK signs
   * the challenge itself, or a pre-computed `agentSignature` for callers
   * holding a remote signer. Exactly one of the two is required.
   *
   * @example
   * ```ts
   * const wallet = ethers.Wallet.createRandom();
   * const { url, token } = await BlindMarket.register({
   *   agentName: 'my-agent',
   *   agentWallet: wallet.address,
   *   agentPublicKey: wallet.signingKey.publicKey.slice(2), // uncompressed, no 0x
   *   agentSigner: wallet,
   * });
   * console.log('Open', url, 'to confirm');
   * const apiKey = await BlindMarket.pollSession(token);
   * const bb = new BlindMarket({ apiKey });
   * ```
   */
  static async register(params: {
    agentName: string;
    agentWallet: string;
    agentPublicKey: string;
    /** Signs the registration challenge proving control of agentWallet. */
    agentSigner?: { signMessage(message: string): Promise<string> };
    /** Pre-computed alternative to agentSigner, for callers holding a remote signer. */
    agentSignature?: string;
    apiBase?: string;
  }): Promise<{ token: string; url: string }> {
    if (!params.agentSigner === !params.agentSignature) {
      throw new ApiError(
        400,
        'Exactly one of agentSigner or agentSignature is required to prove control of agentWallet',
      );
    }
    const message = BlindMarket.agentRegistrationMessage(params.agentName, params.agentWallet, params.agentPublicKey);
    const agentSignature = params.agentSignature ?? await params.agentSigner!.signMessage(message);

    const base = params.apiBase ?? 'https://api.blindmarket.xyz';
    const res = await fetch(`${base}/api/v1/registration/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentName: params.agentName,
        agentWallet: params.agentWallet,
        agentPublicKey: params.agentPublicKey,
        agentSignature,
      }),
    });
    const json = await res.json() as { success: boolean; data?: { token: string; url: string }; error?: { message: string } };
    if (!json.success) throw new ApiError(res.status, json.error?.message ?? 'Registration failed', json);
    return json.data!;
  }

  /**
   * Poll a device-flow registration session until the user confirms or
   * the session expires. Returns the API key to use with `new BlindMarket({ apiKey })`.
   *
   * @param token - The session token from `BlindMarket.register()`.
   * @param apiBase - Optional custom API base URL.
   * @param intervalMs - Poll interval (default 2s).
   * @param timeoutMs - Max wait time (default 5min).
   */
  static async pollSession(
    token: string,
    apiBase?: string,
    intervalMs = 2_000,
    timeoutMs = 300_000,
  ): Promise<string> {
    const base = apiBase ?? 'https://api.blindmarket.xyz';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/api/v1/registration/session/${token}`);
      const json = await res.json() as { success: boolean; data?: { status: string; apiKey?: string }; error?: { message: string } };
      if (!json.success) throw new ApiError(res.status, json.error?.message ?? 'Session lookup failed', json);
      if (json.data?.status === 'confirmed' && json.data?.apiKey) return json.data.apiKey;
      if (json.data?.status === 'pending') {
        await new Promise(r => setTimeout(r, intervalMs));
        continue;
      }
      throw new Error(`Unexpected session status: ${json.data?.status}`);
    }
    throw new Error('Registration session timed out');
  }
}

export { ethers };
export { ApiError };
export {
  tools,
  createBlindMarketTools, createTaskTools, createAgentManagementTools, createA2ATools,
  toLangChainTools, toVercelTools, toOpenAITools, toClaudeTools,
} from './tools/index.js';
export type { Tool, ToolKit, ToolDefinition } from './tools/types.js';
export type { BlindMarketTools } from './tools/index.js';
export * from './executor/index.js';
export * from './types.js';

// Chain abstraction layer
export { EVMChainAdapter } from './chain/evm/index.js';
export { createChainAdapter } from './chain/createChainAdapter.js';
export type { CreateChainAdapterOptions } from './chain/createChainAdapter.js';
export type { IBlindMarketChain } from './chain/IBlindMarketChain.js';
export type {
  Network,
  EVMNetwork,
  BlockchainType,
  CreateTaskParams,
  DomainTask,
  DomainTaskMeta,
  DomainReputation,
  DomainTxReceipt,
  ChainSigner,
} from './chain/domain-types.js';
export { isEVMNetwork } from './network/resolve.js';