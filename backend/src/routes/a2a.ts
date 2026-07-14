import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import * as agentStore from '../services/agentStore.js';
import * as a2aStore from '../services/a2aStore.js';
import * as bidsStore from '../services/bidsStore.js';
import * as keyCustody from '../services/keyCustodyService.js';
import { autoVerify } from '../services/autoVerify.js';
import { settleAssignment, settleVerification } from '../services/a2aSettlement.js';
import { recordWorkerPayout, recordWorkerDispute } from '../services/workerPayout.js';
import { getTaskIdByHash } from '../services/escrowEvents.js';
import * as escrowService from '../services/escrow.js';
import * as reputationService from '../services/reputation.js';
import * as reputationDecay from '../services/reputationDecay.js';
import { provider, escrow } from '../services/chain.js';
import { redis } from '../services/redis.js';
import { ethers } from 'ethers';
import type { AuthRequest, ApiResponse, AgentCapability } from '../types.js';
import { AGENT_CAPABILITIES } from '../types.js';
import { rankAgents } from '../services/agentScorer.js';
import { emitTaskOffer, emitTaskAvailable } from '../services/socket.js';
import { EXPIRY_GRACE_SEC } from '../services/a2aExpirySweep.js';
import { config } from '../config.js';
import * as serviceStore from '../services/serviceStore.js';

export const a2aRouter = Router();

// --- Schemas ---

const registerSchema = z.object({
  displayName: z.string().min(1).max(100),
  capabilities: z.array(z.enum(AGENT_CAPABILITIES as unknown as [string, ...string[]])).min(1).max(20),
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
  // Minimum reward in wei (numeric string). Tasks below this threshold are
  // filtered out before scoring, so the agent never appears in the ranked list.
  minReward: z.string().regex(/^\d+$/, 'minReward must be a non-negative integer string (wei)').optional(),
  // Preferred capabilities subset. If set, scoring overlap only counts these
  // (not the agent's full capability set). The agent must still have ALL
  // requiredCapabilities to match the task (enforced by listAgents), so this
  // only affects ranking, not eligibility.
  preferredCapabilities: z.array(z.enum(AGENT_CAPABILITIES as unknown as [string, ...string[]])).min(1).max(20).optional(),
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
  try {
    const taskId = req.params.id as string;
    const address = req.user!.address;
    console.log(`[a2a] POST /accept: taskId=${taskId}, executor=${address}`);

    const meta = await a2aStore.getMeta(taskId);
    if (!meta) {
      console.warn(`[a2a] accept: task meta not found for ${taskId}`);
      throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');
    }

    // Deadline pre-check. The authoritative gate stays on-chain
    // (marketplaceAssign reverts DeadlineReached), but when meta carries the
    // deadline we can refuse before burning the CAS + a settle round-trip.
    // The refusal is cheap and reversible, so it uses no grace margin — but
    // the terminal off-chain close only happens once clearly past the
    // boundary (same grace as the sweep), so a server clock running a few
    // seconds ahead of block.timestamp can never close a task the contract
    // would still assign. Inside the grace window the worst case is the
    // pre-batch-4 behaviour: the on-chain revert decides.
    if (meta.deadline) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec >= meta.deadline) {
        console.warn(`[a2a] accept: task ${taskId} is past its deadline — refusing pre-CAS`);
        if (nowSec >= meta.deadline + EXPIRY_GRACE_SEC) {
          try { await a2aStore.tryExpire(taskId, 'expired'); } catch { /* best-effort */ }
        }
        throw new AppError(
          409,
          'TASK_EXPIRED',
          'Task deadline has passed — it can no longer be assigned. The poster can reclaim escrow via cancelTask.',
        );
      }
    }

    // Check agent is registered + capability match BEFORE the CAS, so we don't
    // burn the open→accepted transition on a caller who'd be 403'd anyway.
    const agent = await agentStore.getAgent(address);
    if (!agent) {
      console.warn(`[a2a] accept: agent not registered: ${address}`);
      throw new AppError(403, 'NOT_REGISTERED', 'Register as an agent executor first');
    }
    // rent-your-agent: a per-call "Use now" invocation is PINNED to one agent.
    // Reject any other executor before the CAS, so they don't burn the
    // open→accepted transition on a task only the target can decrypt anyway.
    if (meta.targetExecutor && meta.targetExecutor.toLowerCase() !== address.toLowerCase()) {
      throw new AppError(403, 'NOT_TARGET_EXECUTOR', 'This task is reserved for a specific agent');
    }
    if (meta.requiredCapabilities.length > 0) {
      // Match the PostTask UI copy: "an executor agent matches only if it has ALL
      // of them". Required caps are strict requirements (superset match): the
      // agent's capability set must include every cap the task lists — a worker
      // with only summarization can NOT take a task tagged web_research+summarization.
      const hasAll = meta.requiredCapabilities.every((c) => agent.capabilities.includes(c));
      if (!hasAll) {
        console.warn(`[a2a] accept: capability mismatch for ${taskId}: agent has [${agent.capabilities.join(',')}], must have ALL of [${meta.requiredCapabilities.join(',')}]`);
        throw new AppError(
          403,
          'CAPABILITY_MISMATCH',
          `Need all of: ${meta.requiredCapabilities.join(', ')}`,
        );
      }
    }

    // A poster-designated verifier cannot also execute the task it must judge —
    // it would later be blocked at /verdict (SELF_VERIFICATION), trapping the
    // escrow in awaiting_verification with no exit but the poster's claimTimeout.
    // Refuse the accept up front.
    if (meta.verifierAddress && meta.verifierAddress.toLowerCase() === address.toLowerCase()) {
      throw new AppError(
        403,
        'IS_VERIFIER',
        'You are the designated verifier for this task and cannot also execute it',
      );
    }

    // A poster cannot execute their own task. Self-acceptance lets one wallet
    // wash-trade reputation (rating itself per completed task) and recycle its
    // own escrow minus the platform fee — marketplace numbers must stay net of
    // self-dealing. posterAddress is absent only on pre-pivot legacy rows.
    if (meta.posterAddress && meta.posterAddress.toLowerCase() === address.toLowerCase()) {
      throw new AppError(403, 'SELF_ACCEPT', 'You posted this task — a poster cannot also execute it');
    }

    const addrLc = address.toLowerCase();
    const hasOwnSlice = !!meta.wrappedKeys?.[addrLc];
    // Self-heal is possible when the task is encrypted, this caller has no slice
    // yet, the poster sealed the key to custody, a custody backend is live, AND
    // the blob is sealed to the key that backend actually holds. rewrap()
    // hard-throws on any non-active keyId, so without the keyId check a task
    // sealed to a rotated custody key passes this gate, wins the CAS, fails
    // rewrap, gets released, and bounces open↔accepted forever. This is what
    // lets a late joiner pick up the task with no poster present.
    const custodySvc = keyCustody.getKeyCustodyService();
    let activeCustodyKeyId: string | null = null;
    if (meta.keyCustodyBlob && custodySvc) {
      // catch → null: a transient custody-backend error must read as
      // "self-heal unavailable right now" (generic NEEDS_WRAP, retryable),
      // NOT as a rotated key — the rotated diagnosis below tells the poster
      // to re-wrap or cancel, and requires a successful key read to claim.
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
    // Tasks with no rootHash (legacy / unencrypted) skip this entirely.
    if (meta.rootHash && !hasOwnSlice && !canSelfHeal && !meta.skipKeyWrap) {
      const custodyRotated =
        !!meta.keyCustodyBlob &&
        activeCustodyKeyId !== null &&
        meta.keyCustodyBlob.keyId !== activeCustodyKeyId;
      console.log(
        `[a2a] accept: needs wrap for ${taskId}, agent=${address}` +
          (custodyRotated ? ` (custody blob keyId=${meta.keyCustodyBlob!.keyId} != active ${activeCustodyKeyId} — server-side re-wrap impossible)` : ''),
      );
      throw new AppError(
        403,
        'NEEDS_WRAP',
        custodyRotated
          ? 'Task brief is sealed to a rotated custody key — the platform cannot re-wrap it. POST /a2a/tasks/:id/bid to register intent; only the poster can wrap a slice to your pubkey (or cancel and repost).'
          : 'Task brief is not yet wrapped to your pubkey — POST /a2a/tasks/:id/bid to register intent; the poster will wrap on their next polling cycle.',
      );
    }

    // A keyless agent can never be re-wrapped to — refuse before the CAS. New
    // registrations always carry a pubkey (enforced at /register), so this only
    // guards pre-guardrail Redis rows.
    if (canSelfHeal && !agent.publicKey && !meta.skipKeyWrap) {
      console.warn(`[a2a] accept: self-heal blocked — agent ${address} has no public key`);
      throw new AppError(
        403,
        'NEEDS_WRAP',
        'Your executor record has no public key to re-wrap the brief to — re-register with a pubkey.',
      );
    }

    // Check for an exclusive offer. If one exists and it's for this caller,
    // proceed to CAS. If one exists for a different caller, refuse — the
    // best-fit agent should get first dibs. If no offer (expired or never
    // created), fall through to open CAS race.
    const offer = await a2aStore.getOffer(taskId);
    if (offer) {
      if (offer.address.toLowerCase() !== address.toLowerCase()) {
        console.warn(`[a2a] accept: offer belongs to ${offer.address}, caller is ${address}`);
        throw new AppError(
          409,
          'OFFER_HELD',
          'This task has been offered to a higher-scored agent; wait for the offer window to expire for CAS-race fallback',
        );
      }
      // Caller holds the offer — they are the expected winner. Continue to CAS.
    }

    // Atomic open→accepted via a Lua CAS. Two concurrent /accept requests can
    // both pass an open-state read, so we serialise the transition itself on
    // the Redis server. Loser gets 409, no on-chain side effect — preserves
    // the invariant that the executor in Redis matches the one in the bridge
    // tx (and thereby the on-chain t.worker).
    //
    // Idempotent path: if the caller is already the recorded executor (resume
    // after restart), skip the CAS and re-confirm on-chain assignment.
    const currentState = await a2aStore.getState(taskId);
    if (currentState?.executorAddress?.toLowerCase() === address.toLowerCase() &&
        (currentState.status === 'accepted' || currentState.status === 'in_progress')) {
      console.log(`[a2a] accept: already accepted by ${address} for ${taskId} — re-confirming on-chain assignment`);
      // Re-check on-chain assignment; the settleAssignment call is idempotent
      // (alreadyAssigned returns success true).
      const reSettleResult = await settleAssignment(taskId, address);
      if (!reSettleResult.success) {
        if (reSettleResult.expired || reSettleResult.cancelled) {
          throw new AppError(409, 'TASK_EXPIRED', 'Task is no longer available on-chain.');
        }
        throw new AppError(503, 'SETTLEMENT_FAILED', `On-chain assignment re-check failed: ${reSettleResult.error}.`);
      }
      // Return the same shape as a fresh accept so the caller doesn't need
      // to distinguish fresh vs resumed. The wrapped key may have been
      // persisted already; best-effort re-read from meta.
      const currentMeta = await a2aStore.getMeta(taskId);
      const wrappedKey = currentMeta?.wrappedKeys?.[addrLc];
      const body: ApiResponse = {
        success: true,
        data: {
          taskId,
          status: 'accepted',
          rootHash: currentMeta?.rootHash,
          wrappedKey,
          alreadySettled: reSettleResult.alreadySettled ?? true,
          assignTxHash: reSettleResult.txHash,
        },
      };
      res.json(body);
      return;
    }

    const accept = await a2aStore.tryAccept(taskId, address, new Date().toISOString());
    if (!accept.ok) {
      console.warn(`[a2a] accept: CAS lost for ${taskId}, currentStatus=${accept.currentStatus}`);
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
    const settleResult = await settleAssignment(taskId, address);
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
        if (settleResult.onChainWorker) {
          try {
            await a2aStore.updateState(taskId, { executorAddress: settleResult.onChainWorker.toLowerCase() });
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
        alreadySettled: settleResult.alreadySettled,
        assignTxHash: settleResult.txHash,
      },
    };
    res.json(body);

    // Bids are only needed until a task is assigned — drop the index now that it
    // is (best-effort; the addBid TTL is the backstop if this fails).
    bidsStore.clearBids(taskId).catch(() => {});

    // Fire webhook for task assignment (non-blocking)
    try {
      const { fireWebhooks } = await import('../services/webhookStore.js');
      fireWebhooks(address, 'task_assigned', { taskId, rootHash: meta.rootHash }).catch(() => {});
    } catch { /* webhook module optional */ }
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
    if (meta.requiredCapabilities.length > 0) {
      const hasAll = meta.requiredCapabilities.every((c) => agent.capabilities.includes(c));
      if (!hasAll) {
        throw new AppError(
          403,
          'CAPABILITY_MISMATCH',
          `Need all of: ${meta.requiredCapabilities.join(', ')}`,
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
  rootHash: string | undefined,
): void {
  setTimeout(async () => {
    try {
      const state = await a2aStore.getState(taskHash);
      if (!state || state.status !== 'open') return;

      const next = await a2aStore.advanceCascade(taskHash);
      if (!next) {
        emitTaskAvailable(taskHash, { requiredCapabilities: requiredCaps });
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
      emitTaskOffer(next.address, taskHash, {
        requiredCapabilities: requiredCaps,
      }, next.score, deadline);

      scheduleCascadeAdvance(taskHash, requiredCaps, rootHash);
    } catch (err) {
      console.error(`[a2a] cascade advance failed for ${taskHash.slice(0, 10)}…:`, (err as Error).message);
    }
  }, a2aStore.CASCADE_OFFER_MS);
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
    let receipt = await provider.getTransactionReceipt(data.txHash);
    for (let i = 0; i < 8 && !receipt; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      receipt = await provider.getTransactionReceipt(data.txHash);
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
      if (!wrappedKeysNormalized?.[data.verifierAddress.toLowerCase()]) {
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
      const onChainVerifier = await escrowService.getTaskVerifier(Number(onChainTaskId));
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

    await a2aStore.setMeta({
      taskId: taskHash,
      targetExecutorType: 'agent',
      verificationMode: data.verificationMode ?? 'manual',
      verificationCriteria: data.verificationCriteria,
      requiredCapabilities: requiredCaps,
      posterAddress: address,
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
    if (!config.cascadeEnabled || requiredCaps.length === 0) {
      emitTaskAvailable(taskHash, requiredCaps.length > 0 ? { requiredCapabilities: requiredCaps } : {});
    } else if (requiredCaps.length > 0) {
      const taskRewardWei = onChainAmount;
      rankAgents(requiredCaps, taskRewardWei).then((ranked) => {
        if (ranked.length === 0) {
          emitTaskAvailable(taskHash, { requiredCapabilities: requiredCaps });
          return;
        }
        const cascadeEntries = ranked.map((r) => ({
          address: r.address,
          score: r.score,
          displayName: r.displayName,
        }));
        a2aStore.setCascade(taskHash, cascadeEntries).catch(() => {});
        // Offer to position 0
        const best = ranked[0];
        const deadline = Date.now() + a2aStore.CASCADE_OFFER_MS;
        a2aStore.setOffer(taskHash, {
          address: best.address,
          score: best.score,
          expiresAt: deadline,
        }).catch(() => {});
        // rootHash deliberately omitted — unauthenticated WS room, see above.
        emitTaskOffer(best.address, taskHash, {
          requiredCapabilities: requiredCaps,
        }, best.score, deadline);
        // Schedule advancement after the per-position window
        scheduleCascadeAdvance(taskHash, requiredCaps, data.rootHash);
      }).catch((err) => {
        console.error(`[a2a] scoring/offer failed for ${taskHash.slice(0, 10)}…:`, (err as Error).message);
        emitTaskAvailable(taskHash, { requiredCapabilities: requiredCaps });
      });
    } else {
      emitTaskAvailable(taskHash, {});
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

    // Single on-chain assignment check. /accept now awaits settleAssignment,
    // so the assignment should already be confirmed. This is just a defensive
    // sanity check with one retry in case of RPC lag. Also captures the
    // current on-chain submissionAttempts so the state below can record which
    // round the pending evidence broadcast will become.
    let chainAttempts = 0;
    const onChainTask = await escrowService.getTask(Number(onChainId));
    chainAttempts = onChainTask.submissionAttempts;
    if (onChainTask.worker.toLowerCase() !== address.toLowerCase()) {
      // One retry after 2s — covers edge cases like reorgs.
      await new Promise((r) => setTimeout(r, 2_000));
      const retryTask = await escrowService.getTask(Number(onChainId));
      chainAttempts = retryTask.submissionAttempts;
      if (retryTask.worker.toLowerCase() !== address.toLowerCase()) {
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
      const t = await escrowService.getTask(Number(onChainId));
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
      unsignedSubmitEvidence = await escrowService.buildSubmitEvidence(
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
    });
    console.log(`[a2a] submit: resultData stored and unsignedSubmitEvidence built for ${taskHash}`);

    // Fire webhook for task submission (non-blocking)
    try {
      const { fireWebhooks } = await import('../services/webhookStore.js');
      fireWebhooks(address, 'task_submitted', { taskId: taskHash }).catch(() => {});
    } catch { /* webhook module optional */ }

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
      const ocIdA = await getTaskIdByHash(taskHash);
      if (!ocIdA) {
        throw new AppError(503, 'NOT_INDEXED', 'On-chain taskId not yet indexed — wait a few seconds and retry');
      }
      const tA = await escrowService.getTask(Number(ocIdA));
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
    // the task would stick permanently.
    const ocId = await getTaskIdByHash(taskHash);
    if (!ocId) {
      throw new AppError(
        503,
        'NOT_INDEXED',
        'On-chain taskId not yet indexed — wait a few seconds and retry',
      );
    }
    const onChainTask = await escrowService.getTask(Number(ocId));

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
        await recordWorkerPayout(taskHash, address, ocId, onChainTask.amount, { serviceId: meta.serviceId });
      } else {
        await recordWorkerDispute(taskHash, address);
      }
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
    const settle = await settleVerification(taskHash, verificationResult.passed);
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
      await recordWorkerPayout(taskHash, address, ocId, onChainTask.amount, { serviceId: meta.serviceId });
    } else {
      await recordWorkerDispute(taskHash, address);
    }

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
    const ocId = await getTaskIdByHash(taskHash);
    if (!ocId) {
      throw new AppError(
        503,
        'NOT_INDEXED',
        'On-chain taskId not yet indexed — wait a few seconds and retry',
      );
    }
    const onChainTask = await escrowService.getTask(Number(ocId));

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
      await recordWorkerPayout(taskHash, state.executorAddress, ocId, onChainTask.amount);
    } else if (!passed && state.executorAddress) {
      await recordWorkerDispute(taskHash, state.executorAddress);
    }

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
    const ocId = await getTaskIdByHash(taskHash);
    if (!ocId) {
      throw new AppError(503, 'NOT_INDEXED', 'On-chain taskId not yet indexed — retry shortly');
    }
    const onChainTask = await escrowService.getTask(Number(ocId));
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
      const onChainVerifier = await escrowService.getTaskVerifier(Number(ocId));
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
      await recordWorkerPayout(taskHash, state.executorAddress, ocId, onChainTask.amount);
    } else if (!passed && state.executorAddress) {
      await recordWorkerDispute(taskHash, state.executorAddress);
    }

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
    const verifications = await Promise.all(
      pending.map(async (t) => ({
        ...t,
        onChainId: await getTaskIdByHash(t.meta.taskId).catch(() => null),
      })),
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
          const onChainId = await getTaskIdByHash(t.meta.taskId);
          if (!onChainId) return { ...t, wrapCount, hasCustody, onChain: null };
          const onChainTask = await escrowService.getTask(Number(onChainId));
          return {
            ...t,
            wrapCount,
            hasCustody,
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
          return { ...t, wrapCount, hasCustody, onChain: null };
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
