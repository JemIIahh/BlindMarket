import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { canViewerSeeResult } from '../services/resultVisibility.js';
import { AppError } from '../middleware/errorHandler.js';
import * as escrowService from '../services/escrow.js';
import * as registryService from '../services/registry.js';
import { getTokenDecimals } from '../services/chain.js';
import type { AuthRequest, ApiResponse } from '../types.js';
import { AGENT_CAPABILITIES } from '../types.js';
import * as a2aStore from '../services/a2aStore.js';
import { redis } from '../services/redis.js';
import { randomUUID } from 'crypto';
import * as accountingService from '../services/accountingService.js';
import { getDb } from '../services/database.js';
import { rooms } from '../services/socket.js';

export const tasksRouter = Router();

// --- Schemas ---
const createTaskSchema = z.object({
  taskHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a bytes32 hex string'),
  token: z.string().regex(/^0x[0-9a-fA-F]{40,66}$/, 'Invalid token address'),
  amount: z.string().min(1, 'Amount required'), // bigint as string
  locationZone: z.string().min(1).max(128),
  duration: z.string().min(1, 'Duration required'), // seconds as string
  // A2A optional fields
  targetExecutorType: z.enum(['human', 'agent']).optional(),
  verificationMode: z.enum(['manual', 'auto', 'oracle', 'agent']).optional(),
  // Poster-designated verifier (verificationMode='agent'). When present the
  // unsigned tx targets createTaskWithVerifier so the verifier is committed
  // on-chain at task creation (the poster signs it, not the platform).
  verifierAddress: z.string().regex(/^0x[0-9a-fA-F]{40,66}$/, 'Invalid verifier address').optional(),
  verificationCriteria: z.object({
    required_fields: z.array(z.string()).optional(),
    min_length: z.number().int().positive().optional(),
    contains_keywords: z.array(z.string()).optional(),
    max_length: z.number().int().positive().optional(),
    expected_answer: z.string().optional(),
    forbidden_phrases: z.array(z.string()).optional(),
    regex_pattern: z.string().max(200).optional(),
    expected_schema: z.object({
      type: z.string().optional(),
      required: z.array(z.string()).optional(),
      properties: z.record(z.object({ type: z.string().optional() })).optional(),
    }).optional(),
    rubric: z.array(z.object({
      criterion: z.string(),
      keywords: z.array(z.string()).optional(),
      min_mentions: z.number().int().positive().optional(),
      weight: z.number().positive().optional(),
    })).optional(),
    pass_threshold: z.number().min(0).max(100).optional(),
  }).optional(),
  requiredCapabilities: z.array(z.enum(AGENT_CAPABILITIES as unknown as [string, ...string[]])).optional(),
  // 0G Storage root hash of the AES-encrypted brief. Required for the
  // encrypted-flow demo; absent for legacy/H2H tasks that don't use the
  // decryption pipeline.
  rootHash: z.string().min(1).max(256).optional(),
  // Map of lowercased executor address → hex ECIES blob (AES key wrapped to
  // that executor's pubkey, browser-side at post time). Keys must be valid
  // 0x-prefixed EOA addresses; values are hex strings of the wrapped blob.
  // Cap at 200 entries — way above realistic executor pool, well below abuse
  // territory (200 * ~200 bytes = ~40KB inline, comfortable for Redis).
  wrappedKeys: z
    .record(
      z.string().regex(/^0x[0-9a-fA-F]{40,66}$/, 'wrappedKeys address must be 0x-prefixed hex'),
      z.string().regex(/^[0-9a-fA-F]+$/, 'wrappedKeys value must be hex (no 0x prefix)').min(2).max(8192),
    )
    .refine((m) => Object.keys(m).length <= 200, { message: 'wrappedKeys cannot exceed 200 entries' })
    .optional(),
});

const applySchema = z.object({
  message: z.string().max(500).optional(),
});

const assignSchema = z.object({
  worker: z.string().regex(/^0x[0-9a-fA-F]{40,66}$/, 'Invalid worker address'),
});

// --- Helpers ---
function serializeBigInts(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = typeof value === 'bigint' ? value.toString() : value;
  }
  return result;
}

/**
 * GET /api/v1/tasks
 * List open tasks from TaskRegistry (paginated).
 */
// Public list — handler is unauthenticated, but the typed request lets us
// optionally log the caller's address if an Authorization header happens to be
// attached (some clients always send one). The route does NOT use requireAuth.
tasksRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    console.log(`[tasks] GET / list: offset=${offset}, limit=${limit}, user=${req.user?.address || 'public'}`);

    let tasks: Record<string, unknown>[] = [];
    let total = 0;
    let chainError: string | null = null;
    try {
      const rawTasks = await registryService.getOpenTasks(offset, limit);
      total = await registryService.openTaskCount();

      // Enrich with token + taskHash from escrow. We need taskHash here so
      // we can ask a2aStore which tasks are indexed for the executor board —
      // tasks created before the current code path was wired up have no
      // a2a:meta entry and are unreachable through /a2a (stranded).
      const enriched = await Promise.all(rawTasks.map(async (t) => {
        const taskId = Number(t.taskId);
        try {
          const escrowTask = await escrowService.getTask(taskId);
          const decimals = await getTokenDecimals(escrowTask.token);
          return {
            ...serializeBigInts(t as unknown as Record<string, unknown>),
            token: escrowTask.token,
            taskHash: escrowTask.taskHash,
            decimals,
          };
        } catch (err) {
          return serializeBigInts(t as unknown as Record<string, unknown>);
        }
      }));

      // Single batched Redis EXISTS check across all hashes in this page.
      const hashes = enriched
        .map((t) => (t.taskHash as string | undefined))
        .filter((h): h is string => typeof h === 'string');
      const indexed = await a2aStore.getIndexedHashes(hashes);
      tasks = enriched.map((t) => ({
        ...t,
        a2aIndexed:
          typeof t.taskHash === 'string'
            ? indexed.has((t.taskHash as string).toLowerCase())
            : false,
      }));
    } catch (chainErr) {
      // Surface chain failures so the UI can show a real error instead of
      // pretending the list is empty. Frontends can still render a graceful
      // empty state by inspecting data.chainError.
      chainError = (chainErr as Error).message || 'chain call failed';
      console.warn('[tasks] Chain call failed:', chainError);
    }

    const body: ApiResponse = {
      success: true,
      data: {
        tasks,
        total,
        offset,
        limit,
        hasMore: offset + tasks.length < total,
        ...(chainError ? { chainError } : {}),
      },
    };
    const replacer = (key: string, value: any) => typeof value === 'bigint' ? value.toString() : value;
    res.json(JSON.parse(JSON.stringify(body, replacer)));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/tasks/:id
 * Get full task details from BlindEscrow + TaskRegistry metadata.
 */
tasksRouter.get('/:id', optionalAuth, async (req: AuthRequest, res, next) => {
  try {
    const rawId = req.params.id;

    const isHexHash = /^0x[0-9a-fA-F]{64}$/.test(rawId);
    let taskId: number;
    if (isHexHash) {
      const hashKey = `a2a:hash2id:${rawId.toLowerCase()}`;
      const resolved = await redis.get(hashKey);
      if (!resolved || !/^\d+$/.test(resolved)) {
        throw new AppError(404, 'NOT_INDEXED_YET', 'Task hash not found — create transaction may not be confirmed or indexed yet. Retry in a few seconds.');
      }
      taskId = parseInt(resolved, 10);
    } else {
      if (!/^\d+$/.test(rawId)) {
        throw new AppError(400, 'INVALID_TASK_ID', 'Task ID must be a positive integer or a 0x-prefixed task hash');
      }
      taskId = parseInt(rawId, 10);
    }

    const [task, meta] = await Promise.all([
      escrowService.getTask(taskId).catch((err) => {
        if ((err as Error).message?.includes('could not decode result data')) {
          throw new AppError(404, 'NOT_FOUND', 'Task not found on chain');
        }
        throw err;
      }),
      registryService.getTaskMeta(taskId).catch(() => null),
    ]);

    const taskHash = task.taskHash;
    const decimals = await getTokenDecimals(task.token);
    // Same flag as the list endpoint — lets the detail page surface the
    // stranded notice when a Funded task can never be picked up by an agent.
    const indexedSet = await a2aStore.getIndexedHashes([taskHash]);
    const a2aIndexed = indexedSet.has(taskHash.toLowerCase());

    // Fetch A2A off-chain state so TaskDetail can show agent output / verification result
    const [a2aMeta, a2aState] = await Promise.all([
      a2aStore.getMeta(taskHash),
      a2aStore.getState(taskHash),
    ]);

    // The deliverable (resultData) is poster/worker-only — except on PUBLIC
    // tasks, where the poster opted out of blindness and the result is part
    // of the public record. Viewer addresses come from optionalAuth (Privy
    // JWT wallets, agent platform JWT, or API key). When the poster is a
    // deployed agent, its human owner(s) qualify too. Gate shared with the
    // MCP get_task_status tool — see resultVisibility.ts.
    let canSeeResult = a2aMeta?.privacy === 'public';
    if (!canSeeResult && a2aState?.resultData != null && req.user) {
      canSeeResult = await canViewerSeeResult(req.user, String(task.agent), String(task.worker));
    }

    const body: ApiResponse = {
      success: true,
      data: {
        ...serializeBigInts(task as unknown as Record<string, unknown>),
        taskId: taskId.toString(), // Include numeric ID explicitly
        a2aIndexed,
        // Public projection — this route has no auth, and full A2A meta
        // carries the brief's key material (wrappedKeys/keyCustodyBlob) plus
        // the storage pointer. Strip it; the executor's slice travels only in
        // the authenticated /a2a/tasks/:id/accept response.
        a2aMeta: a2aMeta ? a2aStore.projectPublicMeta(a2aMeta) : null,
        // Strip operator-internal diagnostics (assignError/verifyError) on this
        // surface. resultData (the deliverable) is attached only for the
        // poster, the assigned worker, or the poster-agent's owner(s).
        a2aState: a2aState
          ? { ...a2aStore.projectPublicState(a2aState), resultData: canSeeResult ? a2aState.resultData ?? null : null }
          : null,
        meta: meta ? {
          ...serializeBigInts(meta as unknown as Record<string, unknown>),
          decimals,
        } : null,
        decimals,
      },
    };
    const replacer = (key: string, value: any) => typeof value === 'bigint' ? value.toString() : value;
    res.json(JSON.parse(JSON.stringify(body, replacer)));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/tasks
 * Build unsigned createTask transaction for frontend to sign.
 */
tasksRouter.post('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const data = createTaskSchema.parse(req.body);
    const from = req.user!.address;

    const amountBigInt = BigInt(data.amount);
    const isNative = data.token === '0x0000000000000000000000000000000000000000';

    const tx = await escrowService.buildCreateTask(
      from,
      data.taskHash,
      data.token,
      amountBigInt,
      'general',
      data.locationZone,
      BigInt(data.duration),
      isNative ? amountBigInt : undefined,
      data.verificationMode === 'agent' ? data.verifierAddress : undefined,
    );

    // Note: A2A meta is NOT written here. Doing so unconditionally produced
    // phantom Redis entries (createTask reverts with TokenNotAllowed, gas
    // shortfall, etc. → no TaskCreated event → indexer can't resolve the
    // hash → submit fails forever with NOT_INDEXED). The poster's frontend
    // must call POST /api/v1/a2a/tasks/index AFTER the tx confirms; that
    // endpoint verifies the receipt and the TaskCreated event before writing
    // anything. See routes/a2a.ts for the verified-write path.

    // Record escrow_lock accounting event
    try {
      const decimals = await getTokenDecimals(data.token);
      accountingService.recordTransaction({
        address: from,
        role: 'agent',
        taskId: data.taskHash,
        type: 'escrow_lock',
        amount: Number(data.amount) / (10 ** decimals),
      });
    } catch (accErr) {
      console.warn('[tasks] Accounting record failed (non-blocking):', accErr);
    }

    const body: ApiResponse = {
      success: true,
      data: { unsignedTx: tx },
    };
    rooms.tasks('task:created', { locationZone: data.locationZone, amount: data.amount });
    rooms.platform('stats:update', {});
    
    // Custom replacer to handle BigInt serialization
    res.json(JSON.parse(JSON.stringify(body, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/tasks/:id/apply
 * Record a task application (in-memory store).
 */
tasksRouter.post('/:id/apply', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskId = req.params.id as string;
    const { message } = applySchema.parse(req.body);
    const applicant = req.user!.address;
    const db = getDb();

    const existing = db.prepare('SELECT id FROM applications WHERE task_id = ? AND applicant = ?').get(taskId, applicant);
    if (existing) throw new AppError(409, 'ALREADY_APPLIED', 'Already applied to this task');

    const id = randomUUID();
    db.prepare('INSERT INTO applications (id, task_id, applicant, message) VALUES (?, ?, ?, ?)').run(id, taskId, applicant, message ?? null);

    res.status(201).json({ success: true, data: { application_id: id } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/tasks/:id/applications
 * List applicants for a task (agent only — shows reputation, not identity).
 */
tasksRouter.get('/:id/applications', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rawId = req.params.id as string;
    if (!/^\d+$/.test(rawId)) {
      throw new AppError(400, 'INVALID_TASK_ID', 'Task ID must be a positive integer');
    }
    const from = req.user!.address;

    // Authorization: applicant identities (wallet address + message) are visible
    // ONLY to the task's poster. requireAuth alone previously let any authenticated
    // wallet enumerate every task's applicants, deanonymizing bidders. Mirror the
    // ownership check used by POST /:id/assign below.
    const task = await escrowService.getTask(parseInt(rawId, 10));
    if (from === 'agent' || task.agent.toLowerCase() !== from.toLowerCase()) {
      throw new AppError(403, 'FORBIDDEN', 'Only the task poster can view applicants');
    }

    const db = getDb();
    const taskApps = db.prepare('SELECT * FROM applications WHERE task_id = ? ORDER BY created_at ASC').all(rawId);
    res.json({ success: true, data: { applications: taskApps } } satisfies ApiResponse);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/tasks/:id/assign
 * Build unsigned assignWorker transaction.
 */
tasksRouter.post('/:id/assign', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rawId = req.params.id as string;
    if (!/^\d+$/.test(rawId)) {
      throw new AppError(400, 'INVALID_TASK_ID', 'Task ID must be a positive integer');
    }
    const taskId = parseInt(rawId, 10);

    const { worker } = assignSchema.parse(req.body);
    const from = req.user!.address;

    // Verify caller is the task agent (on-chain check will also enforce, but
    // fail early). The legacy AGENT_API_KEY principal resolves to the literal
    // string 'agent' — it has no EOA, so ethers.getAddress('agent') would throw
    // a 500 inside buildAssignWorker; assignWorker is onlyAgent on-chain and
    // must be signed by the task agent's real wallet. Refuse it cleanly.
    const task = await escrowService.getTask(taskId);
    if (from === 'agent' || task.agent.toLowerCase() !== from.toLowerCase()) {
      throw new AppError(403, 'FORBIDDEN', 'Only the task agent (wallet-authenticated) can assign workers');
    }

    const tx = await escrowService.buildAssignWorker(from, taskId, worker);

    const body: ApiResponse = {
      success: true,
      data: { unsignedTx: tx },
    };
    // NOTE: no task:assigned emit here — this route only BUILDS the unsigned
    // tx. The poster may never sign it; emitting at build time made dashboards
    // refetch a still-Funded task. Listeners learn of the real assignment from
    // on-chain state after the signed tx confirms.
    const replacer = (key: string, value: any) => typeof value === 'bigint' ? value.toString() : value;
    res.json(JSON.parse(JSON.stringify(body, replacer)));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/tasks/:id/cancel
 * Build unsigned cancelTask transaction.
 */
tasksRouter.post('/:id/cancel', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rawId = req.params.id as string;
    if (!/^\d+$/.test(rawId)) {
      throw new AppError(400, 'INVALID_TASK_ID', 'Task ID must be a positive integer');
    }
    const taskId = parseInt(rawId, 10);

    const from = req.user!.address;

    // Verify caller is the task agent
    const task = await escrowService.getTask(taskId);
    // The legacy 'agent' API-key principal has no EOA — buildUnsignedTx would
    // 500 on ethers.getAddress('agent'); this tx must be signed by the task
    // agent's real wallet (onlyAgent on-chain). Refuse it cleanly.
    if (from === 'agent' || task.agent.toLowerCase() !== from.toLowerCase()) {
      throw new AppError(403, 'FORBIDDEN', 'Only the task agent can cancel tasks');
    }

    const tx = await escrowService.buildCancelTask(from, taskId);

    // Record refund accounting event
    try {
      const decimals = await getTokenDecimals(task.token);
      const amount = Number(task.amount) / (10 ** decimals);
      accountingService.recordTransaction({
        address: from,
        role: 'agent',
        taskId: String(taskId),
        type: 'refund',
        amount,
      });
    } catch (accErr) {
      console.warn('[tasks] Accounting record failed (non-blocking):', accErr);
    }

    const body: ApiResponse = {
      success: true,
      data: { unsignedTx: tx },
    };
    const replacer = (key: string, value: any) => typeof value === 'bigint' ? value.toString() : value;
    res.json(JSON.parse(JSON.stringify(body, replacer)));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/tasks/:id/timeout
 * Build unsigned claimTimeout transaction.
 */
tasksRouter.post('/:id/timeout', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rawId = req.params.id as string;
    if (!/^\d+$/.test(rawId)) {
      throw new AppError(400, 'INVALID_TASK_ID', 'Task ID must be a positive integer');
    }
    const taskId = parseInt(rawId, 10);

    const from = req.user!.address;

    // Verify caller is the task agent
    const task = await escrowService.getTask(taskId);
    // The legacy 'agent' API-key principal has no EOA — buildUnsignedTx would
    // 500 on ethers.getAddress('agent'); this tx must be signed by the task
    // agent's real wallet (onlyAgent on-chain). Refuse it cleanly.
    if (from === 'agent' || task.agent.toLowerCase() !== from.toLowerCase()) {
      throw new AppError(403, 'FORBIDDEN', 'Only the task agent can reclaim funds');
    }

    // Check if deadline passed
    if (BigInt(Math.floor(Date.now() / 1000)) < task.deadline) {
      throw new AppError(400, 'DEADLINE_NOT_REACHED', 'Cannot reclaim before deadline');
    }

    const tx = await escrowService.buildClaimTimeout(from, taskId);

    // Record refund accounting event
    try {
      const decimals = await getTokenDecimals(task.token);
      const amount = Number(task.amount) / (10 ** decimals);
      accountingService.recordTransaction({
        address: from,
        role: 'agent',
        taskId: String(taskId),
        type: 'refund',
        amount,
      });
    } catch (accErr) {
      console.warn('[tasks] Accounting record failed (non-blocking):', accErr);
    }

    const body: ApiResponse = {
      success: true,
      data: { unsignedTx: tx },
    };
    const replacer = (key: string, value: any) => typeof value === 'bigint' ? value.toString() : value;
    res.json(JSON.parse(JSON.stringify(body, replacer)));
  } catch (err) {
    next(err);
  }
});
