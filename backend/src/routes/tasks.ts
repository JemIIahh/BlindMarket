import { Router } from 'express';
import { z } from 'zod';
import { storageIdSchema } from '../services/storageId.js';
import { ethers } from 'ethers';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { canViewerSeeResult } from '../services/resultVisibility.js';
import { AppError } from '../middleware/errorHandler.js';
import * as escrowService from '../services/escrow.js';
import * as registryService from '../services/registry.js';
import { getTokenDecimals } from '../services/chain.js';
import { chainRuntime } from '../services/chainRuntime.js';
import { isSettlementChainKey, postingChain, settlementChainConfig } from '../services/settlementChains.js';
import { payoutCurrency } from '../services/settlementUnits.js';
import { isIndexedTask, resolvePosterTask, resolveCachedTaskByHash, type TaskChain } from '../services/taskChain.js';
import { callerWallets } from '../services/callerWallets.js';
import type { AuthRequest, ApiResponse } from '../types.js';
import { AGENT_CAPABILITIES } from '../types.js';
import * as a2aStore from '../services/a2aStore.js';
import { randomUUID } from 'crypto';
import * as accountingService from '../services/accountingService.js';
import { getDb } from '../services/database.js';
import { getPool } from '../services/neonDb.js';
import { config } from '../config.js';
import { rooms } from '../services/socket.js';
import { isSafeRegexSource } from '../services/rubricEngine.js';

export const tasksRouter = Router();

/**
 * The settlement chain a refund-route client names for its task (`chain` in
 * the body or query), or undefined when it names none. Numeric ids collide
 * across chains, so a client that knows the chain passes it and the route
 * reads only that escrow.
 */
function requestedChain(req: AuthRequest): TaskChain | undefined {
  const raw = (req.body as { chain?: unknown } | undefined)?.chain ?? req.query.chain;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (!isSettlementChainKey(raw)) {
    throw new AppError(400, 'INVALID_CHAIN', `Unknown settlement chain ${JSON.stringify(raw)}`);
  }
  return raw;
}

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
  rootHash: storageIdSchema.optional(),
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

function usePg(): boolean {
  return Boolean(config.databaseUrl);
}

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
 *
 * 0G only, by design: the TaskRegistry and the numeric ids it lists belong to
 * the 0G escrow. Tasks on other settlement chains are listed by /a2a/tasks.
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
    // Ids collide across chains, so a numeric id is read on the posting chain,
    // where new tasks live (as MCP get_task_status does); a hash names exactly
    // one task, so it resolves to whichever chain holds it.
    let chain: TaskChain = postingChain();
    if (isHexHash) {
      const resolved = await resolveCachedTaskByHash(rawId.toLowerCase());
      if (!resolved || !/^\d+$/.test(resolved.taskId)) {
        throw new AppError(404, 'NOT_INDEXED_YET', 'Task hash not found — create transaction may not be confirmed or indexed yet. Retry in a few seconds.');
      }
      taskId = parseInt(resolved.taskId, 10);
      chain = resolved.chain;
    } else {
      if (!/^\d+$/.test(rawId)) {
        throw new AppError(400, 'INVALID_TASK_ID', 'Task ID must be a positive integer or a 0x-prefixed task hash');
      }
      taskId = parseInt(rawId, 10);
    }

    const [task, meta] = await Promise.all([
      escrowService.getTaskOn(chain, taskId).catch((err) => {
        if ((err as Error).message?.includes('could not decode result data')) {
          throw new AppError(404, 'NOT_FOUND', 'Task not found on chain');
        }
        throw err;
      }),
      // The TaskRegistry lives on 0G; reading it with another chain's id would
      // return the meta of an unrelated 0G task that happens to share the number.
      settlementChainConfig(chain).hasTaskRegistry
        ? registryService.getTaskMeta(taskId).catch(() => null)
        : Promise.resolve(null),
    ]);

    const taskHash = task.taskHash;
    const decimals = await getTokenDecimals(task.token, chain);
    // The token's symbol when it is the chain's settlement token, else null:
    // together with `decimals` this is the unit the reward is in, so the
    // detail page no longer assumes every task is priced like a new one.
    const symbol = payoutCurrency(chain, task.token)?.symbol ?? null;
    // Same flag as the list endpoint — lets the detail page surface the
    // stranded notice when a Funded task can never be picked up by an agent.
    // A2A state is keyed by hash, and a hash can be escrowed twice: serve it
    // only for the task the hash is indexed to (a hash lookup always is). A
    // duplicate's id otherwise reads the original's brief meta and result.
    const ownsA2a = isHexHash || await isIndexedTask(chain, taskId, taskHash);
    const indexedSet = ownsA2a ? await a2aStore.getIndexedHashes([taskHash]) : new Set<string>();
    const a2aIndexed = indexedSet.has(taskHash.toLowerCase());

    // Fetch A2A off-chain state so TaskDetail can show agent output / verification result
    const [a2aMeta, a2aState] = ownsA2a
      ? await Promise.all([a2aStore.getMeta(taskHash), a2aStore.getState(taskHash)])
      : [null, null];

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
        // Which escrow holds the task — the frontend picks the matching
        // chain explorer (Base vs 0G) for its hash/address links.
        chain,
        symbol,
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
// Mirror of AUTO_CHECK_KEYS / hasAutoCheck in routes/a2a.ts (POST
// /a2a/tasks/index) — keep the two identical. The index route refuses these
// modes too, but by then the escrow is already funded; refusing here stops
// the poster before they sign.
const AUTO_CHECK_KEYS = [
  'min_length',
  'contains_keywords',
  'required_fields',
  'expected_schema',
  'regex_pattern',
  'rubric',
  'expected_answer',
] as const;

// A criterion counts only if it can actually fail junk. forbidden_phrases
// alone cannot (junk simply omits the phrases — so it is not in the list
// above), nor can min_length: 0, blank strings, empty lists, a schema with
// neither type:'object' nor required keys, or a rubric item with no keywords
// (it scores a flat 0.5). An uncompilable regex_pattern is no check either;
// autoVerify fails closed on one rather than paying.
function hasAutoCheck(criteria: z.infer<typeof createTaskSchema>['verificationCriteria']): boolean {
  if (!criteria) return false;
  const anyText = (v?: string[]) => Array.isArray(v) && v.some((s) => typeof s === 'string' && s.trim().length > 0);
  if (typeof criteria.min_length === 'number' && criteria.min_length > 0) return true;
  if (anyText(criteria.contains_keywords) || anyText(criteria.required_fields)) return true;
  if (typeof criteria.expected_answer === 'string' && criteria.expected_answer.trim().length > 0) return true;
  if (criteria.expected_schema && (criteria.expected_schema.type === 'object' || anyText(criteria.expected_schema.required))) return true;
  if (criteria.rubric?.some((item) => anyText(item.keywords))) return true;
  if (typeof criteria.regex_pattern === 'string' && criteria.regex_pattern.trim().length > 0) {
    try {
      new RegExp(criteria.regex_pattern);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** A whole number sent as a string: decimal digits, or 0x hex as BigInt() reads it. Null otherwise. */
function parseWholeNumber(value: string): bigint | null {
  return /^(?:\d+|0x[0-9a-fA-F]+)$/.test(value) ? BigInt(value) : null;
}

tasksRouter.post('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const data = createTaskSchema.parse(req.body);
    const from = req.user!.address;

    if (data.verificationMode === 'oracle') {
      throw new AppError(
        400,
        'VERIFICATION_MODE_UNSUPPORTED',
        "verificationMode='oracle' is not supported — use 'manual', 'auto' or 'agent'",
      );
    }
    if (data.verificationMode === 'auto' && !hasAutoCheck(data.verificationCriteria)) {
      throw new AppError(
        400,
        'AUTO_CRITERIA_REQUIRED',
        `verificationMode='auto' requires verificationCriteria with at least one of: ${AUTO_CHECK_KEYS.join(', ')}`,
      );
    }
    // An auto task whose regex cannot run can never pass: autoVerify fails
    // closed on a pattern that does not compile or is prone to catastrophic
    // backtracking. Say so now, before the poster funds or lists it.
    if (data.verificationMode === 'auto' && typeof data.verificationCriteria?.regex_pattern === 'string') {
      const pattern = data.verificationCriteria.regex_pattern;
      let usable = isSafeRegexSource(pattern);
      if (usable) {
        try {
          new RegExp(pattern);
        } catch {
          usable = false;
        }
      }
      if (!usable) {
        throw new AppError(
          400,
          'REGEX_PATTERN_UNUSABLE',
          'verificationCriteria.regex_pattern does not compile or can backtrack catastrophically (nested or stacked quantifiers) — simplify it',
        );
      }
    }

    // Checked before the hash is claimed below. BigInt() on "1.5" or "" throws
    // a SyntaxError, which answered 500 and, for the duration, only after the
    // hash was already claimed for this poster.
    const amountBigInt = parseWholeNumber(data.amount);
    if (amountBigInt === null || amountBigInt <= 0n) {
      throw new AppError(
        400,
        'INVALID_AMOUNT',
        "amount must be a whole number above 0, in the token's smallest unit (USDC has 6 decimals: '1500000' is 1.5 USDC)",
      );
    }
    const durationBigInt = parseWholeNumber(data.duration);
    if (durationBigInt === null || durationBigInt <= 0n) {
      throw new AppError(400, 'INVALID_DURATION', 'duration must be a whole number of seconds above 0');
    }

    // New tasks are funded on this deployment's posting chain (POSTING_CHAIN,
    // else Base when it has an escrow, else 0G), in that chain's settlement
    // token. Any other token would revert TokenNotAllowed, or be refused
    // later by /a2a/tasks/index, with the poster's gas spent.
    const chain = postingChain();
    const { label, escrowAddress, escrowEnv, chainId, token } = settlementChainConfig(chain);
    if (!escrowAddress) {
      throw new AppError(503, 'CHAIN_NOT_CONFIGURED', `This backend has no ${label} escrow to post tasks on (${escrowEnv})`);
    }
    // Claim the hash for this poster before the tx exists, so nobody who
    // sees it on-chain can index it first (a2aStore.claimTaskHash). Refused
    // here, before any gas is spent, when another poster already holds it.
    const claim = await a2aStore.claimTaskHash(data.taskHash, from);
    if (!claim.mine) {
      throw new AppError(409, 'TASK_HASH_TAKEN', 'Another poster is already posting a task with this hash — post with a new brief');
    }
    if (!token.address || !payoutCurrency(chain, data.token)) {
      throw new AppError(
        400,
        'TOKEN_NOT_SETTLEMENT',
        `New tasks are escrowed in ${token.unit.symbol} on ${label} (token ${token.address ?? 'unset'}), not ${data.token}`,
      );
    }
    // The match above ignores letter case. Build with the registry's address,
    // checksummed afresh: a mixed-case spelling with a bad checksum, in the
    // request or in BASE_USDC_ADDRESS, would make ethers throw.
    const tokenAddress = ethers.getAddress(token.address.toLowerCase());
    const isNative = token.kind === 'native';

    const tx = await escrowService.buildCreateTaskOn(
      chain,
      from,
      data.taskHash,
      tokenAddress,
      amountBigInt,
      'general',
      data.locationZone,
      durationBigInt,
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

    // Record escrow_lock accounting event as PENDING (M5 audit): this handler
    // builds an unsigned tx — nothing is funded until it broadcasts. The
    // receipt-verified POST /a2a/tasks/index flips it to confirmed; an
    // abandoned build stays visibly pending instead of masquerading as funded.
    try {
      const decimals = await getTokenDecimals(tokenAddress, chain);
      accountingService.recordTransaction({
        address: from,
        role: 'agent',
        taskId: data.taskHash,
        type: 'escrow_lock',
        amount: Number(data.amount) / (10 ** decimals),
        unit: token.unit.symbol,
        status: 'pending',
      });
    } catch (accErr) {
      console.warn('[tasks] Accounting record failed (non-blocking):', accErr);
    }

    const body: ApiResponse = {
      success: true,
      // chain and chainId name where the tx must be sent.
      data: { unsignedTx: tx, chain, chainId },
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

    if (usePg()) {
      const pool = await getPool();
      const existing = await pool.query('SELECT id FROM applications WHERE task_id = $1 AND applicant = $2', [taskId, applicant]);
      if (existing.rows.length > 0) throw new AppError(409, 'ALREADY_APPLIED', 'Already applied to this task');

      const id = randomUUID();
      await pool.query('INSERT INTO applications (id, task_id, applicant, message) VALUES ($1, $2, $3, $4)', [id, taskId, applicant, message ?? null]);

      res.status(201).json({ success: true, data: { application_id: id } } satisfies ApiResponse);
      return;
    }

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

    if (usePg()) {
      const pool = await getPool();
      const taskApps = await pool.query('SELECT * FROM applications WHERE task_id = $1 ORDER BY created_at ASC', [rawId]);
      res.json({ success: true, data: { applications: taskApps.rows } } satisfies ApiResponse);
      return;
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

    // The legacy 'agent' API-key principal has no EOA — buildUnsignedTx would
    // 500 on ethers.getAddress('agent'); this tx must be signed by the task
    // agent's real wallet (onlyAgent on-chain). Refuse it cleanly.
    if (req.user!.address === 'agent') {
      throw new AppError(403, 'FORBIDDEN', 'Only the task agent can cancel tasks');
    }

    // The task may be escrowed on Base or on Arc; resolving by ownership also
    // does the agent check, since a chain where the caller isn't the agent
    // never matches. A client that names the chain gets only that chain. The
    // poster may be any of the caller's linked wallets, not only the session's
    // address, and the tx is built for the one that posted: it must sign.
    const resolved = await resolvePosterTask(taskId, callerWallets(req.user), requestedChain(req));
    if (!resolved) {
      throw new AppError(403, 'FORBIDDEN', 'Only the task agent can cancel tasks');
    }
    const { chain, poster: from } = resolved;

    const task = await escrowService.getTaskOn(chain, taskId);
    const tx = await escrowService.buildCancelTaskOn(chain, from, taskId);

    // Record refund accounting event as PENDING (M5 audit): unsigned-tx build
    // only. POST /tasks/:id/confirm-tx flips it once the cancel lands.
    try {
      const decimals = await getTokenDecimals(task.token, chain);
      const amount = Number(task.amount) / (10 ** decimals);
      accountingService.recordTransaction({
        address: from,
        role: 'agent',
        taskId: String(taskId),
        type: 'refund',
        amount,
        unit: payoutCurrency(chain, task.token)?.symbol,
        status: 'pending',
      });
    } catch (accErr) {
      console.warn('[tasks] Accounting record failed (non-blocking):', accErr);
    }

    const body: ApiResponse = {
      success: true,
      // chain and chainId name where the tx must be sent (a task lives on one chain).
      data: { unsignedTx: tx, chain, chainId: settlementChainConfig(chain).chainId },
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

    // The legacy 'agent' API-key principal has no EOA — buildUnsignedTx would
    // 500 on ethers.getAddress('agent'); this tx must be signed by the task
    // agent's real wallet (onlyAgent on-chain). Refuse it cleanly.
    if (req.user!.address === 'agent') {
      throw new AppError(403, 'FORBIDDEN', 'Only the task agent can reclaim funds');
    }

    // The task may be escrowed on Base or on Arc; resolving by ownership also
    // does the agent check, since a chain where the caller isn't the agent
    // never matches. A client that names the chain gets only that chain. The
    // poster may be any of the caller's linked wallets, not only the session's
    // address, and the tx is built for the one that posted: it must sign.
    const resolved = await resolvePosterTask(taskId, callerWallets(req.user), requestedChain(req));
    if (!resolved) {
      throw new AppError(403, 'FORBIDDEN', 'Only the task agent can reclaim funds');
    }
    const { chain, poster: from } = resolved;

    const task = await escrowService.getTaskOn(chain, taskId);

    // Check if deadline passed
    if (BigInt(Math.floor(Date.now() / 1000)) < task.deadline) {
      throw new AppError(400, 'DEADLINE_NOT_REACHED', 'Cannot reclaim before deadline');
    }

    const tx = await escrowService.buildClaimTimeoutOn(chain, from, taskId);

    // Record refund accounting event as PENDING (M5 audit): unsigned-tx build
    // only. POST /tasks/:id/confirm-tx flips it once the reclaim lands.
    try {
      const decimals = await getTokenDecimals(task.token, chain);
      const amount = Number(task.amount) / (10 ** decimals);
      accountingService.recordTransaction({
        address: from,
        role: 'agent',
        taskId: String(taskId),
        type: 'refund',
        amount,
        unit: payoutCurrency(chain, task.token)?.symbol,
        status: 'pending',
      });
    } catch (accErr) {
      console.warn('[tasks] Accounting record failed (non-blocking):', accErr);
    }

    const body: ApiResponse = {
      success: true,
      // chain and chainId name where the tx must be sent (a task lives on one chain).
      data: { unsignedTx: tx, chain, chainId: settlementChainConfig(chain).chainId },
    };
    const replacer = (key: string, value: any) => typeof value === 'bigint' ? value.toString() : value;
    res.json(JSON.parse(JSON.stringify(body, replacer)));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/tasks/:id/confirm-tx
 *
 * M5 (audit) companion to cancel/timeout: flips the build-time 'pending'
 * refund row to confirmed AFTER verifying the reclaim actually landed
 * on-chain. Requires receipt status=1 plus this task's TaskCancelled (cancel)
 * or DeadlineExpired (timeout) event from the chain's escrow address — logs
 * are address-filtered first so lookalike events from other contracts can't
 * confirm. Idempotent: a repeat matches zero pending rows.
 */
const confirmTxSchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a transaction hash'),
});

tasksRouter.post('/:id/confirm-tx', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rawId = req.params.id as string;
    if (!/^\d+$/.test(rawId)) {
      throw new AppError(400, 'INVALID_TASK_ID', 'Task ID must be a positive integer');
    }
    const taskId = parseInt(rawId, 10);
    const { txHash } = confirmTxSchema.parse(req.body);

    if (req.user!.address === 'agent') {
      throw new AppError(403, 'FORBIDDEN', 'Only the task agent can confirm refunds');
    }

    // Same ownership gate as cancel/timeout: resolving by ownership doubles
    // as the agent check, over every wallet linked to the caller.
    const resolved = await resolvePosterTask(taskId, callerWallets(req.user), requestedChain(req));
    if (!resolved) {
      throw new AppError(403, 'FORBIDDEN', 'Only the task agent can confirm refunds');
    }
    const { chain, poster: from } = resolved;
    const { provider: prov, escrow: esc } = chainRuntime(chain);
    if (!esc) {
      throw new AppError(503, 'CHAIN_NOT_CONFIGURED', `Settlement chain ${chain} is not configured on this backend`);
    }

    const receipt = await prov.getTransactionReceipt(txHash).catch(() => null);
    if (!receipt || receipt.status !== 1) {
      throw new AppError(409, 'NOT_CONFIRMED', 'Transaction receipt not found or reverted — broadcast the cancel/timeout tx first');
    }

    const escAddr = (await esc.getAddress()).toLowerCase();
    let settled: 'cancelled' | 'expired' | null = null;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== escAddr) continue;
      let parsed: { name: string; args: unknown } | null = null;
      try {
        parsed = esc.interface.parseLog(log) as unknown as { name: string; args: unknown };
      } catch {
        continue;
      }
      if (!parsed || typeof parsed.args !== 'object' || parsed.args === null) continue;
      const args = parsed.args as Record<string, unknown>;
      if (args.taskId !== BigInt(taskId)) continue;
      if (parsed.name === 'TaskCancelled' || parsed.name === 'DeadlineExpired') {
        settled = parsed.name === 'TaskCancelled' ? 'cancelled' : 'expired';
        break;
      }
    }
    if (!settled) {
      throw new AppError(
        409,
        'NO_SETTLEMENT_EVENT',
        'Receipt carries no TaskCancelled / DeadlineExpired for this task from the escrow — nothing to confirm',
      );
    }

    // The escrow is gone — close the off-chain A2A state too, whatever live
    // status it is in. Left open it keeps listing in a2a:open; left
    // accepted/submitted/awaiting_verification it keeps feeding worker resume
    // loops and the verifier queue. CAS, so a terminal state is never
    // rewritten. Best-effort: the refund confirmation below must not depend on
    // Redis, and a repeat confirm-tx retries the close.
    //
    // A2A state is keyed by taskHash alone and the escrow does not enforce
    // unique hashes, so owning SOME escrow task with this hash proves nothing
    // about the A2A task: anyone can createTask with a victim's hash, cancel it
    // for an instant refund and land here. Close only when the A2A task is this
    // caller's (meta.posterAddress, set from the authenticated poster at index
    // time — the check that matters) and the hash index does not name a
    // different escrow task. The indexers keep the first writer (SET NX), but
    // an entry can be missing, so the index is the secondary guard; no
    // recorded poster means no close.
    try {
      const onChain = await escrowService.getTaskOn(chain, taskId);
      const taskHash = onChain.taskHash;
      if (taskHash && (await a2aStore.getState(taskHash))) {
        const [a2aMeta, mapped] = await Promise.all([
          a2aStore.getMeta(taskHash),
          resolveCachedTaskByHash(taskHash).catch(() => null),
        ]);
        const posterMatches = a2aMeta?.posterAddress?.toLowerCase() === from.toLowerCase();
        const sameEscrowTask = !mapped || (mapped.chain === chain && mapped.taskId === String(taskId));
        if (!posterMatches || !sameEscrowTask) {
          console.warn(
            `[tasks] confirm-tx: NOT closing A2A state ${taskHash.slice(0, 10)}… for ${chain} task ${taskId} — ` +
              (posterMatches
                ? `the hash index names ${mapped!.chain} task ${mapped!.taskId}`
                : `caller ${from} is not the A2A task's poster`) +
              ' (duplicate taskHash on another escrow task)',
          );
        } else {
          const closed = await a2aStore.tryCloseOnChainTerminal(taskHash, settled);
          if (closed.ok) {
            await Promise.all([
              a2aStore.clearOffer(taskHash).catch(() => {}),
              a2aStore.clearCascade(taskHash).catch(() => {}),
            ]);
            console.log(`[tasks] confirm-tx: closed A2A state for task ${taskId} (${closed.previousStatus} → failed/${settled})`);
          }
        }
      }
    } catch (closeErr) {
      console.warn(`[tasks] confirm-tx: could not close A2A state for task ${taskId}:`, (closeErr as Error).message);
    }

    const { confirmed } = await accountingService.confirmPendingTransactions(String(taskId), ['refund']);
    res.json({ success: true, data: { confirmed: true, alreadyConfirmed: confirmed === 0 } } as ApiResponse);
  } catch (err) {
    next(err);
  }
});
