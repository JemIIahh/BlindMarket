import { backgroundWritesAllowed, deploymentIdentityStatus, onBackgroundWritesStopped } from './deploymentIdentity.js';
import { fork, type ChildProcess } from 'child_process';
import { randomUUID, createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { Wallet } from 'ethers';
import jwt from 'jsonwebtoken';
import { deploySmartAccount } from './aa.js';
import pidusage from 'pidusage';
import { config } from '../config.js';
import { configuredChainKeys, postingChain, settlementChainConfig } from './settlementChains.js';

import { eciesEncrypt, generateKeyPair } from './crypto.js';
import { inft } from './chain.js';
import {
  appendLog, getLogs, subscribeAgentLogs as redisSubscribe,
  touchHeartbeat, isAlive, getHeartbeat,
} from './redis.js';
import { saveAgent, loadAgent, loadAllAgents } from './deployedAgentStore.js';
import { composeAgentRuntime } from './skillComposer.js';
import type { DeployedAgent, AgentCapability, LLMProvider, AgentTool, InstalledSkill } from '../types.js';

/**
 * The settlement chains a worker signs on, as JSON for its env.
 *
 * Only chains this deployment has an escrow on: a worker cannot settle
 * anywhere else, and an entry with no escrow would make it offer to sign for
 * a chain the backend never names. `posting` marks the chain new tasks are
 * funded on, which is the one a worker delegating a sub-task must use.
 *
 * What the worker can sign for at all is its own code's business
 * (SETTLEMENT_CHAINS in worker.js) and is NOT this list — a worker declares
 * its capability at registration, and a backend with a narrower config must
 * not overwrite that declaration.
 */
export function settlementChainsJson(): string {
  const posting = postingChain();
  return JSON.stringify(
    configuredChainKeys().map((key) => {
      const { chainId, rpcUrl, escrowAddress, token, gas, aa } = settlementChainConfig(key);
      return {
        key,
        chainId,
        rpcUrl,
        escrow: escrowAddress,
        token: { address: token.address, kind: token.kind, symbol: token.unit.symbol, decimals: token.unit.decimals },
        gasSymbol: gas.symbol,
        nativeIsSettlementToken: gas.nativeIsSettlementToken,
        aa,
        posting: key === posting,
      };
    }),
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, '../../agents/worker.js');

// The worker is a sandbox boundary: it executes user-supplied tool code, and
// Node's `vm` is explicitly not a security boundary. Pass only what
// backend/agents/worker.js actually reads, so a worker-side escape cannot
// reach the marketplace signer keys, JWT_SECRET, or the database.
// Derived by enumerating every process.env read in worker.js.
// SENTRY_DSN is on the list deliberately: a DSN is a write-only ingest address
// (it lets the holder SEND events, not read them or reach any platform
// resource), so it is not a secret of the kind this boundary exists to keep
// out. Without it worker crashes never reach Sentry. @sentry/node reads
// SENTRY_ENVIRONMENT itself.
export const WORKER_ENV_PASSTHROUGH = [
  'NODE_ENV',
  'BACKEND_URL',
  'OG_RPC_URL',
  'OG_CHAIN_ID',
  'BASE_RPC_URL',
  'BASE_CHAIN_ID',
  // @ai-sdk/openai reads this itself. Lets an operator point 'openai'-provider
  // agents at a compatible endpoint (self-hosted model, proxy, or a local stub
  // for end-to-end tests) without a code change.
  'OPENAI_BASE_URL',
  'HEARTBEAT_INTERVAL_MS',
  'POLL_INTERVAL_MS',
  'WS_RECONCILE_MS',
  'GAS_RECHECK_MS',
  'LLM_TIMEOUT_MS',
  'RELEASE_COOLDOWN_MS',
  'SENTRY_DSN',
  'SENTRY_ENVIRONMENT',
  'DELEGATE_REWARD_OG',
  'DELEGATE_REWARD_USDC',
  'DELEGATE_GAS_RESERVE_OG',
  // OS/runtime vars node + tsx need to start at all:
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'NODE_OPTIONS',
] as const;

// Running child processes (in-memory only — processes don't survive restarts)
const processes = new Map<string, ChildProcess>();

/**
 * Kill every worker this process runs, without touching their saved status:
 * they come back through reconcile when a backend that may write boots. Used
 * when this process learns it is on another deployment's Redis, where its
 * workers would poll a queue that is not theirs. Returns how many it stopped.
 */
export function stopLocalWorkers(): number {
  let stopped = 0;
  for (const [id, child] of processes) {
    intentionalStops.add(child);
    child.kill('SIGTERM');
    processes.delete(id);
    stopped++;
  }
  return stopped;
}
onBackgroundWritesStopped(() => {
  const stopped = stopLocalWorkers();
  if (stopped > 0) console.error(`[agentRunner] stopped ${stopped} running worker(s): this backend may not write to this Redis (deploymentIdentity)`);
});

// ── Crash auto-restart ────────────────────────────────────────────────────────
// When a worker crashes (non-zero exit / kill signal we didn't send), re-fork it
// — but rate-limited so a worker that crash-loops can't spin forever or hammer
// the LLM/chain. Cap: MAX_RESTARTS_IN_WINDOW within RESTART_WINDOW_MS, then alert
// and leave it stopped for manual recovery.
const RESTART_WINDOW_MS = 10 * 60_000;
const MAX_RESTARTS_IN_WINDOW = 5;
const RESTART_DELAY_MS = 3_000;
// id → timestamps of recent auto-restarts (pruned to the rolling window).
const restartTimes = new Map<string, number[]>();
// Children the operator deliberately stopped (SIGTERM via stopAgent). Their exit
// must NOT be treated as a crash. Marked per-CHILD (not per-id): during a
// stop→restart overlap the old SIGTERM'd child and its replacement transiently
// coexist, and a per-id marker could be consumed by the wrong one. Keyed on the
// ChildProcess so it can never be misattributed; a WeakSet drops the entry when
// the child is GC'd after exit.
const intentionalStops = new WeakSet<ChildProcess>();

// ── Resource limits ────────────────────────────────────────────────────────────
// Max concurrent forked agent processes. On a 512 MB Render box each Node worker
// needs ~50 MB baseline; cap at 5 to leave headroom for the API server + Redis.
const MAX_CONCURRENT_AGENTS = Number(process.env.MAX_CONCURRENT_AGENTS ?? 5);

// ── Zombie reaper ──────────────────────────────────────────────────────────────
// Every 60 s, sweep the processes map and kill any agent whose Redis heartbeat
// key has expired (stale >90 s). This catches workers that exit without triggering
// the 'exit' event (e.g. SIGKILL from the OOM killer on low-memory instances).
export function startZombieReaper(): void {
  setInterval(async () => {
    // ── Heartbeat watchdog ───────────────────────────────────────────
    // Scan ALL running agents (not just the processes map) so we catch
    // workers where the child process died but the PG status wasn't flipped.
    try {
      const all = await loadAllAgents();
      for (const a of all.filter(a => a.status === 'running')) {
        const lastBeat = await getHeartbeat(a.id);
        if (lastBeat === 0 || Date.now() - lastBeat > 120_000) {
          appendLog(a.id, '[agentRunner] heartbeat timeout — worker appears hung');
        }
      }
    } catch { /* non-fatal */ }

    // ── Zombie reaper ────────────────────────────────────────────────
    // Kill forked processes whose Redis heartbeat TTL has fully expired.
    for (const [id, child] of processes) {
      try {
        if (!(await isAlive(id))) {
          console.warn(`[agentRunner] reaper: agent ${id} heartbeat expired — killing stale process`);
          const a = await loadAgent(id);
          intentionalStops.add(child);
          child.kill('SIGTERM');
          processes.delete(id);
          if (a && a.status === 'running') {
            a.status = 'stopped';
            await saveAgent(a);
          }
        }
      } catch {
        try {
          intentionalStops.add(child);
          child.kill('SIGTERM');
          processes.delete(id);
        } catch { /* best-effort */ }
      }
    }
  }, 60_000).unref();
}

// ── Crash memory across restarts ──────────────────────────────────────────────
// The rolling restart cap above only trips on FAST loops. A task that reliably
// kills the worker is slow: the restart skips the first resume pass, resumes
// ~2 min later, pays for an LLM call, dies — one lap is longer than the cap's
// window allows for, and the worker's own per-task attempt budget is in-memory,
// so it resets on every lap. The count therefore has to live HERE, in the
// parent. The worker reports which task it is running ({type:'task-started'} /
// {type:'task-finished', completed} over IPC); when it crashes, the task in flight is
// charged. Both counters go back to the worker via env on restart, and the
// worker stops resuming a task once it has been in flight for
// TASK_CRASH_LIMIT crashes (worker.js resumeSkipReason). In-memory: a backend
// restart forgets it, which costs at most one more budget of laps.
export interface CrashMemory {
  /** Crash-restarts in a row, without a healthy stretch or a finished task in between. */
  consecutive: number;
  /** taskHash → crashes that happened while that task was in flight. */
  byTask: Record<string, number>;
}
/** A worker that stayed up this long before crashing starts a new streak. Longer
 *  than any one poison-task lap (resume delay + LLM_TIMEOUT_MS + a repair pass). */
export const HEALTHY_UPTIME_MS = 30 * 60_000;
const MAX_TRACKED_CRASH_TASKS = 20;

/** Pure: the crash memory after one more crash. */
export function recordCrash(
  prev: CrashMemory | undefined,
  crash: { inFlightTask: string | null; uptimeMs: number },
  healthyUptimeMs = HEALTHY_UPTIME_MS,
): CrashMemory {
  const streak = crash.uptimeMs >= healthyUptimeMs ? 0 : (prev?.consecutive ?? 0);
  const byTask = { ...(prev?.byTask ?? {}) };
  if (crash.inFlightTask) {
    // Re-insert so the most recently charged task is last, then keep the tail.
    const n = (byTask[crash.inFlightTask] ?? 0) + 1;
    delete byTask[crash.inFlightTask];
    byTask[crash.inFlightTask] = n;
  }
  const keep = Object.entries(byTask).slice(-MAX_TRACKED_CRASH_TASKS);
  return { consecutive: streak + 1, byTask: Object.fromEntries(keep) };
}

/**
 * Pure: a task went all the way through (submitted + finalized, or a verdict
 * recorded) — clear it and the streak. A run that merely RETURNED is not
 * reported here: an LLM error or a gas hold says nothing about whether the
 * task is poison, and clearing on it would let a task that crashes the worker
 * shortly after its run returns reset its own count every lap.
 */
export function recordTaskCompleted(prev: CrashMemory | undefined, taskHash: string): CrashMemory | undefined {
  if (!prev) return prev;
  const byTask = { ...prev.byTask };
  delete byTask[taskHash];
  return { consecutive: 0, byTask };
}

const crashMemory = new Map<string, CrashMemory>();
// id → task the live worker last reported as in flight (null between tasks).
const inFlightTasks = new Map<string, string | null>();

function isTaskHashLike(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 80;
}

// Record an auto-restart attempt and report whether it's within the rolling cap.
// Returns false (and does NOT record) once the agent has crash-looped past the cap.
function canAutoRestart(id: string): boolean {
  const now = Date.now();
  const recent = (restartTimes.get(id) ?? []).filter((t) => now - t < RESTART_WINDOW_MS);
  if (recent.length >= MAX_RESTARTS_IN_WINDOW) {
    restartTimes.set(id, recent);
    return false;
  }
  recent.push(now);
  restartTimes.set(id, recent);
  return true;
}

// Re-fork a crashed worker after the restart delay, with skipResume=true so a
// poison brief can't immediately re-crash the restart (the crash memory above
// is what stops it re-crashing every later lap). Re-checks state first:
// the operator may have stopped it during the delay, or it may already be back.
async function autoRestart(id: string): Promise<void> {
  const a = await loadAgent(id);
  // Bail if the operator stopped it during the delay (status flipped to
  // 'stopped') or it's already been re-forked. The status check is the
  // authoritative "operator stopped" signal here — there's no child to test.
  if (!a || a.status !== 'running' || processes.has(id)) return;
  try {
    await startAgent(id, { skipResume: true });
  } catch (e) {
    appendLog(id, `[agentRunner] auto-restart failed: ${(e as Error).message}`);
    const a2 = await loadAgent(id);
    if (a2 && a2.status === 'running') { a2.status = 'stopped'; await saveAgent(a2); }
  }
}

// ── Logs ─────────────────────────────────────────────────────────────────────

export async function getAgentLogs(id: string): Promise<string[]> {
  return getLogs(id);
}

export async function subscribeAgentLogs(
  id: string,
  cb: (line: string) => void,
): Promise<() => void> {
  return redisSubscribe(id, cb);
}

// ── Deploy ────────────────────────────────────────────────────────────────────

export async function deployAgent(params: {
  ownerAddress: string;
  ownerPublicKey: string;
  name: string;
  instructions: string;
  provider: LLMProvider;
  model: string;
  apiKey: string;
  capabilities: AgentCapability[];
  tools?: AgentTool[];
  toolSecrets?: Record<string, string>;
  storageRef?: string;
  /** Frozen skill snapshots, resolved server-side from slugs in routes/agents.ts. */
  skills?: InstalledSkill[];
}): Promise<DeployedAgent> {
  const { privateKey, publicKey } = generateKeyPair();

  // Only EVM (0G) chain is supported
  const walletAddress = new Wallet(`0x${privateKey}`).address;

  const encryptedPrivateKey = eciesEncrypt(
    Buffer.from(privateKey, 'hex'),
    params.ownerPublicKey,
  ).toString('hex');

  const encryptedApiKey = eciesEncrypt(
    Buffer.from(params.apiKey, 'utf8'),
    params.ownerPublicKey,
  ).toString('hex');

  // Encrypt per-tool secrets (API keys) with owner's public key
  const toolSecretEntries = Object.entries(params.toolSecrets ?? {});
  const toolSecrets: Record<string, string> = {};
  const encryptedToolSecrets: Record<string, string> = {};
  for (const [key, val] of toolSecretEntries) {
    if (!val) continue;
    toolSecrets[key] = val;
    encryptedToolSecrets[key] = eciesEncrypt(
      Buffer.from(val, 'utf8'),
      params.ownerPublicKey,
    ).toString('hex');
  }

  let inftTokenId: number | undefined;
  if (inft) {
    try {
      const metadataHash = `0x${createHash('sha256').update(walletAddress + publicKey).digest('hex')}` as `0x${string}`;
      const tx = await (inft as any).mint(params.ownerAddress, '', metadataHash);
      const receipt = await tx.wait();
      const event = receipt?.logs?.find((l: any) => {
        try { return (inft as any).interface.parseLog(l)?.name === 'INFTMinted'; } catch { return false; }
      });
      if (event) {
        inftTokenId = Number((inft as any).interface.parseLog(event)?.args?.tokenId);
      }
    } catch (e) {
      console.warn('INFT mint failed (non-fatal):', (e as Error).message);
    }
  }

  const platformToken = jwt.sign(
    {
      address: walletAddress, ownerAddress: params.ownerAddress.toLowerCase(), agentName: params.name,
      jti: randomUUID(), // M3 (audit): per-token id so owners can revoke without rotating JWT_SECRET
      // M6 (audit): first-party worker token. verifyRegistrationToken honors
      // this over the default 'agent-registration', so device-flow-phished
      // ownerAddress claims can't be laundered through worker credentials.
      typ: 'agent-platform',
    },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: '365d' } as jwt.SignOptions,
  );

  const agent: DeployedAgent = {
    id: randomUUID(),
    ownerAddress: params.ownerAddress,
    name: params.name,
    instructions: params.instructions,
    provider: params.provider,
    model: params.model,
    apiKey: params.apiKey,       // kept in memory for worker env; not persisted to Redis
    encryptedApiKey,
    capabilities: params.capabilities,
    tools: params.tools ?? [],
    status: 'stopped',
    deployedAt: new Date().toISOString(),
    walletAddress,
    publicKey,
    encryptedPrivateKey,
    rawPrivateKey: privateKey,
    inftTokenId,
    storageRef: params.storageRef,
    platformToken,
    toolSecrets: Object.keys(toolSecrets).length > 0 ? toolSecrets : undefined,
    encryptedToolSecrets: Object.keys(encryptedToolSecrets).length > 0 ? encryptedToolSecrets : undefined,
    skills: params.skills?.length ? params.skills : undefined,
  };

  // Deploy ERC-4337 smart account on Base (non-fatal if AA infra is unconfigured).
  // The smart account lets the worker pay gas in USDC via the paymaster instead of
  // requiring ETH. Deterministic address: same owner always yields the same address.
  try {
    const smartAddr = await deploySmartAccount(agent);
    if (smartAddr) {
      agent.smartAccountAddress = smartAddr;
      await saveAgent(agent);
    }
  } catch (e) {
    // Non-fatal — agent runs on 0G without AA when deployment fails
    console.warn(`[agentRunner] Smart account deployment failed for ${agent.id}: ${(e as Error).message}`);
  }

  await saveAgent(agent);
  return agent;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export async function startAgent(id: string, opts?: { skipResume?: boolean }): Promise<void> {
  // A worker polls this backend, which serves the Redis queue it sits on; on
  // another deployment's Redis that is how tasks get poached.
  if (!backgroundWritesAllowed('agent start')) {
    throw new Error(`This backend is on another deployment's Redis (${deploymentIdentityStatus()?.reason}), so it starts no agents. Give it its own REDIS_URL.`);
  }
  const agent = await loadAgent(id);
  if (!agent) throw new Error(`Agent ${id} not found`);
  if (processes.has(id)) return;

  // Enforce max concurrent agents so a reconcile storm can't OOM the instance.
  // Checked AFTER the already-running dedup so an in-flight agent is never
  // counted against the cap twice.
  if (processes.size >= MAX_CONCURRENT_AGENTS) {
    throw new Error(
      `Max concurrent agents (${MAX_CONCURRENT_AGENTS}) reached — stop an agent first or increase MAX_CONCURRENT_AGENTS`,
    );
  }

  // Migration: Generate platform token if missing
  if (!agent.platformToken) {
    if (!config.jwtSecret) {
      console.error('[agentRunner] Cannot start agent: JWT_SECRET not configured');
      throw new Error('Server configuration error: JWT_SECRET missing');
    }
    agent.platformToken = jwt.sign(
      {
        address: agent.walletAddress, ownerAddress: agent.ownerAddress.toLowerCase(), agentName: agent.name,
        jti: randomUUID(), // M3 (audit): per-token id so owners can revoke without rotating JWT_SECRET
        typ: 'agent-platform', // M6 (audit): first-party worker token (see deploy mint above)
      },
      config.jwtSecret,
      { algorithm: 'HS256', expiresIn: '365d' } as jwt.SignOptions,
    );
    await saveAgent(agent);
    console.log(`[agentRunner] Generated missing platform token for agent ${id}`);
  }

  // Cap each agent worker at 128 MB so a leaky LLM call never OOMs the backend
  // or other agents. Without this the forked child inherits the parent's default
  // 2 GB heap limit, which on a 512 MB Render box means 9 agents = guaranteed OOM.
  // Compose installed skills into the two env surfaces the worker consumes.
  // With zero skills this is an exact passthrough (see skillComposer.ts) —
  // the worker itself is skill-agnostic.
  const composed = composeAgentRuntime(agent);

  const child = fork(WORKER_PATH, [], {
    execArgv: ['--max-old-space-size=128', '--import', 'tsx/esm'],
    env: {
      ...Object.fromEntries(
        WORKER_ENV_PASSTHROUGH
          .filter((k) => process.env[k] !== undefined)
          .map((k) => [k, process.env[k] as string]),
      ),
      AGENT_ID: agent.id,
      AGENT_NAME: agent.name,
      AGENT_INSTRUCTIONS: composed.instructions,
      AGENT_PROVIDER: agent.provider,
      AGENT_MODEL: agent.model,
      AGENT_API_KEY: agent.apiKey,
      AGENT_PLATFORM_TOKEN: agent.platformToken,
      AGENT_WALLET: agent.walletAddress,
      AGENT_PRIVATE_KEY: agent.rawPrivateKey ?? '',
      // Worker passes this to /a2a/register so posters can ECIES-wrap the AES
      // key to it at task-creation time. Same format the backend ECIES expects:
      // uncompressed secp256k1 hex, no 0x prefix.
      AGENT_PUBLIC_KEY: agent.publicKey ?? '',
      OG_RPC_URL: config.ogRpcUrl,
      OG_CHAIN_ID: String(config.ogChainId),
      // Escrow proxy address — the verifier role (verificationMode='agent')
      // signs completeVerification directly against this contract.
      AGENT_ESCROW_ADDRESS: config.blindEscrowAddress,
      // Every settlement chain this deployment is configured for, as data:
      // the worker builds one signer per entry and picks by the `chain` the
      // backend reports on /submit and /verifications. Before it existed the
      // worker had a single 0G signer and broadcast every Base submitEvidence
      // onto 0G, so a deployed agent could accept a Base task and never
      // deliver it; before THIS table, each new chain meant another pair of
      // env vars in both processes. An older worker ignores it and reads the
      // legacy vars below, which stay for one more release.
      SETTLEMENT_CHAINS_JSON: settlementChainsJson(),
      // Base settlement (legacy). Empty when Base is unconfigured, and the
      // worker treats empty as "no Base signer" rather than guessing an RPC.
      BASE_RPC_URL: config.baseEscrowAddress ? config.baseRpcUrl : '',
      BASE_CHAIN_ID: config.baseEscrowAddress ? String(config.baseChainId) : '',
      AGENT_BASE_ESCROW_ADDRESS: config.baseEscrowAddress ?? '',
      BACKEND_URL: `http://localhost:${config.port}`,
      AGENT_TOOLS: JSON.stringify(composed.tools),
      AGENT_TOOL_SECRETS: JSON.stringify(agent.toolSecrets ?? {}),
      AGENT_CAPABILITIES: JSON.stringify(agent.capabilities ?? []),
      AGENT_MIN_REWARD: agent.minReward ?? '',
      AGENT_MEMORY_NS: `agent:${agent.id}`,
      AGENT_FILES_DIR: `/data/agents/${agent.id}`,
      // Set only on a post-crash auto-restart: the worker skips re-driving its
      // in-flight (accepted-but-unsubmitted) task so a poison brief can't loop
      // the crash. Empty on fresh starts and graceful boot-reconciles.
      AGENT_SKIP_RESUME: opts?.skipResume ? '1' : '',
      // Crash memory (see CrashMemory): how many crash-restarts in a row, and
      // which tasks were in flight when the worker died. Zero/empty on a
      // fresh start.
      AGENT_CRASH_COUNT: String(crashMemory.get(id)?.consecutive ?? 0),
      AGENT_CRASHED_TASKS: JSON.stringify(crashMemory.get(id)?.byTask ?? {}),
      // ERC-4337 AA — smart account on Base for gasless USDC paymaster.
      // Empty when the agent has no smart account (pre-AA agents or deployment failed).
      AGENT_SMART_ACCOUNT_ADDRESS: agent.smartAccountAddress ?? '',
      AA_ENTRY_POINT: config.entryPointAddress,
      AA_PAYMASTER: config.usdcPaymasterAddress,
      AA_USDC: config.baseUsdcAddress,
      PIMLICO_BUNDLER_URL: config.pimlicoBundlerUrl,
      PIMLICO_API_KEY: config.pimlicoApiKey,
    },
    silent: true,
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    chunk.toString().split('\n').filter(Boolean).forEach(line => appendLog(id, line));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    chunk.toString().split('\n').filter(Boolean).forEach(line => appendLog(id, `[err] ${line}`));
  });

  const startedAt = Date.now();
  inFlightTasks.set(id, null);

  child.on('message', async (msg: unknown) => {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { type?: unknown; taskHash?: unknown; completed?: unknown };
    // In-flight task reports — only from the child that currently owns the id.
    if (m.type === 'task-started' && isTaskHashLike(m.taskHash)) {
      if (processes.get(id) === child) inFlightTasks.set(id, m.taskHash);
      return;
    }
    if (m.type === 'task-finished' && isTaskHashLike(m.taskHash)) {
      if (processes.get(id) === child) {
        if (inFlightTasks.get(id) === m.taskHash) inFlightTasks.set(id, null);
        if (m.completed === true) {
          const next = recordTaskCompleted(crashMemory.get(id), m.taskHash);
          if (next) crashMemory.set(id, next);
        }
      }
      return;
    }
    if (m.type === 'heartbeat') {
      await touchHeartbeat(id);
      const a = await loadAgent(id);
      if (a) {
        a.lastActiveAt = new Date().toISOString();
        await saveAgent(a);
      }
    }
  });

  // A fork that fails to SPAWN (worker.js missing, EACCES, OOM at spawn time)
  // emits 'error', NOT 'exit'. With no listener Node re-throws it in THIS
  // (backend) process — which would take down the API and every other running
  // agent. Catch it, surface it on the agent's log stream, and treat it as a
  // stop so one bad fork can never cascade into a full backend outage.
  child.on('error', async (err) => {
    // Ignore a stale event from a child that's already been replaced in the map.
    if (processes.get(id) !== child) return;
    appendLog(id, `[agentRunner] worker failed to start: ${err.message}`);
    processes.delete(id);
    const a = await loadAgent(id);
    if (a && a.status === 'running') { a.status = 'stopped'; await saveAgent(a); }
  });

  child.on('exit', async (code, signal) => {
    // Ignore a STALE exit. If a newer child has already replaced us in the map
    // (e.g. /restart forked a replacement before our SIGTERM exit landed, or an
    // auto-restart re-forked), this event is from the OLD process — running
    // processes.delete / the status flip here would evict the live child and
    // wrongly mark a working agent 'stopped'. Identity-scope every mutation.
    if (processes.get(id) !== child) return;
    processes.delete(id);
    // Did the operator stop THIS child (SIGTERM via stopAgent)? Per-child marker,
    // so a concurrent restart can't misattribute an operator stop to a crash.
    const wasIntentional = intentionalStops.has(child);
    const a = await loadAgent(id);

    // A crash = an exit we didn't ask for: a non-zero code (the worker's own
    // unhandledRejection/uncaughtException handlers exit(1)) or a signal we
    // didn't send (SIGKILL from the OOM killer, SIGSEGV). A clean code-0 exit
    // (e.g. parent-disconnect during backend shutdown) and operator SIGTERM are
    // NOT crashes and never auto-restart.
    const crashed =
      !wasIntentional &&
      ((code != null && code !== 0) || (signal != null && signal !== 'SIGTERM'));

    const inFlightTask = inFlightTasks.get(id) ?? null;
    inFlightTasks.delete(id);
    if (crashed) {
      crashMemory.set(id, recordCrash(crashMemory.get(id), { inFlightTask, uptimeMs: Date.now() - startedAt }));
    }

    if (crashed && a && a.status === 'running') {
      if (canAutoRestart(id)) {
        const mem = crashMemory.get(id);
        const blame = inFlightTask
          ? ` while running task ${inFlightTask.slice(0, 10)}… (crash ${mem?.byTask[inFlightTask] ?? 1} on that task)`
          : '';
        appendLog(id, `[agentRunner] worker crashed (${code != null ? `exit code=${code}` : `signal=${signal}`})${blame} — auto-restarting in ${RESTART_DELAY_MS / 1000}s (crash ${mem?.consecutive ?? 1} in a row; first resume pass skipped)`);
        setTimeout(() => { void autoRestart(id); }, RESTART_DELAY_MS);
        return; // keep status 'running' across the restart
      }
      appendLog(id, `[agentRunner] ALERT: worker crash-looped (≥${MAX_RESTARTS_IN_WINDOW} restarts within ${RESTART_WINDOW_MS / 60000}min) — auto-restart disabled. Fix the cause, then click Start to relaunch.`);
      restartTimes.delete(id);
      a.status = 'stopped';
      await saveAgent(a);
      return;
    }

    // Non-crash exit: surface a crash-vs-stop line (best-effort; a true crash
    // only reaches here once auto-restart is exhausted) and flip running→stopped.
    if (code && code !== 0) {
      appendLog(id, `[agentRunner] worker exited (code=${code}${signal ? ` signal=${signal}` : ''}) — agent stopped; click Start to relaunch`);
    } else if (signal && signal !== 'SIGTERM') {
      appendLog(id, `[agentRunner] worker terminated by signal ${signal} — agent stopped`);
    }
    if (a && a.status === 'running') {
      a.status = 'stopped';
      await saveAgent(a);
    }
  });

  processes.set(id, child);
  agent.status = 'running';
  await saveAgent(agent);
}

export async function pauseAgent(id: string): Promise<void> {
  const child = processes.get(id);
  if (!child) throw new Error(`Agent ${id} is not running`);
  child.kill('SIGSTOP');
  const agent = await loadAgent(id);
  if (agent) { agent.status = 'paused'; await saveAgent(agent); }
}

export async function stopAgent(id: string): Promise<void> {
  // Clear any crash-restart history; an explicit stop is a clean slate.
  restartTimes.delete(id);
  crashMemory.delete(id);
  inFlightTasks.delete(id);
  const child = processes.get(id);
  if (child) {
    // Mark THIS child's impending SIGTERM exit as operator-initiated so the exit
    // handler doesn't mistake it for a crash and auto-restart it. Keyed on the
    // child object (not the id) so a concurrent restart can't misattribute it.
    intentionalStops.add(child);
    child.kill('SIGTERM');
    processes.delete(id);
  }
  const agent = await loadAgent(id);
  if (agent) { agent.status = 'stopped'; await saveAgent(agent); }
}

export async function resumeAgent(id: string): Promise<void> {
  const child = processes.get(id);
  if (!child) throw new Error(`Agent ${id} is not running`);
  child.kill('SIGCONT');
  const agent = await loadAgent(id);
  if (agent) { agent.status = 'running'; await saveAgent(agent); }
}

/**
 * Poll the OS for live CPU and RSS memory of a forked agent process using
 * the pidusage library. Returns null if the agent isn't currently running.
 */
export async function getAgentStats(id: string): Promise<{ cpu: number; ramMb: number } | null> {
  const child = processes.get(id);
  if (!child?.pid) return null;
  try {
    const stats = await pidusage(child.pid);
    return {
      cpu: stats.cpu,
      ramMb: stats.memory / 1024 / 1024,
    };
  } catch {
    return null;
  }
}

/**
 * Re-fork agents that were 'running' when the backend last stopped. The
 * `processes` map lives only in this process's memory, so a backend restart
 * (deploy, crash, OOM) silently leaves every persisted-'running' agent with no
 * worker — it still shows 'running' in the UI but does no work and stops
 * emitting heartbeats. Call this once at boot to reconcile persisted state with
 * reality.
 *
 * Graceful path: this does NOT pass skipResume, so workers re-drive their
 * in-flight accepted tasks (a clean restart should recover owed work) — only the
 * crash auto-restart skips resume. Each start is isolated so one bad agent can't
 * abort boot. Assumes a single agent-hosting backend instance (the `processes`
 * map is per-process); honored by an env flag in index.ts for unusual topologies.
 */
export async function reconcileAgents(): Promise<void> {
  if (!backgroundWritesAllowed('agent reconcile')) return;
  let agents: DeployedAgent[];
  try {
    agents = await loadAllAgents();
  } catch (e) {
    console.error(`[agentRunner] reconcile: failed to load agents`, e);
    return;
  }
  const running = agents.filter((a) => a.status === 'running' && !processes.has(a.id));
  if (running.length === 0) return;

  const available = Math.max(0, MAX_CONCURRENT_AGENTS - processes.size);
  const toStart = running.slice(0, available);
  const excess = running.length - toStart.length;

  console.log(
    `[agentRunner] reconcile: re-forking ${toStart.length}/${running.length} agent(s)` +
    (excess > 0 ? ` (${excess} deferred — MAX_CONCURRENT_AGENTS=${MAX_CONCURRENT_AGENTS})` : ''),
  );

  for (const a of toStart) {
    try {
      await startAgent(a.id);
      console.log(`[agentRunner] reconcile: restarted agent ${a.id} (${a.name})`);
    } catch (e) {
      console.error(`[agentRunner] reconcile: failed to restart agent ${a.id} (${a.name}): ${(e as Error).message}`);
    }
  }

  if (excess > 0) {
    console.warn(
      `[agentRunner] reconcile: ${excess} running agent(s) not re-forked due to MAX_CONCURRENT_AGENTS=${MAX_CONCURRENT_AGENTS}. ` +
      `Increase the env var or start them manually.`,
    );
  }
}

export async function getAgent(id: string): Promise<DeployedAgent | undefined> {
  return (await loadAgent(id)) ?? undefined;
}

export async function listAgents(ownerAddress?: string): Promise<DeployedAgent[]> {
  const all = await loadAllAgents();
  return ownerAddress
    ? all.filter(a => a.ownerAddress?.toLowerCase() === ownerAddress.toLowerCase())
    : all;
}

export async function updateAgent(id: string, patch: Partial<Pick<DeployedAgent, 'instructions' | 'provider' | 'model' | 'apiKey' | 'tools' | 'capabilities' | 'minReward' | 'skills'>>): Promise<DeployedAgent | undefined> {
  const agent = await loadAgent(id);
  if (!agent) return undefined;
  // Strip undefined values before merging.
  const cleanPatch: typeof patch = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (cleanPatch as Record<string, unknown>)[k] = v;
  }
  // Re-encrypt API key if it changed
  if (cleanPatch.apiKey !== undefined && agent.publicKey) {
    const encryptedApiKey = eciesEncrypt(
      Buffer.from(cleanPatch.apiKey as string, 'utf8'),
      agent.publicKey,
    ).toString('hex');
    (cleanPatch as Record<string, unknown>).encryptedApiKey = encryptedApiKey;
  }
  const updated = { ...agent, ...cleanPatch };
  await saveAgent(updated);
  return updated;
}

/**
 * Append a wallet to an agent's authorizedOwners allowlist (lowercased,
 * deduped). Drives the signature-gated owner-link flow so a Privy identity
 * that differs from the original wagmi deploy wallet can manage the agent once
 * it has proven control of the owner wallet. No-op (returns the unchanged
 * record) if the address is already the ownerAddress or already authorized.
 */
export async function addAuthorizedOwner(id: string, address: string): Promise<DeployedAgent | undefined> {
  const agent = await loadAgent(id);
  if (!agent) return undefined;
  const lower = address.toLowerCase();
  const already =
    lower === agent.ownerAddress.toLowerCase() ||
    (agent.authorizedOwners ?? []).some((a) => a.toLowerCase() === lower);
  if (!already) {
    agent.authorizedOwners = [...(agent.authorizedOwners ?? []), lower];
    await saveAgent(agent);
  }
  return agent;
}
