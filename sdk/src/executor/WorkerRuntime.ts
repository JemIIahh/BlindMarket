import { ethers } from 'ethers';
import { BlindMarket } from '../index.js';
import { eciesDecrypt, aesDecrypt } from '../crypto/index.js';
import type {
  A2ATaskState, AgentCapability, ExecutorProfile, Message,
} from '../types.js';

// ── Config ──────────────────────────────────────────────────────────────────

export interface WorkerRuntimeConfig {
  apiKey: string;
  apiBase?: string;
  displayName: string;
  capabilities: AgentCapability[];
  executeTask: ExecuteTaskHandler;
  existingPrivateKey?: string;
  existingAddress?: string;
  existingPublicKey?: string;
  minReward?: string;
  preferredCapabilities?: AgentCapability[];
  browseIntervalMs?: number;
  watchIntervalMs?: number;
  maxConcurrentTasks?: number;
  /**
   * RPC URL used to sign + broadcast `submitEvidence` after `submitResult()`.
   * Defaults to the 0G testnet RPC (matches `backend/agents/worker.js`'s
   * default). Point this at the RPC for whichever chain your tasks settle on.
   */
  rpcUrl?: string;
  /** Per-chain RPCs. A task is escrowed on exactly one chain and /submit names
   *  it; submitEvidence must be signed on that chain. `rpcUrl` remains the 0G
   *  default. Without a Base entry the runtime refuses a Base task at submit
   *  rather than broadcasting it on 0G. */
  rpcUrls?: { '0g'?: string; base?: string };
}

// ── Types ───────────────────────────────────────────────────────────────────

export type ExecuteTaskHandler = (ctx: TaskContext) => Promise<Record<string, unknown>>;

export interface TaskContext {
  taskId: string;
  task: A2ATaskState;
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
  private watchTimers = new Map<string, ReturnType<typeof setInterval>>();
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

    // 1. Register or restore executor
    if (this.config.existingPrivateKey && this.config.existingAddress && this.config.existingPublicKey) {
      this.wallet = {
        address: this.config.existingAddress,
        privateKey: this.config.existingPrivateKey,
        publicKey: this.config.existingPublicKey,
      };
      // Fetch existing profile — backend identifies by API key
      const result = await this.bb.getExecutorProfile();
      this.profile = result.agent;
    } else {
      const result = await this.bb.createAgent({
        displayName: this.config.displayName,
        capabilities: this.config.capabilities,
        minReward: this.config.minReward,
        preferredCapabilities: this.config.preferredCapabilities,
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

  stop(): void {
    this.running = false;
    if (this.browseTimer) {
      clearInterval(this.browseTimer);
      this.browseTimer = undefined;
    }
    for (const t of this.watchTimers.values()) clearInterval(t);
    this.watchTimers.clear();
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
      const inFlight = active.filter(e => e.status === 'bidding' || e.status === 'working').length;
      if (inFlight >= this.config.maxConcurrentTasks) return;

      const result = await this.bb.browseA2ATasks({
        capabilities: this.config.capabilities,
      });

      this.emit({ type: 'browse_done', found: result.tasks.length });

      for (const task of result.tasks) {
        if (this.executions.has(task.taskId)) continue;
        if (task.status !== 'open' && task.status !== 'bidding') continue;
        if (task.executorAddress && task.executorAddress !== this.wallet?.address) continue;

        this.executions.set(task.taskId, {
          taskId: task.taskId,
          status: 'bidding',
          task,
          startedAt: Date.now(),
        });

        this.emit({ type: 'task_found', taskId: task.taskId, task });

        await this.bb.bidOnTask(task.taskId);
        this.emit({ type: 'task_bidded', taskId: task.taskId });

        this.watchForAssignment(task.taskId);
      }
    } catch (err) {
      this.emit({ type: 'error', error: `Browse failed: ${err}` });
    }
  }

  // ── Assignment watching ─────────────────────────────────────────────────

  private watchForAssignment(taskId: string): void {
    if (!this.running) return;
    const ms = this.config.watchIntervalMs;
    const timer = setInterval(async () => {
      if (!this.running || this.paused) return;
      try {
        const detail = await this.bb.getTask(taskId);
        const a2a = detail.a2aState;
        if (!a2a) return;

        if (a2a.status === 'assigned') {
          clearInterval(timer);
          this.watchTimers.delete(taskId);
          this.emit({ type: 'task_assigned', taskId });
          await this.executeTask(taskId, a2a);
        }
      } catch {
        // Retry next tick
      }
    }, ms);
    this.watchTimers.set(taskId, timer);
  }

  // ── Task execution ──────────────────────────────────────────────────────

  private async executeTask(taskId: string, a2a: A2ATaskState): Promise<void> {
    const exec = this.executions.get(taskId);
    if (!exec) return;

    try {
      exec.status = 'assigned';

      // Accept task — get the rootHash + this executor's ECIES-wrapped AES
      // key. wrappedKey is a single hex string (this caller's slice), not a
      // Record — see acceptTask()'s doc comment in ../index.ts.
      const acceptResult = await this.bb.acceptTask(taskId);
      exec.task = a2a;
      this.emit({ type: 'task_accepted', taskId });

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
        instructions,
      });

      exec.status = 'submitted';
      this.emit({ type: 'task_executed', taskId });

      // Submit result — the contract requires the assigned worker to sign
      // submitEvidence personally (onlyWorker), so the backend hands back an
      // unsigned tx instead of broadcasting it for us.
      const submitResult = await this.bb.submitResult(taskId, result);

      // Sign + broadcast submitEvidence with the runtime's own wallet, wait
      // for confirmation, then tell the backend to proceed with
      // verification. Without this the on-chain task never leaves
      // 'Assigned' and completeVerification always reverts — the task only
      // LOOKS complete.
      if (submitResult.unsignedSubmitEvidence) {
        // Pick the RPC for the chain the backend says holds this task. This
        // used to be a single 0G provider, so a Base submitEvidence was
        // broadcast onto 0G. The tx now also carries chainId, so a wrong RPC
        // fails loudly at ethers instead of landing on the wrong network.
        const chain = submitResult.chain === 'base' ? 'base' : '0g';
        const rpc = this.config.rpcUrls?.[chain] ?? (chain === '0g' ? this.config.rpcUrl : undefined);
        if (!rpc) {
          throw new Error(
            `task ${taskId} is escrowed on ${chain} but no RPC is configured for it — set rpcUrls.${chain} in the WorkerRuntime config`,
          );
        }
        const provider = new ethers.JsonRpcProvider(rpc);
        const signer = new ethers.Wallet(this.wallet!.privateKey, provider);
        const tx = await signer.sendTransaction(
          submitResult.unsignedSubmitEvidence as ethers.TransactionRequest,
        );
        await tx.wait();
      }
      const finalizeResult = await this.bb.finalize(taskId);

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
