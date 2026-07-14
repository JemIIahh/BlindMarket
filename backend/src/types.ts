import type { Request } from 'express';

/** Authenticated user attached by auth middleware */
export interface AuthUser {
  address: string;
  /** All linked wallet addresses from the Privy JWT (multi-wallet support). */
  addresses?: string[];
  /** Agent owner address (from platform token JWT). */
  ownerAddress?: string;
}

/** Express request with authenticated user */
export interface AuthRequest extends Request {
  user?: AuthUser;
}

/** Standard API success response */
export interface ApiResponse<T = unknown> {
  success: true;
  data: T;
}

/** Standard API error response */
export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

/** On-chain task status enum (mirrors BlindEscrow.TaskStatus) */
export enum TaskStatus {
  Funded = 0,
  Assigned = 1,
  Submitted = 2,
  Verified = 3,
  Completed = 4,
  Cancelled = 5,
  Disputed = 6,
}

/** On-chain task struct (mirrors BlindEscrow.Task) */
export interface OnChainTask {
  agent: string;
  worker: string;
  token: string;
  amount: bigint;
  taskHash: string;
  evidenceHash: string;
  status: TaskStatus;
  createdAt: bigint;
  deadline: bigint;
  submissionAttempts: number;
}

/** Task metadata from TaskRegistry */
export interface TaskMeta {
  taskId: bigint;
  agent: string;
  category: string;
  locationZone: string;
  reward: bigint;
  createdAt: bigint;
  isOpen: boolean;
}

/** Reputation from BlindReputation */
export interface Reputation {
  tasksCompleted: bigint;
  totalScore: bigint;
  disputes: bigint;
}

/** In-memory application record */
export interface Application {
  id: string;
  taskId: string;
  applicant: string;
  message?: string;
  createdAt: string;
}

// ── A2A (Agent-to-Agent) types ──────────────────────────────────────

export type ExecutorType = 'human' | 'agent';
// 'manual' = poster approves via /verify; 'auto' = backend lexical rubric
// (autoVerify); 'agent' = a poster-designated verifier agent decrypts the brief,
// judges the output against the real task, and posts a verdict to /verdict;
// 'oracle' = reserved/unwired.
export type VerificationMode = 'manual' | 'auto' | 'oracle' | 'agent';

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

// Keep the array for backwards-compatible iteration and zod enum.
export const AGENT_CAPABILITIES = [
  'data_processing', 'web_research', 'code_execution', 'content_generation',
  'api_integration', 'text_analysis', 'translation', 'summarization',
  'image_analysis', 'document_processing', 'math_computation', 'data_extraction',
  'report_generation', 'code_review', 'testing', 'scheduling',
  'email_drafting', 'social_media', 'market_research', 'competitive_analysis',
] as const;

export interface AgentExecutor {
  address: string;
  displayName: string;
  capabilities: AgentCapability[];
  // Minimum reward in wei (decimal string for JSON safety). Agents won't be
  // offered tasks below this threshold at scoring time.
  minReward?: string;
  // If set, only these capabilities are considered for overlap scoring.
  // The agent must still have ALL requiredCapabilities (enforced at /accept),
  // but scoring only counts the ones they prefer — letting agents express
  // "I CAN do this but I'd rather not" without being excluded entirely.
  preferredCapabilities?: AgentCapability[];
  // secp256k1 uncompressed hex (130 chars, leading `04`, no 0x prefix). Used by
  // posters at task-creation time to ECIES-wrap the AES key so only this
  // executor can decrypt the brief. Optional for back-compat with executors
  // registered before this field existed — they can't accept encrypted tasks
  // until they re-register.
  publicKey?: string;
  agentCardUrl?: string;
  mcpEndpointUrl?: string;
  reputation: number; // 0-100
  tasksCompleted: number;
  // Sum of worker payouts in smallest token unit (e.g. USDC micro-units; 6
  // decimals). Stored as a decimal string because BigInt doesn't survive
  // JSON.stringify. Optional for back-compat with rows written before this
  // field existed — readers must default to "0".
  totalEarnedRaw?: string;
  registeredAt: string;
}

export interface A2ATaskMeta {
  taskId: string;
  targetExecutorType: ExecutorType;
  verificationMode: VerificationMode;
  verificationCriteria?: VerificationCriteria;
  requiredCapabilities: AgentCapability[];
  // Address of the EOA that posted the task (authenticated at POST /api/v1/tasks
  // time). Indexed in a2aStore so a poster can query their own pending-review
  // inbox without scanning all tasks.
  posterAddress?: string;
  // Lowercased EOA address of a poster-designated verifier agent
  // (verificationMode='agent'). The brief AES key is ECIES-wrapped to this
  // address too (it appears in wrappedKeys), so the verifier can decrypt the
  // real task and judge the output. Only the holder of this key can post a
  // verdict via /tasks/:id/verdict; the platform stays blind.
  verifierAddress?: string;
  // 0G Storage root hash of the AES-encrypted brief. The executor downloads
  // this and AES-decrypts with the unwrapped AES key (see wrappedKeys).
  // Optional for back-compat with H2H tasks and pre-pivot test data.
  rootHash?: string;
  // ECIES-wrapped AES key, one entry per eligible executor. Keys are
  // lowercased EOA addresses; values are hex-encoded ECIES blobs. At /accept
  // time the backend returns wrappedKeys[lowercased(caller_address)] so only
  // the accepting executor receives a slice they can decrypt with their
  // own private key. Posters wrap browser-side — backend never sees the AES
  // key in plaintext, preserving the "architecturally blind" invariant.
  wrappedKeys?: Record<string, string>;
  // Key custody (docs/TEE-REWRAP-SPEC.md): the brief AES key ECIES-sealed to
  // the platform's custody key, so a late-joining agent — one not in the
  // post-time wrappedKeys snapshot — can be served a re-wrapped slice on
  // /accept with no poster present. `keyId` binds the blob to the exact custody
  // key that can unwrap it (enables rotation + the operator→enclave migration);
  // `blob` is a hex ECIES blob (no 0x), same format as wrappedKeys values. The
  // re-wrap happens only AFTER a winning /accept CAS (winner-only — CAS losers
  // never see it). Present only when KEY_CUSTODY_ENABLED at post time.
  keyCustodyBlob?: { keyId: string; blob: string };
  // Set by the operator via POST /api/v1/admin/tasks/:id/skip-wrap for
  // tasks posted before key custody was enabled. When true, the NEEDS_WRAP
  // gate is bypassed, allowing any agent to accept regardless of wrap state.
  skipKeyWrap?: boolean;
  // Absolute on-chain deadline (unix epoch SECONDS), captured from the
  // TaskCreated event at /tasks/index time. Lets browse hide tasks the
  // contract would refuse to assign (DeadlineReached) and lets the expiry
  // sweep close them without a per-task chain read. Optional for tasks
  // indexed before this field existed — the sweep backfills it from chain.
  deadline?: number;
  // ── rent-your-agent Phase 2 (Use now) ──────────────────────────────────
  // When set, this task is a per-call service invocation PINNED to one executor
  // EOA (lowercased): the /accept gate rejects anyone else with NOT_TARGET_EXECUTOR
  // and the brief AES key is wrapped only to this address.
  targetExecutor?: string;
  // The agent_services row this invocation rents — lets sold_count bump on
  // settlement. Validated at /tasks/index (active, agent_address==targetExecutor,
  // on-chain amount >= price_raw).
  serviceId?: number;
}

export type A2ATaskStateStatus =
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
  status: A2ATaskStateStatus;
  // Why a 'failed' task failed. 'expired' = the on-chain deadline passed while
  // the task was still open/Funded (closed by the expiry sweep or an /accept
  // that hit DeadlineReached); 'unindexed' = phantom meta with no TaskCreated
  // event in the chain's history (reverted createTask). Distinguishes these
  // from verification failures so dashboards/agents don't read them as bad work.
  failedReason?: string;
  executorAddress?: string;
  acceptedAt?: string;
  submittedAt?: string;
  // Which on-chain submission round this state's evidence belongs to
  // (contract submissionAttempts AFTER the pending broadcast = attempts at
  // /submit time + 1). Lets /verdict reject a stale verdict from a PREVIOUS
  // round during a failed-verification retry — without it, a delayed round-1
  // verdict could re-fail a task whose round-2 evidence is mid-broadcast.
  submissionRound?: number;
  resultData?: Record<string, unknown>;
  verificationResult?: { passed: boolean; reasons: string[]; score?: number; breakdown?: Array<{ name: string; score: number; weight: number; reason: string; error?: string }>; errors?: Record<string, string> };
  // Settlement-bridge bookkeeping. Existence of these hashes means the
  // corresponding on-chain call has at least been broadcast; absence means
  // the bridge hasn't run yet (or the broadcast failed and was logged).
  assignTxHash?: string;
  verifyTxHash?: string;
  // Persisted error from the most recent fire-and-forget bridge call. If
  // set, the bridge attempt blew up before the on-chain state could move —
  // /submit-result and /finalize use these to short-circuit with a clear
  // BRIDGE_FAILED code instead of looping on NOT_ASSIGNED_YET forever.
  assignError?: string;
  verifyError?: string;
}

export interface VerificationCriteria {
  // Legacy (backward-compatible)
  required_fields?: string[];
  min_length?: number;
  contains_keywords?: string[];

  // New rubric fields
  max_length?: number;
  expected_answer?: string;            // exact or fuzzy expected output
  forbidden_phrases?: string[];        // output must NOT contain these
  regex_pattern?: string;              // regex the output must match
  expected_schema?: {
    type?: string;
    required?: string[];
    properties?: Record<string, { type?: string }>;
  };
  rubric?: Array<{                     // custom per-criterion scoring
    criterion: string;                 // human-readable label
    keywords?: string[];               // keywords to check for
    min_mentions?: number;             // minimum keyword occurrences
    weight?: number;                   // weight (default 1)
  }>;
  pass_threshold?: number;             // 0-100, default 60. Score must meet this to pass.
  // Natural-language acceptance description for verificationMode='agent'. The
  // verifier agent judges the output against the decrypted brief; this is an
  // optional poster-supplied hint for what "correct" means (e.g. "must be a
  // runnable Python function that handles empty input"). Not used by autoVerify.
  acceptance?: string;
}

// ---- Forensic Evidence Verification ----

export interface ExifData {
  make?: string;
  model?: string;
  dateTime?: string;
  dateTimeOriginal?: string;
  gpsLat?: number;
  gpsLng?: number;
  software?: string;
  imageWidth?: number;
  imageHeight?: number;
}

export type PhotoSource = 'camera' | 'gallery' | 'screenshot' | 'edited' | 'unknown';

export interface DeviceFingerprint {
  screenWidth: number;
  screenHeight: number;
  hardwareConcurrency: number;
  deviceMemory: number | null;
  webglRenderer: string;
  userAgent: string;
  platform: string;
}

export interface FreshnessResult {
  photoAgeMs: number | null;
  submissionTimestamp: number;
  isFresh: boolean;
  maxAgeMs: number;
}

export interface ForensicReport {
  version: 1;
  taskId: string;
  workerAddress: string;
  timestamp: number;
  exif: ExifData;
  photoSource: PhotoSource;
  phash: string;
  deviceFingerprint: DeviceFingerprint;
  freshness: FreshnessResult;
  tamperingSignals: string[];
  reportHash: string;
}

export interface SignedForensicReport {
  report: ForensicReport;
  signature: string;
}

export interface ForensicCheck {
  name: string;
  passed: boolean;
  severity: 'critical' | 'warning' | 'info';
  detail: string;
}

export interface ForensicValidation {
  overallScore: number;
  passed: boolean;
  checks: ForensicCheck[];
  flags: string[];
}

export type TaskForensicCategory = 'physical_presence' | 'location_based' | 'creative' | 'general';

// ── Agent Tool types ─────────────────────────────────────────────────────────

/** HTTP tool — agent calls an external REST endpoint */
export interface HttpAgentTool {
  type: 'http';
  name: string;           // tool name exposed to the LLM
  description: string;
  url: string;            // endpoint URL (may include {param} placeholders)
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  bodyTemplate?: string;  // JSON template with {{param}} substitutions
}

/** MCP tool — agent connects to a Model Context Protocol server */
export interface McpAgentTool {
  type: 'mcp';
  name: string;
  description: string;
  endpointUrl: string;    // MCP server URL
  toolName: string;       // specific tool on the MCP server to invoke
}

/** JS eval tool — agent runs a sandboxed JS snippet (Node vm module) */
export interface JsAgentTool {
  type: 'js';
  name: string;
  description: string;
  code: string;           // JS function body: receives (input: string) => string
}

export type AgentTool = HttpAgentTool | McpAgentTool | JsAgentTool;

// ── Deployed Agent types ─────────────────────────────────────────────────────

export type AgentStatus = 'stopped' | 'running' | 'paused';
export type LLMProvider = 'openai' | 'anthropic' | 'groq' | 'gemini' | '0g-compute';

export const LLM_PROVIDER_MODELS: Record<LLMProvider, string[]> = {
  openai:      ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  anthropic:   ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-3-haiku-20240307'],
  groq:        ['llama-3.3-70b-versatile', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
  gemini:      ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'],
  '0g-compute': ['deepseek-ai/DeepSeek-V3.1', 'qwen/qwen-2.5-7b-instruct', 'google/gemma-3-27b-it'],
};

export interface DeployedAgent {
  id: string;
  ownerAddress: string;
  // Additional wallets authorized to manage this agent (start/stop/pause/
  // restart/withdraw/export-key), beyond ownerAddress. Populated via the
  // signature-gated POST /agents/:id/link-owner flow when the deploy wallet
  // (the wagmi-connected wallet captured at deploy) differs from the Privy
  // identity that authorizeOwner checks at action time. Always lowercased.
  // Absent on legacy agents — authorizeOwner then falls back to ownerAddress.
  authorizedOwners?: string[];
  name: string;
  instructions: string;
  provider: LLMProvider;
  model: string;
  apiKey: string;           // ECIES-encrypted at rest; plaintext only in worker env
  encryptedApiKey: string;  // ECIES blob encrypted to owner pubkey
  capabilities: AgentCapability[];
  tools: AgentTool[];       // custom tools the agent can call
  status: AgentStatus;
  deployedAt: string;
  lastActiveAt?: string;    // updated on each heartbeat from worker
  storageRef?: string;
  platformToken?: string;   // HS256 JWT for backend auth
  // On-chain identity — generated at deploy time
  walletAddress: string;
  publicKey: string;
  encryptedPrivateKey: string;
  // Server-custodial copy of the raw signing key. Lets the worker autonomously
  // sign on-chain calls (e.g. submitEvidence) without owner involvement. Demo-
  // grade custody — production would replace this with an EIP-712 owner-signed
  // delegation that the contract verifies, so the backend never holds the key.
  rawPrivateKey?: string;
  inftTokenId?: number;
  // Minimum reward in wei (decimal string). The worker sends this at A2A
  // registration time so scoring filters out tasks below this threshold.
  minReward?: string;
}

export interface TaskForensicRequirement {
  requireFreshPhoto: boolean;
  maxPhotoAgeMs: number;
  requireGps: boolean;
  gpsCenter?: { lat: number; lng: number };
  gpsRadiusMeters?: number;
  requireCameraSource: boolean;
  category: TaskForensicCategory;
}
