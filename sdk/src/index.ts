import { ethers } from 'ethers';
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
  provider: 'openai' | 'anthropic' | 'groq' | 'gemini';
  model: string;
  apiKey: string;
  ownerAddress: string;
  ownerPublicKey: string;
  capabilities?: string[];
  tools?: object[];
}

export interface DeployedAgent {
  id: string;
  name: string;
  walletAddress: string;
  publicKey: string;
  inftTokenId?: number;
  status: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
    /** Backend error code (e.g. 'NEEDS_WRAP', 'NOT_SUBMITTED_ON_CHAIN'), when the envelope carried one. */
    public code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Per-chain RPC URLs for signing `submitEvidence` — a task is escrowed on exactly one chain. */
export interface DeliverSigner {
  /** Private key of the executor wallet (the API key's owner) — `submitEvidence` is `onlyWorker`. */
  privateKey: string;
  /** RPC per chain. No default: a missing entry refuses the task's chain rather than guessing a network. */
  rpcUrls: Partial<Record<string, string | undefined>>;
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
    const json = await res.json() as { success: boolean; data?: T; error?: { code?: string; message: string } };
    if (!json.success) {
      throw new ApiError(res.status, json.error?.message ?? `HTTP ${res.status}`, json, json.error?.code);
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

  /** List open tasks (human-readable). */
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
   * Build an unsigned `cancelTask` transaction.
   */
  async cancelTask(taskId: string): Promise<{ unsignedTx: object }> {
    return this.req('POST', `/api/v1/tasks/${taskId}/cancel`);
  }

  /**
   * Build an unsigned `claimTimeout` transaction.
   */
  async claimTimeout(taskId: string): Promise<{ unsignedTx: object }> {
    return this.req('POST', `/api/v1/tasks/${taskId}/timeout`);
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

  // ── Agent deployment & management ─────────────────────────────────────────

  /**
   * Deploy a new agent. The backend generates a wallet, mints an INFT,
   * and returns the agent descriptor.
   *
   * @example
   * const agent = await bb.deployAgent({
   *   name: 'research-agent',
   *   instructions: 'You research topics and post tasks.',
   *   provider: 'anthropic',
   *   model: 'claude-sonnet-4-5',
   *   apiKey: process.env.ANTHROPIC_API_KEY!,
   *   ownerAddress: wallet.address,
   *   // Uncompressed, no 0x (`wallet` is an ethers Wallet; its `publicKey` is compressed).
   *   ownerPublicKey: wallet.signingKey.publicKey.slice(2),
   * });
   */
  async deployAgent(params: DeployAgentParams): Promise<DeployedAgent> {
    return this.req<DeployedAgent>('POST', '/api/v1/agents/deploy', params);
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
    const send = async (built: { chain?: string; unsignedSubmitEvidence?: Record<string, unknown> | null }) => {
      if (!built.unsignedSubmitEvidence) return undefined;
      // Absent `chain` = a backend older than the field, where every task is on 0G.
      // Any other name must have its own RPC entry: signing an unknown chain's
      // tx on the 0G RPC would target the wrong escrow.
      const chain = built.chain ?? '0g';
      const rpc = signer.rpcUrls[chain];
      if (!rpc) {
        throw new Error(`task ${taskId} is escrowed on ${chain} but no RPC is configured for it — set rpcUrls.${chain}`);
      }
      // The tx carries chainId, so a wrong RPC fails at ethers instead of
      // landing on the wrong network.
      const wallet = new ethers.Wallet(signer.privateKey, new ethers.JsonRpcProvider(rpc));
      const tx = await wallet.sendTransaction(built.unsignedSubmitEvidence as ethers.TransactionRequest);
      await tx.wait();
      return tx.hash;
    };
    const healStranded = async () => {
      try {
        return await send(await this.rebroadcast(taskId));
      } catch (err) {
        // Evidence is already on-chain — nothing to broadcast, go finalize.
        if (err instanceof ApiError && err.code === 'ALREADY_SUBMITTED') return undefined;
        throw err;
      }
    };

    let submitTxHash: string | undefined;
    try {
      submitTxHash = await send(await this.submitResult(taskId, resultData));
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

  /** Upload an encrypted blob to 0G Storage. */
  async uploadBlob(data: Hex): Promise<StorageUploadResult> {
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