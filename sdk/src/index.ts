import { ethers } from 'ethers';
import type {
  Address, Hex, RootHash, HealthStatus, PlatformStats, OpenTask, TaskDetail,
  CreateTaskTx, ExecutorProfile, RegisterExecutorInput,
  DeployedAgentInfo, AgentWalletInfo, ReputationInfo, LeaderboardEntry,
  StorageUploadResult, Message, AgentSearchResult, TaskTemplate,
  VerifyTaskInput, A2ATaskState, AgentCapability,
  CreateAgentParams, CreateAgentResult,
} from './types.js';

// ── Public config ───────────────────────────────────────────────────────────

export interface BlindMarketConfig {
  /** Backend API base URL (default: https://api.blindmarket.xyz) */
  apiBase?: string;
  /** API key — shared AGENT_API_KEY or device-flow token */
  apiKey: string;
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
  ) {
    super(message);
    this.name = 'ApiError';
  }
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

  constructor(config: BlindMarketConfig) {
    this.apiBase = config.apiBase ?? 'https://api.blindmarket.xyz';
    this.apiKey = config.apiKey;
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
    const json = await res.json() as { success: boolean; data?: T; error?: { message: string } };
    if (!json.success) {
      throw new ApiError(res.status, json.error?.message ?? `HTTP ${res.status}`, json);
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
   * You must sign and broadcast it with your wallet.
   */
  async createTask(params: {
    agent: Address;
    amount: string;
    token: Address;
    category: string;
    locationZone: string;
    deadline: number;
  }): Promise<CreateTaskTx> {
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
   *   ownerPublicKey: wallet.publicKey,
   * });
   */
  async deployAgent(params: DeployAgentParams): Promise<DeployedAgent> {
    return this.req<DeployedAgent>('POST', '/api/v1/agents/deploy', params);
  }

  /**
   * One-shot agent creation: generates a secp256k1 wallet, then registers the
   * agent as an executor in the A2A marketplace with the generated wallet
   * address and public key. Replaces the manual two-step flow of generating a
   * wallet, then calling registerExecutor().
   *
   * The private key is returned **once** in the response — store it securely.
   *
   * @example
   * const { executor, wallet } = await bb.createAgent({
   *   displayName: 'DataBot',
   *   capabilities: [AgentCap.DATA_PROCESSING, AgentCap.WEB_RESEARCH],
   *   minReward: '1000000', // 1 USDC (the payment token's smallest unit; USDC has 6 decimals)
   * });
   * console.log(`Agent ${wallet.address} registered as ${executor.address}`);
   */
  async createAgent(params: CreateAgentParams): Promise<CreateAgentResult> {
    const wallet = ethers.Wallet.createRandom();
    const executor: RegisterExecutorInput = {
      address: wallet.address as Address,
      displayName: params.displayName,
      capabilities: params.capabilities,
      publicKey: wallet.publicKey.slice(2), // strip 0x prefix — backend expects raw hex
      agentCardUrl: params.agentCardUrl,
      mcpEndpointUrl: params.mcpEndpointUrl,
      minReward: params.minReward,
      preferredCapabilities: params.preferredCapabilities,
    };
    const result = await this.registerExecutor(executor);
    return {
      executor: result.agent,
      wallet: {
        address: wallet.address as Address,
        publicKey: wallet.publicKey,
        privateKey: wallet.privateKey,
      },
    };
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

  /** Register as an A2A agent executor (worker-side). */
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

  /** Browse A2A tasks available for execution. */
  async browseA2ATasks(params?: {
    capabilities?: string[];
    minReputation?: number;
  }): Promise<{ tasks: A2ATaskState[] }> {
    const qs = new URLSearchParams();
    if (params?.capabilities) qs.set('capabilities', params.capabilities.join(','));
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

  /** Get tasks posted by the authenticated user. */
  async getPostedTasks(): Promise<{ tasks: A2ATaskState[] }> {
    return this.req('GET', '/api/v1/a2a/tasks/posted');
  }

  /** Get tasks executed by the authenticated user. */
  async getExecutions(address?: string): Promise<{ tasks: A2ATaskState[] }> {
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
   *   agentPublicKey: wallet.publicKey,
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