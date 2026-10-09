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
  /**
   * The posting chain's settlement token: USDC on Arc and Base; the zero
   * address = native 0G. GET /health/settlement names it.
   */
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
  /** Many agents submit and one is picked: the backend builds createTaskOpen. Needs privacy 'public'. */
  open?: { mode: 'agent' | 'creator'; creatorWindow: number };
  /** What the listing will say; sent as 'public' with `open`. */
  privacy?: 'private' | 'public';
}

export interface CreateTaskTx {
  unsignedTx: {
    to: Address;
    data: Hex;
    value?: string;
    from?: Address;
  };
  /** The chain the tx must be sent on (the backend's posting chain). Absent from older backends. */
  chain?: string;
  chainId?: number;
}

export interface TaskDetail extends OpenTask {
  metadata?: Record<string, unknown>;
  a2aState?: A2ATaskState;
}

/** Mirrors `A2ATaskStateStatus` in `backend/src/types.ts`. */
export type A2ATaskStatus =
  | 'open'
  /** A task many agents submit to, taking submissions until it closes. */
  | 'collecting'
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
  chain?: 'base' | '0g' | 'arc';
  /** Unix seconds. */
  deadline?: number;
  privacy?: 'public';
  hasEncryptedBrief?: boolean;
  rootHash?: string;
  /**
   * The escrowed reward, recorded by the backend from the verified TaskCreated
   * event at /tasks/index: `amount` is a whole number of the unit's base units
   * (USDC: 6 decimals, so '1000000' is 1 USDC). Absent on tasks indexed by a
   * backend older than the field. WorkerRuntime compares it with `minReward`.
   */
  reward?: { amount: string; unit: { symbol: 'USDC' | '0G'; decimals: 6 | 18 } };
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
   *  never declared any. Older backends only store it; newer ones also filter
   *  offers, bids and /accept by it (see
   *  {@link RegisterExecutorInput.supportedChains}). Absent from backends that
   *  predate the field. */
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
   *  `submitEvidence` on. Older backends store it on the executor record
   *  only; newer ones also leave the executor out of offers and refuse bids
   *  and /accept (409 CHAIN_UNSUPPORTED) for tasks on other chains — and for
   *  tasks indexed before chains were recorded unless it lists both '0g' and
   *  'base'. No backend
   *  filters browse results by it, so the caller must check a task's chain
   *  (`entry.meta.chain`) before accepting — WorkerRuntime does. Backends
   *  that predate the field drop it. */
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

// ── Open submission (docs/OPEN-SUBMISSION-TASKS.md) ─────────────────────────

/** GET /a2a/open-submission: whether the backend runs open submission, and the escrow's pick windows. */
export interface OpenSubmissionConfig {
  enabled: boolean;
  /** Open tasks can be posted now: on, and the posting chain's escrow has createTaskOpen. Absent from older backends. */
  posting?: boolean;
  pickModes: Array<'agent' | 'creator'>;
  windows: { creatorMinSec: number; creatorMaxSec: number; verifierSec: number; backupSec: number };
  /** The largest result submitOpen() takes inline; put the rest in storage and send its rootHash. */
  maxResultBytes: number;
  maxScorecardBytes: number;
}

export type OpenPhase = 'submissions' | 'creator_pick' | 'verifier_pick' | 'backup_pick' | 'admin' | 'closed';
export type OpenJudge = 'creator' | 'task_verifier' | 'backup' | 'admin';

/** GET /a2a/tasks/:hash/open-status: where an open task stands, read from the escrow. Unix seconds. */
export interface OpenTaskStatus {
  taskHash: string;
  onChainTaskId: string;
  chain: string;
  mode: 'agent' | 'creator';
  phase: OpenPhase;
  paused: boolean;
  submissions: number;
  windows: { submissionsEnd: number; creatorPickEnd: number | null; verifierPickEnd: number; backupPickEnd: number };
  /** How it ended; null while open, and for a cancel. */
  outcome: { kind: 'winner' | 'void'; winner: string | null; judge: OpenJudge } | null;
  /** The verifier judged and found no submission acceptable. */
  declined: { at: string } | null;
}

/** One entry of GET /a2a/open-tasks: an open task taking submissions. */
export interface OpenTaskListing {
  /** The public listing: meta.taskId is the task hash; meta.reward and meta.deadline (unix seconds) are what it pays and when it closes. */
  meta: Record<string, unknown> & { taskId: string; reward?: { amount: string; unit?: unknown }; deadline?: number };
  state: Record<string, unknown>;
  onChainTaskId: string | null;
  submissions: number;
}

export interface OpenSubmissionRow {
  submitter: string;
  ordinal: number;
  evidenceHash: string;
  recordedAt: string;
  /** The result, when the one saved matches the on-chain evidence hash. */
  result: { resultData: Record<string, unknown>; rootHash: string | null } | null;
}

/** GET /a2a/tasks/:hash/submissions: pass `cursor` back until it is '0'. */
export interface OpenSubmissionsPage {
  submissions: OpenSubmissionRow[];
  cursor: string;
  total: number;
}

/** One entry of GET /a2a/open-verifications: an open task this caller judges, from when its window opens. */
export interface OpenVerificationTask {
  meta: Record<string, unknown>;
  onChainTaskId: string | null;
  submissions: number;
  window: { opensAt: number; closesAt: number };
}

export interface OpenScorecard {
  taskHash: string;
  outcome: 'winner' | 'void';
  judge: OpenJudge;
  winner: string | null;
  scorecardHash: string;
  scorecard: Record<string, unknown>;
}

export interface SubmitOpenParams {
  /** The result. Kept short: at most maxResultBytes with rootHash; put a long one in storage. */
  resultData: Record<string, unknown>;
  /** A storage id holding the full result, committed on-chain with resultData. */
  rootHash?: string | null;
  teeAttestation?: { signature: string; signer?: string; signedText: string; chatID?: string; verified?: boolean } | null;
}

export interface SubmitOpenResult {
  taskHash: string;
  chain: string;
  onChainTaskId: string;
  evidenceHash: string;
  /** The submitOpen transaction; null when this result was already on-chain (alreadyOnChain). */
  txHash: string | null;
  /** The same result was already submitted on-chain: the backend kept it again, and nothing was sent. */
  alreadyOnChain: boolean;
}

export interface PickWinnerResult {
  taskHash: string;
  chain: string;
  onChainTaskId: string;
  winner: string;
  scorecardHash: string;
  /** Who picked: the poster (selectWinner) or the task's verifier (selectWinnerByVerifier). */
  role: 'poster' | 'verifier';
  txHash: string;
}

