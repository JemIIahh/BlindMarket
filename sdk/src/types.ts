export type Address = `0x${string}`;
export type Hex = `0x${string}`;
export type TaskId = bigint;
export type RootHash = Hex;

export type TokenSymbol = 'USDC' | 'A0GI' | string;

export interface TokenRef {
  address: Address;
  symbol?: TokenSymbol;
  decimals?: number;
}

export interface Reward {
  token: Address | TokenSymbol;
  amount: bigint;
}

export type TaskStatus =
  | 'funded'
  | 'assigned'
  | 'submitted'
  | 'verified'
  | 'completed'
  | 'cancelled'
  | 'disputed';

export interface TaskMetadata {
  category: string;
  locationZone: string;
  reward: Reward;
  deadline?: Date;
  extra?: Record<string, string>;
}

export interface TaskRecord extends TaskMetadata {
  taskId: TaskId;
  agent: Address;
  worker?: Address;
  taskHash: RootHash;
  evidenceHash?: RootHash;
  status: TaskStatus;
  createdAt: Date;
}

export interface TaskKey {
  /** AES-256 symmetric key (32 bytes) used to encrypt task content. */
  aesKey: Uint8Array;
  createdAt: Date;
}

export interface TaskKeyRef {
  taskId: TaskId;
  createdAt: Date;
}

export interface UploadResult {
  rootHash: RootHash;
  txHash?: Hex;
  size: number;
}

export interface VerificationResult {
  passed: boolean;
  confidence: number;
  model: string;
  attestation?: Hex;
  completedAt: Date;
}

export interface TxReceiptLike {
  hash: Hex;
  blockNumber: number;
  gasUsed: bigint;
}

export type Awaitable<T> = T | Promise<T>;

// ── REST API types ──────────────────────────────────────────────────────────

export interface HealthStatus {
  status: string;
  timestamp: string;
}

export interface PlatformStats {
  openTasks: number;
  activeAgents: number;
  activeValidators: number;
  totalAgents: number;
  registeredUsers: number;
  completedTasks: number;
  activeWorkers: number;
}

export interface OpenTask {
  id: number;
  agent: Address;
  worker?: Address;
  amount: string;
  token: Address;
  category: string;
  locationZone: string;
  deadline: number;
  status: number;
  taskHash?: Hex;
}

/**
 * Body of `POST /api/v1/tasks` — mirrors `createTaskSchema` in
 * `backend/src/routes/tasks.ts`. The poster is the authenticated caller; the
 * deadline is derived on-chain from `duration`.
 */
export interface CreateTaskRequest {
  /** bytes32 commitment to the brief (0x + 64 hex) — sha256 of the ciphertext. */
  taskHash: Hex;
  /** Payment token address (USDC on Base; the zero address = native on 0G). */
  token: Address;
  /** Reward, as an integer string in the payment token's smallest unit. */
  amount: string;
  locationZone: string;
  /** Task duration in SECONDS, as a string. */
  duration: string;
  targetExecutorType?: 'human' | 'agent';
  /**
   * 'oracle' is deliberately absent: it is reserved/unwired and the index route
   * rejects it (400 VERIFICATION_MODE_UNSUPPORTED).
   */
  verificationMode?: 'manual' | 'auto' | 'agent';
  /** Designated verifier — only with verificationMode 'agent'. */
  verifierAddress?: Address;
  /**
   * REQUIRED in practice for 'auto': `POST /a2a/tasks/index` rejects an 'auto'
   * task without at least one real check (400 AUTO_CRITERIA_REQUIRED) —
   * min_length, contains_keywords, required_fields, expected_schema,
   * regex_pattern, rubric, forbidden_phrases or expected_answer. Send the same
   * criteria to both calls.
   */
  verificationCriteria?: Record<string, unknown>;
  requiredCapabilities?: AgentCapability[];
  /** 0G Storage root hash of the (encrypted) brief. */
  rootHash?: string;
  /** Lowercased executor address → hex ECIES blob (no 0x) of the brief AES key. */
  wrappedKeys?: Record<string, string>;
}

export interface CreateTaskTx {
  unsignedTx: {
    to: Address;
    data: Hex;
    value?: string;
  };
}

export interface TaskDetail extends OpenTask {
  metadata?: Record<string, unknown>;
  a2aState?: A2ATaskState;
}

/** Mirrors `A2ATaskStateStatus` in `backend/src/types.ts`. */
export type A2ATaskStatus =
  | 'open'
  | 'accepted'
  | 'in_progress'
  | 'submitted'
  | 'awaiting_verification'
  | 'verified'
  | 'completed'
  | 'failed';

export interface A2ATaskState {
  taskId: string;
  /** One of A2ATaskStatus; left open so a newer backend doesn't break parsing. */
  status: A2ATaskStatus | (string & {});
  failedReason?: string;
  executorAddress?: string;
  acceptedAt?: string;
  submittedAt?: string;
  resultData?: Record<string, unknown> | null;
  verificationResult?: {
    passed: boolean;
    reasons: string[];
    score?: number;
    breakdown?: Array<{ name: string; score: number; weight: number; reason: string; error?: string }>;
  };
  assignTxHash?: Hex;
  verifyTxHash?: Hex;
  wrappedKeys?: Record<string, string>;
}

/**
 * Public task metadata as served by the unauthenticated browse surface
 * (`projectPublicMeta` in the backend): key material is stripped, and
 * `rootHash` appears only on public tasks.
 */
export interface A2APublicTaskMeta {
  taskId: string;
  targetExecutorType?: 'human' | 'agent';
  verificationMode?: string;
  requiredCapabilities?: AgentCapability[];
  posterAddress?: string;
  /** Which escrow holds the task. Absent on rows indexed before the field existed. */
  chain?: 'base' | '0g';
  /** Unix seconds. */
  deadline?: number;
  privacy?: 'public';
  hasEncryptedBrief?: boolean;
  rootHash?: string;
  [key: string]: unknown;
}

/** One entry of `GET /api/v1/a2a/tasks` (and /tasks/posted, /executions). */
export interface A2ATaskEntry {
  meta: A2APublicTaskMeta;
  state: A2ATaskState;
}

export interface ExecutorProfile {
  address: Address;
  displayName: string;
  capabilities: AgentCapability[];
  publicKey: string;
  reputation: number;
  tasksCompleted: number;
  /** Native 0G earned, in wei (18 decimals). */
  totalEarnedRaw: string;
  /** USDC earned, in base units (6 decimals). Absent from backends older than Sep 2026. */
  totalEarnedUsdcRaw?: string;
  minReward?: string;
  preferredCapabilities?: AgentCapability[];
  /** Settlement chains the executor declared at registration. `null` means it
   *  never declared any, which the backend treats as 0G and Base. Absent from
   *  backends that predate the field. */
  supportedChains?: string[] | null;
  registeredAt: string;
  decayedScore?: number;
  disputeRatio?: number;
  avgRating?: number;
}

export interface RegisterExecutorInput {
  /**
   * Ignored by the backend: the registered executor is ALWAYS the wallet that
   * owns the API key. Kept optional for source compatibility.
   */
  address?: Address;
  displayName: string;
  capabilities: AgentCapability[];
  /** Uncompressed secp256k1 public key: 130 hex chars, leading `04`, NO 0x prefix. */
  publicKey: string;
  agentCardUrl?: string;
  mcpEndpointUrl?: string;
  minReward?: string;
  preferredCapabilities?: AgentCapability[];
  /** Settlement chains ('0g', 'base', …) this executor can sign
   *  `submitEvidence` on. The backend only offers and assigns it tasks
   *  escrowed on these chains. Omitted: the backend's default, 0G and Base.
   *  Backends that predate the field ignore it. */
  supportedChains?: string[];
}

/** Params for BlindMarket.createAgent() — derives the pubkey from your key + registers the executor in one call. */
export interface CreateAgentParams {
  /**
   * Private key of the wallet that OWNS the API key. The backend registers the
   * API key's owner as the executor (never an address from the request), wraps
   * briefs to the public key registered here, and builds `submitEvidence` for
   * the owner address — so this must be that wallet's key. Never sent to the
   * backend; only its public half is. Defaults to
   * `BlindMarketConfig.executor.privateKey`. With neither, a random wallet is
   * generated (it can decrypt briefs but cannot sign `submitEvidence` for the
   * owner's address).
   */
  privateKey?: string;
  /** Display name for the agent in the marketplace. */
  displayName: string;
  /** Capabilities this agent offers. Use AgentCap.DATA_PROCESSING etc. */
  capabilities: AgentCapability[];
  /** Which of the above the agent prefers (subset of capabilities). */
  preferredCapabilities?: AgentCapability[];
  /** Minimum reward per task, as an integer string in the payment token's smallest unit (USDC: 6 decimals). */
  minReward?: string;
  /** Agent card URL for marketplace display. */
  agentCardUrl?: string;
  /** MCP endpoint URL for tool-based agents. */
  mcpEndpointUrl?: string;
  /** Settlement chains the agent can sign `submitEvidence` on. See
   *  {@link RegisterExecutorInput.supportedChains}. */
  supportedChains?: string[];
}

/** Result of BlindMarket.createAgent(). */
export interface CreateAgentResult {
  /** The registered executor — `executor.address` is the API key's owner wallet. */
  executor: ExecutorProfile;
  /** The wallet of the `privateKey` you passed in, or the generated one. */
  wallet: {
    address: Address;
    /** Uncompressed secp256k1 public key, 0x-prefixed (`0x04…`); registered without the 0x. */
    publicKey: string;
    privateKey: string; // hex with 0x prefix — ⚠️ store securely; a generated key is shown once
  };
}

export interface DeployedAgentInfo {
  id: string;
  name: string;
  ownerAddress: Address;
  walletAddress: Address;
  publicKey: string;
  status: string;
  provider: string;
  model: string;
  capabilities: AgentCapability[];
  inftTokenId?: number;
  deployedAt: string;
  lastActiveAt?: string;
  minReward?: string;
}

export interface AgentWalletInfo {
  walletAddress: Address;
  publicKey: string;
}

export interface ReputationInfo {
  address: Address;
  onChainScore: number;
  decayedScore: number;
  totalTasks: number;
  disputesLost: number;
  disputeRatio: number;
}

export interface LeaderboardEntry extends ReputationInfo {
  rank: number;
  displayName?: string;
}

export interface StorageUploadResult {
  rootHash: RootHash;
  size: number;
}

export interface Message {
  id: number;
  taskId: string;
  fromAddress: Address;
  toAddress: Address;
  content: string;
  read: boolean;
  createdAt: string;
}

export interface AgentSearchResult {
  address: Address;
  displayName: string;
  capabilities: string[];
  avgRating: number;
  reviewCount: number;
  badgeCount: number;
  reputation: number;
}

export interface TaskTemplate {
  id: number;
  title: string;
  description: string;
  category: string;
  instructions: string;
  verificationCriteria: Record<string, unknown>;
  requiredCapabilities?: string[];
  estimatedReward?: string;
}

export interface VerifyTaskInput {
  /** taskHash (bytes32 hex). Not the numeric on-chain id — those collide
   *  across 0G and Base, so they cannot identify a task. */
  taskHash: string;
  taskCategory: string;
  /** Optional supplemental requirements. The backend builds the standard being
   *  judged against from the task the poster created; this is accepted only
   *  from the poster or the designated verifier, never the executor. */
  taskRequirements?: string;
  evidenceSummary: string;
}

// ── Agent capabilities ───────────────────────────────────────────────────────

/** Dot-notation access to valid capability strings. */
export const AgentCap = {
  DATA_PROCESSING: 'data_processing',
  WEB_RESEARCH: 'web_research',
  CODE_EXECUTION: 'code_execution',
  CONTENT_GENERATION: 'content_generation',
  API_INTEGRATION: 'api_integration',
  TEXT_ANALYSIS: 'text_analysis',
  TRANSLATION: 'translation',
  SUMMARIZATION: 'summarization',
  IMAGE_ANALYSIS: 'image_analysis',
  DOCUMENT_PROCESSING: 'document_processing',
  MATH_COMPUTATION: 'math_computation',
  DATA_EXTRACTION: 'data_extraction',
  REPORT_GENERATION: 'report_generation',
  CODE_REVIEW: 'code_review',
  TESTING: 'testing',
  SCHEDULING: 'scheduling',
  EMAIL_DRAFTING: 'email_drafting',
  SOCIAL_MEDIA: 'social_media',
  MARKET_RESEARCH: 'market_research',
  COMPETITIVE_ANALYSIS: 'competitive_analysis',
} as const;

export type AgentCapability = typeof AgentCap[keyof typeof AgentCap];
