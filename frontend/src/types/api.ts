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

export const TaskStatusLabels: Record<TaskStatus, string> = {
  [TaskStatus.Funded]: 'Funded',
  [TaskStatus.Assigned]: 'Assigned',
  [TaskStatus.Submitted]: 'Submitted',
  // On-chain Verified (3) means "verification ran and FAILED — worker may
  // retry" (see BlindEscrow.sol enum comment). Label it by what it means to
  // a reader so status chips don't present a failure as a success state.
  [TaskStatus.Verified]: 'Verification failed',
  [TaskStatus.Completed]: 'Completed',
  [TaskStatus.Cancelled]: 'Cancelled',
  [TaskStatus.Disputed]: 'Disputed',
};

/** On-chain task struct (mirrors BlindEscrow.Task) */
export interface OnChainTask {
  taskId?: string; // numeric id
  agent: string;
  worker: string;
  token: string;
  amount: string; // bigint serialized as string from API
  taskHash: string;
  evidenceHash: string;
  status: TaskStatus;
  createdAt: string;
  deadline: string;
  submissionAttempts: number;
  // Which escrow holds the task ('arc' = where new tasks post, 'base' =
  // legacy USDC settlement, '0g' = agent infra). Sent by
  // GET /api/v1/tasks/:id; picks the chain explorer.
  chain?: '0g' | 'base' | 'arc';
  // The escrow token's symbol when it is that chain's settlement token
  // (GET /api/v1/tasks/:id), null otherwise. With `decimals`, the reward's unit.
  symbol?: string | null;
  decimals?: number;
  // Whether the backend's A2A executor index has a meta entry for this task.
  // False means no agent can see it on /a2a/tasks — typically a task created
  // before the current code path was wired up.
  a2aIndexed?: boolean;
  // Enriched A2A data from backend
  a2aState?: A2ATaskState;
  a2aMeta?: A2ATaskMeta;
}

/** A2A State tracked in Redis */
export interface A2ATaskState {
  taskId: string;
  // 'collecting' is an open-submission task taking submissions; it ends
  // 'completed' (a winner was paid) or 'failed' (closed with no winner).
  status: 'open' | 'collecting' | 'accepted' | 'in_progress' | 'submitted' | 'awaiting_verification' | 'verified' | 'completed' | 'failed' | 'cancelled';
  executorAddress?: string;
  acceptedAt?: string;
  submittedAt?: string;
  resultData?: Record<string, any> | null;
  verificationResult?: {
    passed: boolean;
    reasons: string[];
    score?: number;
    breakdown?: Array<{ name: string; score: number; weight: number; reason: string; error?: string }>;
    errors?: Record<string, string>;
    teeVerified?: boolean;
  };
  assignTxHash?: string;
  verifyTxHash?: string;
  outputRootHash?: string;
}

/** A2A Metadata tracked in Redis */
export interface A2ATaskMeta {
  taskId: string;
  targetExecutorType: 'agent' | 'human';
  verificationMode: 'manual' | 'auto' | 'oracle' | 'agent';
  verificationCriteria: Record<string, any>;
  requiredCapabilities: string[];
  posterAddress?: string;
  verifierAddress?: string;
  rootHash?: string;
  // Per-task privacy: 'public' = plaintext brief, no key wrapping, brief +
  // result visible to everyone. Absent = private (encrypted flow).
  privacy?: 'public';
  // Bounded plaintext display copy of a PUBLIC task's brief.
  publicBrief?: string;
  // 'open': many agents submit and one wins (docs/OPEN-SUBMISSION-TASKS.md).
  submissionMode?: 'open';
  // Who picks an open task's winner first: its verifier agent, or the poster
  // for `creatorWindow` seconds after the deadline, then the verifier.
  openPick?: { mode: 'agent' | 'creator'; creatorWindow: number };
  // The on-chain deadline (unix seconds) as listed.
  deadline?: number;
}

/** Task metadata from TaskRegistry */
export interface TaskMeta {
  taskId: string;
  agent: string;
  category: string;
  locationZone: string;
  reward: string;
  createdAt: string;
  isOpen: boolean;
  rootHash?: string;
  requiredCapabilities?: string[];
  decimals?: number;
}

/** Reputation from BlindReputation */
export interface Reputation {
  tasksCompleted: string;
  totalScore: string;
  disputes: string;
}

/** In-memory application record */
export interface Application {
  id: string;
  taskId: string;
  applicant: string;
  message?: string;
  createdAt: string;
}

/** Combined task data for display */
export interface TaskDisplay {
  id: string;
  onChain: OnChainTask;
  meta: TaskMeta;
}

/** Unsigned transaction from backend */
export interface UnsignedTx {
  to: string;
  data: string;
  from: string;
  value?: string;
  gasLimit?: number;
}

/** Nonce response */
export interface NonceResponse {
  nonce: string;
}

/** Auth verify response */
export interface AuthVerifyResponse {
  token: string;
  expiresIn: string;
}

/** Verification result */
export interface VerificationResult {
  taskId: string;
  passed: boolean;
  confidence: number;
  reasoning: string;
  model: string;
  teeVerified?: boolean;
  attestation?: string;
  timestamp?: number;
}
