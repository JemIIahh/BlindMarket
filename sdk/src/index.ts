import { ethers } from 'ethers';
import { ApiError } from './apiError.js';
import {
  sendAndWait, assertSignerChain, ensureAllowance, tokenBalance, openTaskOnChain, UnconfirmedTransactionError, DEFAULT_CONFIRM_TIMEOUT_MS,
} from './onchain.js';
import { checkEscrowCall, evidenceHashOf, openEvidenceHashOf, scorecardHashOf, taskIdOf, type EscrowFunction } from './escrowCalls.js';
import { isPinnedSettlement, SETTLEMENT_PINS, type SettlementPin } from './settlementPins.js';
import {
  normalizePost, checkRowFields, sealBrief, createTaskBody, indexParamsFor, commitsVerifier,
  type NormalizedPost, type SealedBrief, type ExecutorKey,
} from './posting.js';
import type {
  Address, Hex, RootHash, HealthStatus, PlatformStats, OpenTask, TaskDetail,
  CreateTaskTx, ExecutorProfile, RegisterExecutorInput,
  DeployedAgentInfo, AgentWalletInfo, ReputationInfo, LeaderboardEntry,
  StorageUploadResult, Message, AgentSearchResult, TaskTemplate,
  VerifyTaskInput, A2ATaskEntry, AgentCapability,
  CreateAgentParams, CreateAgentResult, CreateTaskRequest,
  OpenSubmissionConfig, OpenTaskStatus, OpenTaskListing, OpenSubmissionsPage, OpenVerificationTask, OpenScorecard,
  SubmitOpenParams, SubmitOpenResult, PickWinnerResult,
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
  /**
   * Escrows postTask() and postTasks() may fund besides the known
   * deployments (SETTLEMENT_PINS: Arc mainnet and Arc Testnet), for a custom
   * or local deployment. Each names its chain id, escrow and settlement
   * token; the backend's /health/settlement must name exactly one of them, or
   * nothing is approved or funded (ESCROW_NOT_PINNED).
   */
  trustedEscrows?: SettlementPin[];
}

// ── Agent deployment params ─────────────────────────────────────────────────

export interface DeployAgentParams {
  name: string;
  instructions: string;
  provider: 'openai' | 'anthropic' | 'groq' | 'gemini' | 'xai' | '0g-compute';
  /**
   * Any model id the provider lists for `apiKey`. One the platform's catalog
   * lacks is checked against the provider's own models list at deploy
   * (400 MODEL_NOT_AVAILABLE when the key can't use it).
   */
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
   * `nonce` is the transaction's: persist it too. When the backend never
   * finds the fee (DEPLOY_FEE_NOT_FOUND), no node has it, and the payer's
   * confirmed nonce is past this one, it can never land: nothing was paid.
   */
  onFeePaid?: (feeTxHash: string, nonce?: number) => void | Promise<void>;
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

// ── Deploying several agents ────────────────────────────────────────────────

/** The most agents deployAgents() deploys in one call. */
export const MAX_DEPLOY_AGENTS = 10;
/** The longest agent name the backend takes (POST /agents/deploy). */
export const MAX_AGENT_NAME = 80;

/**
 * How many more agents the API key's owner can start now, from GET
 * /api/v1/agents/capacity: the free worker slots on the backend (shared by
 * every owner), the owner's own share of them, and how many more the
 * server's memory allows. A deploy needs one of each.
 */
export interface AgentCapacity {
  poolMax: number;
  poolFree: number;
  ownerMax: number;
  ownerFree: number;
  /**
   * What memory allows: free memory less a reserve, in steps of one worker.
   * Null where the backend doesn't measure it; absent from older backends.
   */
  memory?: { availableMb: number; reserveMb: number; workerMb: number; slotsFree: number; source: string } | null;
  canStart: boolean;
  /**
   * 'process': the counts are those of the backend process that answered.
   * Behind several instances each has its own pool, so they are not a
   * cluster-wide total.
   */
  scope?: string;
}

/** Agents that can start now: one free slot, one of the owner's share and room in memory each. */
export const freeAgentSlots = (c: Pick<AgentCapacity, 'poolFree' | 'ownerFree' | 'memory'>) =>
  Math.max(0, Math.min(c.poolFree, c.ownerFree, c.memory?.slotsFree ?? Number.POSITIVE_INFINITY));

/**
 * The names deployAgents() gives `count` agents: every `{n}` in `name`
 * becomes the agent's number, else the number follows the name ("scout 1",
 * "scout 2"). One agent numbered 1 keeps `name` as it is. Numbers start at
 * `startAt` (default 1), so a later run can carry on where one stopped.
 */
export function agentNames(name: string, count: number, startAt = 1): string[] {
  const base = name.trim();
  return Array.from({ length: count }, (_, i) => {
    const n = startAt + i;
    if (base.includes('{n}')) return base.split('{n}').join(String(n));
    return count === 1 && startAt === 1 ? base : `${base} ${n}`;
  });
}

/** What deployAgents() is doing, as it happens. */
export type DeployAgentsProgress =
  | { type: 'deploying'; index: number; name: string }
  /** The backend answered 429; the same agent is asked for again after `waitMs`, with any fee it already paid. */
  | { type: 'rate-limited'; index: number; name: string; attempt: number; waitMs: number }
  | { type: 'deployed'; index: number; name: string; agent: DeployedAgent }
  | { type: 'funding'; index: number; name: string; walletAddress: string; amountRaw: string }
  | { type: 'funded'; index: number; name: string; txHash: string }
  | { type: 'failed'; index: number; name: string; error: { code?: string; message: string }; feeTxHash?: string };

/** Gas for each agent's wallet, sent after that agent is deployed and running. */
export interface DeployAgentsFunding {
  /** Per agent, in the posting chain's settlement token's smallest unit (USDC: 6 decimals). */
  amountRaw: bigint | string;
  /**
   * Signs the transfers on the posting chain instead of the configured
   * executor (BlindMarketConfig.executor, whose rpcUrls must name that chain).
   */
  signer?: ethers.Signer;
}

export interface DeployAgentsOptions extends Omit<DeployAgentOptions, 'onFeePaid'> {
  /** How many agents, 1 to MAX_DEPLOY_AGENTS. */
  count: number;
  /** The first agent's number in its name (agentNames). Default 1. */
  startAt?: number;
  /**
   * When fewer than `count` agents can start now, deploy that many instead
   * of refusing with AGENT_CAPACITY. Never more than can start.
   */
  upToCapacity?: boolean;
  /**
   * Called with each agent's deploy fee the moment it is broadcast, the
   * agent's index, and the fee's nonce (see DeployAgentOptions.onFeePaid).
   * Persist it: if the run stops before that agent exists, pass it back as
   * the template's `feeTxHash` and the next run's first agent deploys with
   * it, paying nothing.
   */
  onFeePaid?: (feeTxHash: string, index: number, nonce?: number) => void | Promise<void>;
  onProgress?: (event: DeployAgentsProgress) => void;
  /** Stops the run before the next agent. An agent already being deployed or funded is seen through. */
  signal?: AbortSignal;
  /**
   * Backoff for a rate limit (429) on a deploy: `attempts` tries per agent in
   * all (default 6), the wait doubling from `baseDelayMs` (default 2000):
   * 2, 4, 8, 16 and 32 s, past the backend's one-minute window. A 429 is
   * refused before the deploy runs, so nothing was created, and a fee the
   * agent already paid is named again rather than paid twice.
   */
  retry?: { attempts?: number; baseDelayMs?: number };
  /** Optional gas for each agent's wallet, never sent before that agent is deployed. */
  fund?: DeployAgentsFunding;
  /**
   * Called once every check has passed, with what the run will deploy and
   * spend, before anything is: return false to cancel (CANCELLED, nothing
   * deployed or paid), or throw to refuse with your own error.
   */
  confirm?: (plan: DeployAgentsPlan) => boolean | Promise<boolean>;
}

/** What a deployAgents() run will deploy and spend, for its `confirm`. */
export interface DeployAgentsPlan {
  /** The count asked for. */
  asked: number;
  /** Agents this run deploys: `asked`, or fewer with upToCapacity. */
  count: number;
  names: string[];
  /** Null when the backend could not say. */
  capacity: AgentCapacity | null;
  /**
   * The deploy fee, when the backend charges one. `paying` is how many
   * agents pay it now: one fewer when the template names a fee already paid.
   */
  fee:
    | { method: 'transfer'; chain: string; chainId?: number; token: string; recipient: string; perAgentRaw: string; decimals: number; paying: number; totalRaw: string }
    | { method: 'factory'; chain: string; paying: number }
    | null;
  /** Gas for each wallet, when asked for. */
  funding: { chain: string; token: string; symbol: string; decimals: number; perAgentRaw: string; totalRaw: string } | null;
}

/** What became of one agent of deployAgents(), by its position. */
export type DeployAgentsItem =
  /**
   * Deployed. `agent.started` false means it was created but did not start,
   * which stops the run. `funding` is there when gas was asked for: the
   * transfer, or why it failed (which stops the run too).
   */
  | { index: number; name: string; status: 'deployed'; agent: DeployedAgent; funding?: { txHash: string; amountRaw: string } | { error: { code?: string; message: string }; txHash?: string } }
  /** Not deployed. `feeTxHash` is a fee already paid for it: the next run's template.feeTxHash. */
  | { index: number; name: string; status: 'failed'; error: { code?: string; message: string }; feeTxHash?: string }
  /** Not tried: the run stopped before it. */
  | { index: number; name: string; status: 'skipped' };

export interface DeployAgentsResult {
  /** Agents asked for after any upToCapacity cut. */
  requested: number;
  deployed: number;
  results: DeployAgentsItem[];
  /** Where and why the run stopped early, when it did. */
  stopped?: { index: number; code?: string; message: string };
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
  /**
   * A public one-liner shown on the task board, at most 500 characters. A
   * private task's brief is sealed, so this is what the board says it is
   * about: keep secrets out of it.
   */
  routingSummary?: string;
  /**
   * Many agents submit and one is picked, instead of one agent taking the
   * task (docs/OPEN-SUBMISSION-TASKS.md). Such a task is public, needs
   * `verifierAddress` (the verifier agent that judges and picks), and takes no
   * `targetExecutor`; `privacy` and `verificationMode` default to 'public' and
   * 'agent'. `pick`: 'agent' (default), the verifier picks from the
   * deadline; 'creator', you pick first, for `pickWindowSeconds` (default
   * 86400; 1 hour to 7 days), then the verifier. Only when the backend runs
   * open submission (getOpenSubmissionConfig().enabled), and one at a time:
   * postTasks() refuses it.
   */
  open?: { pick?: 'agent' | 'creator'; pickWindowSeconds?: number };
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
  onFunded?: (funding: { txHash: string; nonce: number; raw?: string; taskHash: string; indexParams: IndexTaskParams }) => void | Promise<void>;
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
  /** A task many agents submit to: who picks first, and the poster's window in seconds (0 when the verifier picks). */
  open?: { pick: 'agent' | 'creator'; creatorWindow: number };
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
  routingSummary?: string;
}

// ── Posting many tasks ──────────────────────────────────────────────────────

export interface PostTasksOptions {
  /** As postTask(): signs on the posting chain instead of the configured executor, and must be the API key's own wallet. */
  signer?: ethers.Signer;
  /**
   * The most postTasks() will lock in escrow across every row, in the
   * token's smallest unit. Refused with AMOUNT_ABOVE_MAX before anything is sent.
   */
  maxTotalRaw?: bigint | string;
  /**
   * Tasks per transaction on an escrow that has createTasks (SettlementChainInfo.batchCreate).
   * Default 20, at most the chain's maxBatch and 50. On an escrow without
   * it every task is its own transaction and this is ignored.
   */
  chunkSize?: number;
  /** Called as each row settles: posted, unlisted, failed or skipped. A throwing callback does not stop the run. */
  onProgress?: (progress: { done: number; total: number; result: PostTasksRowResult }) => void | Promise<void>;
  /**
   * Called the moment a funding transaction is broadcast, once for every row
   * it funds. Persist `indexParams`: if this process dies before the row is
   * listed, indexTask(indexParams) lists it without funding it again, or
   * indexTasks() for rows whose `batch` is true, which share one transaction
   * (the single index route refuses a receipt that funded several tasks).
   */
  onFunded?: (funding: { index: number; txHash: string; nonce: number; raw?: string; taskHash: string; batch: boolean; indexParams: IndexTaskParams }) => void | Promise<void>;
  /** How long to wait for each transaction to confirm. Default 180000 ms. */
  confirmTimeoutMs?: number;
  /**
   * Stops the run before the next row, or the next transaction of rows; a
   * transaction already sent is always seen through to its listing. Rows not
   * started come back 'skipped'.
   */
  signal?: AbortSignal;
  /**
   * Backoff for a rate limit (429), a 5xx or a network error on a read, an
   * upload, a build or a listing: `attempts` tries in all (default 5), the
   * wait doubling from `baseDelayMs` (default 2000). A funding transaction is
   * never sent twice.
   */
  retry?: { attempts?: number; baseDelayMs?: number };
}

/** A row that cannot be posted as it is, from postTasks()' checks before anything is sent (ApiError INVALID_ROWS, `body.errors`). */
export interface PostTasksRowError {
  /** The row's position in the array passed to postTasks(). */
  index: number;
  code: string;
  message: string;
}

/** What happened to one row of postTasks(), by its position in the input. */
export type PostTasksRowResult =
  /** Funded and listed. */
  | { index: number; status: 'posted'; task: PostedTask }
  /**
   * Funded (or sent and maybe funded, with code UNCONFIRMED) but not listed.
   * Do not post it again: list it with indexTask(indexParams), or with
   * indexTasks() when `batch` is true, or cancel it for a refund.
   */
  | {
    index: number; status: 'unlisted'; taskHash: string; txHash: string; batch: boolean;
    indexParams: IndexTaskParams; aesKey?: string; error: { code?: string; message: string };
  }
  /** Nothing was funded for this row. */
  | { index: number; status: 'failed'; error: { code?: string; message: string } }
  /** Not started: the run was aborted, or stopped at an earlier row. */
  | { index: number; status: 'skipped'; reason: string };

export interface PostTasksResult {
  chain: string;
  chainId: number;
  /** 'batch': createTasks, several tasks per transaction. 'single': one createTask per task. */
  mode: 'batch' | 'single';
  /** One per input row, in input order. */
  results: PostTasksRowResult[];
  posted: number;
  unlisted: number;
  failed: number;
  skipped: number;
  /**
   * Why the run stopped before the last row, when it did: an on-chain or
   * listing failure (so no further escrow is funded behind it), a backend
   * that built the wrong transaction, one that stayed unreachable, or the abort signal.
   */
  stopped?: { index: number; code?: string; message: string };
}

/** POST /api/v1/tasks/batch: several posts built into one createTasks transaction. */
export interface CreateTasksRequest {
  token: Address;
  tasks: Array<Omit<CreateTaskRequest, 'token'>>;
}

export interface CreateTasksTx {
  unsignedTx: { to: Address; data: Hex; value?: string; from?: Address };
  chain?: string;
  chainId?: number;
  /** The task hashes the transaction escrows, in order. */
  taskHashes?: string[];
}

/** POST /api/v1/a2a/tasks/index-batch: list the tasks one transaction funded. */
export interface IndexTasksParams {
  txHash: string;
  isUserOp?: boolean;
  tasks: Array<Omit<IndexTaskParams, 'txHash'>>;
}

export interface IndexTasksResult {
  results: Array<
    | { taskHash: string; onChainTaskId?: string; indexed: true }
    | { taskHash: string; error: { code?: string; message: string } }
  >;
}

/** A refund the client signed and sent: cancelAndRefund() or reclaimAfterTimeout(). */
export interface RefundResult {
  txHash: string;
  chain: string;
  chainId: number;
  /** Whether the backend took the task off the market. False leaves it listed until its deadline; the refund stands either way. */
  listingClosed: boolean;
  /**
   * What the transaction did, when the backend says: 'refund' returned the
   * escrow to the poster; 'escalate' (reclaimAfterTimeout on work delivered
   * before the deadline and never judged) sent the task for review and
   * refunded nothing. An admin rules on it, and with no ruling within 14 days
   * the worker is paid.
   */
  outcome?: 'refund' | 'escalate';
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
  /**
   * Whether this chain's escrow has createTasks (several tasks in one
   * transaction), and how many one call takes. Absent from older backends,
   * which is the same as unsupported.
   */
  batchCreate?: { supported: boolean; maxBatch: number };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Per-chain RPC URLs for signing `submitEvidence` — a task is escrowed on exactly one chain. */
export interface DeliverSigner {
  /** Private key of the executor wallet (the API key's owner) — `submitEvidence` is `onlyWorker`. */
  privateKey: string;
  /** RPC per chain. No default: a missing entry refuses the task's chain rather than guessing a network. */
  rpcUrls: Partial<Record<string, string | undefined>>;
}


// ── Posting many tasks: internals ───────────────────────────────────────────

/** Rows per postTasks() call: past this, split the list (each row is sealed in memory first). */
const MAX_POST_TASKS_ROWS = 1000;
/** Rows per createTasks transaction unless chunkSize says otherwise. */
const DEFAULT_CHUNK_SIZE = 20;
/** POST /storage/upload-batch and /a2a/tasks/index-batch take at most this many items. */
const MAX_BATCH_REQUEST = 50;
const MAX_RETRY_DELAY_MS = 30_000;
/** The category the backend builds every task with (backend/src/routes/tasks.ts): bound in the calldata check like the rest. */
const TASK_CATEGORY = 'general';
/** A createTasks gas limit is its estimate plus a fifth. */
const BATCH_GAS_HEADROOM_PCT = 120n;
/**
 * Briefs per /storage/upload-batch request. The backend stores briefs on 0G
 * one at a time (20–40 s each) and answers within ~85 s, and production sits
 * behind a ~100 s edge timeout (Cloudflare's 524), so a request carries two
 * at most. The web app does the same (frontend/src/lib/postTaskFlow.ts).
 */
const UPLOAD_GROUP = 2;
/** How long one upload request may take before it counts as timed out. */
const UPLOAD_TIMEOUT_MS = 95_000;

/** The posting chain, its escrow and token, and the signer checked against them. */
interface PostingContext {
  postingChain: string;
  entry: SettlementChainInfo & { escrowAddress: string };
  escrow: string;
  token: string;
  isNative: boolean;
  signer: ethers.Signer;
  poster: string;
}

interface RetryPolicy { attempts: number; baseDelayMs: number }

/** One postTasks() run: the checked rows and their sealed briefs, and what has happened so far. */
interface PostingRun {
  ctx: PostingContext;
  posts: NormalizedPost[];
  sealed: SealedBrief[];
  opts: PostTasksOptions;
  retry: RetryPolicy;
  timeoutMs: number;
  /** Rows not yet settled: the approval covers exactly these. */
  pending: Set<number>;
  approved: boolean;
  /** The next nonce, once a transaction of this run has confirmed (an RPC can answer from before it). */
  nonce?: number;
  settle: (result: PostTasksRowResult) => Promise<void>;
}

interface RunOutcome {
  /** Stop here: nothing more is funded behind this row. */
  halt?: { index: number; code?: string; message: string };
  /** Rows to post one by one instead: the escrow refused createTasks. */
  fallback?: number[];
}

function retryPolicy(retry: PostTasksOptions['retry']): RetryPolicy {
  const attempts = retry?.attempts ?? 5;
  const baseDelayMs = retry?.baseDelayMs ?? 2_000;
  return {
    attempts: Number.isInteger(attempts) && attempts >= 1 ? attempts : 5,
    baseDelayMs: Number.isFinite(baseDelayMs) && baseDelayMs >= 0 ? baseDelayMs : 2_000,
  };
}

/**
 * A rate limit (429): the backend's limiter refused the request before the
 * route ran, so it created nothing and took no fee. Asking again is safe.
 */
function isRateLimited(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 429 || err.code === 'RATE_LIMIT');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const ERC20_TRANSFER = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);

/**
 * Wait, up to about 10 s, until the signer's RPC counts every transaction
 * this run sent from it (`next` is the nonce after the last one), so the
 * next transaction is not given a nonce already used: a load-balanced RPC
 * can answer from a node a block behind the one that confirmed. Best effort:
 * an RPC that cannot say is not waited for.
 */
async function settleNonce(signer: ethers.Signer, next: number | undefined): Promise<void> {
  if (next === undefined || !signer.provider) return;
  const address = await signer.getAddress();
  for (let i = 0; i < 20; i++) {
    try {
      if ((await signer.provider.getTransactionCount(address, 'pending')) >= next) return;
    } catch {
      return;
    }
    await sleep(500);
  }
}

/** A rate limit, a server error, a network failure, or a body that was not JSON (a proxy's error page): worth asking again. */
function isTransient(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 429 || err.status >= 500 || err.code === 'RATE_LIMIT' || err.code === 'TIMEOUT';
  return err instanceof TypeError || err instanceof SyntaxError;
}

/**
 * Storage busy or unreachable, as opposed to a brief the backend refused or
 * an answer that does not add up: a dropped connection (fetch's TypeError),
 * this client's own timeout, or a gateway giving up (502, 503, 504,
 * Cloudflare's 524): the web app's isTransientUploadError. A rate limit
 * (429) counts too: it asks to come back later, which the backoff does.
 */
function isTransientUpload(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  if (!(err instanceof ApiError)) return false;
  return err.code === 'TIMEOUT' || err.code === 'RATE_LIMIT' || [429, 502, 503, 504, 524].includes(err.status);
}

/**
 * Failures before a row is funded that stop the whole run rather than that
 * row: a backend that built the wrong transaction or moved chain, an auth
 * failure, or one that stayed unreachable through every retry. Anything else
 * (a brief the backend refuses, say) fails the row alone.
 */
const HALTING_CODES = new Set([
  'ESCROW_MISMATCH', 'TX_MISMATCH', 'CHAIN_MISMATCH', 'POSTING_CHAIN_CHANGED', 'CHAIN_UNKNOWN',
  'SETTLEMENT_NOT_POSTABLE', 'WRONG_CHAIN', 'OWNER_MISMATCH', 'UPLOAD_MISMATCH',
]);
function haltsBeforeFunding(err: unknown): boolean {
  if (err instanceof ApiError && (HALTING_CODES.has(err.code ?? '') || err.status === 401 || err.status === 403)) return true;
  // The escrow approve reverted or never confirmed: no row can be funded.
  if (!(err instanceof ApiError)) return true;
  return isTransient(err);
}

function errorInfo(err: unknown): { code?: string; message: string } {
  const e = err as { code?: unknown; message?: unknown };
  const code = err instanceof ApiError || err instanceof UnconfirmedTransactionError
    ? (err as ApiError).code
    : typeof e?.code === 'string' ? e.code : undefined;
  return { ...(code ? { code } : {}), message: typeof e?.message === 'string' ? e.message : String(err) };
}

function haltAt(index: number, err: unknown, code?: string): { index: number; code?: string; message: string } {
  const info = errorInfo(err);
  const c = code ?? info.code;
  return { index, ...(c ? { code: c } : {}), message: info.message };
}

function rowError(index: number, err: unknown): PostTasksRowError {
  const info = errorInfo(err);
  return { index, code: info.code ?? 'INVALID_ROW', message: info.message };
}

function invalidRows(errors: PostTasksRowError[], total: number): ApiError {
  errors.sort((a, b) => a.index - b.index);
  const shown = errors.slice(0, 3).map((e) => `rows[${e.index}]: ${e.message.replace(/\s*Nothing was sent\.?$/, '')}`).join('; ');
  return new ApiError(
    400,
    `${errors.length} of ${total} rows cannot be posted as they are (${shown}${errors.length > 3 ? '; …' : ''}). Nothing was sent: fix them, or leave them out, and post again.`,
    { errors },
    'INVALID_ROWS',
  );
}

function failedRow(index: number, err: unknown): PostTasksRowResult {
  return { index, status: 'failed', error: errorInfo(err) };
}

function unlistedRow(
  index: number, txHash: string, batch: boolean, indexParams: IndexTaskParams, aesKey: string | undefined, error: { code?: string; message: string },
): PostTasksRowResult {
  return {
    index, status: 'unlisted', taskHash: indexParams.taskHash, txHash, batch,
    indexParams: { ...indexParams, txHash }, ...(aesKey ? { aesKey } : {}), error,
  };
}

/**
 * The rows an all-or-nothing POST /tasks/batch refused, by position in the
 * request, when its 400 names them ({ errors: [{ index, code, message }] });
 * null when it does not, so the whole call fails as it came back.
 */
function refusedRows(err: unknown, count: number): PostTasksRowError[] | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null;
  const body = err.body as { errors?: unknown; error?: { errors?: unknown; details?: { errors?: unknown } } } | undefined;
  const list = body?.error?.errors ?? body?.errors ?? body?.error?.details?.errors;
  if (!Array.isArray(list)) return null;
  const rows = list
    .filter((e): e is { index: number; code?: unknown; message?: unknown } =>
      !!e && typeof e === 'object' && Number.isInteger((e as { index?: unknown }).index)
      && (e as { index: number }).index >= 0 && (e as { index: number }).index < count)
    .map((e) => ({ index: e.index, code: typeof e.code === 'string' ? e.code : 'INVALID_ROW', message: typeof e.message === 'string' ? e.message : 'refused by the backend' }));
  return rows.length > 0 ? rows : null;
}

const capsKey = (caps: readonly string[]) => [...caps].sort().join(',');

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
  private trustedEscrows: SettlementPin[];

  constructor(config: BlindMarketConfig) {
    this.apiBase = config.apiBase ?? 'https://api.blindmarket.xyz';
    this.apiKey = config.apiKey;
    this.executor = config.executor;
    this.trustedEscrows = config.trustedEscrows ?? [];
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

  /**
   * `timeoutMs` gives up on a request that has not answered (ApiError
   * TIMEOUT). `strictBody` turns a reply that is not JSON (a gateway's error
   * page, such as Cloudflare's 524) into an ApiError carrying its HTTP status,
   * instead of the parser's SyntaxError.
   */
  private async req<T>(method: string, path: string, body?: unknown, opts: { timeoutMs?: number; strictBody?: boolean } = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.apiBase}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
      });
    } catch (err) {
      if (opts.timeoutMs && (err as Error)?.name === 'TimeoutError') {
        throw new ApiError(0, `${path} did not answer within ${Math.round(opts.timeoutMs / 1000)} s.`, undefined, 'TIMEOUT');
      }
      throw err;
    }
    let json: { success: boolean; data?: T; error?: { code?: string; message: string; reason?: string } };
    try {
      json = await res.json() as typeof json;
    } catch (err) {
      if (opts.strictBody) throw new ApiError(res.status, `${path} answered HTTP ${res.status} with a body that is not JSON.`, undefined, `HTTP_${res.status}`);
      throw err;
    }
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
   * `outcome` says what it will do: on work delivered before the deadline and
   * never judged, the escrow sends the task for review ('escalate') instead
   * of refunding it, and `message` explains.
   */
  async claimTimeout(taskId: string, chain?: string): Promise<{ unsignedTx: object; chain?: string; chainId?: number; outcome?: 'refund' | 'escalate'; message?: string }> {
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
    const post = normalizePost(params, opts.maxAmountRaw);
    if (post.open) await this.assertOpenSubmission('Posting a task many agents submit to');
    const ctx = await this.postingContext(opts.signer);
    if (post.open && post.verifierAddress!.toLowerCase() === ctx.poster.toLowerCase()) {
      throw new ApiError(400, 'The verifier agent judges the submissions, so it cannot be the wallet that posts the task. Nothing was sent.', undefined, 'INVALID_VERIFIER');
    }
    await this.assertCovers(ctx, post.amount);

    // The brief: plaintext, or encrypted to the executors that can take it.
    const executors = post.privacy === 'public' ? [] : await this.postingExecutors(ctx.postingChain, post.requiredCapabilities);
    const sealed = await sealBrief(post, executors, ctx.postingChain);
    const { taskHash } = sealed;
    const { rootHash } = await this.uploadBlob(ethers.encodeBase64(sealed.blob));

    const built = await this.createTask(createTaskBody(post, sealed, ctx.token, rootHash));
    const createCall = this.checkedCreateCall(ctx, built, post, taskHash);

    const timeoutMs = opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    // createTask pulls an ERC-20 with transferFrom: approve the escrow first.
    const nonce = ctx.isNative ? undefined : await ensureAllowance(ctx.signer, ctx.token, ctx.escrow, post.amount, { timeoutMs });
    const indexParams = indexParamsFor(post, sealed, rootHash);
    let txHash: string;
    try {
      ({ hash: txHash } = await sendAndWait(ctx.signer, createCall, {
        value: ctx.isNative ? post.amount : undefined,
        nonce,
        timeoutMs,
        onSent: (hash, sentNonce, raw) => opts.onFunded?.({ txHash: hash, nonce: sentNonce, ...(raw ? { raw } : {}), taskHash, indexParams: { ...indexParams, txHash: hash } }),
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
    return this.postedTask(ctx, post, sealed, rootHash, txHash, indexed.onChainTaskId);
  }

  /**
   * Post many tasks, from the API key's own wallet: postTask() for a list, in
   * as few transactions as the posting chain's escrow allows.
   *
   * Every row is checked and its brief sealed before anything is uploaded or
   * sent: a row the escrow or the backend would refuse throws 400
   * INVALID_ROWS listing every such row (`err.body.errors`), with nothing
   * sent. The wallet must hold the total, and the escrow is approved for it
   * once, just before the first funding transaction.
   *
   * On an escrow with createTasks (SettlementChainInfo.batchCreate) up to
   * `chunkSize` rows share one transaction and one listing call; otherwise
   * each row is its own createTask, as postTask() sends it. The same checks
   * guard every transaction: the backend's build must be exactly these tasks,
   * for this escrow and chain, before a key signs it.
   *
   * A row the backend refuses before funding fails alone and the run goes on.
   * A funding transaction that reverts or cannot be confirmed, a listing that
   * fails, or a backend that builds the wrong transaction or stays
   * unreachable stops the run there (`result.stopped`), so no further escrow
   * is funded behind a problem. Nothing is ever funded twice: a funded row
   * that is not listed comes back 'unlisted' with its `indexParams`.
   *
   * @example
   * const res = await bb.postTasks(rows, {
   *   onFunded: ({ taskHash, indexParams }) => save(taskHash, indexParams),
   *   onProgress: ({ done, total }) => console.log(`${done}/${total}`),
   * });
   */
  async postTasks(rows: PostTaskParams[], opts: PostTasksOptions = {}): Promise<PostTasksResult> {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new ApiError(400, 'postTasks() needs at least one row. Nothing was sent.', undefined, 'NO_ROWS');
    }
    if (rows.length > MAX_POST_TASKS_ROWS) {
      throw new ApiError(400, `postTasks() takes at most ${MAX_POST_TASKS_ROWS} rows per call, not ${rows.length}: split the list. Nothing was sent.`, undefined, 'TOO_MANY_ROWS');
    }
    if (opts.chunkSize !== undefined && (!Number.isInteger(opts.chunkSize) || opts.chunkSize < 1)) {
      throw new ApiError(400, `chunkSize must be a whole number of rows from 1, not ${opts.chunkSize}. Nothing was sent.`, undefined, 'INVALID_CHUNK_SIZE');
    }

    // 1. Each row's own fields, before any lookup.
    const errors: PostTasksRowError[] = [];
    const checked = rows.map((row, index) => {
      try {
        checkRowFields(row);
        return normalizePost(row);
      } catch (err) {
        errors.push(rowError(index, err));
        return undefined;
      }
    });
    if (errors.length > 0) throw invalidRows(errors, rows.length);
    const posts = checked as NormalizedPost[];
    const total = posts.reduce((sum, p) => sum + p.amount, 0n);
    if (opts.maxTotalRaw !== undefined && total > BigInt(opts.maxTotalRaw)) {
      throw new ApiError(402, `The ${rows.length} escrows total ${total}, above your limit of ${opts.maxTotalRaw}. Nothing was sent.`, undefined, 'AMOUNT_ABOVE_MAX');
    }

    // 2. Where, and from which wallet: postTask()'s checks, for the total.
    const retry = retryPolicy(opts.retry);
    const ctx = await this.postingContext(opts.signer);
    await this.assertCovers(ctx, total);

    // 3. Every brief sealed, still before anything is sent. Executors are
    //    asked for once per capability list.
    const executors = new Map<string, ExecutorKey[]>();
    for (const post of posts) {
      if (post.privacy !== 'private') continue;
      const key = capsKey(post.requiredCapabilities);
      if (!executors.has(key)) executors.set(key, await this.retrying(() => this.postingExecutors(ctx.postingChain, post.requiredCapabilities), retry));
    }
    const sealed: SealedBrief[] = [];
    for (let i = 0; i < posts.length; i++) {
      try {
        const post = posts[i];
        sealed[i] = await sealBrief(post, post.privacy === 'private' ? executors.get(capsKey(post.requiredCapabilities))! : [], ctx.postingChain);
      } catch (err) {
        errors.push(rowError(i, err));
      }
    }
    // A public brief's task hash is the brief's hash, and the market lists a hash once.
    const firstWithHash = new Map<string, number>();
    sealed.forEach((s, i) => {
      if (!s) return;
      const hash = s.taskHash.toLowerCase();
      const first = firstWithHash.get(hash);
      if (first === undefined) firstWithHash.set(hash, i);
      else errors.push({ index: i, code: 'DUPLICATE_BRIEF', message: `rows[${i}] is the same public brief as rows[${first}], and the market lists a brief once. Nothing was sent.` });
    });
    if (errors.length > 0) throw invalidRows(errors, rows.length);

    // 4. Fund and list, in as few transactions as the escrow allows.
    const batch = ctx.entry.batchCreate;
    const batchable = !ctx.isNative && batch?.supported === true && Number.isInteger(batch.maxBatch) && batch.maxBatch > 1;
    const size = batchable ? Math.max(1, Math.min(opts.chunkSize ?? DEFAULT_CHUNK_SIZE, batch!.maxBatch, MAX_BATCH_REQUEST)) : 1;
    let mode: PostTasksResult['mode'] = size > 1 ? 'batch' : 'single';
    let units: number[][] = [];
    for (let i = 0; i < posts.length; i += size) units.push(posts.slice(i, i + size).map((_, j) => i + j));

    const results: PostTasksRowResult[] = new Array(rows.length);
    const run: PostingRun = {
      ctx, posts, sealed, opts, retry,
      timeoutMs: opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS,
      pending: new Set(posts.map((_, i) => i)),
      approved: ctx.isNative,
      settle: async (result) => {
        results[result.index] = result;
        run.pending.delete(result.index);
        try {
          await opts.onProgress?.({ done: rows.length - run.pending.size, total: rows.length, result });
        } catch { /* a progress callback never stops a run that is moving money */ }
      },
    };
    let stopped: PostTasksResult['stopped'];
    for (let u = 0; u < units.length; u++) {
      const unit = units[u];
      if (!stopped && opts.signal?.aborted) {
        stopped = { index: unit[0], code: 'ABORTED', message: 'The run was aborted before this row started.' };
      }
      if (stopped) {
        const reason = stopped.code === 'ABORTED' ? 'aborted' : `stopped at rows[${stopped.index}]: ${stopped.message}`;
        for (const i of unit) await run.settle({ index: i, status: 'skipped', reason });
        continue;
      }
      const outcome = unit.length === 1 ? await this.postRow(run, unit[0]) : await this.postChunk(run, unit);
      if (outcome.fallback && outcome.fallback.length > 0) {
        // The escrow refused createTasks after all: the rest go one by one.
        mode = 'single';
        units = [...units.slice(0, u + 1), ...outcome.fallback.map((i) => [i]), ...units.slice(u + 1).flat().map((i) => [i])];
      }
      if (outcome.halt) stopped = outcome.halt;
    }

    const count = (status: PostTasksRowResult['status']) => results.filter((r) => r.status === status).length;
    return {
      chain: ctx.postingChain,
      chainId: ctx.entry.chainId,
      mode,
      results,
      posted: count('posted'),
      unlisted: count('unlisted'),
      failed: count('failed'),
      skipped: count('skipped'),
      ...(stopped ? { stopped } : {}),
    };
  }

  /**
   * Build and list several posts at once (POST /api/v1/tasks/batch): one
   * unsigned createTasks transaction for the posting chain's escrow. Only an
   * escrow with createTasks builds it (409 BATCH_UNSUPPORTED otherwise);
   * postTasks() calls it, and checks the transaction before signing.
   */
  async createTasks(params: CreateTasksRequest): Promise<CreateTasksTx> {
    return this.req<CreateTasksTx>('POST', '/api/v1/tasks/batch', params);
  }

  /**
   * List every task one funding transaction created
   * (POST /api/v1/a2a/tasks/index-batch). It works for a transaction that
   * funded one task too. Each task comes back listed, or with its own error;
   * a task the receipt does not hold is NOT_IN_RECEIPT. postTasks() calls it;
   * call it yourself to finish rows it returned 'unlisted' with `batch` true.
   */
  async indexTasks(params: IndexTasksParams): Promise<IndexTasksResult> {
    return this.req<IndexTasksResult>('POST', '/api/v1/a2a/tasks/index-batch', params);
  }

  /**
   * Upload several blobs to 0G Storage in one call
   * (POST /api/v1/storage/upload-batch). Each is base64, as uploadBlob()
   * takes it; the results come back in the same order. All or nothing.
   */
  async uploadBlobs(data: string[]): Promise<Array<{ rootHash: string; txHash?: string }>> {
    const { results } = await this.req<{ results: Array<{ rootHash: string; txHash?: string }> }>(
      'POST', '/api/v1/storage/upload-batch', { items: data.map((d) => ({ data: d })) },
    );
    return results;
  }

  /** The posting chain, its escrow and token, and a signer checked to be the API key's own wallet on that chain. */
  private async postingContext(signerOption?: ethers.Signer): Promise<PostingContext> {
    const { postingChain, chains } = await this.getSettlement();
    const entry = chains.find((c) => c.chain === postingChain);
    if (!postingChain || !entry || !entry.escrowAddress || !entry.token.address) {
      throw new ApiError(503, `The backend has no chain to post new tasks on right now (posting chain: ${postingChain ?? 'none'}). Nothing was sent.`, { postingChain, chains }, 'SETTLEMENT_NOT_POSTABLE');
    }
    // The escrow approved and funded, and its token, must be a known
    // deployment (or one the caller trusts), not whatever the backend names.
    if (!isPinnedSettlement(entry.chainId, entry.escrowAddress, entry.token.address, this.trustedEscrows)) {
      const known = [...SETTLEMENT_PINS, ...this.trustedEscrows].filter((p) => p.chainId === entry.chainId);
      throw new ApiError(
        409,
        `The backend names escrow ${entry.escrowAddress} and token ${entry.token.address} on ${postingChain} (chain ${entry.chainId}), which ${known.length ? `is not the known deployment (escrow ${known.map((p) => p.escrow).join(' or ')})` : 'has no known deployment'}. Nothing was approved or sent. For a custom or local deployment, list it in BlindMarketConfig.trustedEscrows.`,
        undefined,
        'ESCROW_NOT_PINNED',
      );
    }
    const signer = signerOption ?? this.signerOn(postingChain, 'Funding the escrow');
    const poster = await signer.getAddress();
    await this.assertSpender(poster, 'A task', true);
    await assertSignerChain(signer, entry.chainId, `Funding the escrow on ${postingChain}`);
    return {
      postingChain,
      entry: entry as SettlementChainInfo & { escrowAddress: string },
      escrow: entry.escrowAddress,
      token: entry.token.address,
      isNative: entry.token.kind === 'native',
      signer,
      poster,
    };
  }

  /** Throws 402 INSUFFICIENT_BALANCE, with nothing sent, when the wallet holds less than `amount` of an ERC-20 settlement token. */
  private async assertCovers(ctx: PostingContext, amount: bigint): Promise<void> {
    if (ctx.isNative) return;
    const balance = await tokenBalance(ctx.signer, ctx.token, ctx.poster);
    if (balance < amount) {
      const fmt = (v: bigint) => ethers.formatUnits(v, ctx.entry.token.decimals);
      throw new ApiError(
        402,
        `${ctx.poster} holds ${fmt(balance)} ${ctx.entry.token.symbol} on ${ctx.postingChain}; the escrow needs ${fmt(amount)}. Nothing was sent.`,
        undefined,
        'INSUFFICIENT_BALANCE',
      );
    }
  }

  /** The executors on the posting chain a private brief can be wrapped to. */
  private async postingExecutors(postingChain: string, capabilities: readonly string[]): Promise<ExecutorKey[]> {
    const qs = new URLSearchParams({ capabilities: capabilities.join(','), chain: postingChain });
    const { executors } = await this.req<{ executors: ExecutorKey[] }>('GET', `/api/v1/a2a/executors?${qs}`);
    return executors;
  }

  /**
   * The backend's createTask, checked to be exactly this post before a key
   * signs it: the chain and escrow checked above, the task hash, the token,
   * the amount, the zone and the duration (a verifier commits through
   * createTaskWithVerifier). Only its to and data are signed; the value is
   * the amount computed here.
   */
  private checkedCreateCall(ctx: PostingContext, built: CreateTaskTx, post: NormalizedPost, taskHash: string): { to: string; data: string } {
    // A backend whose posting chain moved in between would otherwise have it signed blind.
    if ((built.chain !== undefined && built.chain !== ctx.postingChain) || (built.chainId !== undefined && Number(built.chainId) !== ctx.entry.chainId)) {
      throw new ApiError(409, `The backend built this task for ${built.chain} (chain ${built.chainId}), not ${ctx.postingChain}: its posting chain changed. Nothing was sent; try again.`, undefined, 'POSTING_CHAIN_CHANGED');
    }
    const withVerifier = commitsVerifier(post);
    const { open } = post;
    return checkEscrowCall(built.unsignedTx, {
      escrow: ctx.escrow,
      fn: open ? 'createTaskOpen' : withVerifier ? 'createTaskWithVerifier' : 'createTask',
      args: (a) => String(a[0]).toLowerCase() === taskHash.toLowerCase()
        && String(a[1]).toLowerCase() === ctx.token.toLowerCase()
        && a[2] === post.amount
        && a[3] === TASK_CATEGORY
        && a[4] === post.locationZone
        && a[5] === BigInt(post.duration)
        && (!(open || withVerifier) || String(a[6]).toLowerCase() === post.verifierAddress!.toLowerCase())
        // createTaskOpen's PickMode (0 the verifier picks, 1 the poster first) and the poster's window.
        && (!open || (a[7] === (open.pick === 'creator' ? 1n : 0n) && a[8] === BigInt(open.creatorWindow))),
      value: ctx.isNative ? post.amount : 0n,
      chainId: ctx.entry.chainId,
    }, `Funding the escrow on ${ctx.postingChain}`);
  }

  /** The backend's createTasks, checked to be exactly these posts, in this order, for this token, escrow and chain. */
  private checkedCreateTasksCall(ctx: PostingContext, built: CreateTasksTx, rows: Array<{ post: NormalizedPost; taskHash: string }>): { to: string; data: string } {
    if ((built.chain !== undefined && built.chain !== ctx.postingChain) || (built.chainId !== undefined && Number(built.chainId) !== ctx.entry.chainId)) {
      throw new ApiError(409, `The backend built these tasks for ${built.chain} (chain ${built.chainId}), not ${ctx.postingChain}: its posting chain changed. Nothing was sent; try again.`, undefined, 'POSTING_CHAIN_CHANGED');
    }
    return checkEscrowCall(built.unsignedTx, {
      escrow: ctx.escrow,
      fn: 'createTasks',
      args: (a) => {
        if (String(a[0]).toLowerCase() !== ctx.token.toLowerCase()) return false;
        const tasks = a[1] as ethers.Result;
        if (tasks.length !== rows.length) return false;
        return rows.every(({ post, taskHash }, j) => {
          const t = tasks[j] as ethers.Result;
          const verifier = commitsVerifier(post) ? post.verifierAddress!.toLowerCase() : ethers.ZeroAddress;
          return String(t[0]).toLowerCase() === taskHash.toLowerCase()
            && t[1] === post.amount
            && t[2] === TASK_CATEGORY
            && t[3] === post.locationZone
            && t[4] === BigInt(post.duration)
            && String(t[5]).toLowerCase() === verifier;
        });
      },
      value: 0n,
      chainId: ctx.entry.chainId,
    }, `Funding ${rows.length} escrows on ${ctx.postingChain}`);
  }

  private postedTask(ctx: PostingContext, post: NormalizedPost, sealed: SealedBrief, rootHash: string, txHash: string, onChainTaskId?: string | number): PostedTask {
    return {
      taskHash: sealed.taskHash,
      ...(onChainTaskId !== undefined ? { taskId: String(onChainTaskId) } : {}),
      txHash,
      chain: ctx.postingChain,
      chainId: ctx.entry.chainId,
      rootHash,
      privacy: post.privacy,
      wrappedTo: sealed.wrappedKeys ? Object.keys(sealed.wrappedKeys).length : 0,
      ...(sealed.aesKey ? { aesKey: sealed.aesKey } : {}),
      ...(post.open ? { open: post.open } : {}),
    };
  }

  /**
   * The escrow's ERC-20 allowance for every row still to fund, approved once,
   * right before the first funding transaction (after that transaction's
   * build has been checked, as postTask() approves).
   */
  private async approveRemaining(run: PostingRun): Promise<void> {
    if (run.approved) return;
    let remaining = 0n;
    for (const i of run.pending) remaining += run.posts[i].amount;
    const nonce = await ensureAllowance(run.ctx.signer, run.ctx.token, run.ctx.escrow, remaining, { timeoutMs: run.timeoutMs });
    run.approved = true;
    if (nonce !== undefined) run.nonce = nonce;
  }

  /** Every row a transaction funds, told its hash (again with a replacement's hash if the wallet re-priced it). */
  private async notifyFunded(run: PostingRun, rows: Array<{ index: number; indexParams: IndexTaskParams }>, hash: string, nonce: number, batch: boolean, raw?: string): Promise<void> {
    for (const { index, indexParams } of rows) {
      try {
        await run.opts.onFunded?.({ index, txHash: hash, nonce, ...(raw ? { raw } : {}), taskHash: indexParams.taskHash, batch, indexParams: { ...indexParams, txHash: hash } });
      } catch { /* the transaction is out; one row's callback must not keep the others from hearing it */ }
    }
  }

  /** One row as its own createTask, the way postTask() posts it. */
  private async postRow(run: PostingRun, i: number): Promise<RunOutcome> {
    const { ctx, retry } = run;
    const post = run.posts[i];
    const sealed = run.sealed[i];
    let call: { to: string; data: string };
    let rootHash: string;
    try {
      [rootHash] = await this.uploadBriefs([ethers.encodeBase64(sealed.blob)], retry, false);
      const built = await this.retrying(() => this.createTask(createTaskBody(post, sealed, ctx.token, rootHash)), retry);
      call = this.checkedCreateCall(ctx, built, post, sealed.taskHash);
      await this.approveRemaining(run);
    } catch (err) {
      await run.settle(failedRow(i, err));
      return haltsBeforeFunding(err) ? { halt: haltAt(i, err) } : {};
    }

    const indexParams = indexParamsFor(post, sealed, rootHash);
    let txHash: string;
    try {
      const sent = await sendAndWait(ctx.signer, call, {
        value: ctx.isNative ? post.amount : undefined,
        nonce: run.nonce,
        timeoutMs: run.timeoutMs,
        onSent: (hash, nonce, raw) => this.notifyFunded(run, [{ index: i, indexParams }], hash, nonce, false, raw),
        unconfirmedHint: (hash) => `If it confirms, call indexTask() with txHash '${hash}' to list the task; do not fund it again.`,
      });
      run.nonce = sent.nonce + 1;
      txHash = sent.hash;
    } catch (err) {
      run.nonce = undefined;
      if (err instanceof UnconfirmedTransactionError) {
        await run.settle(unlistedRow(i, err.hash, false, indexParams, sealed.aesKey, { code: 'UNCONFIRMED', message: err.message }));
        return { halt: haltAt(i, err, 'UNCONFIRMED') };
      }
      await run.settle(failedRow(i, err));
      return { halt: haltAt(i, err) };
    }

    indexParams.txHash = txHash;
    try {
      const indexed = await this.retrying(() => this.indexTask(indexParams), retry, { receiptLag: true });
      await run.settle({ index: i, status: 'posted', task: this.postedTask(ctx, post, sealed, rootHash, txHash, indexed.onChainTaskId) });
      return {};
    } catch (err) {
      await run.settle(unlistedRow(i, txHash, false, indexParams, sealed.aesKey, errorInfo(err)));
      return { halt: haltAt(i, err) };
    }
  }

  /** Several rows in one createTasks transaction, listed with one call. */
  private async postChunk(run: PostingRun, unit: number[]): Promise<RunOutcome> {
    const { ctx, retry } = run;
    let live = [...unit];
    const rootHashes = new Map<number, string>();
    let call: { to: string; data: string };
    let gasLimit: bigint;
    try {
      // Every brief of the chunk is stored before anything of it is built or funded.
      const roots = await this.uploadBriefs(live.map((i) => ethers.encodeBase64(run.sealed[i].blob)), retry, true);
      live.forEach((i, j) => rootHashes.set(i, roots[j]));
      const build = () => this.retrying(() => this.createTasks({
        token: ctx.token as Address,
        tasks: live.map((i) => {
          const { token: _token, ...task } = createTaskBody(run.posts[i], run.sealed[i], ctx.token, rootHashes.get(i)!);
          return task;
        }),
      }), retry);
      let built: CreateTasksTx;
      try {
        built = await build();
      } catch (err) {
        // All or nothing: the rows the backend refused fail, and the rest are built again, once.
        const refused = refusedRows(err, live.length);
        if (!refused) throw err;
        const bad = new Set(refused.map((r) => r.index));
        for (const r of refused) await run.settle({ index: live[r.index], status: 'failed', error: { code: r.code, message: r.message } });
        live = live.filter((_, j) => !bad.has(j));
        if (live.length === 0) return {};
        built = await build();
      }
      call = this.checkedCreateTasksCall(ctx, built, live.map((i) => ({ post: run.posts[i], taskHash: run.sealed[i].taskHash })));
      await this.approveRemaining(run);
      // A createTasks costs about 200k gas per task. The limit is estimated
      // here, after the approve it depends on, with headroom; a backend's gas
      // field is never forwarded (security audit run 1, C41). An estimate that
      // fails is a revert predicted before anything is sent.
      const estimate = await ctx.signer.estimateGas({ to: call.to, data: call.data, ...(run.nonce !== undefined ? { nonce: run.nonce } : {}) });
      gasLimit = (estimate * BATCH_GAS_HEADROOM_PCT) / 100n;
    } catch (err) {
      // An escrow that refuses createTasks after all: these rows go one by one.
      if (err instanceof ApiError && err.code === 'BATCH_UNSUPPORTED') return { fallback: live };
      for (const i of live) await run.settle(failedRow(i, err));
      return haltsBeforeFunding(err) ? { halt: haltAt(live[0], err) } : {};
    }

    const indexParams = new Map(live.map((i) => [i, indexParamsFor(run.posts[i], run.sealed[i], rootHashes.get(i)!)]));
    const funded = live.map((i) => ({ index: i, indexParams: indexParams.get(i)! }));
    let txHash: string;
    try {
      const sent = await sendAndWait(ctx.signer, call, {
        nonce: run.nonce,
        gasLimit,
        timeoutMs: run.timeoutMs,
        onSent: (hash, nonce, raw) => this.notifyFunded(run, funded, hash, nonce, true, raw),
        unconfirmedHint: (hash) => `If it confirms, call indexTasks() with txHash '${hash}' to list these tasks; do not fund them again.`,
      });
      run.nonce = sent.nonce + 1;
      txHash = sent.hash;
    } catch (err) {
      run.nonce = undefined;
      if (err instanceof UnconfirmedTransactionError) {
        for (const i of live) await run.settle(unlistedRow(i, err.hash, true, indexParams.get(i)!, run.sealed[i].aesKey, { code: 'UNCONFIRMED', message: err.message }));
        return { halt: haltAt(live[0], err, 'UNCONFIRMED') };
      }
      for (const i of live) await run.settle(failedRow(i, err));
      return { halt: haltAt(live[0], err) };
    }

    for (const params of indexParams.values()) params.txHash = txHash;
    let listed: IndexTasksResult;
    try {
      listed = await this.retrying(() => this.indexTasks({
        txHash,
        tasks: live.map((i) => {
          const { txHash: _tx, ...task } = indexParams.get(i)!;
          return task;
        }),
      }), retry, { receiptLag: true });
    } catch (err) {
      for (const i of live) await run.settle(unlistedRow(i, txHash, true, indexParams.get(i)!, run.sealed[i].aesKey, errorInfo(err)));
      return { halt: haltAt(live[0], err) };
    }
    const byHash = new Map((Array.isArray(listed?.results) ? listed.results : []).map((r) => [String(r?.taskHash).toLowerCase(), r]));
    let firstUnlisted: { index: number; code?: string; message: string } | undefined;
    for (const i of live) {
      const sealed = run.sealed[i];
      const r = byHash.get(sealed.taskHash.toLowerCase());
      if (r && 'indexed' in r && r.indexed) {
        await run.settle({ index: i, status: 'posted', task: this.postedTask(ctx, run.posts[i], sealed, rootHashes.get(i)!, txHash, r.onChainTaskId) });
        continue;
      }
      const error = r && 'error' in r && r.error ? r.error : { code: 'NOT_LISTED', message: 'The backend did not say it listed this task.' };
      await run.settle(unlistedRow(i, txHash, true, indexParams.get(i)!, sealed.aesKey, error));
      firstUnlisted ??= { index: i, ...(error.code ? { code: error.code } : {}), message: `funded in ${txHash} but not listed: ${error.message}` };
    }
    return firstUnlisted ? { halt: firstUnlisted } : {};
  }

  /**
   * Store briefs (base64) and return their root hashes, in order. Batched
   * (upload-batch), they go UPLOAD_GROUP to a request, one request after the
   * other; a group that fails transiently (isTransientUpload) is sent again
   * one brief per request, each with the backoff, and a brief already stored
   * comes back at once. Unbatched, each brief is one /storage/upload request
   * with the backoff. A refusal (a 400) or an answer that does not add up
   * fails at once.
   */
  private async uploadBriefs(blobs: string[], retry: RetryPolicy, batched: boolean): Promise<string[]> {
    const one = (blob: string) => this.retrying(
      () => (batched ? this.uploadBatchRequest([blob]) : this.uploadOneRequest(blob)),
      retry,
      { retryable: isTransientUpload },
    );
    const roots: string[] = [];
    for (let i = 0; i < blobs.length; i += batched ? UPLOAD_GROUP : 1) {
      const group = blobs.slice(i, i + (batched ? UPLOAD_GROUP : 1));
      if (group.length === 1) {
        roots.push(...(await one(group[0])));
        continue;
      }
      try {
        roots.push(...(await this.uploadBatchRequest(group)));
      } catch (err) {
        if (!isTransientUpload(err)) throw err;
        // A slow storage node pushed the pair past the deadline: one at a time.
        for (const blob of group) roots.push(...(await one(blob)));
      }
    }
    return roots;
  }

  /** One /storage/upload-batch request, checked to answer one root hash per brief. */
  private async uploadBatchRequest(blobs: string[]): Promise<string[]> {
    const res = await this.req<{ results?: Array<{ rootHash?: unknown }> }>(
      'POST', '/api/v1/storage/upload-batch', { items: blobs.map((data) => ({ data })) }, { timeoutMs: UPLOAD_TIMEOUT_MS, strictBody: true },
    );
    const results = Array.isArray(res?.results) ? res.results : [];
    if (results.length !== blobs.length || results.some((r) => typeof r?.rootHash !== 'string' || !r.rootHash)) {
      throw new ApiError(0, `The backend answered ${results.length} uploads for ${blobs.length} briefs. Nothing was sent.`, undefined, 'UPLOAD_MISMATCH');
    }
    return results.map((r) => r.rootHash as string);
  }

  /** One /storage/upload request, as postTask() stores a brief. */
  private async uploadOneRequest(blob: string): Promise<string[]> {
    const res = await this.req<{ rootHash?: unknown }>('POST', '/api/v1/storage/upload', { data: blob }, { timeoutMs: UPLOAD_TIMEOUT_MS, strictBody: true });
    if (typeof res?.rootHash !== 'string' || !res.rootHash) {
      throw new ApiError(0, 'The backend stored the brief but answered no root hash. Nothing was sent.', undefined, 'UPLOAD_MISMATCH');
    }
    return [res.rootHash];
  }

  /**
   * `fn`, asked again after a rate limit, a 5xx or a network error (and, for
   * a listing, while the backend's RPC has not seen the receipt), or after
   * what `retryable` says is worth another try.
   */
  private async retrying<T>(fn: () => Promise<T>, policy: RetryPolicy, opts: { receiptLag?: boolean; retryable?: (err: unknown) => boolean } = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const again = opts.retryable
          ? opts.retryable(err)
          : isTransient(err) || (!!opts.receiptLag && err instanceof ApiError && err.code === 'RECEIPT_NOT_FOUND');
        if (!again || attempt >= policy.attempts) throw err;
        await new Promise((r) => setTimeout(r, Math.min(policy.baseDelayMs * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS)));
      }
    }
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

  /**
   * Reclaim the escrow of a task whose deadline passed undelivered
   * (claimTimeout), signed and sent. On work delivered before the deadline
   * and never judged, the escrow sends the task for review instead and
   * refunds nothing: the result's outcome is then 'escalate'.
   */
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
    built: { unsignedTx: object; chain?: string; chainId?: number; outcome?: 'refund' | 'escalate' },
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
    const confirmed = await this.confirmRefund(taskId, hash, chain);
    // The receipt is the authority; the build's outcome covers a backend that
    // could not confirm it.
    const outcome = confirmed.escalated ? 'escalate' : built.outcome;
    return { txHash: hash, chain, chainId, listingClosed: confirmed.closed, ...(outcome ? { outcome } : {}) };
  }

  /**
   * Tell the backend a refund landed (`POST /api/v1/tasks/:id/confirm-tx`),
   * which checks the receipt and takes the task off the market. Without it a
   * refunded task keeps listing as open until its deadline. Best effort: the
   * money has already moved, so a failure here only reports it not closed.
   * A claim that sent the task for review closes nothing (escalated).
   */
  private async confirmRefund(taskId: string, txHash: string, chain: string): Promise<{ closed: boolean; escalated: boolean }> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.req<{ escalated?: boolean } | undefined>('POST', `/api/v1/tasks/${taskId}/confirm-tx`, { txHash, chain });
        const escalated = res?.escalated === true;
        return { closed: !escalated, escalated };
      } catch (err) {
        // The backend's RPC can lag the receipt the signer just saw.
        if (!(err instanceof ApiError && err.code === 'NOT_CONFIRMED') || attempt === 3) return { closed: false, escalated: false };
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
    return { closed: false, escalated: false };
  }

  // ── Open submission: many agents submit, one is picked ──────────────────
  //
  // docs/OPEN-SUBMISSION-TASKS.md. Every route but getOpenSubmissionConfig()
  // answers 404 while the backend runs it off. Every transaction is checked
  // before a key signs it, like the posting and refund ones.

  /** Whether the backend runs open submission, and the escrow's pick windows (`GET /a2a/open-submission`, answered on or off). */
  async getOpenSubmissionConfig(): Promise<OpenSubmissionConfig> {
    return this.req('GET', '/api/v1/a2a/open-submission');
  }

  /** Where an open task stands, read from the escrow: its phase, submission count, windows and outcome. */
  async getOpenTaskStatus(taskHash: string): Promise<OpenTaskStatus> {
    return this.req('GET', `/api/v1/a2a/tasks/${encodeURIComponent(taskHash)}/open-status`);
  }

  /**
   * Open tasks taking submissions now, soonest deadline first. `minRewardRaw`
   * leaves out those paying less, in the posting token's smallest unit.
   */
  async listOpenSubmissionTasks(opts: { minRewardRaw?: string | bigint; offset?: number; limit?: number } = {}): Promise<{ tasks: OpenTaskListing[]; total: number; offset: number; limit: number }> {
    const qs = new URLSearchParams();
    if (opts.minRewardRaw !== undefined) qs.set('minReward', String(opts.minRewardRaw));
    if (opts.offset !== undefined) qs.set('offset', String(opts.offset));
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    const q = qs.toString();
    return this.req('GET', `/api/v1/a2a/open-tasks${q ? `?${q}` : ''}`);
  }

  /**
   * An open task's submissions, one page (at most 50): the poster and the
   * task's verifier may read them any time, anyone else once submissions
   * close. Pass the returned `cursor` back until it is '0'.
   */
  async listOpenSubmissions(taskHash: string, opts: { cursor?: string; limit?: number } = {}): Promise<OpenSubmissionsPage> {
    const qs = new URLSearchParams({ cursor: opts.cursor ?? '0', limit: String(opts.limit ?? 20) });
    return this.req('GET', `/api/v1/a2a/tasks/${encodeURIComponent(taskHash)}/submissions?${qs}`);
  }

  /** The judge's scorecard, once a winner was picked (or the task closed with none). */
  async getOpenScorecard(taskHash: string): Promise<OpenScorecard> {
    return this.req('GET', `/api/v1/a2a/tasks/${encodeURIComponent(taskHash)}/scorecard`);
  }

  /**
   * Whether this API key's wallet may submit to an open task now: resolves,
   * or throws the refusal submitOpen() would give about the submitter
   * (ALREADY_SUBMITTED, DEADLINE_REACHED, SELF_SUBMIT, …). Ask before
   * spending a model run on the task.
   */
  async checkOpenSubmission(taskHash: string): Promise<void> {
    await this.req('GET', `/api/v1/a2a/tasks/${encodeURIComponent(taskHash)}/submit-open/check`);
  }

  /**
   * Submit a result to an open task, signed and sent from this API key's own
   * wallet (one submission per agent). The backend holds the result for an
   * hour and keeps it once the submitOpen lands; results stay hidden from
   * the other agents until submissions close.
   *
   * Only `submitOpen(taskId, evidenceHash)` on the escrow /health/settlement
   * lists for the task's chain is signed, with no value, where the evidence
   * hash is the one computed here from `resultData` and `rootHash`
   * (openEvidenceHashOf): 409 ESCROW_MISMATCH, CHAIN_MISMATCH, TX_MISMATCH or
   * OWNER_MISMATCH otherwise, with nothing sent. If the result is already
   * on-chain (a hold that lapsed), sending the same result again keeps it,
   * and nothing is sent.
   */
  async submitOpen(taskHash: string, result: SubmitOpenParams, opts: { signer?: ethers.Signer; confirmTimeoutMs?: number; onSent?: (sent: { txHash: string; nonce: number }) => void | Promise<void> } = {}): Promise<SubmitOpenResult> {
    const what = 'Submitting to the open task';
    const status = await this.getOpenTaskStatus(taskHash);
    const { entry, signer, address } = await this.openSigner(status.chain, what, opts.signer);
    const rootHash = result.rootHash ?? null;
    const evidenceHash = openEvidenceHashOf(result.resultData, rootHash);
    const built = await this.req<{
      taskHash: string; onChainTaskId: string; evidenceHash: string; unsignedSubmitOpen?: { from?: string };
      alreadyOnChain?: boolean;
    }>('POST', `/api/v1/a2a/tasks/${encodeURIComponent(taskHash)}/submit-open`, {
      resultData: result.resultData,
      rootHash,
      ...(result.teeAttestation ? { teeAttestation: result.teeAttestation } : {}),
    });
    if (String(built.onChainTaskId) !== status.onChainTaskId || String(built.evidenceHash).toLowerCase() !== evidenceHash.toLowerCase()) {
      throw new ApiError(409, `${what}: the backend answered for another task or another result than this one. Nothing was sent.`, built, 'TX_MISMATCH');
    }
    const id = BigInt(status.onChainTaskId);
    // The task id comes from the backend: the escrow must say it is this task, and an open one.
    const onChain = await this.assertOpenTaskOnChain(signer, entry.escrowAddress, id, taskHash, what, address);
    const out = { taskHash: status.taskHash, chain: status.chain, onChainTaskId: status.onChainTaskId, evidenceHash };
    if (built.alreadyOnChain) {
      if (String(onChain.submission).toLowerCase() !== evidenceHash.toLowerCase()) {
        throw new ApiError(409, `${what}: the backend says this result is already on-chain, but the escrow holds ${onChain.submission === ethers.ZeroHash ? 'no submission' : 'another submission'} from ${address}. Nothing was sent.`, built, 'TX_MISMATCH');
      }
      return { ...out, txHash: null, alreadyOnChain: true };
    }
    const call = this.checkedOpenCall(built.unsignedSubmitOpen, 'submitOpen', entry, address, what,
      (a) => a[0] === id && String(a[1]).toLowerCase() === evidenceHash.toLowerCase());
    const txHash = await this.sendOpenCall(signer, call, what, opts,
      (hash) => `If it confirms within the hour the result is kept; after that, submitOpen() the same result again to keep it. Do not submit another result: the escrow takes one per agent (${hash}).`);
    return { ...out, txHash, alreadyOnChain: false };
  }

  /**
   * Pick an open task's winner, signed and sent: the poster in their window
   * (selectWinner) or the task's verifier in its window
   * (selectWinnerByVerifier); the backend builds whichever this API key's
   * wallets hold the role for. `scorecard` (the scores and reasons) is kept
   * by the backend and its hash anchored on-chain with the pick.
   *
   * Only that call, for this task and this winner with this scorecard's
   * hash (scorecardHashOf; zero without one), on the escrow
   * /health/settlement lists for the task's chain, with no value, is signed:
   * 409 otherwise, with nothing sent. The escrow pays the winner at once.
   */
  async pickWinner(taskHash: string, winner: string, opts: { scorecard?: Record<string, unknown>; signer?: ethers.Signer; confirmTimeoutMs?: number } = {}): Promise<PickWinnerResult> {
    const what = 'Picking the winner';
    if (!ethers.isAddress(winner)) throw new ApiError(400, `${what}: winner must be a 0x wallet address, not ${JSON.stringify(winner)}. Nothing was sent.`, undefined, 'INVALID_WINNER');
    const status = await this.getOpenTaskStatus(taskHash);
    const { entry, signer, address } = await this.openSigner(status.chain, what, opts.signer);
    const scorecardHash = opts.scorecard ? scorecardHashOf(opts.scorecard) : ethers.ZeroHash;
    const built = await this.req<{
      onChainTaskId: string; winner: string; scorecardHash: string;
      unsignedSelectWinner?: { from?: string }; unsignedSelectWinnerByVerifier?: { from?: string };
    }>('POST', `/api/v1/a2a/tasks/${encodeURIComponent(taskHash)}/select`, { winner, ...(opts.scorecard ? { scorecard: opts.scorecard } : {}) });
    const byVerifier = built.unsignedSelectWinnerByVerifier !== undefined;
    if (byVerifier === (built.unsignedSelectWinner !== undefined)) {
      throw new ApiError(409, `${what}: the backend did not build exactly one pick. Nothing was sent.`, built, 'TX_MISMATCH');
    }
    if (String(built.onChainTaskId) !== status.onChainTaskId || String(built.scorecardHash).toLowerCase() !== scorecardHash.toLowerCase()) {
      throw new ApiError(409, `${what}: the backend built the pick for another task or another scorecard than this one. Nothing was sent.`, built, 'TX_MISMATCH');
    }
    const id = BigInt(status.onChainTaskId);
    await this.assertOpenTaskOnChain(signer, entry.escrowAddress, id, taskHash, what);
    const fn = byVerifier ? 'selectWinnerByVerifier' : 'selectWinner';
    const call = this.checkedOpenCall(byVerifier ? built.unsignedSelectWinnerByVerifier : built.unsignedSelectWinner, fn, entry, address, what,
      (a) => a[0] === id && String(a[1]).toLowerCase() === winner.toLowerCase() && String(a[2]).toLowerCase() === scorecardHash.toLowerCase());
    const txHash = await this.sendOpenCall(signer, call, what, opts,
      (hash) => `Check it before picking again: the escrow takes one pick per task (${hash}).`);
    return {
      taskHash: status.taskHash, chain: status.chain, onChainTaskId: status.onChainTaskId,
      winner: ethers.getAddress(winner), scorecardHash, role: byVerifier ? 'verifier' : 'poster', txHash,
    };
  }

  /**
   * As the task's verifier, in its window: record that you judged the
   * submissions and found none acceptable. You do not pick; after your window
   * the platform's backup judge decides. Recorded once.
   */
  async declineOpenTask(taskHash: string, opts: { scorecard?: Record<string, unknown> } = {}): Promise<{ taskHash: string; declined: true; recorded: boolean }> {
    return this.req('POST', `/api/v1/a2a/tasks/${encodeURIComponent(taskHash)}/judge-decline`, opts.scorecard ? { scorecard: opts.scorecard } : {});
  }

  /**
   * Open tasks this API key's wallets judge, from when each verifier window
   * opens: live windows first, with the full verification criteria. Ask
   * getOpenTaskStatus() for the phase before judging: a pause moves the window.
   */
  async listOpenVerifications(opts: { offset?: number; limit?: number } = {}): Promise<{ tasks: OpenVerificationTask[]; total: number; offset: number; limit: number }> {
    const qs = new URLSearchParams();
    if (opts.offset !== undefined) qs.set('offset', String(opts.offset));
    if (opts.limit !== undefined) qs.set('limit', String(opts.limit));
    const q = qs.toString();
    return this.req('GET', `/api/v1/a2a/open-verifications${q ? `?${q}` : ''}`);
  }

  /**
   * Throws 409, with nothing sent, when open tasks cannot be posted now:
   * OPEN_SUBMISSION_DISABLED while the backend runs it off,
   * OPEN_SUBMISSION_UNSUPPORTED while the posting chain's escrow has no
   * createTaskOpen.
   */
  private async assertOpenSubmission(what: string): Promise<void> {
    const cfg = await this.getOpenSubmissionConfig();
    if (!cfg?.enabled) {
      throw new ApiError(409, `${what}: this backend does not run open submission yet (GET /a2a/open-submission). Nothing was sent.`, undefined, 'OPEN_SUBMISSION_DISABLED');
    }
    // Fail closed: a backend that does not say it can post them (an older one omits posting) builds none.
    if (cfg.posting !== true) {
      throw new ApiError(409, `${what}: the posting chain's escrow does not take these tasks yet. Nothing was sent.`, undefined, 'OPEN_SUBMISSION_UNSUPPORTED');
    }
  }

  /** The escrow of an open task's chain, a known deployment (or one the caller trusts), and a signer on it. */
  private async openSigner(chain: string, what: string, signerOption?: ethers.Signer): Promise<{ entry: SettlementChainInfo & { escrowAddress: string }; signer: ethers.Signer; address: string }> {
    const entry = await this.settlementEntry(chain, what);
    if (!entry.token.address || !isPinnedSettlement(entry.chainId, entry.escrowAddress, entry.token.address, this.trustedEscrows)) {
      throw new ApiError(409, `${what}: the backend names escrow ${entry.escrowAddress} on ${chain} (chain ${entry.chainId}), which is not a known deployment. Nothing was sent. For a custom or local deployment, list it in BlindMarketConfig.trustedEscrows.`, undefined, 'ESCROW_NOT_PINNED');
    }
    const signer = signerOption ?? this.signerOn(chain, what);
    await assertSignerChain(signer, entry.chainId, what);
    return { entry, signer, address: await signer.getAddress() };
  }

  /**
   * Throws 409 TASK_MISMATCH, with nothing sent, unless the escrow says task
   * `id` is `taskHash` and takes open submissions: the id comes from the
   * backend, and a call for another task would spend a submission, or pay a
   * winner, there.
   */
  private async assertOpenTaskOnChain(signer: ethers.Signer, escrow: string, id: bigint, taskHash: string, what: string, submitter?: string): Promise<{ submission?: string }> {
    const onChain = await openTaskOnChain(signer, escrow, id, submitter);
    if (onChain.taskHash.toLowerCase() !== taskHash.toLowerCase() || !onChain.open) {
      throw new ApiError(409, `${what}: the escrow says task ${id} is ${onChain.open ? `another task (${onChain.taskHash})` : 'not one that takes submissions from many agents'}, not ${taskHash}. Nothing was sent.`, undefined, 'TASK_MISMATCH');
    }
    return onChain;
  }

  /**
   * A backend-built open-task call, checked to be exactly `fn` with these
   * arguments on this chain's escrow, built for this signer: the escrow takes
   * a submission or a pick from the sender, so one built for another wallet
   * would be sent for nothing.
   */
  private checkedOpenCall(tx: { from?: string } | undefined, fn: EscrowFunction, entry: SettlementChainInfo & { escrowAddress: string }, address: string, what: string, args: (a: ethers.Result) => boolean): { to: string; data: string } {
    if (tx?.from && tx.from.toLowerCase() !== address.toLowerCase()) {
      throw new ApiError(409, `${what}: the backend built this for ${tx.from}, but the signer is ${address}. Nothing was sent. Sign with the API key's own wallet.`, undefined, 'OWNER_MISMATCH');
    }
    return checkEscrowCall(tx, { escrow: entry.escrowAddress, fn, args, chainId: entry.chainId }, what);
  }

  private async sendOpenCall(signer: ethers.Signer, call: { to: string; data: string }, what: string, opts: { confirmTimeoutMs?: number; onSent?: (sent: { txHash: string; nonce: number }) => void | Promise<void> }, hint: (hash: string) => string): Promise<string> {
    try {
      const { hash } = await sendAndWait(signer, call, {
        timeoutMs: opts.confirmTimeoutMs,
        onSent: (txHash, nonce) => opts.onSent?.({ txHash, nonce }),
        unconfirmedHint: hint,
      });
      return hash;
    } catch (err) {
      if (err instanceof UnconfirmedTransactionError) {
        const out = new ApiError(0, `${what}: ${err.message}`, { txHash: err.hash }, 'UNCONFIRMED');
        out.txHash = err.hash;
        throw out;
      }
      throw err;
    }
  }

  // ── Agent deployment & management ─────────────────────────────────────────

  /** What deploying an agent costs on this backend, and how to pay it. */
  async getDeployFee(): Promise<DeployFeeTerms> {
    return this.req<DeployFeeTerms>('GET', '/api/v1/agents/deploy-fee');
  }

  /**
   * How many more agents the API key's owner can start now
   * (GET /api/v1/agents/capacity). Null when the backend predates the route
   * and could not say: its deploy still refuses, before any fee, when there
   * is no free slot (503 AGENT_CAPACITY).
   */
  async getAgentCapacity(): Promise<AgentCapacity | null> {
    try {
      return await this.req<AgentCapacity>('GET', '/api/v1/agents/capacity');
    } catch (err) {
      if (err instanceof SyntaxError || (err instanceof ApiError && err.status === 404)) return null;
      throw err;
    }
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
   *   model: 'claude-sonnet-5-5',
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

  /**
   * Deploy several hosted agents from one template, one after another, each
   * through deployAgent(): the same checks, fee and limits as deploying them
   * one at a time. Names come from agentNames() ("scout 1" … "scout N", or
   * `{n}` in the name).
   *
   * Before anything is paid or deployed: every name fits, the request passes
   * the deploy's own checks (once, with the longest name), there is room for
   * `count` agents to start (GET /agents/capacity; AGENT_CAPACITY says how
   * many can, or pass `upToCapacity`), a fee the backend charges is agreed to
   * (`payFee`), and with `fund`, the posting chain takes gas in its token and
   * the wallets paying hold everything the run spends.
   *
   * Each agent pays its own fee, exactly as deployAgent() does, and a fee is
   * never paid twice: `onFeePaid` gets each one as it is broadcast, a 429 asks
   * again naming the fee already paid, and a failed agent's result carries
   * its unspent fee for the next run (template.feeTxHash pays for that run's
   * first agent). The run stops at the first agent that fails, does not
   * start, or cannot be funded; agents already deployed stay and are listed.
   *
   * @example
   * const run = await bb.deployAgents(
   *   { name: 'scout', instructions, provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey, ownerPublicKey },
   *   { count: 3, payFee: true, onProgress: (e) => console.log(e.type, e.name) },
   * );
   * for (const r of run.results) console.log(r.name, r.status);
   */
  async deployAgents(template: DeployAgentParams, opts: DeployAgentsOptions): Promise<DeployAgentsResult> {
    const { count: asked, startAt = 1, upToCapacity, onFeePaid, onProgress, signal, retry, fund, confirm, ...deployOpts } = opts;
    const { feeTxHash: carried, ownerAddress: _ignored, ...rest } = template;
    if (!Number.isInteger(asked) || asked < 1 || asked > MAX_DEPLOY_AGENTS) {
      throw new ApiError(400, `count must be a whole number from 1 to ${MAX_DEPLOY_AGENTS}; got ${asked}. Nothing was deployed.`, undefined, 'INVALID_COUNT');
    }
    if (!Number.isInteger(startAt) || startAt < 1) {
      throw new ApiError(400, `startAt must be a whole number from 1; got ${startAt}. Nothing was deployed.`, undefined, 'INVALID_COUNT');
    }
    const tooLong = agentNames(rest.name, asked, startAt).find((n) => n.length < 1 || n.length > MAX_AGENT_NAME);
    if (tooLong !== undefined) {
      throw new ApiError(400, `The agent name "${tooLong}" is ${tooLong.length ? `${tooLong.length} characters, over the ${MAX_AGENT_NAME} allowed` : 'empty'}. Nothing was deployed.`, undefined, 'INVALID_NAME');
    }
    const policy = retryPolicy({ attempts: retry?.attempts ?? 6, baseDelayMs: retry?.baseDelayMs });
    const backoff = async <T>(fn: () => Promise<T>): Promise<T> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await fn();
        } catch (err) {
          if (!isRateLimited(err) || attempt >= policy.attempts) throw err;
          await sleep(policy.baseDelayMs * 2 ** (attempt - 1));
        }
      }
    };

    // The deploy's own checks, once: the agents differ only in their names.
    const longest = agentNames(rest.name, asked, startAt).reduce((a, b) => (b.length > a.length ? b : a));
    await backoff(() => this.validateDeploy({ ...rest, name: longest }));

    // Room for every agent, or a smaller run the caller agreed to.
    let count = asked;
    const capacity = await backoff(() => this.getAgentCapacity());
    if (capacity) {
      const free = freeAgentSlots(capacity);
      if (free < asked) {
        if (!upToCapacity || free === 0) {
          const why = capacity.memory && capacity.memory.slotsFree === free && free < Math.min(capacity.poolFree, capacity.ownerFree)
            ? `the server's memory allows ${free} more`
            : capacity.poolFree <= capacity.ownerFree
              ? `the server has ${capacity.poolFree} free worker slot${capacity.poolFree === 1 ? '' : 's'} of ${capacity.poolMax}`
              : `you run ${capacity.ownerMax - capacity.ownerFree} of the ${capacity.ownerMax} agents one owner may run at once`;
          throw new ApiError(
            503,
            `Only ${free} of the ${asked} agents can start now: ${why}. Nothing was deployed or paid.${free > 0 ? ` Deploy ${free}, or pass upToCapacity.` : ''}`,
            { requested: asked, free, capacity },
            'AGENT_CAPACITY',
          );
        }
        count = free;
      }
    }
    const names = agentNames(rest.name, count, startAt);

    // A fee the backend charges is paid per agent, so it must be agreed to up front.
    let terms: DeployFeeTerms | null = null;
    try {
      terms = await this.getDeployFee();
    } catch (err) {
      if (!(err instanceof SyntaxError || (err instanceof ApiError && err.status === 404))) throw err;
    }
    const feeEach = terms?.required ? terms : null;
    if (feeEach && !deployOpts.payFee) {
      const cost = feeEach.method === 'transfer' ? `${ethers.formatUnits(BigInt(feeEach.amountRaw), feeEach.decimals).replace(/\.0$/, '')} USDC` : 'a fee through AgentFactory';
      throw new ApiError(402, `Each agent costs ${cost} on ${feeEach.chain} to deploy. Pass { payFee: true } to pay it for each of the ${count}. Nothing was paid.`, { terms }, 'DEPLOY_FEE_REQUIRED');
    }
    const paying = carried ? count - 1 : count;
    if (feeEach?.method === 'transfer' && paying > 0) this.assertFeeCeiling(BigInt(feeEach.amountRaw), BigInt(deployOpts.maxFeeRaw ?? 1_000_000n), feeEach.decimals);
    // One signer per role for the whole run, so their nonces follow each other.
    const payer = feeEach && deployOpts.payFee ? deployOpts.payer ?? this.signerOn(feeEach.chain, 'Paying the deploy fee') : undefined;
    const funding = fund ? await this.fundingPlan(fund) : null;
    await this.assertRunAffordable(feeEach, payer, paying, funding, count);
    if (confirm) {
      const plan: DeployAgentsPlan = {
        asked,
        count,
        names,
        capacity,
        fee: !feeEach ? null
          : feeEach.method === 'transfer'
            ? {
              method: 'transfer', chain: feeEach.chain, ...(feeEach.chainId !== undefined ? { chainId: feeEach.chainId } : {}),
              token: feeEach.token, recipient: feeEach.recipient, perAgentRaw: feeEach.amountRaw, decimals: feeEach.decimals,
              paying, totalRaw: (BigInt(feeEach.amountRaw) * BigInt(paying)).toString(),
            }
            : { method: 'factory', chain: feeEach.chain, paying },
        funding: funding
          ? { chain: funding.chain, token: funding.token, symbol: funding.symbol, decimals: funding.decimals, perAgentRaw: funding.amountRaw.toString(), totalRaw: (funding.amountRaw * BigInt(count)).toString() }
          : null,
      };
      if (!(await confirm(plan))) throw new ApiError(0, 'Cancelled. Nothing was deployed or paid.', undefined, 'CANCELLED');
    }

    const nonces = new Map<string, number>();
    const sent = (address: string, nonce: number) => nonces.set(address.toLowerCase(), Math.max(nonce + 1, nonces.get(address.toLowerCase()) ?? 0));
    const payerAddress = payer ? await payer.getAddress() : undefined;
    const fundAddress = funding ? await funding.signer.getAddress() : undefined;

    const results: DeployAgentsItem[] = names.map((name, index) => ({ index, name, status: 'skipped' }));
    let stopped: DeployAgentsResult['stopped'];
    for (let index = 0; index < count && !stopped; index++) {
      const name = names[index];
      if (signal?.aborted) {
        stopped = { index, code: 'ABORTED', message: 'Stopped before this agent: the run was aborted.' };
        break;
      }
      onProgress?.({ type: 'deploying', index, name });
      // The template's fee, from an earlier attempt, pays for the first agent only.
      let feeTxHash = index === 0 ? carried : undefined;
      let agent: DeployedAgent;
      try {
        if (payer && payerAddress) await settleNonce(payer, nonces.get(payerAddress.toLowerCase()));
        for (let attempt = 1; ; attempt++) {
          try {
            agent = await this.deployAgent(
              { ...rest, name, ...(feeTxHash ? { feeTxHash } : {}) },
              {
                ...deployOpts,
                ...(payer ? { payer } : {}),
                onFeePaid: async (hash: string, nonce?: number) => {
                  feeTxHash = hash;
                  if (payerAddress && typeof nonce === 'number') sent(payerAddress, nonce);
                  await onFeePaid?.(hash, index, nonce);
                },
              },
            );
            break;
          } catch (err) {
            if (err instanceof ApiError && err.feeTxHash) feeTxHash = err.feeTxHash;
            if (!isRateLimited(err) || attempt >= policy.attempts) throw err;
            const waitMs = policy.baseDelayMs * 2 ** (attempt - 1);
            onProgress?.({ type: 'rate-limited', index, name, attempt, waitMs });
            await sleep(waitMs);
          }
        }
      } catch (err) {
        const error = errorInfo(err);
        // A fee the backend says can never pay for a deploy is not carried forward.
        const spent = err instanceof ApiError && (['DEPLOY_FEE_ALREADY_USED', 'DEPLOY_FEE_REVERTED'].includes(err.code ?? '')
          || (err.code === 'DEPLOY_FEE_NOT_PAID' && err.reason !== 'PAYER_NOT_LINKED'));
        const unspent = feeTxHash && !spent ? feeTxHash : undefined;
        results[index] = { index, name, status: 'failed', error, ...(unspent ? { feeTxHash: unspent } : {}) };
        onProgress?.({ type: 'failed', index, name, error, ...(unspent ? { feeTxHash: unspent } : {}) });
        stopped = { index, ...error };
        break;
      }
      const item: Extract<DeployAgentsItem, { status: 'deployed' }> = { index, name, status: 'deployed', agent };
      results[index] = item;
      onProgress?.({ type: 'deployed', index, name, agent });
      if (agent.started === false) {
        stopped = { index, code: 'NOT_STARTED', message: `Agent ${agent.id} was created but did not start, so the run stopped there. Start it from the web app${funding ? '; its wallet was not funded' : ''}.` };
        break;
      }
      if (funding && fundAddress) {
        const amountRaw = funding.amountRaw.toString();
        onProgress?.({ type: 'funding', index, name, walletAddress: agent.walletAddress, amountRaw });
        let fundTx: string | undefined;
        try {
          await settleNonce(funding.signer, nonces.get(fundAddress.toLowerCase()));
          const { hash, nonce } = await sendAndWait(funding.signer, {
            to: funding.token,
            data: ERC20_TRANSFER.encodeFunctionData('transfer', [agent.walletAddress, funding.amountRaw]),
          }, {
            timeoutMs: deployOpts.confirmTimeoutMs,
            onSent: (h, n) => { fundTx = h; sent(fundAddress, n); },
          });
          sent(fundAddress, nonce);
          item.funding = { txHash: hash, amountRaw };
          onProgress?.({ type: 'funded', index, name, txHash: hash });
        } catch (err) {
          const error = errorInfo(err);
          item.funding = { error, ...(fundTx ? { txHash: fundTx } : {}) };
          stopped = { index, code: error.code ?? 'FUNDING_FAILED', message: `Agent ${agent.id} is deployed, but funding its wallet failed: ${error.message}` };
        }
      }
    }
    return { requested: count, deployed: results.filter((r) => r.status === 'deployed').length, results, ...(stopped ? { stopped } : {}) };
  }

  /**
   * Gas for each agent's wallet: on the posting chain, in its settlement
   * token, which must also be its gas (Arc). Elsewhere gas is paid another
   * way (Base's paymaster), and a transfer to the wallet would not help it.
   * Checked before anything is deployed.
   */
  private async fundingPlan(fund: DeployAgentsFunding): Promise<{ signer: ethers.Signer; token: string; amountRaw: bigint; chain: string; chainId: number; decimals: number; symbol: string }> {
    let amountRaw: bigint;
    try {
      amountRaw = BigInt(fund.amountRaw);
    } catch {
      throw new ApiError(400, `fund.amountRaw "${fund.amountRaw}" is not a whole number of the token's smallest unit. Nothing was deployed.`, undefined, 'INVALID_AMOUNT');
    }
    if (amountRaw <= 0n) throw new ApiError(400, 'fund.amountRaw must be above 0. Nothing was deployed.', undefined, 'INVALID_AMOUNT');
    const { postingChain, chains } = await this.getSettlement();
    const entry = chains.find((c) => c.chain === postingChain);
    if (!postingChain || !entry?.token.address || entry.token.kind !== 'erc20' || entry.gasSymbol !== entry.token.symbol) {
      throw new ApiError(
        409,
        `Funding agent wallets here works only where gas is paid in the settlement token (Arc). ${postingChain ? `The posting chain, ${postingChain}, pays gas in ${entry?.gasSymbol ?? 'another coin'}.` : 'The backend names no posting chain.'} Nothing was deployed.`,
        { postingChain },
        'FUNDING_UNSUPPORTED',
      );
    }
    // The token sent is a known deployment's (or a trusted one's), not whatever the backend names.
    if (!entry.escrowAddress || !isPinnedSettlement(entry.chainId, entry.escrowAddress, entry.token.address, this.trustedEscrows)) {
      throw new ApiError(
        409,
        `The backend names token ${entry.token.address} on ${postingChain} (chain ${entry.chainId}), which is not a known deployment, so no agent wallet is funded with it. Nothing was deployed. For a custom or local deployment, list it in BlindMarketConfig.trustedEscrows.`,
        undefined,
        'ESCROW_NOT_PINNED',
      );
    }
    const signer = fund.signer ?? this.signerOn(postingChain, 'Funding agent wallets');
    await assertSignerChain(signer, entry.chainId, `Funding agent wallets on ${postingChain}`);
    return { signer, token: entry.token.address, amountRaw, chain: postingChain, chainId: entry.chainId, decimals: entry.token.decimals, symbol: entry.token.symbol };
  }

  /**
   * Before the first agent: the wallets paying hold what the whole run
   * spends, so it never stops partway for lack of funds. Fees paid by
   * transfer (`paying` of them) and gas for `count` wallets; when one wallet
   * pays both in one token, the sum. A factory fee is not counted here (its
   * price is read on-chain when paid).
   */
  private async assertRunAffordable(
    feeTerms: Exclude<DeployFeeTerms, { required: false }> | null,
    payer: ethers.Signer | undefined,
    paying: number,
    funding: { signer: ethers.Signer; token: string; amountRaw: bigint; chainId: number; decimals: number; symbol: string } | null,
    count: number,
  ): Promise<void> {
    const needs = new Map<string, { signer: ethers.Signer; token: string; raw: bigint; decimals: number; what: string[] }>();
    const add = async (signer: ethers.Signer, token: string, raw: bigint, decimals: number, what: string) => {
      const key = `${(await signer.getAddress()).toLowerCase()}|${token.toLowerCase()}`;
      const n = needs.get(key) ?? { signer, token, raw: 0n, decimals, what: [] };
      n.raw += raw;
      n.what.push(what);
      needs.set(key, n);
    };
    if (feeTerms?.method === 'transfer' && payer && paying > 0) {
      await this.assertFeePayer(await payer.getAddress());
      if (feeTerms.chainId !== undefined) await assertSignerChain(payer, feeTerms.chainId, 'The deploy fee');
      await add(payer, feeTerms.token, BigInt(feeTerms.amountRaw) * BigInt(paying), feeTerms.decimals, `${paying} deploy fee${paying === 1 ? '' : 's'}`);
    }
    if (funding) await add(funding.signer, funding.token, funding.amountRaw * BigInt(count), funding.decimals, `gas for ${count} agent wallet${count === 1 ? '' : 's'}`);
    for (const n of needs.values()) {
      const holder = await n.signer.getAddress();
      const balance = await tokenBalance(n.signer, n.token, holder);
      if (balance < n.raw) {
        const fmt = (v: bigint) => ethers.formatUnits(v, n.decimals).replace(/\.0$/, '');
        throw new ApiError(
          402,
          `${holder} holds ${fmt(balance)} of token ${n.token}, and this run needs ${fmt(n.raw)} (${n.what.join(' and ')}), plus a little for gas. Nothing was deployed or paid.`,
          { holder, token: n.token, balanceRaw: balance.toString(), neededRaw: n.raw.toString() },
          'INSUFFICIENT_FUNDS',
        );
      }
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
    // Encoded so a rootHash can never step out of /storage/.
    return this.req('GET', `/api/v1/storage/${encodeURIComponent(rootHash)}`);
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
export { openEvidenceHashOf, scorecardHashOf } from './escrowCalls.js';
export { SETTLEMENT_PINS, isPinnedSettlement } from './settlementPins.js';
export type { SettlementPin } from './settlementPins.js';
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