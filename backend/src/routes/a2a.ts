import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import * as agentStore from '../services/agentStore.js';
import * as a2aStore from '../services/a2aStore.js';
import * as bidsStore from '../services/bidsStore.js';
import { autoVerify } from '../services/autoVerify.js';
import { settleAssignment, settleVerification } from '../services/a2aSettlement.js';
import { getTaskIdByHash } from '../services/escrowEvents.js';
import * as escrowService from '../services/escrow.js';
import * as accountingService from '../services/accountingService.js';
import * as reputationDecay from '../services/reputationDecay.js';
import { provider, escrow } from '../services/chain.js';
import { redis } from '../services/redis.js';
import { ethers } from 'ethers';
import type { AuthRequest, ApiResponse, AgentCapability } from '../types.js';
import { AGENT_CAPABILITIES } from '../types.js';

export const a2aRouter = Router();

// --- Schemas ---

const registerSchema = z.object({
  displayName: z.string().min(1).max(100),
  capabilities: z.array(z.enum(AGENT_CAPABILITIES as unknown as [string, ...string[]])).min(1).max(20),
  // Uncompressed secp256k1 hex (130 chars, leading `04`, no 0x prefix).
  // Optional so legacy workers can still register, but anything created without
  // it can't decrypt encrypted briefs (the new posting flow wraps the AES key
  // to this pubkey at task-create time).
  publicKey: z
    .string()
    .regex(/^04[0-9a-fA-F]{128}$/, 'publicKey must be uncompressed secp256k1 hex (130 chars, leading 04, no 0x prefix)')
    .optional(),
  agentCardUrl: z.string().url().optional(),
  mcpEndpointUrl: z.string().url().optional(),
});

const submitSchema = z.object({
  resultData: z.record(z.unknown()),
});

// POST /tasks/index — verified A2A meta write. The poster's frontend calls
// this AFTER the createTask tx confirms, supplying the txHash so the backend
// can re-parse the receipt and confirm the on-chain task actually exists
// before persisting anything to Redis. Without this gate, writing meta
// speculatively in POST /tasks left phantom entries whenever a tx reverted
// (token-not-allowed, gas, etc.) and agents got stuck retrying NOT_INDEXED.
const indexTaskSchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'txHash must be a 32-byte hex string'),
  taskHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'taskHash must be a bytes32 hex string'),
  verificationMode: z.enum(['manual', 'auto', 'oracle']).optional(),
  verificationCriteria: z
    .object({
      required_fields: z.array(z.string()).optional(),
      min_length: z.number().int().positive().optional(),
      contains_keywords: z.array(z.string()).optional(),
    })
    .optional(),
  requiredCapabilities: z
    .array(z.enum(AGENT_CAPABILITIES as unknown as [string, ...string[]]))
    .optional(),
  rootHash: z.string().min(1).max(256).optional(),
  wrappedKeys: z
    .record(
      z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'wrappedKeys address must be 0x-prefixed EOA hex'),
      z.string().regex(/^[0-9a-fA-F]+$/, 'wrappedKeys value must be hex (no 0x prefix)').min(2).max(8192),
    )
    .refine((m) => Object.keys(m).length <= 200, { message: 'wrappedKeys cannot exceed 200 entries' })
    .optional(),
});

const verifySchema = z.object({
  passed: z.boolean(),
  reasons: z.array(z.string()).max(20).optional(),
});

// Cache the on-chain feeBps for the duration of the process. Fee changes are
// admin-gated and rare; one stale read per restart is fine. Falls back to 1500
// (15%) — the documented default in CLAUDE.md — if the RPC is unreachable.
let cachedFeeBps: number | null = null;
async function getFeeBps(): Promise<number> {
  if (cachedFeeBps !== null) return cachedFeeBps;
  try {
    cachedFeeBps = await escrowService.feeBps();
  } catch (err) {
    console.warn('[a2a] feeBps RPC read failed, falling back to 1500:', (err as Error).message);
    cachedFeeBps = 1500;
  }
  return cachedFeeBps;
}

/**
 * Record a successful task completion on the executor's record: bump
 * tasksCompleted, reputation, and totalEarnedRaw by the worker's share of the
 * escrow (amount minus platform fee). Idempotent at the route level — only
 * called from auto-/verify success branches, each of which checks state isn't
 * already 'verified' before transitioning.
 *
 * Persists to Redis (agentStore) so the /agents endpoint can surface these
 * stats to the UI without re-deriving from on-chain history. If anything in
 * here fails we log + continue: settleVerification still fires and the worker
 * still gets paid on chain — only the UI counter is at risk.
 */
async function recordWorkerPayout(taskHash: string, executorAddr: string): Promise<void> {
  try {
    const agent = await agentStore.getAgent(executorAddr);
    if (!agent) return;
    agent.tasksCompleted += 1;
    agent.reputation = Math.min(100, agent.reputation + 1);

    const onChainId = await getTaskIdByHash(taskHash);
    if (onChainId) {
      const task = await escrowService.getTask(Number(onChainId));
      const feeBps = await getFeeBps();
      const workerShare = (task.amount * (10_000n - BigInt(feeBps))) / 10_000n;
      const platformFee = task.amount - workerShare;
      const prev = BigInt(agent.totalEarnedRaw ?? '0');
      agent.totalEarnedRaw = (prev + workerShare).toString();

      // Mirror the payout into the accounting ledger so the Earnings page can
      // surface it. Native 0G has 18 decimals.
      try {
        accountingService.recordTransaction({
          address: executorAddr.toLowerCase(),
          role: 'worker',
          taskId: onChainId,
          type: 'payment',
          amount: Number(workerShare) / 1e18,
          fee: Number(platformFee) / 1e18,
          status: 'confirmed',
        });
      } catch (acctErr) {
        console.warn(`[a2a] accounting recordTransaction failed for ${taskHash.slice(0, 10)}…:`, (acctErr as Error).message);
      }
    } else {
      console.warn(`[a2a] recordWorkerPayout: hash ${taskHash.slice(0, 10)}… not indexed yet; tasksCompleted bumped but totalEarnedRaw untouched`);
    }
    await agentStore.registerAgent(agent);

    // Update the off-chain decay-based reputation (SQLite) — mirrors the
    // reputationDecay.recordTaskCompletion call in the traditional
    // submissions.ts /verify route. Without this, the A2A path never
    // populates the /reputation/ leaderboard or the decayed score that
    // /agents and /agents/:id return.
    try {
      reputationDecay.recordTaskCompletion(executorAddr, taskHash, 10);
    } catch (decayErr) {
      console.warn(`[a2a] recordWorkerPayout: reputationDecay.recordTaskCompletion failed for ${taskHash.slice(0, 10)}…:`, (decayErr as Error).message);
    }
  } catch (err) {
    console.error(`[a2a] recordWorkerPayout failed for ${taskHash.slice(0, 10)}… executor=${executorAddr}:`, (err as Error).message);
  }
}

// POST /tasks/:id/wrap-to — poster pushes ECIES-wrapped AES slices to new
// bidders that registered after the task was posted. Address keys are EOA
// 0x-prefixed; values are the same hex wrapped-blob format used at task
// creation (no 0x prefix). Bounded so a buggy client can't dump megabytes.
const wrapToSchema = z.object({
  wrappedKeys: z
    .record(
      z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'wrappedKeys address must be 0x-prefixed EOA hex'),
      z.string().regex(/^[0-9a-fA-F]+$/, 'wrappedKeys value must be hex (no 0x prefix)').min(2).max(8192),
    )
    .refine((m) => Object.keys(m).length > 0 && Object.keys(m).length <= 50, {
      message: 'wrap-to batch must include 1..50 entries',
    }),
});

/**
 * POST /api/v1/a2a/register
 * Register as an agent executor.
 */
a2aRouter.post('/register', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const data = registerSchema.parse(req.body);
    const address = req.user!.address;

    const existing = await agentStore.getAgent(address);

    await agentStore.registerAgent({
      address,
      displayName: data.displayName,
      capabilities: data.capabilities as AgentCapability[],
      // Preserve any prior pubkey on a re-register that omits it (back-compat
      // path: old workers still call /register without the field). New workers
      // always send it; this fall-through keeps the encrypted-task pipeline
      // working across rolling worker restarts.
      publicKey: data.publicKey ?? existing?.publicKey,
      agentCardUrl: data.agentCardUrl,
      mcpEndpointUrl: data.mcpEndpointUrl,
      reputation: existing?.reputation ?? 50, // start at 50
      tasksCompleted: existing?.tasksCompleted ?? 0,
      registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    });

    const body: ApiResponse = {
      success: true,
      data: { agent: await agentStore.getAgent(address) },
    };
    res.status(existing ? 200 : 201).json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/a2a/executors
 * List registered A2A executors, optionally filtered by capability (ANY-match).
 *
 * Public — the executor set is not sensitive (you can see them all by polling
 * /a2a/tasks accepts anyway). Used by the frontend at task-creation time to
 * discover which pubkeys to ECIES-wrap the AES key to so each eligible
 * executor can decrypt the brief.
 *
 * Response shape is intentionally narrow: only fields the wrap step needs.
 */
a2aRouter.get('/executors', async (req, res, next) => {
  try {
    const caps = req.query.capabilities
      ? (req.query.capabilities as string).split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    const executors = await agentStore.listAgents(caps);

    const body: ApiResponse = {
      success: true,
      data: {
        executors: executors
          // Only include executors that registered a pubkey — without one, the
          // poster has no way to wrap the AES key to them, so listing them
          // would silently include unreachable workers in the bundle.
          .filter((e) => !!e.publicKey)
          .map((e) => ({
            address: e.address,
            publicKey: e.publicKey,
            capabilities: e.capabilities,
            reputation: e.reputation,
          })),
      },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/a2a/tasks
 * Browse agent-targeted tasks (filter by capabilities, minReputation).
 */
a2aRouter.get('/tasks', async (req, res, next) => {
  try {
    const caps = req.query.capabilities
      ? (req.query.capabilities as string).split(',').filter(Boolean) as AgentCapability[]
      : undefined;
    const minRep = req.query.minReputation ? parseInt(req.query.minReputation as string) : undefined;

    const tasks = await a2aStore.browseAgentTasks(caps, minRep);

    const body: ApiResponse = {
      success: true,
      data: { tasks, total: tasks.length },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/a2a/tasks/:id/accept
 * Accept a task (capability match + reputation gate).
 */
a2aRouter.post('/tasks/:id/accept', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskId = req.params.id as string;
    const address = req.user!.address;
    console.log(`[a2a] POST /accept: taskId=${taskId}, executor=${address}`);

    const meta = await a2aStore.getMeta(taskId);
    if (!meta) {
      console.warn(`[a2a] accept: task meta not found for ${taskId}`);
      throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');
    }

    // Check agent is registered + capability match BEFORE the CAS, so we don't
    // burn the open→accepted transition on a caller who'd be 403'd anyway.
    const agent = await agentStore.getAgent(address);
    if (!agent) {
      console.warn(`[a2a] accept: agent not registered: ${address}`);
      throw new AppError(403, 'NOT_REGISTERED', 'Register as an agent executor first');
    }
    if (meta.requiredCapabilities.length > 0) {
      // Match the PostTask UI copy: "an executor agent matches if it has any one".
      // Tasks usually list multiple caps as hints, not strict requirements — a
      // worker with summarization can take a task tagged web_research+summarization
      // even if it doesn't claim web_research.
      const hasAny = meta.requiredCapabilities.some((c) => agent.capabilities.includes(c));
      if (!hasAny) {
        console.warn(`[a2a] accept: capability mismatch for ${taskId}: agent has [${agent.capabilities.join(',')}], needs one of [${meta.requiredCapabilities.join(',')}]`);
        throw new AppError(
          403,
          'CAPABILITY_MISMATCH',
          `Need at least one of: ${meta.requiredCapabilities.join(', ')}`,
        );
      }
    }

    // NEEDS_WRAP gate — refuse BEFORE the CAS so the open→accepted transition
    // isn't burned on a caller who can't actually decrypt the brief. The
    // poster's frontend will see this agent's bid (if it bid first) and wrap
    // the AES key to it; once meta.wrappedKeys[addr] is populated, the next
    // accept attempt sails through. Skipping this check for tasks without a
    // rootHash (legacy / unencrypted) keeps the back-compat path open.
    if (meta.rootHash && !meta.wrappedKeys?.[address.toLowerCase()]) {
      console.log(`[a2a] accept: needs wrap for ${taskId}, agent=${address}`);
      throw new AppError(
        403,
        'NEEDS_WRAP',
        'Task brief is not yet wrapped to your pubkey — POST /a2a/tasks/:id/bid to register intent; the poster will wrap on their next polling cycle.',
      );
    }

    // Atomic open→accepted via a Lua CAS. Two concurrent /accept requests can
    // both pass an open-state read, so we serialise the transition itself on
    // the Redis server. Loser gets 409, no on-chain side effect — preserves
    // the invariant that the executor in Redis matches the one in the bridge
    // tx (and thereby the on-chain t.worker).
    const accept = await a2aStore.tryAccept(taskId, address, new Date().toISOString());
    if (!accept.ok) {
      console.warn(`[a2a] accept: CAS lost for ${taskId}, currentStatus=${accept.currentStatus}`);
      throw new AppError(
        409,
        'NOT_OPEN',
        `Task is not open for acceptance (status: ${accept.currentStatus})`,
      );
    }

    // Fire-and-forget on-chain settlement: backend marketplace signer calls
    // marketplaceAssign(taskId, executor) so the contract knows who to pay.
    // We deliberately don't await — the HTTP response returns immediately
    // and the bridge logs its own progress. State update inside the bridge
    // persists the tx hash to a2aStore so clients can poll for confirmation.
    console.log(`[a2a] accept: transition OK for ${taskId}, triggering bridge assignment`);
    void settleAssignment(taskId, address);

    // Encrypted-brief slice: return the caller's wrappedKey + rootHash so the
    // worker can download from 0G Storage and AES-decrypt. The wrappedKey
    // lookup is by lowercased address; posters wrapped to lowercased keys at
    // task creation time. Both fields may be absent on legacy tasks created
    // before the encrypted-flow shipped — the worker treats that as "no brief
    // available, log and skip" rather than crashing.
    const wrappedKey = meta.wrappedKeys?.[address.toLowerCase()];
    const body: ApiResponse = {
      success: true,
      data: {
        taskId,
        status: 'accepted',
        rootHash: meta.rootHash,
        wrappedKey,
      },
    };
    res.json(body);
  } catch (err) {
    console.error(`[a2a] accept failed for ${req.params.id}:`, (err as Error).message);
    next(err);
  }
});

/**
 * POST /api/v1/a2a/tasks/:id/bid
 *
 * An executor registers intent to take a task whose brief hasn't been wrapped
 * to them yet (e.g. they registered after the task was posted). Idempotent —
 * re-bidding from the same address just refreshes the bidAt timestamp.
 *
 * Capability gate matches /accept (ANY-of). Bids on tasks the agent couldn't
 * accept anyway are rejected at intent time so the poster's wrap step doesn't
 * burn cycles wrapping to executors who can't legally accept.
 */
a2aRouter.post('/tasks/:id/bid', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskId = req.params.id as string;
    const address = req.user!.address;

    const meta = await a2aStore.getMeta(taskId);
    if (!meta) throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');

    const agent = await agentStore.getAgent(address);
    if (!agent) {
      throw new AppError(403, 'NOT_REGISTERED', 'Register as an agent executor first');
    }
    if (!agent.publicKey) {
      throw new AppError(
        400,
        'NO_PUBKEY',
        'Your executor registration has no publicKey — re-register so posters can wrap to you',
      );
    }
    if (meta.requiredCapabilities.length > 0) {
      const hasAny = meta.requiredCapabilities.some((c) => agent.capabilities.includes(c));
      if (!hasAny) {
        throw new AppError(
          403,
          'CAPABILITY_MISMATCH',
          `Need at least one of: ${meta.requiredCapabilities.join(', ')}`,
        );
      }
    }

    // If we already have a wrap for this address, the bid is moot — let the
    // caller try /accept directly instead of round-tripping via the poster.
    if (meta.wrappedKeys?.[address.toLowerCase()]) {
      const body: ApiResponse = {
        success: true,
        data: { taskId, status: 'already_wrapped' },
      };
      res.json(body);
      return;
    }

    await bidsStore.addBid(taskId, {
      address: address.toLowerCase(),
      publicKey: agent.publicKey,
      capabilities: agent.capabilities,
      bidAt: new Date().toISOString(),
    });

    const body: ApiResponse = {
      success: true,
      data: { taskId, status: 'bid_received' },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/a2a/tasks/:id/bids
 *
 * Poster reads pending bids on their own task. Returns the bid set plus the
 * set of addresses already wrapped, so the frontend can compute the delta
 * (bidders missing a wrapped key) without a second round-trip.
 *
 * Gated to the poster — the bid list isn't sensitive but it's not useful to
 * anyone else, and gating keeps it out of the public discovery surface.
 */
a2aRouter.get('/tasks/:id/bids', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskId = req.params.id as string;
    const address = req.user!.address;

    const meta = await a2aStore.getMeta(taskId);
    if (!meta) throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');
    if (!meta.posterAddress || meta.posterAddress.toLowerCase() !== address.toLowerCase()) {
      throw new AppError(403, 'NOT_POSTER', 'Only the task poster can read its bid list');
    }

    const bids = await bidsStore.listBids(taskId);
    const wrapped = Object.keys(meta.wrappedKeys ?? {});

    const body: ApiResponse = {
      success: true,
      data: { taskId, bids, wrapped },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/a2a/tasks/:id/wrap-to
 *
 * Poster pushes ECIES-wrapped AES slices to bidders that registered after
 * the task was posted. The AES key never leaves the poster's runtime in
 * plaintext — the backend only ever sees opaque hex blobs.
 *
 * Merges into meta.wrappedKeys (existing slices preserved). Drops the bid
 * records for addresses that got wrapped so the next /bids poll only
 * surfaces still-pending bidders.
 */
a2aRouter.post('/tasks/:id/wrap-to', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskId = req.params.id as string;
    const address = req.user!.address;
    const data = wrapToSchema.parse(req.body);

    const meta = await a2aStore.getMeta(taskId);
    if (!meta) throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');
    if (!meta.posterAddress || meta.posterAddress.toLowerCase() !== address.toLowerCase()) {
      throw new AppError(403, 'NOT_POSTER', 'Only the task poster can wrap new slices');
    }

    const updated = await a2aStore.mergeWrappedKeys(taskId, data.wrappedKeys);
    if (!updated) throw new AppError(404, 'NOT_FOUND', 'Task meta vanished mid-update');

    // Stale bid records are harmless — the wrap is what actually unlocks
    // /accept. /bids returns `wrapped[]` alongside `bids[]` so the frontend
    // can filter without a server-side cleanup.

    const body: ApiResponse = {
      success: true,
      data: {
        taskId,
        totalWrapped: Object.keys(updated.wrappedKeys ?? {}).length,
        added: Object.keys(data.wrappedKeys).length,
      },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/a2a/tasks/index
 *
 * Verified A2A meta write. The poster's frontend calls this AFTER the
 * createTask tx has confirmed on chain. We re-fetch the receipt server-side,
 * parse the TaskCreated event, and assert:
 *
 *   - tx confirmed with status=1
 *   - exactly one TaskCreated log emitted from the escrow address
 *   - log.taskHash === claimed taskHash
 *   - log.agent === authenticated caller
 *
 * Only then do we write meta + eagerly populate the hash2id / id2hash
 * mappings so /submit doesn't have to wait for the forward-only indexer to
 * catch up. Idempotent — re-calling with the same txHash is a no-op-ish
 * merge so a network blip mid-deploy can't strand a task.
 */
a2aRouter.post('/tasks/index', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const data = indexTaskSchema.parse(req.body);
    const address = req.user!.address;
    const taskHash = data.taskHash.toLowerCase();

    const receipt = await provider.getTransactionReceipt(data.txHash);
    if (!receipt) {
      throw new AppError(
        404,
        'RECEIPT_NOT_FOUND',
        'Transaction receipt not yet visible to RPC — wait a couple of blocks and retry',
      );
    }
    if (receipt.status !== 1) {
      throw new AppError(
        409,
        'TX_REVERTED',
        `createTask tx reverted (status=${receipt.status}) — nothing to index`,
      );
    }

    // Parse logs from the configured escrow address only. We don't trust a
    // receipt that originated from some other contract — a malicious poster
    // could otherwise pass a tx hash from a different escrow with a colliding
    // taskHash.
    const escrowAddress = (await escrow.getAddress()).toLowerCase();
    const taskCreatedTopic = ethers.id(
      'TaskCreated(uint256,address,address,uint256,bytes32,string,string,uint256)',
    );
    const matching = receipt.logs.filter(
      (l) => l.address.toLowerCase() === escrowAddress && l.topics[0] === taskCreatedTopic,
    );
    if (matching.length === 0) {
      throw new AppError(
        409,
        'NO_TASK_CREATED',
        'Receipt contains no TaskCreated event from the configured BlindEscrow address',
      );
    }
    if (matching.length > 1) {
      throw new AppError(
        409,
        'MULTIPLE_TASK_CREATED',
        'Receipt contains multiple TaskCreated events — ambiguous index target',
      );
    }
    const parsed = escrow.interface.parseLog({
      topics: matching[0].topics as string[],
      data: matching[0].data,
    });
    if (!parsed) {
      throw new AppError(500, 'PARSE_FAILED', 'Failed to decode TaskCreated log');
    }
    const onChainTaskId = (parsed.args.taskId as bigint).toString();
    const onChainTaskHash = (parsed.args.taskHash as string).toLowerCase();
    const onChainAgent = (parsed.args.agent as string).toLowerCase();

    if (onChainTaskHash !== taskHash) {
      throw new AppError(
        409,
        'HASH_MISMATCH',
        `Claimed taskHash (${taskHash.slice(0, 10)}…) does not match on-chain TaskCreated.taskHash (${onChainTaskHash.slice(0, 10)}…)`,
      );
    }
    if (onChainAgent !== address.toLowerCase()) {
      throw new AppError(
        403,
        'NOT_TASK_AGENT',
        'Authenticated caller is not the on-chain agent (creator) for this task',
      );
    }

    // All checks passed — eagerly seed the indexer mapping so /submit
    // resolves the hash immediately without waiting for the forward-only
    // event poller to catch up.
    await Promise.all([
      redis.set(`a2a:hash2id:${taskHash}`, onChainTaskId),
      redis.set(`a2a:id2hash:${onChainTaskId}`, taskHash),
    ]);

    const wrappedKeysNormalized = data.wrappedKeys
      ? Object.fromEntries(
          Object.entries(data.wrappedKeys).map(([addr, blob]) => [addr.toLowerCase(), blob]),
        )
      : undefined;

    await a2aStore.setMeta({
      taskId: taskHash,
      targetExecutorType: 'agent',
      verificationMode: data.verificationMode ?? 'manual',
      verificationCriteria: data.verificationCriteria,
      requiredCapabilities: (data.requiredCapabilities ?? []) as AgentCapability[],
      posterAddress: address,
      rootHash: data.rootHash,
      wrappedKeys: wrappedKeysNormalized,
    });

    console.log(
      `[a2a] indexed taskHash=${taskHash.slice(0, 10)}… → onChainId=${onChainTaskId} poster=${address}`,
    );

    const body: ApiResponse = {
      success: true,
      data: { taskHash, onChainTaskId, indexed: true },
    };
    res.json(body);
  } catch (err) {
    console.error(`[a2a] index failed:`, (err as Error).message);
    next(err);
  }
});

/**
 * POST /api/v1/a2a/tasks/:id/submit
 *
 * Records the executor's resultData and returns an unsigned submitEvidence
 * transaction. The executor signs and broadcasts it with their own wallet
 * (this is what the BlindEscrow contract enforces: submitEvidence is
 * `onlyWorker`). After confirmation, the executor calls /finalize so the
 * backend can run autoVerify (or wait for poster manual approval, depending
 * on verificationMode).
 *
 * Separation of submit and finalize is the only way to reconcile the
 * on-chain constraint (Assigned → Submitted only via a worker-signed call)
 * with the auto-verify bridge (which needs Submitted state before it can
 * fire completeVerification).
 */
a2aRouter.post('/tasks/:id/submit', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskHash = req.params.id as string;
    const address = req.user!.address;
    const { resultData } = submitSchema.parse(req.body);
    console.log(`[a2a] POST /submit: taskHash=${taskHash}, executor=${address}`);

    const meta = await a2aStore.getMeta(taskHash);
    if (!meta) {
      console.warn(`[a2a] submit: task meta not found for ${taskHash}`);
      throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');
    }

    const state = await a2aStore.getState(taskHash);
    if (!state || state.executorAddress?.toLowerCase() !== address.toLowerCase()) {
      console.warn(`[a2a] submit: forbidden for ${taskHash}: executor in state is ${state?.executorAddress}, caller is ${address}`);
      throw new AppError(403, 'FORBIDDEN', 'Only the accepted executor can submit');
    }
    if (state.status !== 'accepted' && state.status !== 'in_progress') {
      console.warn(`[a2a] submit: invalid state for ${taskHash}: ${state.status}`);
      throw new AppError(409, 'INVALID_STATE', `Cannot submit in state: ${state.status}`);
    }

    // Look up the on-chain taskId via the TaskCreated event mapping. Without
    // it we can't build the submitEvidence tx. The mapping is populated by
    // services/escrowEvents.ts within ~30s of createTask confirming on chain.
    const onChainId = await getTaskIdByHash(taskHash);
    if (!onChainId) {
      console.warn(`[a2a] submit: hash2id not indexed yet for ${taskHash}`);
      throw new AppError(
        503,
        'NOT_INDEXED',
        'On-chain taskId not yet indexed — wait a few seconds after task creation and retry',
      );
    }

    // Short-circuit: if settleAssignment already failed (signer revert, RPC
    // outage, lookup timeout), no amount of polling here will make
    // task.worker move. Return a terminal BRIDGE_FAILED so the worker stops
    // retrying and releases the task back to open — letting another /accept
    // re-fire settleAssignment fresh.
    if (state.assignError) {
      console.warn(
        `[a2a] submit: bridge previously failed for ${taskHash} — assignError=${state.assignError}`,
      );
      throw new AppError(
        503,
        'BRIDGE_FAILED',
        `Assignment bridge failed — ${state.assignError}. Release and retry.`,
      );
    }

    // Wait briefly for the on-chain assignment to confirm before issuing the
    // unsigned submitEvidence. /accept fires settleAssignment fire-and-forget,
    // so task.worker can still be 0x0 here even though our A2A state moved to
    // 'accepted'. Broadcasting submitEvidence in that window reverts with
    // NotWorker() — wastes gas, no recovery on the worker side. Return 503 so
    // the worker's existing 503-retry loop handles the wait.
    const ASSIGNMENT_WAIT_DEADLINE_MS = 20_000;
    const ASSIGNMENT_POLL_INTERVAL_MS = 2_000;
    const assignDeadline = Date.now() + ASSIGNMENT_WAIT_DEADLINE_MS;
    let onChainWorker = '';
    while (true) {
      const onChainTask = await escrowService.getTask(Number(onChainId));
      onChainWorker = onChainTask.worker;
      if (onChainWorker.toLowerCase() === address.toLowerCase()) break;
      // Re-check for a freshly-surfaced bridge error inside the poll loop —
      // settleAssignment may have started concurrently with the worker's
      // /submit-result and only just failed.
      const freshState = await a2aStore.getState(taskHash);
      if (freshState?.assignError) {
        throw new AppError(
          503,
          'BRIDGE_FAILED',
          `Assignment bridge failed mid-poll — ${freshState.assignError}. Release and retry.`,
        );
      }
      if (Date.now() >= assignDeadline) {
        console.warn(
          `[a2a] submit: on-chain assignment not confirmed for ${taskHash} after ${ASSIGNMENT_WAIT_DEADLINE_MS}ms (task.worker=${onChainWorker}, caller=${address})`,
        );
        throw new AppError(
          503,
          'NOT_ASSIGNED_YET',
          `On-chain assignment not yet confirmed — task.worker=${onChainWorker}, caller=${address}. Retry shortly.`,
        );
      }
      await new Promise((r) => setTimeout(r, ASSIGNMENT_POLL_INTERVAL_MS));
    }

    // Deterministic evidence hash = keccak256(JSON.stringify(resultData)).
    // The contract stores this bytes32 and it acts as the commitment for the
    // off-chain payload the verifier will evaluate.
    const evidenceHash = ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify(resultData)),
    );

    const unsignedSubmitEvidence = await escrowService.buildSubmitEvidence(
      address,
      Number(onChainId),
      evidenceHash,
    );

    await a2aStore.updateState(taskHash, {
      status: 'submitted',
      resultData,
      submittedAt: new Date().toISOString(),
    });
    console.log(`[a2a] submit: resultData stored and unsignedSubmitEvidence built for ${taskHash}`);

    const body: ApiResponse = {
      success: true,
      data: {
        taskId: taskHash,
        onChainTaskId: onChainId,
        status: 'submitted',
        evidenceHash,
        unsignedSubmitEvidence,
      },
    };
    res.json(body);
  } catch (err) {
    console.error(`[a2a] submit failed for ${req.params.id}:`, (err as Error).message);
    next(err);
  }
});

/**
 * POST /api/v1/a2a/tasks/:id/release
 *
 * Reverts an accepted/submitted task back to 'open' so it shows up on the
 * agent board again. Used when the accepted executor failed to broadcast
 * submitEvidence (e.g. assignment race, RPC error, agent crash) — without
 * this the task is stranded in Redis state while on-chain it's still Funded
 * with no worker, so the poster's view shows OPEN/NO WORKER YET but no agent
 * can pick it up.
 *
 * Authorized for the current executor (the one who accepted) or the poster
 * (who has standing to rescue their own task). Refuses if the on-chain task
 * has progressed past Funded — in that case a worker really is on-chain
 * and releasing in A2A state would lose alignment with the contract.
 */
a2aRouter.post('/tasks/:id/release', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskHash = req.params.id as string;
    const address = req.user!.address;

    const meta = await a2aStore.getMeta(taskHash);
    if (!meta) throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');

    const state = await a2aStore.getState(taskHash);
    if (!state) throw new AppError(404, 'NOT_FOUND', 'Task state missing');

    const isExecutor = state.executorAddress?.toLowerCase() === address.toLowerCase();
    const isPoster = meta.posterAddress?.toLowerCase() === address.toLowerCase();
    if (!isExecutor && !isPoster) {
      throw new AppError(403, 'FORBIDDEN', 'Only the executor or poster can release a task');
    }

    if (state.status === 'open') {
      const body: ApiResponse = { success: true, data: { taskId: taskHash, status: 'open', noop: true } };
      res.json(body);
      return;
    }
    if (state.status !== 'accepted' && state.status !== 'in_progress' && state.status !== 'submitted') {
      throw new AppError(409, 'INVALID_STATE', `Cannot release in state: ${state.status}`);
    }

    // Don't release if on-chain has progressed past Funded — a worker is
    // actually assigned (or the task is past assignment) and only they can
    // legally drive it forward. Releasing in A2A here would let a second
    // agent /accept, fire a duplicate marketplaceAssign, and either revert
    // or — worse — leave Redis pointing at the new accepter while the chain
    // still credits the original.
    //
    // If we can't reach the chain to check, refuse with 503 rather than
    // guess. The worker's release path retries 503s; a curl rescue will
    // also retry. Better stranded for an extra minute than desynced.
    const onChainId = await getTaskIdByHash(taskHash);
    if (onChainId) {
      let onChainStatus: number;
      try {
        const onChainTask = await escrowService.getTask(Number(onChainId));
        onChainStatus = onChainTask.status;
      } catch (err) {
        throw new AppError(
          503,
          'ON_CHAIN_CHECK_FAILED',
          `Could not verify on-chain task status before release: ${(err as Error).message}`,
        );
      }
      if (onChainStatus !== 0) {
        throw new AppError(
          409,
          'ON_CHAIN_LOCKED',
          `Task is on-chain status ${onChainStatus} (not Funded) — cannot release`,
        );
      }
    }

    await a2aStore.releaseToOpen(taskHash);
    console.log(`[a2a] release: ${taskHash} reverted to open by ${address}`);

    const body: ApiResponse = {
      success: true,
      data: { taskId: taskHash, status: 'open' },
    };
    res.json(body);
  } catch (err) {
    console.error(`[a2a] release failed for ${req.params.id}:`, (err as Error).message);
    next(err);
  }
});

/**
 * POST /api/v1/a2a/tasks/:id/finalize
 *
 * Called by the executor after their submitEvidence tx confirms on chain.
 * For verificationMode=auto: runs autoVerify and fires settleVerification.
 * For verificationMode=manual: returns immediately, leaving state='submitted'
 * for the poster to approve via the /verify endpoint.
 *
 * This split exists because completeVerification (called by settleVerification)
 * requires on-chain status=Submitted, which only happens after the executor
 * personally signs submitEvidence. Finalize is the "OK I've signed it, please
 * proceed with verification" signal.
 */
a2aRouter.post('/tasks/:id/finalize', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskHash = req.params.id as string;
    const address = req.user!.address;

    const meta = await a2aStore.getMeta(taskHash);
    if (!meta) throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');

    const state = await a2aStore.getState(taskHash);
    if (!state || state.executorAddress?.toLowerCase() !== address.toLowerCase()) {
      throw new AppError(403, 'FORBIDDEN', 'Only the recorded executor can finalize');
    }
    if (state.status !== 'submitted') {
      throw new AppError(409, 'INVALID_STATE', `Cannot finalize in state: ${state.status}`);
    }
    if (!state.resultData) {
      throw new AppError(400, 'NO_RESULT_DATA', 'No resultData recorded for this task');
    }

    // Manual mode: leave state='submitted' and let the poster decide via
    // the /verify endpoint. No on-chain action from the bridge here.
    if (meta.verificationMode !== 'auto' || !meta.verificationCriteria) {
      const body: ApiResponse = {
        success: true,
        data: { taskId: taskHash, status: 'submitted', awaitingPosterApproval: true },
      };
      res.json(body);
      return;
    }

    // Auto mode: run criteria check now that we know submitEvidence is on chain.
    const verificationResult = autoVerify(state.resultData, meta.verificationCriteria);
    const newStatus: 'verified' | 'failed' = verificationResult.passed ? 'verified' : 'failed';

    await a2aStore.updateState(taskHash, {
      status: newStatus,
      verificationResult,
    });

    if (verificationResult.passed) {
      await recordWorkerPayout(taskHash, address);
    }

    // Fire-and-forget bridge call: marketplace signer calls completeVerification
    // on chain. Since submitEvidence already confirmed (executor wouldn't have
    // called /finalize otherwise), the contract status is now Submitted — the
    // bridge call should succeed.
    void settleVerification(taskHash, verificationResult.passed);

    const body: ApiResponse = {
      success: true,
      data: { taskId: taskHash, status: newStatus, verificationResult },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/a2a/tasks/:id/verify
 *
 * Poster-only manual approval. Records the verdict in a2aStore and fires the
 * settlement bridge so the marketplace signer can call completeVerification
 * on chain. Only valid for verificationMode=manual tasks in state=submitted.
 *
 * Authorization: req.user.address must match the task's recorded poster
 * (meta.posterAddress, captured at task creation). We deliberately don't fall
 * back to reading t.agent from the on-chain task — meta.posterAddress is the
 * authenticated address that called POST /tasks, which is the right answer
 * even if for some reason on-chain and off-chain identities diverge.
 */
a2aRouter.post('/tasks/:id/verify', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskHash = req.params.id as string;
    const address = req.user!.address;
    const { passed, reasons } = verifySchema.parse(req.body);

    const meta = await a2aStore.getMeta(taskHash);
    if (!meta) throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');

    if (!meta.posterAddress || meta.posterAddress.toLowerCase() !== address.toLowerCase()) {
      throw new AppError(403, 'NOT_POSTER', 'Only the task poster can manually verify');
    }
    if (meta.verificationMode !== 'manual') {
      throw new AppError(409, 'WRONG_MODE', 'Task is not in manual-verify mode');
    }

    const state = await a2aStore.getState(taskHash);
    if (!state || state.status !== 'submitted') {
      throw new AppError(409, 'INVALID_STATE', `Cannot verify in state: ${state?.status ?? 'missing'}`);
    }

    const verificationResult = { passed, reasons: reasons ?? [] };
    const newStatus: 'verified' | 'failed' = passed ? 'verified' : 'failed';

    await a2aStore.updateState(taskHash, {
      status: newStatus,
      verificationResult,
    });

    if (passed && state.executorAddress) {
      await recordWorkerPayout(taskHash, state.executorAddress);
    }

    // Bridge: marketplace signer calls completeVerification on chain. Assumes
    // submitEvidence already confirmed (the executor called /finalize earlier,
    // which only succeeds if state=submitted, which only happens after they
    // sign submitEvidence — manual mode just deferred verification, not the
    // on-chain submission).
    void settleVerification(taskHash, passed);

    const body: ApiResponse = {
      success: true,
      data: { taskId: taskHash, status: newStatus, verificationResult },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/a2a/tasks/posted
 *
 * Returns every A2A task posted by the authenticated address, across the
 * full lifecycle (open → accepted → submitted → verified/failed). Each entry
 * is enriched with the on-chain task record (status, reward, deadline) so the
 * frontend has everything it needs in one round-trip — `state.resultData` for
 * the inline result viewer, plus the on-chain status for the lifecycle chip.
 *
 * This is the right data source for `/tasks/mine`: the bare on-chain
 * `/api/v1/tasks` endpoint returns only Funded tasks (per
 * `registry.getOpenTasks`), so completed work would otherwise vanish from the
 * poster's inbox the moment it settled. Reading off Redis here gives us the
 * full audit trail.
 */
a2aRouter.get('/tasks/posted', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const address = req.user!.address;
    const tasks = await a2aStore.getPosterTasks(address);

    // Enrich each task with its on-chain record so the UI doesn't need a
    // second per-task fetch. Wrapped in try/catch per task — a missing
    // on-chain task (e.g. createTask never confirmed) shouldn't blank out
    // the entire list. Sequential because a typical user has <50 posts;
    // if this grows, batch via Multicall.
    const enriched = await Promise.all(
      tasks.map(async (t) => {
        try {
          const onChainId = await getTaskIdByHash(t.meta.taskId);
          if (!onChainId) return { ...t, onChain: null };
          const onChainTask = await escrowService.getTask(Number(onChainId));
          return {
            ...t,
            onChain: {
              taskId: onChainId.toString(),
              status: onChainTask.status,
              reward: onChainTask.amount.toString(),
              token: onChainTask.token,
              worker: onChainTask.worker,
              createdAt: onChainTask.createdAt.toString(),
              deadline: onChainTask.deadline.toString(),
            },
          };
        } catch {
          // Indexer hasn't caught up, or createTask reverted — return the
          // Redis-only view so the user at least sees the task exists.
          return { ...t, onChain: null };
        }
      }),
    );

    const body: ApiResponse = {
      success: true,
      data: { tasks: enriched, total: enriched.length },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/a2a/executions
 *
 * Default: list the authed caller's accepted/completed tasks (executor view).
 * Pass `?address=0x…` to list a specific executor's history — used by the
 * agent-detail dashboard, where the viewer is the owner EOA but the executor
 * record lives on the agent's separate wallet address. The list is essentially
 * public (all task state is on chain anyway), so we don't gate by ownership.
 */
a2aRouter.get('/executions', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const queryAddr = (req.query.address as string | undefined)?.trim();
    if (queryAddr && !/^0x[0-9a-fA-F]{40}$/.test(queryAddr)) {
      throw new AppError(400, 'BAD_ADDRESS', 'address must be a 0x-prefixed 40-char hex string');
    }
    const address = queryAddr ?? req.user!.address;
    const tasks = await a2aStore.getExecutorTasks(address);

    const body: ApiResponse = {
      success: true,
      data: { executions: tasks, total: tasks.length },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/a2a/profile
 * Get my agent profile with decayed reputation.
 */
a2aRouter.get('/profile', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const address = req.user!.address;
    const agent = await agentStore.getAgent(address);

    if (!agent) {
      throw new AppError(404, 'NOT_REGISTERED', 'Agent not registered');
    }

    const body: ApiResponse = {
      success: true,
      data: { agent, reputation: reputationDecay.getDecayedReputation(address) },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
