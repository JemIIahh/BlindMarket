import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import * as escrowService from '../services/escrow.js';
import * as registryService from '../services/registry.js';
import { getTokenDecimals } from '../services/chain.js';
import type { AuthRequest, ApiResponse, AgentCapability } from '../types.js';
import { AGENT_CAPABILITIES } from '../types.js';
import * as a2aStore from '../services/a2aStore.js';
import { randomUUID } from 'crypto';
import * as accountingService from '../services/accountingService.js';
import { getDb } from '../services/database.js';
import { rooms } from '../services/socket.js';

export const tasksRouter = Router();

// --- Schemas ---
const createTaskSchema = z.object({
  taskHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a bytes32 hex string'),
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid token address'),
  amount: z.string().min(1, 'Amount required'), // bigint as string
  category: z.string().min(1).max(64),
  locationZone: z.string().min(1).max(128),
  duration: z.string().min(1, 'Duration required'), // seconds as string
  // A2A optional fields
  targetExecutorType: z.enum(['human', 'agent']).optional(),
  verificationMode: z.enum(['manual', 'auto', 'oracle']).optional(),
  verificationCriteria: z.object({
    required_fields: z.array(z.string()).optional(),
    min_length: z.number().int().positive().optional(),
    contains_keywords: z.array(z.string()).optional(),
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
      z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'wrappedKeys address must be 0x-prefixed EOA hex'),
      z.string().regex(/^[0-9a-fA-F]+$/, 'wrappedKeys value must be hex (no 0x prefix)').min(2).max(8192),
    )
    .refine((m) => Object.keys(m).length <= 200, { message: 'wrappedKeys cannot exceed 200 entries' })
    .optional(),
});

const applySchema = z.object({
  message: z.string().max(500).optional(),
});

const assignSchema = z.object({
  worker: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid worker address'),
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
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/tasks/:id
 * Get full task details from BlindEscrow + TaskRegistry metadata.
 */
tasksRouter.get('/:id', async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id);
    if (isNaN(taskId) || taskId < 1) {
      throw new AppError(400, 'INVALID_TASK_ID', 'Task ID must be a positive integer');
    }

    const [task, meta] = await Promise.all([
      escrowService.getTask(taskId),
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

    const body: ApiResponse = {
      success: true,
      data: {
        ...serializeBigInts(task as unknown as Record<string, unknown>),
        taskId: taskId.toString(), // Include numeric ID explicitly
        a2aIndexed,
        a2aMeta: a2aMeta ?? null,
        a2aState: a2aState ? { ...a2aState, resultData: a2aState.resultData ?? null } : null,
        meta: meta ? {
          ...serializeBigInts(meta as unknown as Record<string, unknown>),
          decimals,
        } : null,
        decimals,
      },
    };
    res.json(body);
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
      data.category,
      data.locationZone,
      BigInt(data.duration),
      isNative ? amountBigInt : undefined,
    );

    // Store A2A metadata if this is an agent-targeted task
    if (data.targetExecutorType === 'agent') {
      // Lowercase wrappedKeys addresses so /accept can look up the slice using
      // the same key regardless of EIP-55 vs lowercase form in the request.
      const wrappedKeysNormalized = data.wrappedKeys
        ? Object.fromEntries(
            Object.entries(data.wrappedKeys).map(([addr, blob]) => [addr.toLowerCase(), blob]),
          )
        : undefined;
      // Use taskHash as a stable ID (actual on-chain taskId isn't known until tx confirms)
      await a2aStore.setMeta({
        taskId: data.taskHash,
        targetExecutorType: data.targetExecutorType,
        verificationMode: data.verificationMode ?? 'manual',
        verificationCriteria: data.verificationCriteria,
        requiredCapabilities: (data.requiredCapabilities ?? []) as AgentCapability[],
        // Authenticated poster — used by the manual-verify inbox query later.
        posterAddress: from,
        rootHash: data.rootHash,
        wrappedKeys: wrappedKeysNormalized,
      });
    }

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
    rooms.tasks('task:created', { category: data.category, locationZone: data.locationZone, amount: data.amount });
    rooms.platform('stats:update', {});
    res.json(body);
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
    const taskId = req.params.id;
    const db = getDb();
    const taskApps = db.prepare('SELECT * FROM applications WHERE task_id = ? ORDER BY created_at ASC').all(taskId);
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
    const taskId = parseInt(req.params.id as string);
    if (isNaN(taskId) || taskId < 1) {
      throw new AppError(400, 'INVALID_TASK_ID', 'Task ID must be a positive integer');
    }

    const { worker } = assignSchema.parse(req.body);
    const from = req.user!.address;

    // Verify caller is the task agent (on-chain check will also enforce, but fail early)
    const task = await escrowService.getTask(taskId);
    if (task.agent.toLowerCase() !== from.toLowerCase() && from !== 'agent') {
      throw new AppError(403, 'FORBIDDEN', 'Only the task agent can assign workers');
    }

    const tx = await escrowService.buildAssignWorker(from, taskId, worker);

    const body: ApiResponse = {
      success: true,
      data: { unsignedTx: tx },
    };
    rooms.task(taskId, 'task:assigned', { taskId, worker });
    rooms.tasks('task:assigned', { taskId, worker });
    res.json(body);
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
    const taskId = parseInt(req.params.id as string);
    if (isNaN(taskId) || taskId < 1) {
      throw new AppError(400, 'INVALID_TASK_ID', 'Task ID must be a positive integer');
    }

    const from = req.user!.address;

    // Verify caller is the task agent
    const task = await escrowService.getTask(taskId);
    if (task.agent.toLowerCase() !== from.toLowerCase() && from !== 'agent') {
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
    res.json(body);
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
    const taskId = parseInt(req.params.id as string);
    if (isNaN(taskId) || taskId < 1) {
      throw new AppError(400, 'INVALID_TASK_ID', 'Task ID must be a positive integer');
    }

    const from = req.user!.address;

    // Verify caller is the task agent
    const task = await escrowService.getTask(taskId);
    if (task.agent.toLowerCase() !== from.toLowerCase() && from !== 'agent') {
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
    res.json(body);
  } catch (err) {
    next(err);
  }
});
