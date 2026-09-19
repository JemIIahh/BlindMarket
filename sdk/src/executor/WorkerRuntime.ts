import { ethers } from 'ethers';
import { BlindMarket, ApiError } from '../index.js';
import { eciesDecrypt, aesDecrypt, derivePublicKey } from '../crypto/index.js';
import type {
  A2APublicTaskMeta, A2ATaskEntry, A2ATaskState, AgentCapability, ExecutorProfile, Message, RegisterExecutorInput,
} from '../types.js';

// ── Config ──────────────────────────────────────────────────────────────────

export interface WorkerRuntimeConfig {
  apiKey: string;
  apiBase?: string;
  displayName: string;
  capabilities: AgentCapability[];
  executeTask: ExecuteTaskHandler;
  /**
   * Private key of the wallet that OWNS `apiKey`. The backend registers the
   * API key's owner as the executor and builds `submitEvidence` for that
   * address, so only this key can both decrypt briefs and settle them.
   * start() checks the key against the API key's owner BEFORE registering
   * anything, then registers its uncompressed public key.
   *
   * REQUIRED (this or `existingPrivateKey`): start() throws without a key.
   * Up to 0.5.x a keyless runtime registered a random wallet's public key
   * over the owner's and accepted tasks it could never deliver.
   */
  privateKey?: string;
  /**
   * Restore mode: the owner wallet's key, WITHOUT re-registering on start
   * (the stored profile is kept; see declareSupportedChains). start() throws
   * if this key's address is not the executor the API key resolves to.
   */
  existingPrivateKey?: string;
  /** Optional cross-check: start() throws if it is not `existingPrivateKey`'s address. */
  existingAddress?: string;
  /** @deprecated Ignored — the public key is derived from `existingPrivateKey`. */
  existingPublicKey?: string;
  minReward?: string;
  preferredCapabilities?: AgentCapability[];
  browseIntervalMs?: number;
  watchIntervalMs?: number;
  maxConcurrentTasks?: number;
  /**
   * How long a task may wait for the poster to wrap its brief key (403
   * NEEDS_WRAP) before it is backed off (default 10 min). The wait holds no
   * concurrency slot. Each timeout doubles the back-off: `wrapTimeoutMs`,
   * then 2x, 4x … capped at 24 h.
   */
  wrapTimeoutMs?: number;
  /**
   * How long to keep re-trying /accept while the backend answers 503
   * ASSIGNMENT_PENDING (the assign tx is broadcast, the task is held for this
   * executor). Default 3 min — the backend's own settlement deadline is 120 s.
   * After that the task is re-tried from the browse loop with back-off.
   */
  assignmentPendingTimeoutMs?: number;
  /**
   * The 0G RPC used to sign + broadcast `submitEvidence` for a 0G task. NO
   * DEFAULT (0.5.x defaulted to 0G testnet while `apiBase` defaults to
   * production, so a default runtime accepted mainnet tasks and failed the
   * chainId pin after assignment). It is 0G ONLY: it never stands in for
   * another chain. For Base set `rpcUrls.base`. Must be the same network the
   * backend at `apiBase` settles on.
   */
  rpcUrl?: string;
  /**
   * Per-chain RPCs. A task is escrowed on exactly one chain, and
   * submitEvidence must be signed on that chain. The runtime declares, as its
   * `supportedChains`, exactly the chains it has an RPC for — `rpcUrls` keys,
   * plus 0G through `rpcUrl`. The backend only STORES that list; it does not
   * filter offers or /accept by it. What keeps the runtime off a chain it
   * cannot settle is client-side: browse skips entries whose `meta.chain` it
   * did not declare, and executeTask fails before running the handler when
   * /accept names such a chain. start() throws when no RPC is configured.
   */
  rpcUrls?: Partial<Record<SettlementChain, string>>;
}

/**
 * Chains this runtime's CODE can sign submitEvidence on. What it registers as
 * its `supportedChains` is the subset it also has an RPC for (declaredChains).
 */
export const SETTLEMENT_CHAINS = ['0g', 'base'] as const;
export type SettlementChain = (typeof SETTLEMENT_CHAINS)[number];

/**
 * The chain the backend named for a task. Missing means 0G (backends older
 * than the field). Any other value throws: signing it on the 0G RPC would
 * target the wrong escrow.
 */
function settlementChain(taskId: string, reported: string | null | undefined): SettlementChain {
  if (reported == null) return '0g';
  const known = SETTLEMENT_CHAINS.find((c) => c === reported);
  if (!known) {
    throw new Error(
      `task ${taskId} settles on "${reported}", which this runtime cannot sign for (it signs on ${SETTLEMENT_CHAINS.join(' and ')}) — update @blindmarket/sdk`,
    );
  }
  return known;
}

/**
 * The RPC this runtime signs on for `chain`. `rpcUrls` is per chain; the
 * single `rpcUrl` is the 0G RPC and never stands in for another chain: a Base submitEvidence sent through it is rejected by
 * ethers' chainId pin — after the handler has already run.
 */
function rpcFor(config: { rpcUrl?: string; rpcUrls?: Partial<Record<SettlementChain, string>> }, chain: SettlementChain): string | undefined {
  return config.rpcUrls?.[chain] ?? (chain === '0g' ? config.rpcUrl : undefined);
}

// ── Types ───────────────────────────────────────────────────────────────────

export type ExecuteTaskHandler = (ctx: TaskContext) => Promise<Record<string, unknown>>;

export interface TaskContext {
  taskId: string;
  task: A2ATaskState;
  /** Public metadata from the browse entry (chain, deadline, capabilities). */
  meta?: A2APublicTaskMeta;
  instructions: string;
}

export interface TaskExecutionInfo {
  taskId: string;
  status: 'bidding' | 'assigned' | 'working' | 'submitted' | 'completed' | 'failed';
  task?: A2ATaskState;
  error?: string;
  startedAt: number;
}

export type WorkerRuntimeEvent =
  | { type: 'started' }
  | { type: 'stopped' }
  | { type: 'paused' }
  | { type: 'resumed' }
  | { type: 'registered'; profile: ExecutorProfile }
  | { type: 'task_found'; taskId: string; task: A2ATaskState }
  | { type: 'task_bidded'; taskId: string }
  | { type: 'task_assigned'; taskId: string }
  | { type: 'task_accepted'; taskId: string }
  | { type: 'task_working'; taskId: string }
  | { type: 'task_executed'; taskId: string }
  | { type: 'task_submitted'; taskId: string; result: Record<string, unknown> }
  | { type: 'task_finalized'; taskId: string; finalize: Awaited<ReturnType<BlindMarket['finalize']>> }
  | { type: 'task_failed'; taskId: string; error: string }
  | { type: 'message_received'; message: Message; count: number }
  | { type: 'browse_done'; found: number }
  | { type: 'error'; error: string };

// ── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  browseIntervalMs: 15_000,
  watchIntervalMs: 5_000,
  maxConcurrentTasks: 3,
  wrapTimeoutMs: 600_000,
  assignmentPendingTimeoutMs: 180_000,
};

/** First back-off after an /accept the backend released or that never confirmed; doubles per failure. */
const RELEASED_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 3_600_000;
const MAX_WRAP_BACKOFF_MS = 86_400_000;
/** Re-accept rounds for a task that may still be held for this executor before it is dropped. */
const MAX_REACCEPT_ROUNDS = 6;

/**
 * NEEDS_WRAP messages after which waiting is pointless: the platform cannot
 * re-wrap (custody key rotated — only the poster's own client still can), or
 * this executor has no public key on record. Newer backends say so in
 * `error.reason` (CUSTODY_ROTATED / NO_PUBLIC_KEY); the message match covers
 * backends that send only the NEEDS_WRAP code.
 */
const WRAP_IMPOSSIBLE_REASONS = new Set(['CUSTODY_ROTATED', 'NO_PUBLIC_KEY']);
const WRAP_IMPOSSIBLE = /rotated custody key|cannot re-wrap|no public key/i;

/** Per-task retry bookkeeping. A task in here is NOT in `executions` and holds no slot. */
interface RetryState {
  /** Do not touch the task before this time. */
  notBefore: number;
  /** Consecutive released/unconfirmed accepts. */
  failures: number;
  /** When the current NEEDS_WRAP wait began. */
  wrapSince?: number;
  /** Completed NEEDS_WRAP waits that timed out. */
  wrapTimeouts: number;
  bidded: boolean;
  /**
   * Set when the task may still be `accepted` for this executor (it is then
   * absent from the open listing): browse re-tries /accept itself.
   */
  reaccept?: { state: A2ATaskState; meta?: A2APublicTaskMeta; rounds: number };
}

/** /accept was abandoned; `held` = the backend may still hold the task for this executor. */
class AcceptAbandoned extends Error {
  constructor(readonly cause: unknown, readonly held: boolean) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** base, 2·base, 4·base … capped. `n` is 1 for the first failure. */
function backoff(base: number, n: number, cap: number): number {
  return Math.min(base * 2 ** Math.max(0, n - 1), cap);
}

// ── WorkerRuntime ───────────────────────────────────────────────────────────

export class WorkerRuntime {
  private bb: BlindMarket;
  private config: WorkerRuntimeConfig & typeof DEFAULTS;
  private wallet?: { address: string; privateKey: string; publicKey: string };
  private profile?: ExecutorProfile;
  private running = false;
  private paused = false;
  private browseTimer?: ReturnType<typeof setInterval>;
  private executions = new Map<string, TaskExecutionInfo>();
  private retries = new Map<string, RetryState>();
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private listeners = new Set<(event: WorkerRuntimeEvent) => void>();

  constructor(config: WorkerRuntimeConfig) {
    this.config = { ...DEFAULTS, ...config };
    this.bb = new BlindMarket({ apiKey: config.apiKey, apiBase: config.apiBase });
  }

  // ── Status ──────────────────────────────────────────────────────────────

  get isRunning(): boolean {
    return this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get activeExecutions(): TaskExecutionInfo[] {
    return [...this.executions.values()];
  }

  /**
   * The chains this runtime declares to the backend and claims tasks on:
   * those its code can sign for AND it has an RPC for. Older backends only
   * store the list and none filters browse results by it, so browse() and
   * executeTask() enforce it.
   */
  get declaredChains(): SettlementChain[] {
    return SETTLEMENT_CHAINS.filter((chain) => !!rpcFor(this.config, chain));
  }

  /** Get own executor profile (available after start). */
  get executorProfile(): ExecutorProfile | undefined {
    return this.profile;
  }

  /** Get own wallet info (available after start). */
  get executorWallet(): { address: string; publicKey: string } | undefined {
    return this.wallet;
  }

  // ── Events ──────────────────────────────────────────────────────────────

  on(listener: (event: WorkerRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: WorkerRuntimeEvent): void {
    for (const l of this.listeners) l(event);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<ExecutorProfile> {
    if (this.running) return this.profile!;

    // Refuse, before any request, a configuration that can only strand tasks.
    const key = this.config.privateKey ?? this.config.existingPrivateKey;
    if (!key) {
      throw new Error(
        '[WorkerRuntime] no executor key. Pass `privateKey`: the private key of the wallet that owns `apiKey` ' +
          '(or `existingPrivateKey` to restore without re-registering). The backend assigns accepted tasks on-chain to ' +
          "the API key's owner, and only that wallet can sign submitEvidence — a keyless runtime would overwrite the " +
          "owner's registered public key and strand every task it accepted. To only look at tasks, call " +
          'BlindMarket.browseA2ATasks() directly.',
      );
    }
    if (this.declaredChains.length === 0) {
      throw new Error(
        '[WorkerRuntime] no RPC configured. Set `rpcUrl` (0G) and/or `rpcUrls.base` to the network the backend at ' +
          '`apiBase` settles on. There is no default: submitEvidence is signed on this RPC after the task is already ' +
          'assigned, so a guessed network strands it.',
      );
    }

    // "No tasks arrive" looks the same as "no work available", so say which
    // chains this runtime claims tasks on, and what is missing.
    const undeclared = SETTLEMENT_CHAINS.filter((c) => !this.declaredChains.includes(c));
    if (undeclared.length > 0) {
      console.warn(
        `[WorkerRuntime] declaring chains: ${this.declaredChains.join(', ') || 'none'}. ` +
          `No RPC for ${undeclared.join(', ')} — tasks on ${undeclared.length > 1 ? 'those chains' : 'that chain'} are skipped; ` +
          `set ${undeclared.map((c) => `rpcUrls.${c}`).join(', ')} to claim them ` +
          `(production posts new tasks on Base).`,
      );
    }

    // 1. Register or restore executor
    if (this.config.privateKey) {
      // The API key owner's own key: createAgent() checks it against the API
      // key's owner BEFORE registering (no side effects on a mismatch), then
      // registers its uncompressed public key. Registration is an upsert that
      // keeps reputation, so this is safe on every start.
      const result = await this.bb.createAgent({
        privateKey: this.config.privateKey,
        displayName: this.config.displayName,
        capabilities: this.config.capabilities,
        minReward: this.config.minReward,
        preferredCapabilities: this.config.preferredCapabilities,
        supportedChains: this.declaredChains,
      });
      this.wallet = result.wallet;
      this.profile = result.executor;
    } else {
      const signer = new ethers.Wallet(this.config.existingPrivateKey!);
      if (this.config.existingAddress && this.config.existingAddress.toLowerCase() !== signer.address.toLowerCase()) {
        throw new Error(
          `[WorkerRuntime] existingAddress ${this.config.existingAddress} is not existingPrivateKey's address (${signer.address})`,
        );
      }
      // Fetch existing profile — backend identifies by API key
      const result = await this.bb.getExecutorProfile();
      // Checked before declareSupportedChains() can register anything: tasks
      // are assigned to the profile's address, which must be this signer.
      if (result.agent.address.toLowerCase() !== signer.address.toLowerCase()) {
        throw new Error(
          `[WorkerRuntime] the API key resolves to executor ${result.agent.address} but existingPrivateKey belongs to ` +
            `${signer.address}; it could accept tasks but never sign submitEvidence. Use the owner wallet's key, or an API key minted by this wallet.`,
        );
      }
      this.wallet = { address: signer.address, privateKey: signer.privateKey, publicKey: signer.signingKey.publicKey };
      this.profile = await this.declareSupportedChains(result.agent);
    }

    this.emit({ type: 'registered', profile: this.profile });

    // 2. Start the browse loop
    this.running = true;
    this.startBrowseLoop();
    this.emit({ type: 'started' });

    return this.profile;
  }

  /**
   * Re-register a restored executor when its stored `supportedChains` is
   * null (a row registered by code that predates the field), or names a
   * chain this runtime has no RPC for — it would be offered, accept and
   * strand those tasks. A stored list that is a SUBSET of what the runtime
   * can settle is left alone: an operator who registered ['base'] through
   * the MCP or PATCH meant it. Older backends only store the list (newer ones
   * also filter offers and /accept by it); this runtime's own browse filter
   * uses `declaredChains`, not the stored list — and a restore never
   * registers otherwise, so an executor first registered by an older SDK
   * would keep its old list.
   *
   * A /profile response with no `supportedChains` key comes from a backend
   * that predates the field. That backend would drop the field anyway, and
   * some of its versions reset the executor's 0G earnings on every register,
   * so this does nothing there.
   *
   * The public key is derived from the private key, so a stored compressed
   * key (which /register rejects) or a stale one is replaced with the key
   * this runtime can decrypt with. Everything else comes from the stored
   * profile, not this runtime's config, so a restore never rewrites it. The
   * backend overwrites agentCardUrl and mcpEndpointUrl on every register
   * (clearing them when absent), so they are copied from the raw /profile
   * row, which carries them even though ExecutorProfile doesn't type them.
   *
   * Best-effort: on failure it logs, emits 'error', and returns the stored
   * profile, so start() still succeeds.
   */
  private async declareSupportedChains(stored: ExecutorProfile): Promise<ExecutorProfile> {
    const raw = stored as unknown as Record<string, unknown>;
    if (!('supportedChains' in raw)) return stored;
    const can = this.declaredChains;
    const storedChains = Array.isArray(stored.supportedChains) ? stored.supportedChains : null;
    // A deliberate subset of what this runtime can settle stays as it is.
    // (An empty list cannot come from the API: both schemas require one entry.)
    if (storedChains && storedChains.every((c) => (can as string[]).includes(c))) return stored;
    // Otherwise declare what it can settle, keeping the operator's choice
    // where the two overlap.
    const kept = storedChains ? can.filter((c) => storedChains.includes(c)) : [];
    const declare = kept.length > 0 ? kept : can;

    const optionalString = (v: unknown): string | undefined =>
      typeof v === 'string' && v !== '' ? v : undefined;

    try {
      // No `address`: /register has no such field and registers the wallet
      // the API key authenticates.
      const body: Omit<RegisterExecutorInput, 'address'> = {
        displayName: stored.displayName,
        capabilities: stored.capabilities,
        // Uncompressed, without 0x, as /register requires.
        publicKey: derivePublicKey(this.wallet!.privateKey),
        agentCardUrl: optionalString(raw.agentCardUrl),
        mcpEndpointUrl: optionalString(raw.mcpEndpointUrl),
        minReward: optionalString(stored.minReward),
        // The backend reads an unset list back as []; sending [] would store
        // an empty list where there was none.
        preferredCapabilities: stored.preferredCapabilities?.length ? stored.preferredCapabilities : undefined,
        supportedChains: declare,
      };
      const { agent } = await this.bb.registerExecutor(body as RegisterExecutorInput);
      return agent ?? stored;
    } catch (err) {
      const error = `Could not register supported chains (${declare.join(', ')}); continuing with the stored profile: ${err}`;
      console.warn(`[WorkerRuntime] ${error}`);
      this.emit({ type: 'error', error });
      return stored;
    }
  }

  stop(): void {
    this.running = false;
    if (this.browseTimer) {
      clearInterval(this.browseTimer);
      this.browseTimer = undefined;
    }
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    this.emit({ type: 'stopped' });
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.emit({ type: 'paused' });
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.emit({ type: 'resumed' });
    // Immediately browse instead of waiting for next interval
    this.browse();
  }

  // ── Browse loop ─────────────────────────────────────────────────────────

  private startBrowseLoop(): void {
    const ms = this.config.browseIntervalMs;
    this.browseTimer = setInterval(() => this.browse(), ms);
    this.browse();
  }

  private async browse(): Promise<void> {
    if (this.paused) return;
    try {
      if (this.inFlight() >= this.config.maxConcurrentTasks) return;

      const result = await this.bb.browseA2ATasks({
        capabilities: this.config.capabilities,
      });

      this.emit({ type: 'browse_done', found: result.tasks.length });

      // GET /a2a/tasks serves { meta, state } entries — id and status live on
      // `state`. Nobody "assigns" a task: the executor claims it by calling
      // /accept itself (which also assigns it on-chain), so there is no
      // 'assigned' status to wait for.
      const listed = new Set<string>();
      for (const entry of result.tasks as A2ATaskEntry[]) {
        const state = entry.state;
        const taskId = state?.taskId ?? entry.meta?.taskId;
        if (!taskId) continue;
        listed.add(taskId);
        if (state.status !== 'open') continue;
        // An accept assigns on-chain and cannot be released, so never claim a
        // task browse already says is on a chain this runtime did not declare.
        // No backend filters browse results by the registered
        // supportedChains (older ones filter nothing by it), so this filter
        // (and the post-accept check in executeTask, which covers rows with
        // no chain) is what keeps such tasks out.
        if (entry.meta?.chain && !(this.declaredChains as string[]).includes(entry.meta.chain)) continue;
        this.claim(taskId, state, entry.meta);
      }

      // Tasks that may still be held for this executor are not in the open
      // listing: re-try their /accept here once their back-off has passed.
      for (const [taskId, retry] of this.retries) {
        if (retry.reaccept) this.claim(taskId, retry.reaccept.state, retry.reaccept.meta);
        // Anything else that left the listing is gone (taken, cancelled,
        // expired): drop its bookkeeping so the map stays bounded.
        else if (!listed.has(taskId)) this.retries.delete(taskId);
      }
    } catch (err) {
      this.emit({ type: 'error', error: `Browse failed: ${err}` });
    }
  }

  /** Executions holding a concurrency slot. A task waiting for a wrap or backing off holds none. */
  private inFlight(): number {
    let n = 0;
    for (const e of this.executions.values()) {
      if (e.status === 'bidding' || e.status === 'assigned' || e.status === 'working') n++;
    }
    return n;
  }

  /**
   * Start executing `taskId` if it is not running, not backing off, and a slot
   * is free. `dueAt`: the time a scheduled re-try counts as running at.
   */
  private claim(taskId: string, state: A2ATaskState, meta?: A2APublicTaskMeta, dueAt = Date.now()): boolean {
    if (this.executions.has(taskId)) return false;
    const retry = this.retries.get(taskId);
    if (retry && retry.notBefore > dueAt) return false;
    if (this.inFlight() >= this.config.maxConcurrentTasks) return false;
    this.executions.set(taskId, { taskId, status: 'bidding', task: state, startedAt: Date.now() });
    // Announce a task once, not on every re-try.
    if (!retry) this.emit({ type: 'task_found', taskId, task: state });
    void this.executeTask(taskId, state, meta);
    return true;
  }

  private retryState(taskId: string): RetryState {
    let retry = this.retries.get(taskId);
    if (!retry) {
      retry = { notBefore: 0, failures: 0, wrapTimeouts: 0, bidded: false };
      this.retries.set(taskId, retry);
    }
    return retry;
  }

  // ── Accept ──────────────────────────────────────────────────────────────

  /**
   * POST /accept, re-trying while the backend says the claim is still ours:
   * 503 ASSIGNMENT_PENDING means the assign tx is broadcast but unconfirmed
   * and the task stays `accepted` for this executor until a retry confirms it
   * (or the backend's sweep releases it). A 503 SETTLEMENT_FAILED seen AFTER a
   * pending answer is the idempotent re-check failing, not a release, so it is
   * re-tried too. Bounded by assignmentPendingTimeoutMs, then AcceptAbandoned
   * with `held: true`. Every other error is thrown as it came.
   */
  private async acceptUntilAssigned(taskId: string): Promise<Awaited<ReturnType<BlindMarket['acceptTask']>>> {
    const giveUpAt = Date.now() + this.config.assignmentPendingTimeoutMs;
    let delay = Math.min(2_000, this.config.watchIntervalMs);
    let pending = false;
    for (;;) {
      try {
        return await this.bb.acceptTask(taskId);
      } catch (err) {
        const code = err instanceof ApiError ? err.code : undefined;
        if (code === 'ASSIGNMENT_PENDING') pending = true;
        else if (!(pending && code === 'SETTLEMENT_FAILED')) throw err;
        if (!this.running || Date.now() + delay > giveUpAt) throw new AcceptAbandoned(err, true);
        await sleep(delay);
        delay = Math.min(delay * 2, 15_000);
      }
    }
  }

  /**
   * /accept did not hand over the task. Release the slot and decide when (if
   * ever) the task is touched again. Returns the message for `task_failed`.
   */
  private async onAcceptFailed(taskId: string, a2a: A2ATaskState, meta: A2APublicTaskMeta | undefined, err: unknown): Promise<string> {
    this.executions.delete(taskId);
    const now = Date.now();
    const cause = err instanceof AcceptAbandoned ? err.cause : err;
    const api = cause instanceof ApiError ? cause : undefined;

    // 403 NEEDS_WRAP: the brief key is not wrapped to our pubkey. Bid (the
    // poster wraps to bidders) and wait WITHOUT a slot: the task is re-tried
    // every watchIntervalMs until wrapTimeoutMs, then backed off.
    if (api?.code === 'NEEDS_WRAP') {
      const retry = this.retryState(taskId);
      if (!retry.bidded) {
        try {
          await this.bb.bidOnTask(taskId);
          retry.bidded = true;
          this.emit({ type: 'task_bidded', taskId });
        } catch (bidErr) {
          retry.failures++;
          retry.notBefore = now + backoff(RELEASED_BACKOFF_MS, retry.failures, MAX_BACKOFF_MS);
          return `not accepted: NEEDS_WRAP, and the bid failed: ${bidErr}`;
        }
      }
      const reason = (api.body as { error?: { reason?: unknown } } | undefined)?.error?.reason;
      const impossible = typeof reason === 'string'
        ? WRAP_IMPOSSIBLE_REASONS.has(reason)
        : WRAP_IMPOSSIBLE.test(api.message);
      retry.wrapSince ??= now;
      if (!impossible && now - retry.wrapSince < this.config.wrapTimeoutMs) {
        retry.notBefore = now + this.config.watchIntervalMs;
        this.scheduleRetry(taskId, a2a, meta, this.config.watchIntervalMs);
        return 'not accepted yet: NEEDS_WRAP — bid placed, waiting for the poster to wrap the brief key';
      }
      // Timed out, or the backend says the platform can never wrap it: only
      // the poster's own client still can, so look again much later.
      retry.wrapTimeouts++;
      retry.wrapSince = undefined;
      retry.bidded = false; // bid again when the back-off ends
      const wait = backoff(this.config.wrapTimeoutMs, retry.wrapTimeouts, MAX_WRAP_BACKOFF_MS);
      retry.notBefore = now + wait;
      return impossible
        ? `not accepted: ${api.message} Skipping for ${Math.round(wait / 60_000)} min.`
        : `not accepted: no wrapped key after ${Math.round(this.config.wrapTimeoutMs / 1000)}s; skipping for ${Math.round(wait / 60_000)} min`;
    }

    // Lost the race / offer held by another agent / gone: nothing was claimed.
    // A still-open task (OFFER_HELD, ACCEPT_LOCKED) is re-tried by a later browse.
    if (api?.status === 409) {
      this.retries.delete(taskId);
      return `not accepted: ${api.code ?? api.message}`;
    }

    // Refused for a reason a retry cannot change (SELF_ACCEPT, IS_VERIFIER,
    // NOT_REGISTERED, NOT_TARGET_EXECUTOR, 404 …): nothing was claimed. Keep
    // the task out of the way for as long as it stays listed.
    if (api && api.status < 500 && api.status !== 408 && api.status !== 429) {
      const retry = this.retryState(taskId);
      retry.reaccept = undefined;
      retry.notBefore = now + MAX_WRAP_BACKOFF_MS;
      return `not accepted: ${api.code ?? api.message}`;
    }

    // The backend released the task back to open (503 REWRAP_FAILED, or a 503
    // SETTLEMENT_FAILED on a fresh accept): a later browse may claim it again,
    // after a per-task back-off so a persistent failure does not hot-loop.
    const retry = this.retryState(taskId);
    retry.failures++;
    // The backend says "released" in the message only when it did re-open the
    // task (its release is compare-and-set and can fail; SETTLEMENT_FAILED from
    // the idempotent re-check never releases). There is no separate code.
    const released =
      !(err instanceof AcceptAbandoned) &&
      (api?.code === 'REWRAP_FAILED' || api?.code === 'SETTLEMENT_FAILED') &&
      /released/i.test(api.message);
    if (released) {
      retry.reaccept = undefined;
      retry.notBefore = now + backoff(RELEASED_BACKOFF_MS, retry.failures, MAX_BACKOFF_MS);
      return `not accepted: ${api!.code} — the backend released the task; re-trying after a back-off`;
    }

    // ASSIGNMENT_PENDING that never confirmed, a REWRAP/SETTLEMENT failure the
    // backend did not release, an unknown 5xx, a rate limit or a network error: the task MAY be held for (or already assigned to) this executor,
    // and then it is not in the open listing. /accept is idempotent for the
    // recorded executor, so browse re-tries it directly, with back-off, a
    // bounded number of times.
    const rounds = (retry.reaccept?.rounds ?? 0) + 1;
    if (rounds > MAX_REACCEPT_ROUNDS) {
      this.retries.delete(taskId);
      return `accept never confirmed after ${MAX_REACCEPT_ROUNDS} rounds (${api?.code ?? cause}); giving up. If the assignment landed on-chain the task is in getExecutions().`;
    }
    retry.reaccept = { state: a2a, meta, rounds };
    retry.notBefore = now + backoff(RELEASED_BACKOFF_MS, retry.failures, MAX_BACKOFF_MS);
    return `accept not confirmed (${api?.code ?? cause}); the task may still be held for this executor — re-trying /accept after a back-off`;
  }

  /** Re-try one task sooner than the next browse tick (NEEDS_WRAP wait). */
  private scheduleRetry(taskId: string, a2a: A2ATaskState, meta: A2APublicTaskMeta | undefined, ms: number): void {
    if (!this.running) return;
    // The back-off this timer ends. A timer can fire before Date.now() reaches
    // it (they run on different clocks), and the re-try must not then be
    // refused by its own back-off: nothing would re-try it before the next
    // browse. A back-off set after this one still holds.
    const due = this.retries.get(taskId)?.notBefore ?? 0;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      // No free slot / paused: the next browse picks it up instead.
      if (this.running && !this.paused) this.claim(taskId, a2a, meta, Math.max(due, Date.now()));
    }, ms);
    this.retryTimers.add(timer);
  }

  // ── Task execution ──────────────────────────────────────────────────────

  private async executeTask(taskId: string, a2a: A2ATaskState, meta?: A2APublicTaskMeta): Promise<void> {
    const exec = this.executions.get(taskId);
    if (!exec) return;

    try {
      // Accept task — get the rootHash + this executor's ECIES-wrapped AES
      // key. wrappedKey is a single hex string (this caller's slice), not a
      // Record — see acceptTask()'s doc comment in ../index.ts.
      let acceptResult: Awaited<ReturnType<BlindMarket['acceptTask']>>;
      try {
        acceptResult = await this.acceptUntilAssigned(taskId);
      } catch (err) {
        // Never leave a task that was not handed over in `executions`: it
        // would be skipped by every later browse and never executed.
        const error = await this.onAcceptFailed(taskId, a2a, meta, err);
        this.emit({ type: 'task_failed', taskId, error });
        return;
      }
      this.retries.delete(taskId);
      exec.status = 'assigned';
      exec.task = a2a;
      this.emit({ type: 'task_assigned', taskId });
      this.emit({ type: 'task_accepted', taskId });
      // Fail before running the handler if this runtime can't settle the task:
      // an unknown chain, or one it has no RPC for (the send would fail only
      // after the handler had spent its run, leaving the task Assigned).
      const acceptedChain = settlementChain(taskId, acceptResult.chain);
      if (!rpcFor(this.config, acceptedChain)) {
        throw new Error(
          `task ${taskId} is escrowed on ${acceptedChain} but no RPC is configured for it — set rpcUrls.${acceptedChain} in the WorkerRuntime config`,
        );
      }

      // Decrypt the brief. 'public' tasks carry no wrappedKey by design — the
      // blob at rootHash is already plaintext, so skip ECIES/AES entirely.
      // Download by acceptResult.rootHash (the 0G Storage pointer) — NOT the
      // on-chain taskHash, which is a different value (sha256 of the
      // ciphertext, used as the escrow's commitment) and isn't a valid
      // storage lookup key.
      let instructions = '';
      if (acceptResult.rootHash) {
        const storageResult = await this.bb.downloadBlob(acceptResult.rootHash);
        const blobBytes = this.base64ToBytes(storageResult.blob);

        if (acceptResult.privacy === 'public') {
          instructions = new TextDecoder().decode(blobBytes);
        } else if (acceptResult.wrappedKey) {
          const wrappedBytes = this.decodeWrappedKey(acceptResult.wrappedKey);
          const aesKey = await eciesDecrypt(wrappedBytes, this.wallet!.privateKey);
          const plaintext = await aesDecrypt(blobBytes, aesKey);
          instructions = new TextDecoder().decode(plaintext);
        }
      }

      exec.status = 'working';
      this.emit({ type: 'task_working', taskId });

      // Call the user-provided execution handler with decrypted instructions
      const result = await this.config.executeTask({
        taskId,
        task: a2a,
        meta,
        instructions,
      });

      exec.status = 'submitted';
      this.emit({ type: 'task_executed', taskId });

      // Submit → sign + broadcast submitEvidence on the chain /submit names
      // (the contract's onlyWorker means the backend can only hand back an
      // unsigned tx) → finalize, healing a stranded 'submitted' state via
      // /rebroadcast. Without the broadcast the on-chain task never leaves
      // 'Assigned' and the task only LOOKS complete. deliverResult() signs
      // only on a chain named here: rpcUrls per chain, rpcUrl for 0G only, so
      // an unknown chain refuses before anything is sent, and the chainId pin
      // still rejects a genuine mismatch at ethers.
      const { submitTxHash: _submitTxHash, ...finalizeResult } = await this.bb.deliverResult(taskId, result, {
        privateKey: this.wallet!.privateKey,
        rpcUrls: Object.fromEntries(SETTLEMENT_CHAINS.map((c) => [c, rpcFor(this.config, c)])),
      });

      exec.status = 'completed';
      this.emit({ type: 'task_submitted', taskId, result });
      this.emit({ type: 'task_finalized', taskId, finalize: finalizeResult });
    } catch (err) {
      exec.status = 'failed';
      exec.error = String(err);
      this.emit({ type: 'task_failed', taskId, error: String(err) });
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  /**
   * Decode a wrapped-key hex string — acceptTask()'s wrappedKey field is a
   * single hex string (this executor's ECIES-wrapped AES key), not a
   * Record. The old code here called `Object.values` on that STRING
   * argument (treating it as if it were a Record), which returned its
   * first CHARACTER (e.g. "0" from "04a1b2…") — `clean.length / 2` was
   * then 0 and every decrypt got an empty key.
   */
  private decodeWrappedKey(hex: string): Uint8Array {
    if (!hex) throw new Error('Empty wrapped key');
    return this.hexToBytes(hex);
  }

  private hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  /** Decode a base64 string (e.g. downloadBlob()'s `blob` field) into bytes. */
  private base64ToBytes(b64: string): Uint8Array {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
}
