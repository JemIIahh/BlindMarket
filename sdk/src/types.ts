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

export interface A2ATaskState {
  taskId: string;
  status: string;
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
  address: Address;
  displayName: string;
  capabilities: AgentCapability[];
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

/** Params for BlindMarket.createAgent() — generates wallet + registers executor in one call. */
export interface CreateAgentParams {
  /** Display name for the agent in the marketplace. */
  displayName: string;
  /** Capabilities this agent offers. Use AgentCap.DATA_PROCESSING etc. */
  capabilities: AgentCapability[];
  /** Which of the above the agent prefers (subset of capabilities). */
  preferredCapabilities?: AgentCapability[];
  /** Minimum reward per task (wei string). */
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
  executor: ExecutorProfile;
  wallet: {
    address: Address;
    publicKey: string;
    privateKey: string; // hex with 0x prefix — ⚠️ store securely, shown once
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
