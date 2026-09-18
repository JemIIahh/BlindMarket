import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { createUserRateLimiter } from '../middleware/rateLimit.js';
import { AppError } from '../middleware/errorHandler.js';
import * as agentStore from '../services/agentStore.js';
import * as a2aStore from '../services/a2aStore.js';
import { loadAgentBySmartAccount } from '../services/deployedAgentStore.js';
import * as bidsStore from '../services/bidsStore.js';
import * as keyCustody from '../services/keyCustodyService.js';
import { autoVerify } from '../services/autoVerify.js';
import { settleAssignment, settleVerification, resolveAssignee } from '../services/a2aSettlement.js';
import { recordWorkerPayout, recordWorkerDispute } from '../services/workerPayout.js';
import { notifyLifecycle } from '../services/notificationStore.js';
import { resolveTaskByHash, seedTaskId, type TaskChain } from '../services/taskChain.js';
import * as escrowService from '../services/escrow.js';
import * as reputationService from '../services/reputation.js';
import * as reputationDecay from '../services/reputationDecay.js';
import * as agentEmbedding from '../services/agentEmbedding.js';
import * as semanticMatch from '../services/semanticMatch.js';
import { demandFeed, MAX_DEMAND_LIMIT } from '../services/demandFeed.js';
import { provider, escrow, baseProvider, baseEscrow } from '../services/chain.js';
import { ethers } from 'ethers';
import type { AuthRequest, ApiResponse, AgentCapability } from '../types.js';
import { AGENT_CAPABILITIES } from '../types.js';
import { rankAgents, pickExplorationAgent } from '../services/agentScorer.js';
import { emitTaskOffer, emitTaskAvailable } from '../services/socket.js';
import { EXPIRY_GRACE_SEC } from '../constants.js';
import { config } from '../config.js';
import * as serviceStore from '../services/serviceStore.js';
import { consumePendingCost } from '../services/railwaySandbox.js';
import * as accountingService from '../services/accountingService.js';
import { normalizeSettlementAmount } from '../services/settlementUnits.js';

export const a2aRouter = Router();

// --- Schemas ---

const registerSchema = z.object({
  displayName: z.string().min(1).max(100),
  capabilities: z.array(z.enum(AGENT_CAPABILITIES as unknown as [string, ...string[]])).max(20).default([]),
  // Uncompressed secp256k1 hex (130 chars, leading `04`, no 0x prefix).
  // REQUIRED. An executor without a pubkey can't be sent a wrapped AES key, so
  // it could never decrypt an encrypted brief — and every task posted from the
  // UI is encrypted. A pubkey-less executor is therefore a dead-end: it passes
  // the capability gate, gets silently dropped from the post-time wrap snapshot
  // (see GET /executors, which filters on pubkey), then spins forever on
  // 403 NEEDS_WRAP. Requiring it at registration closes that whole class of
  // stranded task. Deployed agents always have a keypair, and the worker derives
  // this value from its private key, so it can always satisfy the requirement.
  publicKey: z
    .string()
    .regex(/^04[0-9a-fA-F]{128}$/, 'publicKey must be uncompressed secp256k1 hex (130 chars, leading 04, no 0x prefix) — deployed agents derive this from their key; register again with it'),
  agentCardUrl: z.string().url().optional(),
  mcpEndpointUrl: z.string().url().optional(),
  // Minimum reward as an integer string in the payment token's smallest unit
  // (USDC: 6 decimals; old 18-decimal amounts are converted). Tasks below this threshold are
  // filtered out before scoring, so the agent never appears in the ranked list.
  minReward: z.string().regex(/^\d+$/, "minReward must be a non-negative integer string in the payment token's smallest unit").transform(normalizeSettlementAmount).optional(),
  // Preferred capabilities subset. If set, scoring overlap only counts these
  // (not the agent's full capability set). The agent must still have ALL
  // requiredCapabilities to match the task (enforced by listAgents), so this
  // only affects ranking, not eligibility.
  preferredCapabilities: z.array(z.enum(AGENT_CAPABILITIES as unknown as [string, ...string[]])).max(20).optional(),
  // Chains this executor can settle on. Workers tell the backend which chains
  // they have an RPC for so they only get offered tasks they can actually settle.
  // Default is ['0g']; include 'base' when the worker has rpcUrls.base configured.
  supportedChains: z.array(z.enum(['0g', 'base'] as [string, string])).max(2).default(['0g']),
});

const submitSchema = z.object({
  resultData: z.record(z.unknown()),
  teeAttestation: z.object({
    signature: z.string(),
    signer: z.string().optional(),
    signedText: z.string(),
    chatID: z.string().optional(),
    verified: z.boolean().optional(),
  }).nullable().optional(),
  rootHash: z.string().nullable().optional(),
});

// POST /tasks/index — verified A2A meta write. The poster's frontend calls
// this AFTER the createTask tx confirms, supplying the txHash so the backend
// can re-parse the receipt and confirm the on-chain task actually exists
// before persisting anything to Redis. Without this gate, writing meta
// speculatively in POST /tasks left phantom entries whenever a tx reverted
// (token-not-allowed, gas, etc.) and agents got stuck retrying NOT_INDEXED.
const indexTaskSchema = z.object({
  txHash: z.string().min(1).max(100), // 32-byte hex tx hash
  taskHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'taskHash must be a bytes32 hex string'),
  verificationMode: z.enum(['manual', 'auto', 'oracle', 'agent']).optional(),
  verificationCriteria: z
    .object({
      required_fields: z.array(z.string()).optional(),
      min_length: z.number().int().positive().optional(),
      contains_keywords: z.array(z.string()).optional(),
      max_length: z.number().int().positive().optional(),
      expected_answer: z.string().optional(),
      forbidden_phrases: z.array(z.string()).optional(),
      regex_pattern: z.string().max(200).optional(),
      expected_schema: z
        .object({
          type: z.string().optional(),
          required: z.array(z.string()).optional(),
          properties: z.record(z.object({ type: z.string().optional() })).optional(),
        })
        .optional(),
      rubric: z
        .array(
          z.object({
            criterion: z.string(),
            keywords: z.array(z.string()).optional(),
            min_mentions: z.number().int().positive().optional(),
            weight: z.number().positive().optional(),
          }),
        )
        .optional(),
      pass_threshold: z.number().min(0).max(100).optional(),
      acceptance: z.string().max(4000).optional(),
    })
    .optional(),
  verifierAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40,66}$/, 'verifierAddress must be a 0x-prefixed hex string')
    .optional(),
  requiredCapabilities: z
    .array(z.enum(AGENT_CAPABILITIES as unknown as [string, ...string[]]))
    .optional(),
  rootHash: z.string().min(1).max(256).optional(),
  wrappedKeys: z
    .record(
      z.string().regex(/^0x[0-9a-fA-F]{40,66}$/, 'wrappedKeys address must be 0x-prefixed hex'),
      z.string().regex(/^[0-9a-fA-F]+$/, 'wrappedKeys value must be hex (no 0x prefix)').min(2).max(8192),
    )
    .refine((m) => Object.keys(m).length <= 200, { message: 'wrappedKeys cannot exceed 200 entries' })
    .optional(),
  // Brief AES key sealed to the platform key-custody key (docs/TEE-REWRAP-SPEC.md).
  // Optional — present only when the poster fetched a key from
  // GET /a2a/key-custody/pubkey (i.e. KEY_CUSTODY_ENABLED). Enables late agents
  // to be re-wrapped on /accept with no poster present.
  keyCustodyBlob: z
    .object({
      keyId: z.string().min(1).max(64),
      blob: z
        .string()
        .regex(/^[0-9a-fA-F]+$/, 'keyCustodyBlob.blob must be hex (no 0x prefix)')
        .min(2)
        .max(8192),
    })
    .optional(),
  // rent-your-agent Phase 2: pin this task to one executor + link the service row.
  targetExecutor: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'targetExecutor must be a 0x EOA address')
    .optional(),
  serviceId: z.number().int().positive().optional(),
  // Per-task privacy. 'public' = plaintext brief at rootHash, no key wrapping,
  // brief + result visible to everyone. Absent/'private' = encrypted flow.
  privacy: z.enum(['private', 'public']).optional(),
  // Bounded display copy of a PUBLIC brief (browse/detail render it without a
  // storage fetch). Only allowed when privacy='public'.
  publicBrief: z.string().min(1).max(4000).optional(),
  // Semantic matching: optional PUBLIC one-liner used only for routing. Lets a
  // PRIVATE task be matched by meaning without unsealing anything — allowed in
  // both privacy modes (public tasks usually rely on publicBrief instead).
  routingSummary: z.string().min(1).max(500).optional(),
  isUserOp: z.boolean().optional(),
});

const verifySchema = z.object({
  passed: z.boolean(),
  reasons: z.array(z.string()).max(20).optional(),
});

// POST /tasks/:id/wrap-to — poster pushes ECIES-wrapped AES slices to new
// bidders that registered after the task was posted. Address keys are EOA
// 0x-prefixed; values are the same hex wrapped-blob format used at task
// creation (no 0x prefix). Bounded so a buggy client can't dump megabytes.
const wrapToSchema = z.object({
  wrappedKeys: z
    .record(
      z.string().regex(/^0x[0-9a-fA-F]{40,66}$/, 'wrappedKeys address must be 0x-prefixed hex'),
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
      // publicKey is required by the schema, so it's always present here. We no
      // longer fall back to a stored pubkey on re-register — registering without
      // one is now a 400, which is what keeps pubkey-less (undecryptable)
      // executors out of the set and prevents the NEEDS_WRAP dead-end.
      publicKey: data.publicKey,
      agentCardUrl: data.agentCardUrl,
      mcpEndpointUrl: data.mcpEndpointUrl,
      minReward: data.minReward,
      preferredCapabilities: data.preferredCapabilities as AgentCapability[] | undefined,
      supportedChains: data.supportedChains,
      reputation: existing?.reputation ?? 50, // start at 50
      tasksCompleted: existing?.tasksCompleted ?? 0,
      // Carried like the two counters above. registerAgent writes whatever it is
      // handed, so leaving this out reset an agent's earnings to '0' every time
      // it re-registered.
      totalEarnedRaw: existing?.totalEarnedRaw,
      registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    });

    // Semantic matching (Phase 0): (re)compute this executor's embedding now
    // that its routing text (display name, capabilities) is set. Best-effort —
    // never blocks registration.
    agentEmbedding.recomputeForWalletBestEffort(address);

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
 * List registered A2A executors, optionally filtered by capability (superset /
 * ALL-match: an agent is returned only if its capability set includes every
 * requested capability).
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
 * GET /api/v1/a2a/semantic-candidates
 *
 * Rank registered agents for a task BY MEANING (embeddings + optional rerank).
 *   ?q=<routing text>       match against arbitrary public text, OR
 *   ?taskHash=<indexed>     resolve the task's public routing text from meta
 *   ?rerank=true            add the cross-encoder precision pass
 *   ?k=<1..25>              how many candidates (default 10)
 *
 * Non-breaking: this only READS a ranking — it does not change accept gating,
 * scoring, or offers (that's the next, gated stage). Each call spends a paid
 * embedding (+ rerank) provider call, so it's requireAuth AND a
 * per-wallet rate limit (keyed by principal, so rotating IPs / many agents
 * can't run up the provider bill).
 */
const semanticCandidatesLimiter = createUserRateLimiter(20);
a2aRouter.get('/semantic-candidates', requireAuth, semanticCandidatesLimiter, async (req: AuthRequest, res, next) => {
  try {
    // Express parses repeated/bracketed params as arrays — coerce to a single
    // string so a `?q=a&q=b` can't throw a 500 in the string ops below.
    const first = (v: unknown): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).toString();
    const k = Math.min(Math.max(parseInt(first(req.query.k)) || 10, 1), 25);
    const rerank = first(req.query.rerank) === 'true';
    let text = first(req.query.q).trim();
    const taskHash = first(req.query.taskHash);
    if (!text && taskHash) {
      const meta = await a2aStore.getMeta(taskHash);
      if (meta) text = semanticMatch.buildTaskRoutingText(meta);
    }
    if (!text) {
      throw new AppError(400, 'NO_ROUTING_TEXT', 'Provide ?q=<routing text> or ?taskHash=<an indexed task with public routing text>');
    }
    const candidates = await semanticMatch.semanticRankedAgents(text, { k, rerank });
    res.json({ success: true, data: { candidates, reranked: rerank } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/a2a/demand
 *
 * The "Wanted" board: open tasks the current agent roster can't serve well
 * (weak or missing best semantic fit), worst-served first — the build-me
 * signal for agent creators. Public and unauthenticated: every field is
 * already public (routing text, tags, on-chain reward/deadline), and results
 * are served from a 60s single-flight cache. Rate-limited per IP anyway —
 * the cache-refresh path still fans out to Redis/PG/chain.
 *   ?limit=<1..50>  (default 20)
 */
const demandLimiter = createUserRateLimiter(30); // keys by IP for unauth callers
a2aRouter.get('/demand', demandLimiter, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), MAX_DEMAND_LIMIT);
    const gaps = await demandFeed(limit);
    const body: ApiResponse = { success: true, data: { gaps, limit } };
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
    // Bounded pagination so the public surface can't be asked for the world in
    // one call. Response keeps the { tasks, total } shape (total = full match
    // count) so existing consumers page without breaking; the default window
    // covers every realistic board size today.
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 100, 1), 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    const matches = await a2aStore.browseAgentTasks(caps, minRep);
    // Public projection: this route has no auth, so key material (wrappedKeys,
    // keyCustodyBlob, rootHash) must never appear here — the accepting
    // executor gets its slice from the authenticated /accept response.
    const tasks = matches.slice(offset, offset + limit).map(a2aStore.projectPublicEntry);

    const body: ApiResponse = {
      success: true,
      data: { tasks, total: matches.length, offset, limit },
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
  const taskId = req.params.id as string;
  const address = req.user!.address;
  const addrLc = address.toLowerCase();
  let lockAcquired = false;
  console.log(`[a2a] POST /accept: taskId=${taskId}, executor=${address}`);

  try {
    // ── 1. Redis lock (first gate — serialises concurrent /accept calls) ──────
    // Whoever acquires the lock proceeds; everyone else is rejected immediately,
    // before touching Postgres or doing capability checks. Lock is per-task_id
    // so agents racing for different tasks never block each other.
    lockAcquired = await a2aStore.acquireAcceptLock(taskId, address);
    if (!lockAcquired) {
      await a2aStore.logAcceptAttempt(taskId, address, 'rejected_locked');
      throw new AppError(409, 'ACCEPT_LOCKED', 'Another agent is currently accepting this task');
    }

    // ── 2. Cheap identity checks (reordered — cheapest first) ────────────────
    const meta = await a2aStore.getMeta(taskId);
    if (!meta) {
      await a2aStore.logAcceptAttempt(taskId, address, 'rejected_precheck');
      throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');
    }

    // Deadline pre-check (cheap — pure arithmetic on meta).
    if (meta.deadline) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec >= meta.deadline) {
        console.warn(`[a2a] accept: task ${taskId} is past its deadline — refusing pre-CAS`);
        if (nowSec >= meta.deadline + EXPIRY_GRACE_SEC) {
          try { await a2aStore.tryExpire(taskId, 'expired'); } catch { /* best-effort */ }
        }
        await a2aStore.logAcceptAttempt(taskId, address, 'rejected_precheck');
        throw new AppError(
          409,
          'TASK_EXPIRED',
          'Task deadline has passed — it can no longer be assigned. The poster can reclaim escrow via cancelTask.',
        );
      }
    }

    // Poster self-accept (cheap — string compare on meta).
    if (meta.posterAddress && meta.posterAddress.toLowerCase() === addrLc) {
      await a2aStore.logAcceptAttempt(taskId, address, 'rejected_precheck');
      throw new AppError(403, 'SELF_ACCEPT', 'You posted this task — a poster cannot also execute it');
    }

    // Designated verifier can't also execute.
    if (meta.verifierAddress && meta.verifierAddress.toLowerCase() === addrLc) {
      await a2aStore.logAcceptAttempt(taskId, address, 'rejected_precheck');
      throw new AppError(403, 'IS_VERIFIER', 'You are the designated verifier for this task and cannot also execute it');
    }

    // Registered agent check.
    const agent = await agentStore.getAgent(address);
    if (!agent) {
      await a2aStore.logAcceptAttempt(taskId, address, 'rejected_precheck');
      throw new AppError(403, 'NOT_REGISTERED', 'Register as an agent executor first');
    }

    // Rent-your-agent: pinned to one agent.
    if (meta.targetExecutor && meta.targetExecutor.toLowerCase() !== addrLc) {
      await a2aStore.logAcceptAttempt(taskId, address, 'rejected_precheck');
      throw new AppError(403, 'NOT_TARGET_EXECUTOR', 'This task is reserved for a specific agent');
    }

    // ── 4. Wrapped key / custody checks ──────────────────────────────────────
    const hasOwnSlice = !!meta.wrappedKeys?.[addrLc];
    const custodySvc = keyCustody.getKeyCustodyService();
    let activeCustodyKeyId: string | null = null;
    if (meta.keyCustodyBlob && custodySvc) {
      activeCustodyKeyId = await custodySvc.getActiveKey().then((k) => k.keyId).catch(() => null);
    }
    const custodyKeyIsActive =
      !!meta.keyCustodyBlob &&
      activeCustodyKeyId !== null &&
      meta.keyCustodyBlob.keyId === activeCustodyKeyId;
    const canSelfHeal = !!meta.rootHash && !hasOwnSlice && custodyKeyIsActive;

    // NEEDS_WRAP gate — refuse BEFORE the CAS so the open→accepted transition
    // isn't burned on a caller who can't decrypt the brief. An encrypted task
    // with no slice for this caller is only acceptable if we can self-heal from
    // the key-custody blob (below). Otherwise the caller must /bid and wait for
    // the poster's browser (or the posting agent's wrap loop) to ship a slice.
    // Tasks with no rootHash (legacy / unencrypted) and PUBLIC tasks (their
    // blob is plaintext — there is no key to wrap) skip this entirely.
    if (meta.privacy !== 'public' && meta.rootHash && !hasOwnSlice && !canSelfHeal && !meta.skipKeyWrap) {
      const custodyRotated =
        !!meta.keyCustodyBlob &&
        activeCustodyKeyId !== null &&
        meta.keyCustodyBlob.keyId !== activeCustodyKeyId;
      console.log(
        `[a2a] accept: needs wrap for ${taskId}, agent=${address}` +
          (custodyRotated ? ` (custody blob keyId=${meta.keyCustodyBlob!.keyId} != active ${activeCustodyKeyId} — server-side re-wrap impossible)` : ''),
      );
      await a2aStore.logAcceptAttempt(taskId, address, 'rejected_precheck');
      throw new AppError(
        403,
        'NEEDS_WRAP',
        custodyRotated
          ? 'Task brief is sealed to a rotated custody key — the platform cannot re-wrap it. POST /a2a/tasks/:id/bid to register intent; only the poster can wrap a slice to your pubkey (or cancel and repost).'
          : 'Task brief is not yet wrapped to your pubkey — POST /a2a/tasks/:id/bid to register intent; the poster will wrap on their next polling cycle.',
      );
    }

    if (canSelfHeal && !agent.publicKey && !meta.skipKeyWrap) {
      console.warn(`[a2a] accept: self-heal blocked — agent ${address} has no public key`);
      await a2aStore.logAcceptAttempt(taskId, address, 'rejected_precheck');
      throw new AppError(
        403,
        'NEEDS_WRAP',
        'Your executor record has no public key to re-wrap the brief to — re-register with a pubkey.',
      );
    }

    // Exclusive offer check.
    const offer = await a2aStore.getOffer(taskId);
    if (offer) {
      if (offer.address.toLowerCase() !== addrLc) {
        console.warn(`[a2a] accept: offer belongs to ${offer.address}, caller is ${address}`);
        await a2aStore.logAcceptAttempt(taskId, address, 'rejected_precheck');
        throw new AppError(
          409,
          'OFFER_HELD',
          'This task has been offered to a higher-scored agent; wait for the offer window to expire for CAS-race fallback',
        );
      }
    }

    // ── 5. Postgres/Lua CAS (durable state transition) ───────────────────────
    // Idempotent path: if the caller is already the recorded executor, skip CAS.
    const currentState = await a2aStore.getState(taskId);
    if (currentState?.executorAddress?.toLowerCase() === addrLc &&
        (currentState.status === 'accepted' || currentState.status === 'in_progress')) {
      console.log(`[a2a] accept: already accepted by ${address} for ${taskId} — re-confirming on-chain assignment`);
      const reSettleResult = await settleAssignment(taskId, address);
      if (!reSettleResult.success) {
        if (reSettleResult.expired || reSettleResult.cancelled) {
          await a2aStore.logAcceptAttempt(taskId, address, 'error');
          throw new AppError(409, 'TASK_EXPIRED', 'Task is no longer available on-chain.');
        }
        await a2aStore.logAcceptAttempt(taskId, address, 'error');
        throw new AppError(503, 'SETTLEMENT_FAILED', `On-chain assignment re-check failed: ${reSettleResult.error}.`);
      }
      const currentMeta = await a2aStore.getMeta(taskId);
      const wrappedKey = currentMeta?.wrappedKeys?.[addrLc];
      const body: ApiResponse = {
        success: true,
        data: {
          taskId,
          status: 'accepted',
          rootHash: currentMeta?.rootHash,
          wrappedKey,
          // 'public' tells the worker the blob at rootHash is plaintext —
          // skip ECIES/AES entirely (there is no wrappedKey by design).
          privacy: currentMeta?.privacy,
          // Same field as the fresh-accept response: resume re-accepts through
          // this branch and needs the chain for its gas check.
          chain: reSettleResult.chain ?? currentMeta?.chain,
          alreadySettled: reSettleResult.alreadySettled ?? true,
          assignTxHash: reSettleResult.txHash,
        },
      };
      await a2aStore.logAcceptAttempt(taskId, address, 'won');
      res.json(body);
      return;
    }

    const accept = await a2aStore.tryAccept(taskId, address, new Date().toISOString());
    if (!accept.ok) {
      console.warn(`[a2a] accept: CAS lost for ${taskId}, currentStatus=${accept.currentStatus}`);
      await a2aStore.logAcceptAttempt(taskId, address, 'lost_cas');
      throw new AppError(
        409,
        'NOT_OPEN',
        `Task is not open for acceptance (status: ${accept.currentStatus})`,
      );
    }

    // Key-custody self-heal (docs/TEE-REWRAP-SPEC.md §5.2). Deliberately runs
    // AFTER winning the CAS — so only the assigned worker ever receives a
    // decryptable slice (CAS losers got 409 above and see nothing, which kills
    // the "harvest the key via repeated /accept" oracle) — and BEFORE
    // settleAssignment, so a re-wrap failure releases the task instead of
    // stranding an undecryptable worker on chain.
    let selfHealedSlice: string | undefined;
    if (canSelfHeal) {
      try {
        selfHealedSlice = await custodySvc!.rewrap(
          meta.keyCustodyBlob!.keyId,
          meta.keyCustodyBlob!.blob,
          agent.publicKey!,
        );
      } catch (err) {
        console.error(`[a2a] accept: key-custody rewrap failed for ${taskId}:`, (err as Error).message);
        // Un-assign so another (or the same) agent can retry; do NOT settle on chain.
        try {
          await a2aStore.releaseToOpen(taskId);
        } catch (relErr) {
          console.error(`[a2a] accept: releaseToOpen after rewrap failure also failed for ${taskId}:`, (relErr as Error).message);
        }
        throw new AppError(503, 'REWRAP_FAILED', 'Key-custody re-wrap failed; task released — retry shortly.');
      }
      // Persist for the record / idempotency: a later /accept by the same agent
      // takes the wrappedKeys[addr] fast-path instead of re-wrapping again.
      await a2aStore.mergeWrappedKeys(taskId, { [addrLc]: selfHealedSlice });
      console.log(`[a2a] accept: key-custody self-heal OK for ${taskId}, agent=${address}`);
    }

    // Clear the exclusive offer and cascade now that the CAS is won.
    await Promise.all([
      a2aStore.clearOffer(taskId).catch(() => {}),
      a2aStore.clearCascade(taskId).catch(() => {}),
    ]);

    // Await on-chain settlement: marketplaceAssign(taskId, executor) so the
    // contract knows who to pay. The HTTP response waits for confirmation,
    // eliminating the redundant 12s sleep on the worker side.
    console.log(`[a2a] accept: CAS won for ${taskId}, awaiting on-chain settlement`);

    // Gas-liveness deadline: if on-chain confirm doesn't arrive within
    // SETTLEMENT_DEADLINE_TTL_S, the sweep reverts the task to 'open'.
    await a2aStore.startSettlementDeadline(taskId);

    const settleResult = await settleAssignment(taskId, address);

    // On-chain confirmed (or already settled) — clear the deadline.
    if (settleResult.success) {
      await a2aStore.clearSettlementDeadline(taskId);
    }

    if (!settleResult.success) {
      // Deadline passed while the task was still Funded: TERMINAL. Do NOT
      // releaseToOpen — that would re-list the task for the next /accept to
      // hit the same DeadlineReached revert, bouncing it open↔accepted
      // forever. Close it off-chain instead ('failed' leaves the a2a:open
      // index via the CAS that already removed it) and tell the agent it's
      // gone for good. The poster reclaims escrow via cancelTask (still
      // Funded) — claimTimeout reverts on Funded tasks.
      if (settleResult.expired) {
        console.warn(`[a2a] accept: task ${taskId} expired while Funded — closing instead of re-opening`);
        try {
          await a2aStore.updateState(taskId, { status: 'failed', failedReason: 'expired' });
        } catch (closeErr) {
          console.error(`[a2a] accept: could not close expired task ${taskId}:`, (closeErr as Error).message);
        }
        throw new AppError(
          409,
          'TASK_EXPIRED',
          'Task deadline has passed — it can no longer be assigned. The poster can reclaim escrow via cancelTask.',
        );
      }
      // Chain truth says a DIFFERENT executor owns this task (cross-deployment
      // poaching on shared Redis, a restored snapshot, or a manual on-chain
      // assignWorker the indexer never saw). TERMINAL for this caller: do NOT
      // releaseToOpen — re-listing bounces every future /accept off the same
      // revert — and do NOT return key material. Point Redis at the on-chain
      // executor so poster views reconcile with the contract.
      // Task was cancelled/refunded on-chain while this accept raced (no worker
      // on chain). TERMINAL: close off-chain and tell the caller it's gone — do
      // NOT reconcile executorAddress to the zero address or re-open it.
      if (settleResult.cancelled) {
        console.warn(`[a2a] accept: task ${taskId} cancelled on-chain — closing off-chain`);
        try {
          await a2aStore.updateState(taskId, { status: 'failed', failedReason: 'cancelled', executorAddress: undefined });
        } catch (closeErr) {
          console.error(`[a2a] accept: could not close cancelled task ${taskId}:`, (closeErr as Error).message);
        }
        throw new AppError(409, 'TASK_CANCELLED', 'Task has been cancelled on-chain — escrow already returned to the poster.');
      }
      if (settleResult.workerMismatch) {
        console.error(
          `[a2a] accept: task ${taskId} already assigned on-chain to ${settleResult.onChainWorker ?? 'unknown'} — refusing ${address} (check /health/bridge for cross-env poaching)`,
        );
        // Reconcile Redis to chain truth. updateState now MOVES the executor
        // index (SREM this refused caller, SADD the real worker) so the poacher
        // stops resume-looping a task it doesn't own and drops off its
        // /executions list. The caller never received key material (we're in
        // the failure path before the wrappedKey response), and any slice the
        // self-heal persisted is now unreachable: every meta-returning surface
        // is projected or ownership-gated, and the caller is no longer indexed
        // on this task.
        //
        // Off-chain identity is always the EOA: when the on-chain worker is a
        // BlindAccount, reconcile to its OWNER, not the contract address —
        // otherwise the owning agent (indexed by wallet) loses sight of the
        // task in /executions and resume.
        if (settleResult.onChainWorker) {
          let reconcileTo = settleResult.onChainWorker.toLowerCase();
          const owner = await loadAgentBySmartAccount(reconcileTo).catch(() => null);
          if (owner) reconcileTo = owner.walletAddress.toLowerCase();
          try {
            await a2aStore.updateState(taskId, { executorAddress: reconcileTo });
          } catch (recErr) {
            console.error(`[a2a] accept: could not reconcile executor for ${taskId}:`, (recErr as Error).message);
          }
        }
        throw new AppError(409, 'ASSIGNED_ELSEWHERE', 'Task is already assigned on-chain to a different executor');
      }
      console.error(`[a2a] accept: settlement failed for ${taskId}: ${settleResult.error}`);
      // Release task back to open so another agent can retry.
      try { await a2aStore.releaseToOpen(taskId); } catch { /* best-effort */ }
      throw new AppError(503, 'SETTLEMENT_FAILED', `On-chain assignment failed: ${settleResult.error}. Task released — another agent may retry.`);
    }

    // Encrypted-brief slice: return the caller's wrappedKey + rootHash so the
    // worker can download from 0G Storage and AES-decrypt. Use the freshly
    // re-wrapped slice if we self-healed, else the slice posters wrapped at
    // task creation (lookup by lowercased address). Both fields may be absent
    // on legacy tasks created before the encrypted-flow shipped — the worker
    // treats that as "no brief available, log and skip" rather than crashing.
    const wrappedKey = selfHealedSlice ?? meta.wrappedKeys?.[addrLc];
    const body: ApiResponse = {
      success: true,
      data: {
        taskId,
        status: 'accepted',
        rootHash: meta.rootHash,
        wrappedKey,
        // 'public' tells the worker the blob at rootHash is plaintext —
        // skip ECIES/AES entirely (there is no wrappedKey by design).
        privacy: meta.privacy,
        // The chain this task settles on — the worker checks it holds gas
        // there before spending an LLM call (worker.js runAcceptedTask).
        chain: settleResult.chain ?? meta.chain,
        alreadySettled: settleResult.alreadySettled,
        assignTxHash: settleResult.txHash,
      },
    };
    res.json(body);

    // Log successful accept for audit trail.
    await a2aStore.logAcceptAttempt(taskId, address, 'won').catch(() => {});

    // Bids are only needed until a task is assigned — drop the index now that it
    // is (best-effort; the addBid TTL is the backstop if this fails).
    bidsStore.clearBids(taskId).catch(() => {});

    // Shadow measurement: record who ACTUALLY won the task so the tuning loop
    // can compare it against both rankings. Best-effort.
    void semanticMatch.recordShadowOutcome(taskId, { acceptedBy: address });

    // Fire webhook for task assignment (non-blocking)
    try {
      const { fireWebhooks } = await import('../services/webhookStore.js');
      fireWebhooks(address, 'task_assigned', { taskId, rootHash: meta.rootHash }).catch(() => {});
    } catch { /* webhook module optional */ }

    // Poster diary: "Task accepted". Fire-and-forget — never blocks accept.
    void notifyLifecycle(taskId, 'assigned');
  } catch (err) {
    console.error(`[a2a] accept failed for ${req.params.id}:`, (err as Error).message);
    next(err);
  } finally {
    // Always release the Redis lock — TTL is the backstop for crashes, not
    // the primary release mechanism.
    if (lockAcquired) {
      await a2aStore.releaseAcceptLock(taskId).catch(() => {});
    }
  }
});

/**
 * POST /api/v1/a2a/tasks/:id/bid
 *
 * An executor registers intent to take a task whose brief hasn't been wrapped
 * to them yet (e.g. they registered after the task was posted). Idempotent —
 * re-bidding from the same address just refreshes the bidAt timestamp.
 *
 * Capability gate matches /accept (superset / ALL-of). Bids on tasks the agent
 * couldn't accept anyway are rejected at intent time so the poster's wrap step
 * doesn't burn cycles wrapping to executors who can't legally accept.
 */
a2aRouter.post('/tasks/:id/bid', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskId = req.params.id as string;
    const address = req.user!.address;

    const meta = await a2aStore.getMeta(taskId);
    if (!meta) throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');

    // Mirror /accept's SELF_ACCEPT gate at intent time — a poster bidding on
    // their own task could only result in wrapping a slice to themselves.
    if (meta.posterAddress && meta.posterAddress.toLowerCase() === address.toLowerCase()) {
      throw new AppError(403, 'SELF_BID', 'You posted this task — a poster cannot bid to execute it');
    }

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
/**
 * GET /api/v1/a2a/key-custody/pubkey  (public)
 *
 * The active key-custody public key a poster seals the brief AES key to, so a
 * late-joining agent can be served a re-wrapped slice on /accept with no poster
 * present (docs/TEE-REWRAP-SPEC.md). Public: it only returns a public key.
 *   - `enabled:false` → custody is off; posters skip sealing and rely on the
 *     browser/agent wrap loops (status quo).
 *   - `attestation` is null for the local (operator-trusted) backend; the
 *     attested backends return a quote the client MUST verify before sealing.
 */
a2aRouter.get('/key-custody/pubkey', async (_req, res, next) => {
  try {
    const svc = keyCustody.getKeyCustodyService();
    if (!svc) {
      res.json({
        success: true,
        data: { enabled: false, keyId: null, publicKey: null, attestation: null },
      });
      return;
    }
    const { keyId, publicKey } = await svc.getActiveKey();
    const attestation = await svc.getAttestation();
    const body: ApiResponse = {
      success: true,
      data: { enabled: true, keyId, publicKey, attestation },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/** task:available meta — caps included only when the task actually has them,
 *  so every broadcast path emits the same shape. */
// `chain` rides along so a worker can refuse a broadcast for a chain it
// cannot pay gas on BEFORE accepting (an accept assigns on-chain and is then
// unreleasable). Omitted for rows indexed before meta.chain existed.
// Exclusive offers always name the required caps (empty list included) and,
// like broadcasts, the chain — so an offered agent that cannot pay gas there
// declines up front instead of accepting and locking the task.
function offerMeta(requiredCaps: string[], chain?: TaskChain): Record<string, unknown> {
  return { requiredCapabilities: requiredCaps, ...(chain ? { chain } : {}) };
}

function broadcastMeta(requiredCaps: string[], chain?: TaskChain): Record<string, unknown> {
  return {
    ...(requiredCaps.length > 0 ? { requiredCapabilities: requiredCaps } : {}),
    ...(chain ? { chain } : {}),
  };
}

/**
 * Advance the cascade to the next ranked agent after the per-position offer
 * window expires. If the task has already been accepted (status !== open) or
 * the cascade is exhausted, the task falls back to CAS-race broadcast.
 * This uses setTimeout, so cascades are lost on server restart — the task
 * remains in a2a:open and can be picked up via CAS race (graceful degradation).
 */
function scheduleCascadeAdvance(
  taskHash: string,
  requiredCaps: string[],
  chain?: TaskChain,
  delayMs: number = a2aStore.CASCADE_OFFER_MS,
): void {
  setTimeout(async () => {
    try {
      const state = await a2aStore.getState(taskHash);
      if (!state || state.status !== 'open') return;

      const next = await a2aStore.advanceCascade(taskHash);
      if (!next) {
        emitTaskAvailable(taskHash, broadcastMeta(requiredCaps, chain));
        return;
      }

      const deadline = Date.now() + a2aStore.CASCADE_OFFER_MS;
      await a2aStore.setOffer(taskHash, {
        address: next.address,
        score: next.score,
        expiresAt: deadline,
      });
      // No rootHash in the broadcast: the WS 'join' handshake is
      // unauthenticated, so a task:offer payload reaches anyone who joined the
      // room. The agent only needs the taskId to fire /accept, which returns
      // rootHash + its wrapped slice over the authenticated channel.
      emitTaskOffer(next.address, taskHash, offerMeta(requiredCaps, chain), next.score, deadline);

      scheduleCascadeAdvance(taskHash, requiredCaps, chain);
    } catch (err) {
      console.error(`[a2a] cascade advance failed for ${taskHash.slice(0, 10)}…:`, (err as Error).message);
    }
  }, delayMs);
}

/**
 * Rank agents and start the cascade of exclusive offers (position 0 first),
 * or fall back to CAS-race broadcast when no ranked candidate exists. The
 * Phase 2 FLIP lives here: when SEMANTIC_ROUTING_ENABLED, the offer queue is
 * ranked by MEANING (semanticCascadeRanking — embeddings + optional rerank);
 * the capability-tag scorer remains the fallback whenever semantic yields
 * nothing, and a caps-less task that can't be semantically ranked broadcasts
 * exactly as before the flip. Throws are handled by the caller (→ broadcast).
 */
/** The offer queue: semantic ranking when eligible (tag ranking appended as
 *  the remainder), else the capability-tag ranking. Shared by the normal
 *  cascade start and the exploration branch, so both walk the same order. */
async function rankedEntries(
  taskHash: string,
  requiredCaps: AgentCapability[],
  routingMeta: semanticMatch.RoutingMeta,
  taskRewardWei: string,
): Promise<{ entries: a2aStore.CascadeEntry[]; semantic: boolean }> {
  const semantic = await semanticMatch.semanticCascadeRanking(routingMeta, taskRewardWei);
  const tagEntries = async () =>
    (await rankAgents(requiredCaps, taskRewardWei)).map((r) => ({
      address: r.address,
      score: r.score,
      displayName: r.displayName,
    }));
  let entries = semantic ?? (await tagEntries());
  if (semantic) {
    // Coverage guarantee carried over from the tag era: every eligible
    // registered agent still gets a cascade position (the tag ranking scores
    // capability overlap but does NOT filter on it — matching is soft, see
    // semanticMatch.ts). Semantic decides the FRONT of the queue; the tag
    // ranking appends anyone the top-K KNN missed (e.g. an agent whose
    // embedding write failed or whose vector is on a stale model).
    // Best-effort — an append failure keeps the semantic queue rather than
    // aborting to broadcast.
    try {
      const seen = new Set(entries.map((e) => e.address.toLowerCase()));
      entries = entries.concat((await tagEntries()).filter((e) => !seen.has(e.address.toLowerCase())));
    } catch (err) {
      console.warn(`[a2a] tag-remainder append failed for ${taskHash.slice(0, 10)}…:`, (err as Error).message);
    }
  }
  return { entries, semantic: !!semantic };
}

async function startRankedCascade(
  taskHash: string,
  requiredCaps: AgentCapability[],
  routingMeta: semanticMatch.RoutingMeta,
  taskRewardWei: string,
  chain?: TaskChain,
): Promise<void> {
  const { entries, semantic } = await rankedEntries(taskHash, requiredCaps, routingMeta, taskRewardWei);
  if (entries.length === 0) {
    emitTaskAvailable(taskHash, broadcastMeta(requiredCaps, chain));
    return;
  }

  if (semantic) {
    console.log(
      `[a2a] semantic cascade for ${taskHash.slice(0, 10)}…: ${entries.length} candidates, top=${entries[0].address} (score=${entries[0].score})`,
    );
  }

  // Same fire-and-forget Redis semantics as the pre-flip dispatch: a transient
  // write failure must not abort the offer emit — without the offer/cascade
  // keys, /accept simply CAS-races (no enforced exclusive window), which is
  // graceful degradation rather than a stall.
  a2aStore.setCascade(taskHash, entries).catch(() => {});
  const best = entries[0];
  const deadline = Date.now() + a2aStore.CASCADE_OFFER_MS;
  a2aStore.setOffer(taskHash, {
    address: best.address,
    score: best.score,
    expiresAt: deadline,
  }).catch(() => {});
  // rootHash deliberately omitted — unauthenticated WS room, see
  // scheduleCascadeAdvance.
  emitTaskOffer(best.address, taskHash, offerMeta(requiredCaps, chain), best.score, deadline);
  scheduleCascadeAdvance(taskHash, requiredCaps, chain);

  // Canary dial: which ranking produced the offers that were just emitted.
  // Gated on the flag so flag-off stays a strict no-op (no new DB writes on
  // the default path), and recorded after the emit so it reflects what was
  // actually dispatched.
  if (config.semanticRoutingEnabled && semanticMatch.buildTaskRoutingText(routingMeta)) {
    void semanticMatch.markShadowRoutedBy(taskHash, semantic ? 'semantic' : 'tag');
  }
}

a2aRouter.post('/tasks/index', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const data = indexTaskSchema.parse(req.body);
    const address = req.user!.address;
    const taskHash = data.taskHash.toLowerCase();

    let onChainTaskId: string;
    let onChainTaskHash: string;
    let onChainAgent: string;
    let onChainDeadline: number;
    let onChainAmount: string;

    // Poll for the receipt rather than taking a single shot. The createTask tx
    // is already confirmed by the time the frontend calls us (its signer waited
    // for the receipt before posting here), but 0G mainnet RPC is
    // eventually-consistent: the replica the backend hits can lag the one the
    // browser saw by a few blocks. A single getTransactionReceipt here would
    // then 404 a tx that is genuinely on-chain — funding the escrow but leaving
    // the task un-indexed (no rootHash/wrappedKeys meta → invisible to
    // executors). Retry across ~24s to ride out that replica lag.
    // Poll for the receipt from both chains — the tx may target 0G or Base escrow.
    // Try Base first (if configured) since new tasks are funded on Base, then 0G.
    // For ERC-4337 user-ops the relay returns a userOperationHash, not a tx hash.
    // getTransactionReceipt(userOpHash) always returns null, so when the first
    // attempt fails we fall back to scanning recent blocks for TaskCreated events
    // matching the taskHash via eth_getLogs.
    let receipt = null;
    let activeEscrow = escrow;
    const taskCreatedTopic = ethers.id(
      'TaskCreated(uint256,address,address,uint256,bytes32,string,string,uint256)',
    );
    const providers = baseProvider && baseEscrow
      ? [
          { prov: baseProvider, esc: baseEscrow, label: 'Base' },
          { prov: provider, esc: escrow, label: '0G' },
        ]
      : [{ prov: provider, esc: escrow, label: '0G' }];

    // If no receipt found, this is likely a user-op hash. Accept an
    // isUserOp flag from the frontend to skip the (always-failing)
    // getTransactionReceipt loop and go straight to the logs scan.
    const isUserOp = (data as any).isUserOp === true;
    if (isUserOp) {
      console.log(`[tasks/index] isUserOp=true, skipping receipt poll — scanning logs`);
    } else {
      for (const { prov, esc } of providers) {
        receipt = await prov.getTransactionReceipt(data.txHash);
        for (let i = 0; i < 3 && !receipt; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          receipt = await prov.getTransactionReceipt(data.txHash);
        }
        if (receipt) {
          activeEscrow = esc;
          break;
        }
      }
    }

    // If no receipt found, this is likely a user-op hash. Scan recent blocks
    // for TaskCreated events matching our taskHash.
    if (!receipt) {
      // Event: TaskCreated(uint256 indexed taskId, address indexed agent,
      //   address token, uint256 amount, bytes32 taskHash, ...)
      // Non-indexed data: [token, amount, taskHash, category, locationZone, deadline]
      // taskHash is at data index 2 (after token and amount).
      // Decode the non-indexed data and keep only OUR task's event. Other
      // tasks' TaskCreated logs in the same page must not end the scan early.
      const matchesOurHash = (l: ethers.Log): boolean => {
        try {
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['address', 'uint256', 'bytes32', 'string', 'string', 'uint256'],
            l.data,
          );
          return String(decoded[2]).toLowerCase() === taskHash;
        } catch { return false; }
      };

      // Scan BACKWARDS in pages, newest first, instead of one fixed "last 200
      // blocks" window. 200 blocks is ~7 minutes on Base Sepolia, so any call
      // to /index more than 7 minutes after the funding tx — a resumed spend
      // after a crash, a client that timed out and re-called with the same
      // idempotencyKey — could never see its own TaskCreated event and got
      // RECEIPT_NOT_FOUND forever, with the escrow funded and the task
      // unindexed. Observed twice from the MCP.
      //
      // Attempt order matters for the common case. The MCP calls /index the
      // moment the relay returns a user-op hash, usually BEFORE the bundler
      // has included it — so attempt 0 checks only the newest page (cheap),
      // attempt 1 scans deep (this is the one that rescues a late retry), and
      // later attempts go back to the newest page, since everything older was
      // just covered. Measured: deep-first cost 38s to index a fresh op that
      // landed one block after the deep scan's top; shallow-first makes that
      // ~10s. Pages stay at 200 blocks (inside every RPC's getLogs limit).
      const PAGE = 200;
      const DEEP_PAGES = 30; // 6,000 blocks ≈ 3.3h on Base Sepolia (2s blocks)
      const DEEP_ATTEMPT = 1;

      // Retry loop — the bundler may take a few blocks to include the user-op.
      for (let attempt = 0; attempt < 5 && !receipt; attempt++) {
        if (attempt > 0) {
          console.log(`[tasks/index] Retry ${attempt + 1}/5 — waiting 5s for inclusion...`);
          await new Promise((r) => setTimeout(r, 5000));
        }
        const maxPages = attempt === DEEP_ATTEMPT ? DEEP_PAGES : 1;
        for (const { prov, esc, label } of providers) {
          try {
            // Each provider is scanned against ITS OWN escrow. Previously the
            // Base escrow address was used on the 0G provider too, which could
            // never match anything there.
            const escrowAddr = await esc.getAddress();
            const blockNum = await prov.getBlockNumber();
            let match: ethers.Log | undefined;
            let scannedFrom = blockNum;
            for (let page = 0; page < maxPages && !match; page++) {
              const toBlock = blockNum - page * PAGE;
              if (toBlock < 0) break;
              const fromBlock = Math.max(0, toBlock - PAGE + 1);
              scannedFrom = fromBlock;
              const pageLogs = await prov.getLogs({
                fromBlock,
                toBlock,
                address: escrowAddr,
                topics: [taskCreatedTopic],
              });
              match = pageLogs.find(matchesOurHash);
              if (fromBlock === 0) break;
            }
            console.log(`[tasks/index] Scanned ${label} blocks ${scannedFrom}–${blockNum} for TaskCreated: ${match ? 'match' : 'no match'}`);
            if (match) {
              console.log(`[tasks/index] Match found! txHash=${match.transactionHash} block=${match.blockNumber}`);
              receipt = await prov.getTransactionReceipt(match.transactionHash);
              if (receipt) {
                activeEscrow = esc;
                console.log(`[tasks/index] Receipt confirmed at block ${receipt.blockNumber}`);
                break;
              }
            }
          } catch (e) {
            console.error(`[tasks/index] getLogs scan failed on ${label}:`, (e as Error).message?.slice(0, 200));
          }
        }
      }
    }

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

    // Parse logs from the active escrow address only. We don't trust a
    // receipt that originated from some other contract — a malicious poster
    // could otherwise pass a tx hash from a different escrow with a colliding
    // taskHash.
    const escrowAddress = (await activeEscrow.getAddress()).toLowerCase();
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
    const parsed = activeEscrow.interface.parseLog({
      topics: matching[0].topics as string[],
      data: matching[0].data,
    });
    if (!parsed) {
      throw new AppError(500, 'PARSE_FAILED', 'Failed to decode TaskCreated log');
    }
    onChainTaskId = (parsed.args.taskId as bigint).toString();
    onChainTaskHash = (parsed.args.taskHash as string).toLowerCase();
    onChainAgent = (parsed.args.agent as string).toLowerCase();
    onChainDeadline = Number(parsed.args.deadline);
    onChainAmount = (parsed.args.amount as bigint).toString();

    if (onChainTaskHash !== taskHash) {
      throw new AppError(
        409,
        'HASH_MISMATCH',
        `Claimed taskHash (${taskHash.slice(0, 10)}…) does not match on-chain TaskCreated.taskHash (${onChainTaskHash.slice(0, 10)}…)`,
      );
    }
    const userAddresses = req.user!.addresses?.map((a: string) => a.toLowerCase()) || [address.toLowerCase()];
    const matchesOnChainAgent = userAddresses.includes(onChainAgent.toLowerCase());

    if (!matchesOnChainAgent) {
      throw new AppError(
        403,
        'NOT_TASK_AGENT',
        'Authenticated caller is not the on-chain agent (creator) for this task',
      );
    }

    // All checks passed — eagerly seed the indexer mapping so /submit and
    // /accept resolve the hash immediately without waiting for the
    // forward-only event poller to catch up. Seeded in the namespace of the
    // chain that actually holds the task: resolveTaskByHash reads the Base
    // namespace first, so seeding a Base task under the 0G keys made it
    // resolve as 0G until the Base poller caught up (see taskChain.seedTaskId).
    await seedTaskId(activeEscrow === baseEscrow ? 'base' : '0g', taskHash, onChainTaskId);

    const wrappedKeysNormalized = data.wrappedKeys
      ? Object.fromEntries(
          Object.entries(data.wrappedKeys).map(([addr, blob]) => [addr.toLowerCase(), blob]),
        )
      : undefined;

    // Agent-verify integrity checks. A task in 'agent' mode is unjudgeable
    // without a verifier, and a poster verifying their own task defeats the
    // independent-judge premise (and would let a poster grief the worker).
    if (data.verificationMode === 'agent') {
      if (!data.verifierAddress) {
        throw new AppError(400, 'NO_VERIFIER', "verificationMode='agent' requires verifierAddress");
      }
      if (data.verifierAddress.toLowerCase() === address.toLowerCase()) {
        throw new AppError(400, 'INVALID_VERIFIER', 'The poster cannot be their own verifier');
      }
      // Public tasks skip this: the brief is plaintext, the verifier reads it
      // like anyone else — there is no AES key to wrap.
      if (data.privacy !== 'public' && !wrappedKeysNormalized?.[data.verifierAddress.toLowerCase()]) {
        throw new AppError(
          400,
          'VERIFIER_NOT_WRAPPED',
          'The brief AES key must be ECIES-wrapped to verifierAddress (include it in wrappedKeys) so the verifier can decrypt the task',
        );
      }
      // The off-chain designation must match the ON-CHAIN settlement authority.
      // completeVerification is gated on taskVerifier[taskId]; if the poster
      // funded via plain createTask (taskVerifier = 0x0) or committed a
      // different verifier, the designated agent's settlement tx reverts
      // NotVerifier and the task sticks in awaiting_verification until
      // claimTimeout. Refuse the index up front instead.
      const onChainVerifier = activeEscrow === baseEscrow
        ? await escrowService.getTaskVerifierBase(Number(onChainTaskId))
        : await escrowService.getTaskVerifier(Number(onChainTaskId));
      if (onChainVerifier.toLowerCase() !== data.verifierAddress.toLowerCase()) {
        throw new AppError(
          409,
          'VERIFIER_MISMATCH',
          onChainVerifier === ethers.ZeroAddress
            ? "On-chain taskVerifier is unset — agent-verify tasks must be funded via createTaskWithVerifier, not plain createTask"
            : `On-chain taskVerifier (${onChainVerifier}) does not match the designated verifier (${data.verifierAddress})`,
        );
      }
    }

    const requiredCaps = (data.requiredCapabilities ?? []) as AgentCapability[];

    // Idempotent re-index: preserve wrappedKeys slices added since the first
    // index (via /wrap-to or /accept self-heal) instead of overwriting them with
    // only the original post-time set — otherwise a re-index strands late joiners
    // back on NEEDS_WRAP. Existing meta (a superset) wins on key collisions.
    const existingMeta = await a2aStore.getMeta(taskHash);

    // ── Per-task privacy ────────────────────────────────────────────────────
    // A PUBLIC task must carry ZERO key material: its blob is plaintext, so a
    // wrapped key or custody blob on the row would be incoherent (and would
    // make the accept-gate/worker branch on inconsistent state). A PRIVATE
    // task must never carry a plaintext display brief. Privacy is immutable
    // across re-indexes — flipping private→public would publish the pointer
    // to a brief the poster encrypted expecting blindness (and vice versa
    // would strand executors mid-flight).
    const isPublic = data.privacy === 'public';
    if (isPublic) {
      if (data.wrappedKeys && Object.keys(data.wrappedKeys).length > 0) {
        throw new AppError(400, 'PUBLIC_TASK_HAS_KEYS', 'A public task must not carry wrappedKeys — post it unencrypted, or omit privacy for the encrypted flow');
      }
      if (data.keyCustodyBlob) {
        throw new AppError(400, 'PUBLIC_TASK_HAS_CUSTODY', 'A public task must not carry a keyCustodyBlob');
      }
    } else if (data.publicBrief) {
      throw new AppError(400, 'BRIEF_ON_PRIVATE_TASK', "publicBrief is only allowed when privacy='public' — a private brief must stay encrypted");
    }
    if (existingMeta && (existingMeta.privacy === 'public') !== isPublic) {
      throw new AppError(409, 'PRIVACY_IMMUTABLE', 'A task\'s privacy mode cannot be changed after it is first indexed');
    }
    const mergedWrappedKeys = (existingMeta?.wrappedKeys || wrappedKeysNormalized)
      ? { ...(wrappedKeysNormalized ?? {}), ...(existingMeta?.wrappedKeys ?? {}) }
      : undefined;

    // rent-your-agent Phase 2: a per-call "Use now" pins the task to one agent and
    // links the agent_services row it rents. Validate the link so a later
    // sold_count bump is trustworthy — the service must be active, its agent must
    // be the pinned executor, and the escrow must cover the listed price.
    const targetExecutor = data.targetExecutor?.toLowerCase();
    if (data.serviceId !== undefined) {
      if (!targetExecutor) {
        throw new AppError(400, 'SERVICE_NO_TARGET', 'serviceId requires targetExecutor (the service agent)');
      }
      const svc = await serviceStore.getActiveService(data.serviceId);
      if (!svc) {
        throw new AppError(409, 'SERVICE_NOT_ACTIVE', 'No active service with that id');
      }
      if (svc.agent_address.toLowerCase() !== targetExecutor) {
        throw new AppError(409, 'SERVICE_AGENT_MISMATCH', "targetExecutor does not match the service's agent");
      }
      if (BigInt(onChainAmount) < BigInt(svc.price_raw)) {
        throw new AppError(409, 'UNDERPAID', 'Escrow amount is below the service price');
      }
    }

    const taskChain: TaskChain = activeEscrow === baseEscrow ? 'base' : '0g';
    await a2aStore.setMeta({
      taskId: taskHash,
      targetExecutorType: 'agent',
      verificationMode: data.verificationMode ?? 'manual',
      verificationCriteria: data.verificationCriteria,
      requiredCapabilities: requiredCaps,
      posterAddress: address,
      chain: taskChain,
      verifierAddress: data.verifierAddress?.toLowerCase(),
      rootHash: data.rootHash,
      wrappedKeys: mergedWrappedKeys,
      keyCustodyBlob: data.keyCustodyBlob,
      // Absolute on-chain deadline (epoch seconds) from the verified
      // TaskCreated event — lets browse hide expired tasks, /accept refuse
      // them pre-CAS, and the expiry sweep close them with no chain read.
      deadline: onChainDeadline,
      // rent-your-agent Phase 2: pin + service link (validated above).
      targetExecutor,
      serviceId: data.serviceId,
      // Stored only when public — absent means private (back-compat with
      // every pre-existing row).
      privacy: isPublic ? 'public' : undefined,
      publicBrief: isPublic ? data.publicBrief : undefined,
      routingSummary: data.routingSummary,
    });

    // M5 (audit): the funding is receipt-verified at this point, so flip the
    // build-time 'pending' escrow_lock row to confirmed. Fire-and-forget —
    // indexing must not fail because the ledger write did.
    void accountingService.confirmPendingTransactions(taskHash, ['escrow_lock'])
      .catch((e) => console.warn(`[tasks/index] escrow_lock confirm failed for ${taskHash.slice(0, 10)}…:`, (e as Error).message));

    // The meta slice both the shadow record and the routing decision read —
    // built ONCE so the shadow log's routing text can never diverge from what
    // the cascade actually ranked on.
    const routingMeta: semanticMatch.RoutingMeta = {
      requiredCapabilities: requiredCaps,
      publicBrief: isPublic ? data.publicBrief : undefined,
      routingSummary: data.routingSummary,
      targetExecutor,
      // Accept-gate mirror inputs: lets the semantic ranking skip agents whose
      // /accept is guaranteed to 403 (poster, verifier, missing wrapped slice
      // on a sealed no-custody task) instead of burning offer windows on them.
      posterAddress: address,
      verifierAddress: data.verifierAddress?.toLowerCase(),
      wrappedKeys: mergedWrappedKeys,
      privacy: isPublic ? 'public' : undefined,
      rootHash: data.rootHash,
      skipKeyWrap: existingMeta?.skipKeyWrap,
      keyCustodyBlob: data.keyCustodyBlob,
    };

    // Semantic matching (Phase 1 SHADOW): embed the task's public routing text
    // and record how semantic KNN would have ranked agents vs the live tag
    // ranking. Pure measurement — fire-and-forget, never affects indexing.
    void semanticMatch.recordMatchShadow({
      ...routingMeta,
      taskId: taskHash,
      targetExecutorType: 'agent',
      verificationMode: data.verificationMode ?? 'manual',
    });

    console.log(
      `[a2a] indexed taskHash=${taskHash.slice(0, 10)}… → onChainId=${onChainTaskId} poster=${address}`,
    );

    // Score matching agents and start a cascade of exclusive offers to the
    // best-fit agents (position 0 first, then position 1 after CASCADE_OFFER_MS,
    // etc.). Only after ALL ranked agents have been given a chance (or scoring
    // finds zero matches) does the task fall back to CAS-race broadcast.
    // Non-blocking: if scoring fails, the task is already in a2a:open for
    // CAS-race fallback.
    // When CASCADE_ENABLED=false, skip straight to CAS-race broadcast.
    //
    // Phase 2 FLIP: a semantically-eligible task (flag on, not pinned, has
    // public routing text) enters the cascade even with ZERO capability tags —
    // the whole point of routing by meaning is that tags become optional.
    //
    // A pinned (targetExecutor) task never cascades AT ALL: every exclusive
    // offer would go to an agent whose /accept 403s NOT_TARGET_EXECUTOR while
    // the offer lock 409s the one agent actually allowed to accept. Broadcast
    // reaches the pinned agent immediately and the accept gate keeps everyone
    // else out. (Pinned+capped tasks previously entered the tag cascade —
    // that was this same lockout.)
    const semanticEligible = semanticMatch.semanticRoutingEligible(routingMeta);
    if (!config.cascadeEnabled || targetExecutor || (requiredCaps.length === 0 && !semanticEligible)) {
      emitTaskAvailable(taskHash, broadcastMeta(requiredCaps, taskChain));
    } else {
      const taskRewardWei = onChainAmount;
      const broadcastAfter = (err: Error, stage: string) => {
        console.error(`[a2a] ${stage} failed for ${taskHash.slice(0, 10)}…:`, err.message);
        emitTaskAvailable(taskHash, broadcastMeta(requiredCaps, taskChain));
      };

      if (requiredCaps.length === 0) {
        // Caps-less semantic path: skip the exploration slot. With no cap
        // filter it would draw a random cold-start agent from the ENTIRE
        // registry, and its pass/timeout path (advanceCascade with no cascade
        // stored) broadcasts without semantic ranking ever running.
        startRankedCascade(taskHash, requiredCaps, routingMeta, taskRewardWei, taskChain)
          .catch((err) => broadcastAfter(err as Error, 'semantic scoring/offer'));
      } else {
        // Cold-start: try the exploration slot first. If a new agent is picked,
        // offer to them; if they pass or timeout, fall back to normal ranked flow.
        const agentMode = existingMeta?.agentSelectionMode ?? 'merit';
        pickExplorationAgent(requiredCaps, agentMode, taskRewardWei).then((explorationPick) => {
          if (explorationPick) {
            console.log(`[a2a] exploration slot: offering to new agent ${explorationPick.address} (score=${explorationPick.score})`);
            const deadline = Date.now() + a2aStore.CASCADE_OFFER_MS;
            a2aStore.setOffer(taskHash, {
              address: explorationPick.address,
              score: explorationPick.score,
              expiresAt: deadline,
            }).catch(() => {});
            emitTaskOffer(explorationPick.address, taskHash, offerMeta(requiredCaps, taskChain), explorationPick.score, deadline);
            // Store the ranked queue behind the pick so a pass/timeout advances
            // into the ranking (see a2aStore.withExplorationHead). Best-effort:
            // if ranking fails the advance falls back to broadcast as before.
            const pickEntry = { address: explorationPick.address, score: explorationPick.score, displayName: explorationPick.displayName };
            return rankedEntries(taskHash, requiredCaps, routingMeta, taskRewardWei)
              .then(({ entries, semantic }) => {
                if (config.semanticRoutingEnabled && semanticMatch.buildTaskRoutingText(routingMeta)) {
                  void semanticMatch.markShadowRoutedBy(taskHash, semantic ? 'semantic' : 'tag');
                }
                return a2aStore.setCascade(taskHash, a2aStore.withExplorationHead(pickEntry, entries));
              })
              .catch((err) => console.warn(`[a2a] exploration cascade store failed for ${taskHash.slice(0, 10)}…:`, (err as Error).message))
              // The pick's window started when its offer went out; arm the advance
              // for whatever is left of it so ranking time does not extend the window.
              .then(() => { scheduleCascadeAdvance(taskHash, requiredCaps, taskChain, Math.max(0, deadline - Date.now())); });
          }

          // Normal ranked flow (semantic when flipped, tag fallback inside).
          return startRankedCascade(taskHash, requiredCaps, routingMeta, taskRewardWei, taskChain)
            .catch((err) => broadcastAfter(err as Error, 'scoring/offer'));
        }).catch((err) => {
          console.error(`[a2a] exploration slot failed for ${taskHash.slice(0, 10)}…:`, (err as Error).message);
          // Fallback: normal ranked flow
          startRankedCascade(taskHash, requiredCaps, routingMeta, taskRewardWei, taskChain)
            .catch((fallbackErr) => broadcastAfter(fallbackErr as Error, 'fallback scoring/offer'));
        });
      }
    }

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
    const { resultData, teeAttestation, rootHash } = submitSchema.parse(req.body);
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
    // 'failed' is allowed back in: the contract explicitly supports a
    // Verified→Submitted retry (submitEvidence from Verified, up to
    // MAX_SUBMISSION_ATTEMPTS). Without this, a worker whose output scored
    // just under the rubric was dead-ended — /submit, /finalize, and /release
    // all rejected state 'failed' and the escrow froze until claimTimeout.
    // The retry is gated on the on-chain facts below (status 3, attempts
    // remaining, before deadline) so we never hand out a tx that reverts.
    if (state.status !== 'accepted' && state.status !== 'in_progress' && state.status !== 'failed') {
      console.warn(`[a2a] submit: invalid state for ${taskHash}: ${state.status}`);
      throw new AppError(409, 'INVALID_STATE', `Cannot submit in state: ${state.status}`);
    }

    // Look up the on-chain taskId via the TaskCreated event mapping. Without
    // it we can't build the submitEvidence tx. The mapping is populated by
    // services/escrowEvents.ts within ~30s of createTask confirming on chain.
    const onChainIdResolved = await resolveTaskByHash(taskHash);
    const onChainId = onChainIdResolved?.taskId ?? null;
    const onChainIdChain = onChainIdResolved?.chain ?? '0g';
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

    // Single on-chain assignment check. /accept now awaits settleAssignment,
    // so the assignment should already be confirmed. This is just a defensive
    // sanity check with one retry in case of RPC lag. Also captures the
    // current on-chain submissionAttempts so the state below can record which
    // round the pending evidence broadcast will become.
    //
    // The recorded worker is the SMART ACCOUNT for AA agents assigned after
    // the AA rollout (settleAssignment assigns it on Base so UserOps pass
    // onlyWorker) — but legacy tasks assigned before that name the EOA.
    // Accept either; the worker picks the matching broadcast path.
    const assignee = await resolveAssignee(address, onChainIdChain);
    const isRecordedWorker = (w: string) =>
      w.toLowerCase() === address.toLowerCase() || w.toLowerCase() === assignee.toLowerCase();
    let chainAttempts = 0;
    const onChainTask = await escrowService.getTaskOn(onChainIdChain, Number(onChainId));
    chainAttempts = onChainTask.submissionAttempts;
    if (!isRecordedWorker(onChainTask.worker)) {
      // One retry after 2s — covers edge cases like reorgs.
      await new Promise((r) => setTimeout(r, 2_000));
      const retryTask = await escrowService.getTaskOn(onChainIdChain, Number(onChainId));
      chainAttempts = retryTask.submissionAttempts;
      if (!isRecordedWorker(retryTask.worker)) {
        const freshState = await a2aStore.getState(taskHash);
        if (freshState?.assignError) {
          throw new AppError(503, 'BRIDGE_FAILED', `Assignment bridge failed — ${freshState.assignError}. Release and retry.`);
        }
        console.warn(`[a2a] submit: on-chain assignment not confirmed for ${taskHash} (task.worker=${retryTask.worker}, caller=${address})`);
        throw new AppError(503, 'NOT_ASSIGNED_YET', `On-chain assignment not yet confirmed — task.worker=${retryTask.worker}, caller=${address}. Retry shortly.`);
      }
    }

    // Failed-verification retry gates. The contract permits Verified(3) →
    // Submitted via submitEvidence while attempts remain and the deadline
    // hasn't passed (BlindEscrow.sol submitEvidence). Check all three here so
    // a worker is never handed a signable tx that's guaranteed to revert.
    if (state.status === 'failed') {
      const t = await escrowService.getTaskOn(onChainIdChain, Number(onChainId));
      if (t.status !== 3) {
        throw new AppError(
          409,
          'NOT_RETRYABLE',
          `Cannot retry: on-chain status is ${t.status}, expected 3 (Verified). ` +
            'The task either settled differently or the verdict has not confirmed yet.',
        );
      }
      if (t.submissionAttempts >= 3) {
        throw new AppError(
          409,
          'MAX_ATTEMPTS_REACHED',
          `No submission attempts left (${t.submissionAttempts}/3). The poster can reclaim escrow via claimTimeout after the deadline.`,
        );
      }
      if (BigInt(Math.floor(Date.now() / 1000)) >= t.deadline) {
        throw new AppError(
          409,
          'DEADLINE_REACHED',
          'The task deadline has passed — the contract would revert DeadlineReached. The poster can reclaim escrow via claimTimeout.',
        );
      }
      chainAttempts = t.submissionAttempts; // freshest read wins
      console.log(
        `[a2a] submit: retry after failed verification for ${taskHash} (attempt ${chainAttempts + 1}/3)`,
      );
    }

    // Deterministic evidence hash = keccak256(JSON.stringify(resultData)).
    // The contract stores this bytes32 and it acts as the commitment for the
    // off-chain payload the verifier will evaluate.
    const evidenceHash = ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify(resultData)),
    );

    let unsignedSubmitEvidence: ethers.TransactionRequest | null = null;
    if (ethers.isAddress(address)) {
      unsignedSubmitEvidence = await escrowService.buildSubmitEvidenceOn(
        onChainIdChain,
        address,
        Number(onChainId),
        evidenceHash,
      );
    }

    await a2aStore.updateState(taskHash, {
      status: 'submitted',
      resultData,
      submittedAt: new Date().toISOString(),
      // Clear the previous round's verdict on a failed-verification retry so
      // /finalize and the verifier judge the NEW output, not a stale failure.
      verificationResult: undefined,
      // The round this evidence becomes once broadcast (the contract
      // increments submissionAttempts in submitEvidence). /verdict uses it to
      // reject verdicts that target a previous round.
      submissionRound: chainAttempts + 1,
      // 0G TEE attestation for trustless settlement on Base
      ...(teeAttestation ? { teeAttestation } : {}),
      // 0G Storage rootHash of the task output
      ...(rootHash ? { outputRootHash: rootHash } : {}),
    });
    console.log(`[a2a] submit: resultData stored and unsignedSubmitEvidence built for ${taskHash}`);

    // Fire webhook for task submission (non-blocking)
    try {
      const { fireWebhooks } = await import('../services/webhookStore.js');
      fireWebhooks(address, 'task_submitted', { taskId: taskHash }).catch(() => {});
    } catch { /* webhook module optional */ }

    // Poster diary: "Result submitted". Fire-and-forget.
    void notifyLifecycle(taskHash, 'submitted');

    const body: ApiResponse = {
      success: true,
      data: {
        taskId: taskHash,
        onChainTaskId: onChainId,
        // Which escrow the unsigned tx targets. The executor holds a signer
        // per chain and must pick the right one; without this field the
        // platform worker had no way to know and broadcast every
        // submitEvidence on 0G, so a Base task could be accepted but never
        // delivered. The tx also carries chainId now (escrow.ts) as a second
        // guard, but the executor still needs to choose the signer up front.
        chain: onChainIdChain,
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
 * POST /api/v1/a2a/tasks/:id/rebroadcast
 *
 * Heal for the submit-then-crash gap: /submit flips state to 'submitted' at
 * unsigned-tx-BUILD time, before the worker broadcasts. If the worker died
 * (or its RPC blipped — seen live as JsonRpcProvider network failures)
 * between the two, off-chain state says 'submitted' while on-chain status is
 * still Assigned(1). The finalize-only resume path then 503s
 * NOT_SUBMITTED_ON_CHAIN until every attempt cap burns out, and /submit
 * refuses a rebuild (INVALID_STATE on 'submitted') — the task strands with
 * escrow locked until claimTimeout.
 *
 * This endpoint rebuilds the SAME unsigned submitEvidence deterministically
 * from the stored resultData (evidenceHash = keccak256(JSON(resultData))) so
 * the executor can broadcast and proceed to /finalize. Gated on the on-chain
 * facts so a stale caller can never be handed a reverting tx: status must
 * still be Assigned(1) — anything else means evidence already landed (call
 * /finalize) or the task moved on.
 */
a2aRouter.post('/tasks/:id/rebroadcast', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskHash = req.params.id as string;
    const address = req.user!.address;

    const meta = await a2aStore.getMeta(taskHash);
    if (!meta) throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');

    const state = await a2aStore.getState(taskHash);
    if (!state || state.executorAddress?.toLowerCase() !== address.toLowerCase()) {
      throw new AppError(403, 'FORBIDDEN', 'Only the accepted executor can rebroadcast');
    }
    if (state.status !== 'submitted') {
      throw new AppError(409, 'INVALID_STATE', `Only a submitted task can be rebroadcast (state=${state.status})`);
    }
    if (!state.resultData) {
      throw new AppError(400, 'NO_RESULT_DATA', 'No resultData recorded for this task');
    }

    const onChainIdResolved = await resolveTaskByHash(taskHash);
    const onChainId = onChainIdResolved?.taskId ?? null;
    const onChainIdChain = onChainIdResolved?.chain ?? '0g';
    if (!onChainId) {
      throw new AppError(503, 'NOT_INDEXED', 'On-chain taskId not yet indexed — retry shortly');
    }
    const onChainTask = await escrowService.getTaskOn(onChainIdChain, Number(onChainId));
    if (onChainTask.status !== 1) {
      throw new AppError(
        409,
        'ALREADY_SUBMITTED',
        `On-chain status is ${onChainTask.status}, not Assigned(1) — evidence already recorded, call /finalize instead.`,
      );
    }
    if (BigInt(Math.floor(Date.now() / 1000)) >= onChainTask.deadline) {
      throw new AppError(
        409,
        'DEADLINE_REACHED',
        'The task deadline has passed — the contract would revert DeadlineReached. The poster can reclaim escrow via claimTimeout.',
      );
    }
    // Same recorded-worker gate as /submit: the contract's onlyWorker
    // reverts evidence from anyone else, so don't hand out a doomed tx.
    const assignee = await resolveAssignee(address, onChainIdChain);
    const isRecordedWorker = (w: string) =>
      w.toLowerCase() === address.toLowerCase() || w.toLowerCase() === assignee.toLowerCase();
    if (!isRecordedWorker(onChainTask.worker)) {
      throw new AppError(503, 'NOT_ASSIGNED_YET', `On-chain assignment not confirmed — task.worker=${onChainTask.worker}, caller=${address}. Retry shortly.`);
    }

    const evidenceHash = ethers.keccak256(
      ethers.toUtf8Bytes(JSON.stringify(state.resultData)),
    );
    let unsignedSubmitEvidence: ethers.TransactionRequest | null = null;
    if (ethers.isAddress(address)) {
      unsignedSubmitEvidence = await escrowService.buildSubmitEvidenceOn(
        onChainIdChain,
        address,
        Number(onChainId),
        evidenceHash,
      );
    }
    console.log(`[a2a] rebroadcast: rebuilt unsignedSubmitEvidence for ${taskHash} (evidence never landed on-chain)`);
    const body: ApiResponse = {
      success: true,
      data: {
        taskId: taskHash,
        onChainTaskId: onChainId,
        chain: onChainIdChain,
        evidenceHash,
        unsignedSubmitEvidence,
      },
    };
    res.json(body);
  } catch (err) {
    console.error(`[a2a] rebroadcast failed for ${req.params.id}:`, (err as Error).message);
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
    const onChainIdResolved = await resolveTaskByHash(taskHash);
    const onChainId = onChainIdResolved?.taskId ?? null;
    const onChainIdChain = onChainIdResolved?.chain ?? '0g';
    if (onChainId) {
      let onChainStatus: number;
      try {
        const onChainTask = await escrowService.getTaskOn(onChainIdChain, Number(onChainId));
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

    // Agent-verify mode: park for the poster-designated verifier agent. It
    // decrypts the brief (it holds a wrapped slice), judges the output against
    // the real task, and posts a verdict to /tasks/:id/verdict — which fires the
    // settlement bridge. No autoVerify and no bridge call happen here.
    if (meta.verificationMode === 'agent') {
      if (!meta.verifierAddress) {
        throw new AppError(409, 'NO_VERIFIER', 'agent-verify task has no designated verifier');
      }
      // Don't park evidence the chain hasn't seen. If this round's
      // submitEvidence was never broadcast (worker died in the gap, or the
      // broadcast permanently fails), parking would re-queue the verifier to
      // judge output whose verdict can never be recorded (/verdict rejects it
      // as STALE_VERDICT) — burning the verifier's LLM spend every poll.
      // 503 keeps the worker's finalize retry/resume loop driving instead.
      // Chain reads are guarded: an RPC blip must 503 (retryable), never 500.
      let ocIdA: string | null;
      let ocIdAChain: '0g' | 'base';
      try {
        const ocIdAResolved = await resolveTaskByHash(taskHash);
        ocIdA = ocIdAResolved?.taskId ?? null;
        ocIdAChain = ocIdAResolved?.chain ?? '0g';
      } catch (err) {
        throw new AppError(
          503,
          'ON_CHAIN_CHECK_FAILED',
          `Could not resolve on-chain task before finalize: ${(err as Error).message}`,
        );
      }
      if (!ocIdA) {
        throw new AppError(503, 'NOT_INDEXED', 'On-chain taskId not yet indexed — wait a few seconds and retry');
      }
      let tA;
      try {
        tA = await escrowService.getTaskOn(ocIdAChain, Number(ocIdA));
      } catch (err) {
        throw new AppError(
          503,
          'ON_CHAIN_CHECK_FAILED',
          `Could not read on-chain task before finalize: ${(err as Error).message}`,
        );
      }
      const broadcastPending =
        state.submissionRound !== undefined && tA.submissionAttempts < state.submissionRound;
      if (broadcastPending || (tA.status !== 2 && tA.status !== 3 && tA.status !== 4)) {
        throw new AppError(
          503,
          'NOT_SUBMITTED_ON_CHAIN',
          `SubmitEvidence not yet confirmed on-chain (status=${tA.status}, attempts=${tA.submissionAttempts}). Wait for the tx to confirm and retry.`,
        );
      }
      await a2aStore.updateState(taskHash, { status: 'awaiting_verification' });
      const body: ApiResponse = {
        success: true,
        data: { taskId: taskHash, status: 'awaiting_verification', verifier: meta.verifierAddress },
      };
      res.json(body);
      return;
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

    // Resolve + gate the on-chain task BEFORE mutating a2a state or executor
    // stats. If the createTask event isn't indexed yet, or submitEvidence
    // hasn't confirmed, we 503 with state still 'submitted' so the executor's
    // retry re-runs cleanly — instead of advancing to 'verified', bumping
    // tasksCompleted, and then losing the earnings credit to the indexing-lag
    // race (the "3 tasks · 0 0G" bug). Without submitEvidence confirmed the
    // bridge's completeVerification would also revert with InvalidStatus and
    // the task would stick permanently. Chain reads are guarded: an RPC blip
    // must 503 (retryable), never 500.
    let ocId: string | null;
    let ocIdChain: '0g' | 'base';
    try {
      const ocIdResolved = await resolveTaskByHash(taskHash);
      ocId = ocIdResolved?.taskId ?? null;
      ocIdChain = ocIdResolved?.chain ?? '0g';
    } catch (err) {
      throw new AppError(
        503,
        'ON_CHAIN_CHECK_FAILED',
        `Could not resolve on-chain task before finalize: ${(err as Error).message}`,
      );
    }
    if (!ocId) {
      throw new AppError(
        503,
        'NOT_INDEXED',
        'On-chain taskId not yet indexed — wait a few seconds and retry',
      );
    }
    let onChainTask;
    try {
      onChainTask = await escrowService.getTaskOn(ocIdChain, Number(ocId));
    } catch (err) {
      throw new AppError(
        503,
        'ON_CHAIN_CHECK_FAILED',
        `Could not read on-chain task before finalize: ${(err as Error).message}`,
      );
    }

    // Reconcile path: on-chain already settled (3=Verified/failed,
    // 4=Completed/passed) while a2a state is still 'submitted' — a previous
    // finalize crashed/deployed between the settle tx confirming and the state
    // write. The chain is the truth; adopt its outcome, credit via the
    // at-most-once guard, and DON'T touch the bridge. Without this branch the
    // status!==2 gate below would 503 NOT_SUBMITTED_ON_CHAIN forever and the
    // worker would be paid on-chain yet never credited off-chain.
    if (onChainTask.status === 3 || onChainTask.status === 4) {
      const settledPass = onChainTask.status === 4;
      const reconciled =
        verificationResult.passed === settledPass
          ? verificationResult
          : { passed: settledPass, reasons: ['Reconciled from on-chain settlement'] };
      const reconciledStatus: 'verified' | 'failed' = settledPass ? 'verified' : 'failed';
      await a2aStore.updateState(taskHash, { status: reconciledStatus, verificationResult: reconciled });
      if (settledPass) {
        const computeCostMicroUnits = consumePendingCost(taskHash);
        await recordWorkerPayout(taskHash, address, ocId, onChainTask.amount, {
          serviceId: meta.serviceId,
          computeCostMicroUnits,
          // Base settles in USDC (6 decimals); 0G in native (18). Without
          // this the accounting ledger divides a USDC amount by 1e18 and the
          // Earnings page never moves off zero.
          decimals: ocIdChain === 'base' ? 6 : 18,
          meta,
        });
      } else {
        await recordWorkerDispute(taskHash, address);
      }
      // Diary: completed (+ review nudge) or failed, poster + worker.
      void notifyLifecycle(taskHash, settledPass ? 'completed' : 'failed');
      const body: ApiResponse = {
        success: true,
        data: { taskId: taskHash, status: reconciledStatus, verificationResult: reconciled, reconciled: true },
      };
      res.json(body);
      return;
    }

    if (onChainTask.status !== 2) { // 2 = Submitted
      throw new AppError(
        503,
        'NOT_SUBMITTED_ON_CHAIN',
        `SubmitEvidence not yet confirmed on-chain (status=${onChainTask.status}). Wait for the tx to confirm and retry.`,
      );
    }

    // Bridge FIRST, credit AFTER: completeVerification must confirm on-chain
    // before we advance a2a state or touch executor stats. The old order
    // (credit, then fire-and-forget settle) produced the inverse drift —
    // "N tasks credited · 0 0G received" — whenever the swallowed settle
    // reverted. On settle failure state stays 'submitted' and we 503; the
    // executor's retry either re-runs the settle or — if the tx actually
    // landed — takes the reconcile branch above. Both converge.
    const settle = await settleVerification(taskHash, verificationResult.passed, state.teeAttestation);
    if (!settle.success) {
      throw new AppError(
        503,
        'SETTLEMENT_FAILED',
        `On-chain completeVerification failed: ${settle.error}. State unchanged — retry.`,
      );
    }

    await a2aStore.updateState(taskHash, {
      status: newStatus,
      verificationResult,
    });

    if (verificationResult.passed) {
      // Deduct sandbox compute costs from worker's payout
      const computeCostMicroUnits = consumePendingCost(taskHash);
      await recordWorkerPayout(taskHash, address, ocId, onChainTask.amount, {
        serviceId: meta.serviceId,
        computeCostMicroUnits,
        // Base settles in USDC (6 decimals); 0G in native (18). Without
        // this the accounting ledger divides a USDC amount by 1e18 and the
        // Earnings page never moves off zero.
        decimals: ocIdChain === 'base' ? 6 : 18,
        meta,
      });
    } else {
      await recordWorkerDispute(taskHash, address);
    }

    // Diary: completed (+ review nudge) or failed, poster + worker.
    void notifyLifecycle(taskHash, verificationResult.passed ? 'completed' : 'failed');

    // Fire webhook for task completion (non-blocking)
    try {
      const { fireWebhooks } = await import('../services/webhookStore.js');
      fireWebhooks(address, 'task_completed', { taskId: taskHash, passed: verificationResult.passed }).catch(() => {});
    } catch { /* webhook module optional */ }

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

    // Resolve + gate the on-chain task BEFORE mutating a2a state or executor
    // stats, so an indexing-lag 503 leaves state='submitted' for a clean retry
    // instead of advancing to 'verified' and bumping tasksCompleted while the
    // earnings credit is lost (the "3 tasks · 0 0G" drift). The executor may
    // have called /finalize (manual mode defers to /verify) before the
    // submitEvidence tx mined, so confirm status=Submitted here too.
    const ocIdResolved = await resolveTaskByHash(taskHash);
    const ocId = ocIdResolved?.taskId ?? null;
    const ocIdChain = ocIdResolved?.chain ?? '0g';
    if (!ocId) {
      throw new AppError(
        503,
        'NOT_INDEXED',
        'On-chain taskId not yet indexed — wait a few seconds and retry',
      );
    }
    const onChainTask = await escrowService.getTaskOn(ocIdChain, Number(ocId));

    // Reconcile path — same as /finalize: a previous verify crashed between
    // the settle confirming (status now 3/4) and the state write. Adopt the
    // on-chain outcome; refuse a poster verdict that CONTRADICTS it (the
    // chain can't be re-settled, so honoring the new verdict is impossible).
    const settledAlready = onChainTask.status === 3 || onChainTask.status === 4;
    if (settledAlready && passed !== (onChainTask.status === 4)) {
      throw new AppError(
        409,
        'ALREADY_SETTLED',
        `Task already settled on-chain with the opposite outcome (status=${onChainTask.status}) — the verdict cannot be changed.`,
      );
    }

    if (!settledAlready && onChainTask.status !== 2) { // 2 = Submitted
      throw new AppError(
        503,
        'NOT_SUBMITTED_ON_CHAIN',
        `SubmitEvidence not yet confirmed on-chain (status=${onChainTask.status}). Wait for the tx to confirm and retry.`,
      );
    }

    // Bridge FIRST, credit AFTER — same ordering as /finalize. Skipped when
    // the chain already settled (reconcile). On settle failure state stays
    // 'submitted' (a clean retry for the poster's re-approval); the
    // at-most-once guard in recordWorkerPayout dedups the credit on retries.
    const settle = settledAlready
      ? { success: true as const, alreadySettled: true }
      : await settleVerification(taskHash, passed);
    if (!settle.success) {
      throw new AppError(
        503,
        'SETTLEMENT_FAILED',
        `On-chain completeVerification failed: ${(settle as { error?: string }).error}. State unchanged — retry.`,
      );
    }

    await a2aStore.updateState(taskHash, {
      status: newStatus,
      verificationResult,
    });

    if (passed && state.executorAddress) {
      const computeCostMicroUnits = consumePendingCost(taskHash);
      await recordWorkerPayout(taskHash, state.executorAddress, ocId, onChainTask.amount, {
        computeCostMicroUnits,
        // Base settles in USDC (6 decimals); 0G in native (18). Without
        // this the accounting ledger divides a USDC amount by 1e18 and the
        // Earnings page never moves off zero.
        decimals: ocIdChain === 'base' ? 6 : 18,
        meta,
      });
    } else if (!passed && state.executorAddress) {
      await recordWorkerDispute(taskHash, state.executorAddress);
    }

    // Diary: completed (+ review nudge) or failed, poster + worker.
    void notifyLifecycle(taskHash, passed ? 'completed' : 'failed');

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
 * POST /api/v1/a2a/tasks/:id/verdict
 *
 * A poster-designated verifier agent (verificationMode='agent') submits its
 * judgement. The verifier decrypted the brief (it holds a wrapped slice in
 * meta.wrappedKeys), read the executor's output, and judged correctness
 * off-chain — the platform never saw the plaintext. We authorize the caller
 * against meta.verifierAddress, gate on the submitEvidence tx being confirmed
 * on chain, then fire the SAME settlement bridge as auto/manual verification so
 * the marketplace signer relays completeVerification. No contract change: the
 * on-chain verifier role stays with the bridge; only the source of the verdict
 * changes (an independent agent instead of the lexical autoVerify rubric).
 */
a2aRouter.post('/tasks/:id/verdict', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskHash = req.params.id as string;
    const address = req.user!.address;
    const { passed, reasons } = verifySchema.parse(req.body);

    const meta = await a2aStore.getMeta(taskHash);
    if (!meta) throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');

    if (meta.verificationMode !== 'agent') {
      throw new AppError(409, 'WRONG_MODE', 'Task is not in agent-verify mode');
    }
    if (!meta.verifierAddress || meta.verifierAddress.toLowerCase() !== address.toLowerCase()) {
      throw new AppError(403, 'NOT_VERIFIER', "Only the task's designated verifier can submit a verdict");
    }

    const state = await a2aStore.getState(taskHash);
    // Idempotent: if a verdict was already recorded (e.g. the verifier's first
    // POST succeeded but its response was lost and it retried), return 200 with
    // the recorded result instead of 409 — so the retry doesn't count as a
    // failure against the verifier's attempt cap.
    if (state && (state.status === 'verified' || state.status === 'failed') && state.verificationResult) {
      const body: ApiResponse = {
        success: true,
        data: { taskId: taskHash, status: state.status, verificationResult: state.verificationResult, alreadyRecorded: true },
      };
      res.json(body);
      return;
    }
    // 'awaiting_verification' is the normal park state after /finalize; accept
    // 'submitted' too in case the verifier raced ahead of the executor's
    // /finalize call.
    if (!state || (state.status !== 'awaiting_verification' && state.status !== 'submitted')) {
      throw new AppError(
        409,
        'INVALID_STATE',
        `Cannot submit a verdict in state: ${state?.status ?? 'missing'}`,
      );
    }

    // No self-verification: the agent that did the work cannot also sign off on
    // it. (A poster could designate an agent as verifier that then also accepts
    // the task as executor.) Reject so escrow can't be released on a self-grade.
    if (
      state.executorAddress &&
      state.executorAddress.toLowerCase() === meta.verifierAddress.toLowerCase()
    ) {
      throw new AppError(
        409,
        'SELF_VERIFICATION',
        'The executor of a task cannot also be its verifier',
      );
    }

    // Trustless settlement: the verifier broadcasts completeVerification
    // on-chain ITSELF (the contract gates on the per-task verifier). This
    // endpoint only RECORDS the verdict for the UI + the off-chain reputation
    // mirror — it does NOT relay settleVerification (the marketplace signer
    // isn't this task's verifier and would revert). We confirm the on-chain
    // settlement actually happened and matches `passed`, so the backend can't be
    // handed a verdict the verifier never committed on-chain.
    const ocIdResolved = await resolveTaskByHash(taskHash);
    const ocId = ocIdResolved?.taskId ?? null;
    const ocIdChain = ocIdResolved?.chain ?? '0g';
    if (!ocId) {
      throw new AppError(503, 'NOT_INDEXED', 'On-chain taskId not yet indexed — retry shortly');
    }
    const onChainTask = await escrowService.getTaskOn(ocIdChain, Number(ocId));
    // 2=Submitted, 3=Verified(failed), 4=Completed(passed).
    const settledPass = onChainTask.status === 4;
    const settledFail = onChainTask.status === 3;
    if (!settledPass && !settledFail) {
      // Disambiguate the dead-end case from plain lag: if the on-chain
      // taskVerifier is unset (funded via plain createTask), this verifier's
      // settlement tx reverts NotVerifier FOREVER — an opaque
      // NOT_SETTLED_ON_CHAIN here would have the verifier retrying a
      // permanently un-settleable task. (New indexes refuse this combination
      // up front via VERIFIER_MISMATCH; this catches pre-existing tasks.)
      const onChainVerifier = await escrowService.getTaskVerifierOn(ocIdChain, Number(ocId));
      if (onChainVerifier === ethers.ZeroAddress) {
        throw new AppError(
          409,
          'NO_ONCHAIN_VERIFIER',
          'Task was funded without an on-chain verifier (plain createTask) — the designated verifier cannot settle it. ' +
            'The poster must reclaim escrow via claimTimeout after the deadline.',
        );
      }
      throw new AppError(
        409,
        'NOT_SETTLED_ON_CHAIN',
        `completeVerification not yet confirmed on-chain (status=${onChainTask.status}). Broadcast it before recording the verdict.`,
      );
    }
    // Round binding: during a failed-verification retry there is a window
    // where on-chain status is still 3 from ROUND 1 while the worker's
    // round-2 evidence is mid-broadcast (state already 'submitted' with a
    // bumped submissionRound). A delayed/duplicate round-1 verdict would pass
    // the settled gate and re-fail the fresh round — reject it as stale.
    // submitEvidence increments submissionAttempts, so attempts >= round
    // means the evidence for the recorded round has actually been broadcast.
    if (
      state.submissionRound !== undefined &&
      onChainTask.submissionAttempts < state.submissionRound
    ) {
      throw new AppError(
        409,
        'STALE_VERDICT',
        `Verdict targets a previous submission round — the latest evidence (round ${state.submissionRound}) has not been broadcast/settled yet.`,
      );
    }
    if (passed !== settledPass) {
      throw new AppError(
        409,
        'VERDICT_MISMATCH',
        `Reported verdict (passed=${passed}) does not match on-chain settlement (status=${onChainTask.status}).`,
      );
    }

    const verificationResult = { passed, reasons: reasons ?? [] };
    const newStatus: 'verified' | 'failed' = passed ? 'verified' : 'failed';
    await a2aStore.updateState(taskHash, { status: newStatus, verificationResult });

    if (passed && state.executorAddress) {
      // ocId + onChainTask were already resolved + gated above (status must be
      // Completed=4 here), so the payout credit can't be lost to an indexing race.
      const computeCostMicroUnits = consumePendingCost(taskHash);
      await recordWorkerPayout(taskHash, state.executorAddress, ocId, onChainTask.amount, {
        computeCostMicroUnits,
        // Base settles in USDC (6 decimals); 0G in native (18). Without
        // this the accounting ledger divides a USDC amount by 1e18 and the
        // Earnings page never moves off zero.
        decimals: ocIdChain === 'base' ? 6 : 18,
        meta,
      });
    } else if (!passed && state.executorAddress) {
      await recordWorkerDispute(taskHash, state.executorAddress);
    }

    // Diary: completed (+ review nudge) or failed, poster + worker.
    void notifyLifecycle(taskHash, passed ? 'completed' : 'failed');

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
 * GET /api/v1/a2a/verifications
 *
 * The verifier agent's queue: tasks where the authenticated caller is the
 * designated verifier (verificationMode='agent') and the work is awaiting a
 * verdict. Each entry carries meta (rootHash + the caller's wrapped brief slice
 * in wrappedKeys + verificationCriteria.acceptance) and state.resultData (the
 * executor's output), so the verifier can decrypt the brief, read the output,
 * judge, and POST /tasks/:id/verdict.
 */
a2aRouter.get('/verifications', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const address = req.user!.address;
    const tasks = await a2aStore.getVerifierTasks(address);
    const pending = tasks.filter((t) => t.state.status === 'awaiting_verification');
    // Resolve each task's on-chain numeric id so the verifier can call
    // completeVerification(id, passed) itself. Null when not yet indexed — the
    // verifier skips it and retries on its next poll.
    // resolveTaskByHash reports the chain alongside the id. It used to be
    // discarded here, leaving the verifier-role worker to settle every task
    // against its 0G escrow — including Base tasks, whose numeric id would
    // then name an unrelated 0G task. Both are returned so the worker can
    // pick the escrow and signer for the chain that actually holds the task.
    const verifications = await Promise.all(
      pending.map(async (t) => {
        const r = await resolveTaskByHash(t.meta.taskId).catch(() => null);
        return { ...t, onChainId: r?.taskId ?? null, chain: r?.chain ?? null };
      }),
    );
    const body: ApiResponse = {
      success: true,
      data: { verifications, total: verifications.length },
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
    const limit = Math.min(50, parseInt(req.query.limit as string) || 15);
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
    const q = ((req.query.q as string) || '').trim().toLowerCase();
    const statusFilter = (req.query.status as string) || 'all';
    const tasks = await a2aStore.getPosterTasks(address);

    // The custody key the backend can ACTUALLY unwrap right now. A task sealed
    // to a rotated/disabled custody key is NOT recoverable server-side —
    // rewrap() throws on any keyId other than the active one — so reporting
    // hasCustody from the blob's mere existence falsely showed at-risk tasks
    // as safe. One read for the whole list.
    const activeCustodyKeyId = await keyCustody
      .getKeyCustodyService()
      ?.getActiveKey()
      .then((k) => k.keyId)
      .catch(() => null) ?? null;

    // Enrich each task with its on-chain record so the UI doesn't need a
    // second per-task fetch. Wrapped in try/catch per task — a missing
    // on-chain task (e.g. createTask never confirmed) shouldn't blank out
    // the entire list. Sequential because a typical user has <50 posts;
    // if this grows, batch via Multicall.
    const enriched = await Promise.all(
      tasks.map(async (t) => {
        // How many executors the brief's AES key has been ECIES-wrapped to and
        // persisted server-side. 0 on an open encrypted task means the only
        // copy of the key is in the poster's browser (localStorage) — if that's
        // cleared before any agent gets wrapped, the brief is permanently
        // undecryptable (the platform never sees the key). The frontend
        // surfaces this as a "key at risk" warning on /tasks/mine.
        const wrapCount = Object.keys(t.meta.wrappedKeys ?? {}).length;
        // Whether the brief AES key is sealed to key-custody AND that custody
        // key is the live one — only then is the task recoverable server-side
        // via re-wrap at wrapCount 0 (docs/TEE-REWRAP-SPEC.md §8). A blob
        // sealed to a rotated key is treated as no custody at all.
        const hasCustody =
          !!t.meta.keyCustodyBlob &&
          !!activeCustodyKeyId &&
          t.meta.keyCustodyBlob.keyId === activeCustodyKeyId;
        try {
          const resolved = await resolveTaskByHash(t.meta.taskId);
          if (!resolved) return { ...t, wrapCount, hasCustody, onChain: null };
          const onChainId = resolved.taskId;
          const onChainTask = await escrowService.getTaskOn(resolved.chain, Number(onChainId));
          return {
            ...t,
            wrapCount,
            hasCustody,
            onChain: {
              taskId: onChainId.toString(),
              chain: resolved.chain,
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
          return { ...t, wrapCount, hasCustody, onChain: null };
        }
      }),
    );

    // Optional text search across task id, on-chain id, and public briefs.
    let filtered = enriched;
    if (q) {
      filtered = enriched.filter((t: any) => {
        const idMatch = t.meta?.taskId?.toLowerCase().includes(q);
        const onChainIdMatch = t.onChain?.taskId?.toString().toLowerCase().includes(q);
        const briefMatch = t.meta?.publicBrief?.toLowerCase().includes(q);
        return idMatch || onChainIdMatch || briefMatch;
      });
    }

    // Map a task to the coarse status used by the UI filters.
    function effectiveStatus(t: any): number {
      if (t.onChain) return Number(t.onChain.status);
      switch (t.state?.status) {
        case 'open': return 0;
        case 'accepted':
        case 'in_progress': return 1;
        case 'submitted':
        case 'awaiting_verification': return 2;
        case 'verified':
        case 'completed': return 4;
        case 'failed': return 6;
        default: return 0;
      }
    }

    if (statusFilter !== 'all') {
      const status = effectiveStatus;
      filtered = filtered.filter((t: any) => {
        const s = status(t);
        if (statusFilter === 'open') return s === 0;
        if (statusFilter === 'active') return s === 1 || s === 2;
        if (statusFilter === 'completed') return s === 4;
        return true;
      });
    }

    // Sort newest-first by on-chain creation time. Tasks without on-chain data
    // (still indexing) fall to the back so they don't keep jumping to the top.
    filtered.sort((a: any, b: any) => {
      const tsA = a.onChain?.createdAt ? Number(a.onChain.createdAt) : 0;
      const tsB = b.onChain?.createdAt ? Number(b.onChain.createdAt) : 0;
      return tsB - tsA;
    });

    const total = filtered.length;
    const paged = filtered.slice(offset, offset + limit);

    const body: ApiResponse = {
      success: true,
      data: { tasks: paged, total },
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

    // Full meta (incl. the caller's own wrappedKey slice + rootHash, needed by
    // the worker's resume path) only for a SELF query. A cross-address query is
    // the agent-detail dashboard viewing some other executor's history — it
    // renders status/result, never key material, so project it. Without this,
    // requireAuth (which only proves control of the CALLER's wallet, not the
    // queried address) would hand any logged-in party the full wrappedKeys /
    // keyCustodyBlob / rootHash graph for every executor — the exact leak the
    // browse/list/detail projection closed.
    const isSelf = !queryAddr || queryAddr.toLowerCase() === req.user!.address.toLowerCase();
    const executions = isSelf ? tasks : tasks.map(a2aStore.projectPublicEntry);

    const body: ApiResponse = {
      success: true,
      data: { executions, total: executions.length },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/a2a/profile
 * Get my agent profile with on-chain + decayed reputation.
 */
a2aRouter.get('/profile', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const address = req.user!.address;
    const agent = await agentStore.getAgent(address);

    if (!agent) {
      // `?optional=1`: the web app asks this for every signed-in wallet, and
      // most are posters with no executor profile — answer 200 { agent: null }
      // so the browser doesn't log a red 404 on every page. The default stays
      // 404 NOT_REGISTERED: the published SDK (sdk/src/index.ts getProfile)
      // calls this route and may rely on it.
      if (req.query.optional === '1') {
        const body: ApiResponse = { success: true, data: { agent: null } };
        res.json(body);
        return;
      }
      throw new AppError(404, 'NOT_REGISTERED', 'Agent not registered');
    }

    const [onChain, decayed] = await Promise.all([
      reputationService.getReputationWithScore(address).catch(() => ({
        address, tasksCompleted: 0, avgScore: 0, disputes: 0, disputeRatio: 0, score: 0,
      })),
      reputationDecay.getDecayedReputation(address).catch(() => ({
        address, rawScore: 0, decayedScore: 0, decayFactor: 1, daysSinceLastTask: null, tasksCompleted: 0, disputes: 0,
      })),
    ]);

    const body: ApiResponse = {
      success: true,
      data: { agent, reputation: onChain, decayedReputation: decayed },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
