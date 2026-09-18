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
   * address, so only this key can both decrypt briefs and settle them. When
   * set, start() registers its uncompressed public key and throws if the
   * registered address is not this wallet's. Without it (and without the
   * `existing*` trio) the runtime generates a random wallet, which can
   * decrypt but cannot sign `submitEvidence` for the owner's address.
   */
  privateKey?: string;
  existingPrivateKey?: string;
  existingAddress?: string;
  existingPublicKey?: string;
  minReward?: string;
  preferredCapabilities?: AgentCapability[];
  browseIntervalMs?: number;
  watchIntervalMs?: number;
  maxConcurrentTasks?: number;
  /** How long to keep re-trying /accept after a NEEDS_WRAP bid before giving up (default 10 min). */
  wrapTimeoutMs?: number;
  /**
   * The 0G RPC used to sign + broadcast `submitEvidence` for a 0G task.
   * Defaults to the 0G testnet RPC (matches `backend/agents/worker.js`'s
   * default). It is 0G ONLY: it never stands in for another chain. For Base
   * set `rpcUrls.base`.
   */
  rpcUrl?: string;
  /**
   * Per-chain RPCs. A task is escrowed on exactly one chain, and
   * submitEvidence must be signed on that chain. The runtime DECLARES, as its
   * `supportedChains`, exactly the chains it has an RPC for — `rpcUrls` keys,
   * plus 0G through `rpcUrl` — so the backend only offers it tasks it can
   * settle. Without `rpcUrls.base` it is not offered Base tasks (production
   * posts new tasks on Base).
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
 * single `rpcUrl` is the 0G RPC (its default is 0G testnet) and never stands
 * in for another chain: a Base submitEvidence sent through it is rejected by
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
  rpcUrl: 'https://evmrpc-testnet.0g.ai',
};

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
   * The chains this runtime declares to the backend: those its code can sign
   * for AND it has an RPC for. Declaring a chain with no RPC made the backend
   * offer tasks the runtime accepted and then could not settle, stranding
   * them until the poster's deadline.
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

    // "No tasks arrive" looks the same as "no work available", so say which
    // chains this runtime will be offered tasks on, and what is missing.
    const undeclared = SETTLEMENT_CHAINS.filter((c) => !this.declaredChains.includes(c));
    if (undeclared.length > 0) {
      console.warn(
        `[WorkerRuntime] declaring chains: ${this.declaredChains.join(', ') || 'none'}. ` +
          `No RPC for ${undeclared.join(', ')} — set ${undeclared.map((c) => `rpcUrls.${c}`).join(', ')} to be offered those tasks ` +
          `(production posts new tasks on Base).`,
      );
    }

    // 1. Register or restore executor
    if (this.config.privateKey) {
      // The API key owner's own key: createAgent() registers its uncompressed
      // public key and throws if the backend registered a different address —
      // this runtime signs submitEvidence locally, so a mismatch could accept
      // tasks it can never deliver. Registration is an upsert that keeps
      // reputation, so this is safe on every start.
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
    } else if (this.config.existingPrivateKey && this.config.existingAddress && this.config.existingPublicKey) {
      this.wallet = {
        address: this.config.existingAddress,
        privateKey: this.config.existingPrivateKey,
        publicKey: this.config.existingPublicKey,
      };
      // Fetch existing profile — backend identifies by API key
      const result = await this.bb.getExecutorProfile();
      this.profile = await this.declareSupportedChains(result.agent);
    } else {
      const result = await this.bb.createAgent({
        displayName: this.config.displayName,
        capabilities: this.config.capabilities,
        minReward: this.config.minReward,
        preferredCapabilities: this.config.preferredCapabilities,
        supportedChains: this.declaredChains,
      });
      this.wallet = {
        address: result.wallet.address,
        privateKey: result.wallet.privateKey,
        publicKey: result.wallet.publicKey,
      };
      this.profile = result.executor;
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
   * the MCP or PATCH meant it. The backend only offers an executor
   * tasks on the chains it declared, and a restore never registers otherwise,
   * so an executor first registered by an older SDK would keep its old list.
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
      const active = this.activeExecutions;
      let inFlight = active.filter(e => e.status === 'bidding' || e.status === 'assigned' || e.status === 'working').length;
      if (inFlight >= this.config.maxConcurrentTasks) return;

      const result = await this.bb.browseA2ATasks({
        capabilities: this.config.capabilities,
      });

      this.emit({ type: 'browse_done', found: result.tasks.length });

      // GET /a2a/tasks serves { meta, state } entries — id and status live on
      // `state`. Nobody "assigns" a task: the executor claims it by calling
      // /accept itself (which also assigns it on-chain), so there is no
      // 'assigned' status to wait for.
      for (const entry of result.tasks as A2ATaskEntry[]) {
        if (inFlight >= this.config.maxConcurrentTasks) break;
        const state = entry.state;
        const taskId = state?.taskId ?? entry.meta?.taskId;
        if (!taskId || this.executions.has(taskId)) continue;
        if (state.status !== 'open') continue;
        // An accept assigns on-chain and cannot be released, so never claim a
        // task browse already says is on a chain this runtime did not declare.
        // (The post-accept check in executeTask still covers rows with no chain.)
        if (entry.meta?.chain && !(this.declaredChains as string[]).includes(entry.meta.chain)) continue;

        this.executions.set(taskId, { taskId, status: 'bidding', task: state, startedAt: Date.now() });
        inFlight++;
        this.emit({ type: 'task_found', taskId, task: state });
        void this.executeTask(taskId, state, entry.meta);
      }
    } catch (err) {
      this.emit({ type: 'error', error: `Browse failed: ${err}` });
    }
  }

  // ── Accept ──────────────────────────────────────────────────────────────

  /**
   * Claim the task. 403 NEEDS_WRAP means the brief key is not yet wrapped to
   * our pubkey: register a bid (the poster wraps to bidders on its next
   * cycle) and re-try /accept until the slice lands or wrapTimeoutMs passes.
   */
  private async acceptWithWrap(taskId: string): Promise<Awaited<ReturnType<BlindMarket['acceptTask']>>> {
    const giveUpAt = Date.now() + this.config.wrapTimeoutMs;
    let bidded = false;
    for (;;) {
      try {
        return await this.bb.acceptTask(taskId);
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'NEEDS_WRAP')) throw err;
        if (!bidded) {
          await this.bb.bidOnTask(taskId);
          bidded = true;
          this.emit({ type: 'task_bidded', taskId });
        }
        if (!this.running || Date.now() >= giveUpAt) throw err;
        await new Promise((r) => setTimeout(r, this.config.watchIntervalMs));
      }
    }
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
        acceptResult = await this.acceptWithWrap(taskId);
      } catch (err) {
        // Lost the race / offer held by another agent / wrap never came:
        // nothing was claimed, so forget the task and let a later browse
        // re-try it if it is still open.
        if (err instanceof ApiError && (err.status === 409 || err.code === 'NEEDS_WRAP')) {
          this.executions.delete(taskId);
          this.emit({ type: 'task_failed', taskId, error: `not accepted: ${err.code ?? err.message}` });
          return;
        }
        throw err;
      }
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
