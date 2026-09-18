import type { Request } from 'express';

/** Authenticated user attached by auth middleware */
export interface AuthUser {
  address: string;
  /** All linked wallet addresses from the Privy JWT (multi-wallet support). */
  addresses?: string[];
  /** Agent owner address (from platform token JWT). */
  ownerAddress?: string;
  /**
   * Set when the principal was authenticated via an HS256 JWT
   * (verifyRegistrationToken), as opposed to Privy. 'agent-platform' =
   * server-minted at deploy (first-party worker); 'agent-registration' =
   * device-flow minted (phishable consent — see M6). requireFounder must
   * reject any principal carrying either — see middleware/auth.ts.
   */
  typ?: 'agent-registration' | 'agent-platform';
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
  // offered task below this threshold at scoring time.
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
  // Chains this executor can settle on, as reported at registration.
  // Default: ['0g']. Set rpcUrls.base in the SDK to include 'base'.
  supportedChains?: string[] | null;
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
  // Which escrow holds the task ('base' or '0g'), recorded at /tasks/index
  // from the chain that produced the TaskCreated receipt. Lets an executor
  // skip tasks on a chain where it cannot pay gas BEFORE accepting (an
  // accept assigns the task on-chain, after which it cannot be released).
  // Absent on rows indexed before this field existed — treat as unknown.
  chain?: 'base' | '0g';
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
  // ── Agent selection mode (Part 2: Cold-Start Fix) ─────────────────────────
  // Poster can choose how the cascade picks agents:
  //   'merit'    — default ranked behaviour (proven agents preferred)
  //   'balanced' — aggressive exploration slot (45% chance to route to new agents)
  agentSelectionMode?: 'merit' | 'balanced';
  // ── Per-task privacy (agent-ready, Jul 2026) ────────────────────────────
  // 'public': the poster explicitly opted OUT of blindness for this task.
  // The storage blob at rootHash is PLAINTEXT utf-8 (no AES/ECIES), key
  // material must be absent (wrappedKeys/keyCustodyBlob rejected at
  // /tasks/index), any registered executor can accept without a wrapped
  // slice (the NEEDS_WRAP gate is skipped), and the brief + resultData are
  // visible on public surfaces. Absent = 'private' = the original encrypted
  // flow; the value is immutable across re-indexes.
  privacy?: 'public';
  // Bounded plaintext display copy of a PUBLIC task's brief, so browse and
  // detail surfaces can show it without a storage fetch. The blob at
  // rootHash stays the canonical brief for execution. Never present on
  // private tasks.
  publicBrief?: string;
  // ── Semantic matching (Phase 1) ─────────────────────────────────────────
  // Optional poster-supplied PUBLIC one-liner used only for routing/matching.
  // The escape hatch that lets a PRIVATE task participate in semantic
  // matching without unsealing anything: the poster states, in their own
  // words, what kind of agent they need. Never derived from the sealed brief.
  routingSummary?: string;
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
  // 0G TEE attestation captured by the worker for trustless settlement
  teeAttestation?: {
    signature: string;
    signer?: string;
    signedText: string;
    chatID?: string;
    verified?: boolean;
  };
  // 0G Storage rootHash of the task output
  outputRootHash?: string;
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

// ── Normalized Tool Definition (v2) ────────────────────────────────────────
// Every tool — regardless of import path (MCP, OpenAPI, manual) — normalizes
// to this shape. The agent never sees URLs, methods, or auth at runtime;
// it only picks a tool and fills in input_schema arguments.

export interface ToolParamSchema {
  type: string;          // JSON Schema type: "string", "number", "boolean", "array", "object"
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: { type: string };  // for array type
}

export interface ToolDefinition {
  name: string;
  description: string;   // written for the LLM: what it does and when to call it
  input_schema: {
    type: 'object';
    properties: Record<string, ToolParamSchema>;
    required?: string[];
  };
  execution: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url: string;           // may contain {param} placeholders
    param_mapping: Record<string, string>;  // input_schema key → "query" | "body" | "path" | "header"
  };
  auth: {
    type: 'query_param' | 'header' | 'bearer' | 'none';
    key_name: string;      // e.g. "api_key", "Authorization"
    secret_ref: string;    // pointer to stored secret, NEVER the literal key
  };
  /** Where this tool came from — controls how the worker executes it */
  source?: 'manual' | 'openapi' | 'mcp';
  /** MCP-specific: server URL (when source='mcp') */
  mcp_endpoint?: string;
  /** MCP-specific: tool name on the MCP server (when source='mcp') */
  mcp_tool_name?: string;
  /** MCP-specific: auth headers to send with JSON-RPC calls (when source='mcp') */
  mcp_headers?: Record<string, string>;
  /** Optional parameter groups for runtime validation (from DSL) */
  parameter_groups?: ToolDSLParameterGroup[];
}

// ── Tool Definition DSL (v3) ───────────────────────────────────────────────
// Rich intermediate representation that every import path compiles into.
// Captures semantic meaning that raw HTTP/MCP shape loses — what a param
// actually represents, when to use this tool, what errors mean, sequencing.

export type ToolDSLSemanticType =
  | 'domain' | 'email' | 'person_name' | 'url' | 'date'
  | 'free_text' | 'enum' | 'id' | 'number';

export type ToolDSLSideEffect = 'none' | 'creates_resource' | 'modifies_resource' | 'destructive';

export interface ToolDSLParameter {
  name: string;
  semantic_type: ToolDSLSemanticType;
  json_type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  description: string;
  format_hint?: string;
  example?: string;
  enum_values?: string[];
}

export interface ToolDSLParameterGroup {
  type: 'require_one_of' | 'require_together';
  params: string[];
}

export interface ToolDSLOutput {
  description: string;
  key_fields?: Array<{ name: string; description: string }>;
}

export interface ToolDSLErrorSemantics {
  condition: string;
  meaning: string;
}

export interface ToolDSLSequencing {
  typically_follows?: string[];
  typically_precedes?: string[];
}

export interface ToolDSL {
  name: string;
  intent: string;
  when_to_use: string;
  parameters: ToolDSLParameter[];
  parameter_groups?: ToolDSLParameterGroup[];
  output?: ToolDSLOutput;
  side_effects: ToolDSLSideEffect;
  retry_safe: boolean;
  error_semantics?: ToolDSLErrorSemantics[];
  sequencing?: ToolDSLSequencing;
  execution: ToolDefinition['execution'];
  auth: ToolDefinition['auth'];
  /** True when imported via OpenAPI/MCP and semantic fields are incomplete */
  needs_review: boolean;
}

// ── Legacy Tool Types (kept for backward compat, deprecated) ────────────────

/** HTTP tool — agent calls an external REST endpoint */
export interface HttpAgentTool {
  type: 'http';
  name: string;           // tool name exposed to the LLM
  description: string;
  url: string;            // endpoint URL (may include {param} placeholders)
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
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

/** Sandbox tool — agent runs code in an isolated Railway sandbox VM */
export interface SandboxAgentTool {
  type: 'sandbox';
  name: string;
  description: string;
  command: string;
  setup?: string;
  timeout?: number;
}

export type AgentTool = HttpAgentTool | McpAgentTool | JsAgentTool | SandboxAgentTool | ToolDefinition | ToolDSL;

// ── Deployed Agent types ─────────────────────────────────────────────────────

export type AgentStatus = 'stopped' | 'running' | 'paused';
export type LLMProvider = 'openai' | 'anthropic' | 'groq' | 'gemini' | '0g-compute';

export interface ModelInfo {
  id: string;
  inputCostPer1M: number;   // USD per 1M input tokens
  outputCostPer1M: number;  // USD per 1M output tokens
}

// Curated catalog behind the deploy form's dropdown and its price hints.
// NOT an allowlist: DeploySchema takes any model string and worker.js hands it
// straight to the provider SDK, so an agent on a model that has since dropped
// off this list keeps running. POST /agents/provider-models supplements this
// with a live list from the provider once the user has pasted a key — this
// table is the no-key fallback and the source of the price hints.
//
// Prices are USD per 1M tokens, standard tier, checked against each provider's
// pricing page on 2026-09-08 (Groq's llama rates carried from 2026-08-05).
// Newest first: the form defaults to the first entry when a provider is picked.
export const LLM_PROVIDER_MODELS: Record<LLMProvider, ModelInfo[]> = {
  openai: [
    { id: 'gpt-6-astra',   inputCostPer1M: 10.00, outputCostPer1M: 50.00 },
    { id: 'gpt-5.6-sol',   inputCostPer1M: 4.00,  outputCostPer1M: 20.00 },
    { id: 'gpt-5.6-terra', inputCostPer1M: 2.00,  outputCostPer1M: 12.00 },
    { id: 'gpt-5.6-luna',  inputCostPer1M: 0.20,  outputCostPer1M: 1.20  },
    { id: 'gpt-5.5',       inputCostPer1M: 5.00,  outputCostPer1M: 30.00 },
    { id: 'gpt-5.4',       inputCostPer1M: 2.50,  outputCostPer1M: 15.00 },
    { id: 'gpt-5.4-mini',  inputCostPer1M: 0.75,  outputCostPer1M: 4.50  },
    { id: 'gpt-5.4-nano',  inputCostPer1M: 0.20,  outputCostPer1M: 1.25  },
    { id: 'gpt-5',         inputCostPer1M: 1.25,  outputCostPer1M: 10.00 },
    { id: 'gpt-5-mini',    inputCostPer1M: 0.25,  outputCostPer1M: 2.00  },
    { id: 'gpt-5-nano',    inputCostPer1M: 0.05,  outputCostPer1M: 0.40  },
    { id: 'gpt-4.1',       inputCostPer1M: 2.00,  outputCostPer1M: 8.00  },
    { id: 'gpt-4o',        inputCostPer1M: 2.50,  outputCostPer1M: 10.00 },
    { id: 'gpt-4o-mini',   inputCostPer1M: 0.15,  outputCostPer1M: 0.60  },
  ],
  anthropic: [
    { id: 'claude-fable-5-1',  inputCostPer1M: 10.00, outputCostPer1M: 50.00 },
    { id: 'claude-fable-5',    inputCostPer1M: 10.00, outputCostPer1M: 50.00 },
    { id: 'claude-opus-5',     inputCostPer1M: 5.00,  outputCostPer1M: 25.00 },
    { id: 'claude-opus-4-8',   inputCostPer1M: 5.00,  outputCostPer1M: 25.00 },
    { id: 'claude-opus-4-7',   inputCostPer1M: 5.00,  outputCostPer1M: 25.00 },
    { id: 'claude-sonnet-5',   inputCostPer1M: 2.00,  outputCostPer1M: 10.00 },
    { id: 'claude-sonnet-4-6', inputCostPer1M: 3.00,  outputCostPer1M: 15.00 },
    { id: 'claude-haiku-4-5',  inputCostPer1M: 1.00,  outputCostPer1M: 5.00  },
  ],
  groq: [
    // Groq namespaces the OSS GPT models — the bare 'gpt-oss-120b' this list
    // used to carry is not a Groq model id.
    { id: 'openai/gpt-oss-120b',     inputCostPer1M: 0.15,  outputCostPer1M: 0.60 },
    { id: 'openai/gpt-oss-20b',      inputCostPer1M: 0.075, outputCostPer1M: 0.30 },
    { id: 'llama-3.3-70b-versatile', inputCostPer1M: 0.59,  outputCostPer1M: 0.79 },
    { id: 'llama-3.1-8b-instant',    inputCostPer1M: 0.05,  outputCostPer1M: 0.08 },
  ],
  gemini: [
    // 3.x Flash is $0.75/$3.75 through 2026-12-31, then $1.50/$7.50.
    { id: 'gemini-3.8-flash',       inputCostPer1M: 0.75,  outputCostPer1M: 3.75  },
    { id: 'gemini-3.7-flash',       inputCostPer1M: 0.75,  outputCostPer1M: 3.75  },
    { id: 'gemini-3.6-flash',       inputCostPer1M: 0.75,  outputCostPer1M: 3.75  },
    { id: 'gemini-3.5-flash',       inputCostPer1M: 1.50,  outputCostPer1M: 9.00  },
    { id: 'gemini-3.5-flash-lite',  inputCostPer1M: 0.30,  outputCostPer1M: 2.50  },
    { id: 'gemini-3.1-pro-preview', inputCostPer1M: 2.00,  outputCostPer1M: 12.00 },
    { id: 'gemini-3.1-flash-lite',  inputCostPer1M: 0.25,  outputCostPer1M: 1.50  },
    { id: 'gemini-2.5-pro',         inputCostPer1M: 1.25,  outputCostPer1M: 10.00 },
    { id: 'gemini-2.5-flash',       inputCostPer1M: 0.30,  outputCostPer1M: 2.50  },
  ],
  // No API key: inference is billed to the agent's own wallet through the 0G
  // Compute Router, which now fronts frontier closed models as well as open
  // ones. Prices are the router's pricing_usd × 1e6 as of 2026-09-09 — they
  // drift day to day, so the live list (same endpoint, keyless) is the
  // authority and overrides these whenever the form can reach it.
  '0g-compute': [
    { id: 'deepseek-v4-flash', inputCostPer1M: 0.138, outputCostPer1M: 0.275 },
    { id: 'qwen3.8-flash',     inputCostPer1M: 0.113, outputCostPer1M: 0.382 },
    { id: 'glm-5.3-flash',     inputCostPer1M: 0.111, outputCostPer1M: 0.389 },
    { id: 'deepseek-v4-pro',   inputCostPer1M: 0.792, outputCostPer1M: 2.376 },
    { id: 'kimi-k3',           inputCostPer1M: 3.00,  outputCostPer1M: 15.00 },
    { id: 'claude-sonnet-5',   inputCostPer1M: 1.90,  outputCostPer1M: 9.50  },
    { id: 'claude-opus-5',     inputCostPer1M: 5.00,  outputCostPer1M: 25.00 },
    { id: 'gpt-5.6-terra',     inputCostPer1M: 2.00,  outputCostPer1M: 12.00 },
    { id: '0gm-1.0-35b-a3b',   inputCostPer1M: 0.08,  outputCostPer1M: 0.48  },
  ],
};

/** Legacy flat string list — used by deploy validation and provider list endpoint. */
export const LLM_MODEL_IDS: Record<LLMProvider, string[]> = Object.fromEntries(
  Object.entries(LLM_PROVIDER_MODELS).map(([k, v]) => [k, v.map(m => m.id)])
) as Record<LLMProvider, string[]>;

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
  // ERC-4337 smart account address on Base (BlindAccount via BlindAccountFactory).
  // Deterministic (CREATE2 from owner address + salt). The worker uses this as
  // the UserOp sender when submitting on Base, so the paymaster can sponsor gas
  // in USDC instead of requiring the EOA to hold ETH. Absent on pre-AA agents.
  smartAccountAddress?: string;
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
  // Per-tool secrets (API keys, tokens) — ECIES-encrypted at rest
  toolSecrets?: Record<string, string>;              // plaintext, only in worker env
  encryptedToolSecrets?: Record<string, string>;     // ECIES blobs encrypted to owner pubkey
  // Installed skills — frozen SNAPSHOTS, not live registry refs. A registry
  // author edit must never silently repoint an agent's system prompt (the
  // agent holds funds and can delegate_to_agent). Updates are explicit
  // re-installs. Composed into AGENT_INSTRUCTIONS/AGENT_TOOLS at spawn by
  // services/skillComposer.ts — the worker itself is skill-agnostic.
  skills?: InstalledSkill[];
}

// ── Skills (agent-ready: installable behavior) ─────────────────────────────

/** A skill snapshot frozen onto an agent at install time. Built server-side
 *  from an agent_skills registry row (skillComposer.buildInstalledSkill) —
 *  never accepted from a client. */
export interface InstalledSkill {
  skillId: number;
  slug: string;
  version: string;
  name: string;
  /** Markdown instructions, injected as a [SKILL: …] section of the system prompt. */
  instructions: string;
  /** Declarative tools only (normalized ToolDefinition + type:'tool'). */
  tools: ToolDefinition[];
  /** secret_ref manifest — drives the secrets UI at install time. */
  secretRefs: string[];
  /** Routing tags — unioned into agent.capabilities at deploy/install. */
  capabilities: AgentCapability[];
  source: 'local' | 'skillmd' | 'mcp' | 'openapi';
  installedAt: string;
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
