import { Router } from 'express';
import { z } from 'zod';
import { storageIdSchema } from '../services/storageId.js';
import { verificationCriteriaSchema } from '../services/verificationCriteriaSchema.js';
import { ethers } from 'ethers';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { canViewerSeeResult } from '../services/resultVisibility.js';
import { AppError } from '../middleware/errorHandler.js';
import * as escrowService from '../services/escrow.js';
import * as registryService from '../services/registry.js';
import { escrow as ogEscrow, getTokenDecimals } from '../services/chain.js';
import { chainRuntime } from '../services/chainRuntime.js';
import { isSettlementChainKey, postingChain, settlementChainConfig } from '../services/settlementChains.js';
import { payoutCurrency } from '../services/settlementUnits.js';
import { isIndexedTask, resolvePosterTask, resolveCachedTaskByHash, type TaskChain } from '../services/taskChain.js';
import { callerWallets } from '../services/callerWallets.js';
import type { AuthRequest, ApiResponse } from '../types.js';
import { AGENT_CAPABILITIES, TaskStatus } from '../types.js';
import * as a2aStore from '../services/a2aStore.js';
import { randomUUID } from 'crypto';
import * as accountingService from '../services/accountingService.js';
import { getDb } from '../services/database.js';
import { getPool } from '../services/neonDb.js';
import { config } from '../config.js';
import { OPEN_PICK_WINDOWS } from '../services/openPickWindows.js';
import { rooms } from '../services/socket.js';
import { isSafeRegexSource } from '../services/rubricEngine.js';
import { hostedVerifierNotOptedIn, verifierChainUnsupported, VERIFIER_NOT_OPTED_IN_MESSAGE } from '../services/verifierDuty.js';
import { refuseUnapprovedDelegation } from '../services/delegationGuard.js';
import { withPosterAvatars } from '../services/avatarStore.js';
import { closeRefundedA2ATask } from '../services/refundedTasks.js';
import { BATCH_UNSUPPORTED, batchCreateSupport, openCreateSupport } from '../services/batchSupport.js';
import { MAX_BATCH_REQUEST, WALLET_POSTING_BUDGET_PER_MIN } from '../constants.js';
import { batchWeight, createWalletBudget, postingIpBudget } from '../middleware/rateLimit.js';
import { invalidRows, zodIssuesText, type RowError } from '../middleware/batchErrors.js';

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
  // Bounded, and shared with POST /a2a/tasks/index (services/verificationCriteriaSchema.ts).
  verificationCriteria: verificationCriteriaSchema.optional(),
  requiredCapabilities: z.array(z.enum(AGENT_CAPABILITIES as unknown as [string, ...string[]])).optional(),
  // A task many agents submit to (docs/OPEN-SUBMISSION-TASKS.md): built as
  // createTaskOpen. `mode` is who picks first: 'agent' its verifier, from
  // the deadline; 'creator' the poster, for `creatorWindow` seconds.
  open: z.object({
    mode: z.enum(['agent', 'creator']),
    creatorWindow: z.number().int().min(0),
  }).optional(),
  // What POST /a2a/tasks/index will be told. Required as 'public' with
  // `open`: every result becomes readable once submissions close, and the
  // index refuses an open task that is not public, after the escrow is funded.
  privacy: z.enum(['private', 'public']).optional(),
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
      //
      // Registry ids belong to the 0G escrow, so read that one. The posting
      // chain's escrow has its own id space: reading id N there spliced an
      // unrelated task's hash, token and indexing status onto this row, and
      // decimals came from the wrong chain (security audit run 1, C28).
      const enriched = await Promise.all(rawTasks.map(async (t) => {
        const taskId = Number(t.taskId);
        try {
          const escrowTask = await ogEscrow.getTask(taskId);
          const decimals = await getTokenDecimals(escrowTask.token, '0g');
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

    // Public projection — this route has no auth, and full A2A meta
    // carries the brief's key material (wrappedKeys/keyCustodyBlob) plus
    // the storage pointer. Strip it; the executor's slice travels only in
    // the authenticated /a2a/tasks/:id/accept response. The poster's avatar
    // rides along when they made one (services/avatarStore.ts).
    const [publicA2aMeta] = a2aMeta ? await withPosterAvatars([a2aStore.projectPublicMeta(a2aMeta)]) : [null];

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
        a2aMeta: publicA2aMeta,
        // Strip operator-internal diagnostics (assignError/verifyError) on this
        // surface. resultData (the deliverable) is attached only for the
        // poster, the assigned worker, or the poster-agent's owner(s).
        // The full verdict text travels with the deliverable.
        a2aState: a2aState
          ? {
              ...a2aStore.projectPublicState(a2aState, a2aMeta),
              resultData: canSeeResult ? a2aState.resultData ?? null : null,
              ...(canSeeResult && a2aState.verificationResult ? { verificationResult: a2aState.verificationResult } : {}),
            }
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

// ── The checks POST /tasks makes, one step each ──────────────────────────────
//
// POST /tasks runs them in this order for its one task, and POST /tasks/batch
// runs the same ones for each of its tasks, so both refuse a task for the
// same reasons, with the same codes and messages.

/** A POST /tasks body without the token: one task of POST /tasks/batch. */
const taskTermsSchema = createTaskSchema.omit({ token: true });
type TaskTerms = z.infer<typeof taskTermsSchema>;

/**
 * The checks on a task's own terms, before anything is read or claimed: a
 * verification mode the platform can settle, and a whole-number amount and
 * duration. Returns the amount and duration the escrow call takes.
 */
function checkTaskTerms(data: TaskTerms): { amount: bigint; duration: bigint } {
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
  const amount = parseWholeNumber(data.amount);
  if (amount === null || amount <= 0n) {
    throw new AppError(
      400,
      'INVALID_AMOUNT',
      "amount must be a whole number above 0, in the token's smallest unit (USDC has 6 decimals: '1500000' is 1.5 USDC)",
    );
  }
  const duration = parseWholeNumber(data.duration);
  if (duration === null || duration <= 0n) {
    throw new AppError(400, 'INVALID_DURATION', 'duration must be a whole number of seconds above 0');
  }
  return { amount, duration };
}

/**
 * The chain new tasks are funded on, in its settlement token: this
 * deployment's posting chain (settlementChains.postingChain: Arc when it has
 * an escrow, else Base). 503 when it has no escrow here.
 */
function postingTarget(): { chain: TaskChain; label: string; chainId: number; token: ReturnType<typeof settlementChainConfig>['token'] } {
  const chain = postingChain();
  const { label, escrowAddress, escrowEnv, chainId, token } = settlementChainConfig(chain);
  if (!escrowAddress) {
    throw new AppError(503, 'CHAIN_NOT_CONFIGURED', `This backend has no ${label} escrow to post tasks on (${escrowEnv})`);
  }
  return { chain, label, chainId, token };
}

/**
 * Refuse a hash that already names a task, then claim it for `from` under
 * this request's `token` (a2aStore.claimTaskHash). `fresh` is true when this
 * call took the claim, false when `from` already held it (POST /tasks/batch
 * releases only the claims it took, and only while they carry its token).
 */
async function claimNewTaskHash(taskHash: string, from: string, token: string): Promise<{ fresh: boolean }> {
  await refuseHashInUse(taskHash);
  // Claim the hash for this poster before the tx exists, so nobody who
  // sees it on-chain can index it first (a2aStore.claimTaskHash). Refused
  // here, before any gas is spent, when another poster already holds it.
  const claim = await a2aStore.claimTaskHash(taskHash, from, token);
  if (!claim.mine) {
    throw new AppError(409, 'TASK_HASH_TAKEN', 'Another poster is already posting a task with this hash — post with a new brief');
  }
  return { fresh: claim.fresh === true };
}

/**
 * A task is known off-chain by its hash, and a public task's hash is the
 * hash of its brief's text: posting the same public brief again made a
 * second escrow under a hash that already names a task. Its listing was
 * then refused (or would have pointed at the first task), after the
 * poster had paid. Refuse here, before anything is funded.
 */
async function refuseHashInUse(taskHash: string): Promise<void> {
  const [listed, escrowed] = await Promise.all([
    a2aStore.getMeta(taskHash),
    resolveCachedTaskByHash(taskHash).catch(() => null),
  ]);
  if (listed || escrowed) {
    throw new AppError(
      409,
      'TASK_HASH_IN_USE',
      `A task with exactly this brief already exists${escrowed ? ` (${escrowed.chain} task ${escrowed.taskId})` : ''}. ` +
        'A public task is identified by its text, so change the brief, even slightly, and post again. ' +
        'If that task is one you just paid for, finish listing it instead. Nothing was charged.',
    );
  }
}

/**
 * The posting chain's settlement token, spelled as the escrow call takes it.
 * Any other token would revert TokenNotAllowed, or be refused later by
 * /a2a/tasks/index, with the poster's gas spent.
 */
function settlementToken(
  chain: TaskChain,
  label: string,
  token: ReturnType<typeof settlementChainConfig>['token'],
  requested: string,
): { tokenAddress: string; isNative: boolean } {
  if (!token.address || !payoutCurrency(chain, requested)) {
    throw new AppError(
      400,
      'TOKEN_NOT_SETTLEMENT',
      `New tasks are escrowed in ${token.unit.symbol} on ${label} (token ${token.address ?? 'unset'}), not ${requested}`,
    );
  }
  // The match above ignores letter case. Build with the registry's address,
  // checksummed afresh: a mixed-case spelling with a bad checksum, in the
  // request or in BASE_USDC_ADDRESS, would make ethers throw.
  return { tokenAddress: ethers.getAddress(token.address.toLowerCase()), isNative: token.kind === 'native' };
}

/**
 * Checked before the funding tx is built, so nothing is escrowed for a
 * verifier that would never act (security audit run 1, C04), or that the
 * index would refuse once the escrow is funded: a registered agent that
 * doesn't settle on the posting chain.
 */
async function refuseUnusableVerifier(data: TaskTerms, chain: TaskChain, label: string): Promise<void> {
  if (data.verificationMode !== 'agent' || !data.verifierAddress) return;
  if (await verifierChainUnsupported(data.verifierAddress, chain)) {
    throw new AppError(409, 'VERIFIER_CHAIN_UNSUPPORTED', `That verifier agent doesn't settle on ${label}. Choose another verifier.`);
  }
  if (await hostedVerifierNotOptedIn(data.verifierAddress)) {
    throw new AppError(409, 'VERIFIER_NOT_OPTED_IN', VERIFIER_NOT_OPTED_IN_MESSAGE);
  }
}

/**
 * The open terms for createTaskOpen, checked as the escrow and the index
 * route check what this request carries: open submission on, a public brief
 * (no wrapped keys), a verifier that is not the poster, and a poster's window
 * within MIN/MAX_CREATOR_WINDOW (none for the verifier's pick). The index
 * body must also be public and name no targetExecutor or serviceId
 * (OPEN_TASK_PINNED); this request does not carry those.
 */
function openTerms(data: z.infer<typeof createTaskSchema>, from: string): { verifier: string; mode: 0 | 1; creatorWindow: number } {
  const open = data.open!;
  if (!config.openSubmissionEnabled) {
    throw new AppError(409, 'OPEN_SUBMISSION_DISABLED', 'This server does not take tasks that many agents submit to yet');
  }
  if (data.privacy !== 'public' || (data.wrappedKeys && Object.keys(data.wrappedKeys).length > 0)) {
    throw new AppError(400, 'OPEN_TASK_MUST_BE_PUBLIC', "A task that takes submissions from many agents is public: send privacy 'public' and no wrappedKeys");
  }
  if (data.verificationMode !== 'agent' || !data.verifierAddress) {
    throw new AppError(400, 'OPEN_TASK_NEEDS_VERIFIER', "A task that takes submissions from many agents needs a verifier agent: send verificationMode 'agent' with verifierAddress");
  }
  if (data.verifierAddress.toLowerCase() === from.toLowerCase()) {
    throw new AppError(400, 'INVALID_VERIFIER', 'The poster cannot be their own verifier');
  }
  const creator = open.mode === 'creator';
  if (creator ? open.creatorWindow < OPEN_PICK_WINDOWS.creatorMinSec || open.creatorWindow > OPEN_PICK_WINDOWS.creatorMaxSec : open.creatorWindow !== 0) {
    throw new AppError(
      400,
      'INVALID_PICK_WINDOW',
      creator
        ? `Your pick window must be between ${OPEN_PICK_WINDOWS.creatorMinSec / 3600} hour and ${OPEN_PICK_WINDOWS.creatorMaxSec / 86_400} days`
        : 'There is no poster window when the verifier picks: send creatorWindow 0',
    );
  }
  return { verifier: data.verifierAddress, mode: creator ? 1 : 0, creatorWindow: open.creatorWindow };
}

/** The verifier the escrow call commits on-chain for this task, if any. */
function committedVerifier(data: TaskTerms): string | undefined {
  return data.verificationMode === 'agent' ? data.verifierAddress : undefined;
}

/**
 * Record the escrow_lock accounting event as PENDING (M5 audit): the route
 * builds an unsigned tx, and nothing is funded until it broadcasts. The
 * receipt-verified POST /a2a/tasks/index flips it to confirmed; an abandoned
 * build stays visibly pending instead of masquerading as funded. A failed
 * write is logged and never fails the build.
 */
async function recordPendingLock(
  from: string,
  taskHash: string,
  amount: string,
  tokenAddress: string,
  chain: TaskChain,
  unit: string,
): Promise<void> {
  try {
    const decimals = await getTokenDecimals(tokenAddress, chain);
    void Promise.resolve(accountingService.recordTransaction({
      address: from,
      role: 'agent',
      taskId: taskHash,
      type: 'escrow_lock',
      amount: Number(amount) / (10 ** decimals),
      unit,
      status: 'pending',
    })).catch((accErr) => console.warn('[tasks] Accounting record failed (non-blocking):', accErr));
  } catch (accErr) {
    console.warn('[tasks] Accounting record failed (non-blocking):', accErr);
  }
}

/** Each wallet's task builds, POST /tasks and /tasks/batch together (middleware/rateLimit.ts). */
const buildBudget = createWalletBudget({ name: 'task builds', perMinute: WALLET_POSTING_BUDGET_PER_MIN, weight: batchWeight('tasks') });

tasksRouter.post('/', requireAuth, buildBudget, postingIpBudget, async (req: AuthRequest, res, next) => {
  try {
    const data = createTaskSchema.parse(req.body);
    const from = req.user!.address;
    // A hosted agent funds a task only as a sub-task its owner allowed.
    await refuseUnapprovedDelegation(from);

    const { amount: amountBigInt, duration: durationBigInt } = checkTaskTerms(data);
    const { chain, label, chainId, token } = postingTarget();
    // Refused before the hash is claimed, like every other term.
    const open = data.open ? openTerms(data, from) : undefined;
    if (open && !(await openCreateSupport(chain))) {
      throw new AppError(409, 'OPEN_SUBMISSION_UNSUPPORTED', `The ${label} escrow does not take tasks that many agents submit to yet`);
    }
    await claimNewTaskHash(data.taskHash, from, randomUUID());
    const { tokenAddress, isNative } = settlementToken(chain, label, token, data.token);
    await refuseUnusableVerifier(data, chain, label);

    const tx = open
      ? await escrowService.buildCreateTaskOpenOn(
        chain,
        from,
        data.taskHash,
        tokenAddress,
        amountBigInt,
        'general',
        data.locationZone,
        durationBigInt,
        isNative ? amountBigInt : undefined,
        open,
      )
      : await escrowService.buildCreateTaskOn(
        chain,
        from,
        data.taskHash,
        tokenAddress,
        amountBigInt,
        'general',
        data.locationZone,
        durationBigInt,
        isNative ? amountBigInt : undefined,
        committedVerifier(data),
      );

    // Note: A2A meta is NOT written here. Doing so unconditionally produced
    // phantom Redis entries (createTask reverts with TokenNotAllowed, gas
    // shortfall, etc. → no TaskCreated event → indexer can't resolve the
    // hash → submit fails forever with NOT_INDEXED). The poster's frontend
    // must call POST /api/v1/a2a/tasks/index AFTER the tx confirms; that
    // endpoint verifies the receipt and the TaskCreated event before writing
    // anything. See routes/a2a.ts for the verified-write path.

    await recordPendingLock(from, data.taskHash, data.amount, tokenAddress, chain, token.unit.symbol);

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

const ZERO_HASH = '0x' + '0'.repeat(64);
/** BlindEscrow.MIN_DEADLINE and MAX_DEADLINE. */
const MIN_DURATION = 3_600n;
const MAX_DURATION = 90n * 86_400n;
const UINT256_LIMIT = 1n << 256n;

/**
 * What would make the escrow revert createTasks, and with it every task in
 * the batch: POST /tasks leaves these to the one task's own transaction. A
 * zero hash, a duration outside 1 hour to 90 days, an amount past uint256,
 * and a verifier that is the poster (or not an EVM address). Also the index
 * route's NO_VERIFIER: an agent-verified task without a verifier is funded
 * and then can never be listed.
 */
function checkBatchedTask(data: TaskTerms, from: string, amount: bigint, duration: bigint): void {
  if (data.taskHash.toLowerCase() === ZERO_HASH) {
    throw new AppError(400, 'EMPTY_HASH', 'taskHash must not be zero: the escrow refuses it, and the whole batch with it');
  }
  if (amount >= UINT256_LIMIT) {
    throw new AppError(400, 'INVALID_AMOUNT', 'amount is larger than the escrow can hold (2^256 - 1)');
  }
  if (duration < MIN_DURATION || duration > MAX_DURATION) {
    throw new AppError(
      400,
      'INVALID_DURATION',
      'duration must be 3600 to 7776000 seconds (1 hour to 90 days): the escrow refuses anything else, and the whole batch with it',
    );
  }
  if (data.verificationMode === 'agent') {
    if (!data.verifierAddress) {
      throw new AppError(400, 'NO_VERIFIER', "verificationMode='agent' requires verifierAddress");
    }
    if (!ethers.isAddress(data.verifierAddress)) {
      throw new AppError(400, 'INVALID_VERIFIER', 'verifierAddress must be a 20-byte EVM address');
    }
    if (data.verifierAddress.toLowerCase() === from.toLowerCase()) {
      throw new AppError(400, 'INVALID_VERIFIER', 'The poster cannot be their own verifier');
    }
  }
}

/** A task's refusal as the batch reports it. Anything but a refusal (Redis, the database) fails the request. */
function batchTaskError(index: number, err: unknown): RowError {
  if (err instanceof AppError) return { index, code: err.code, message: err.message };
  throw err;
}

/**
 * Release the hash claims a failed batch took. Each is dropped only while it
 * still carries this request's `token`: one a concurrent request of the same
 * poster has since built on is left alone.
 */
async function releaseClaims(hashes: readonly string[], from: string, token: string): Promise<void> {
  await Promise.all(hashes.map((hash) =>
    a2aStore.releaseTaskHashClaim(hash, from, token).catch((err) =>
      console.warn(`[tasks] batch: could not release the claim on ${hash.slice(0, 10)}…:`, (err as Error).message))));
}

const createTasksSchema = z.object({
  token: createTaskSchema.shape.token,
  tasks: z.array(z.unknown()).min(1).max(MAX_BATCH_REQUEST),
});

/**
 * POST /api/v1/tasks/batch (docs/BULK-POSTING.md)
 * Build one unsigned createTasks transaction for several tasks, on an escrow
 * that has it. Body: { token, tasks: [<POST /tasks body without token>] },
 * 1 to the posting chain's batchCreate.maxBatch tasks (GET /health/settlement).
 *
 * Each task gets every check POST /tasks makes, in its order, including the
 * duplicate-brief check, the hash claim and the verifier rules, plus
 * checkBatchedTask's, since one task the escrow refuses reverts them all. A
 * hash may appear once per batch. All or nothing: any refused task fails the
 * request with 400 INVALID_TASKS, a summary as the message and every refused
 * task in error.details.errors: [{ index, code, message }]
 * (middleware/batchErrors.ts), and the hash claims this request took are
 * released. 409 BATCH_UNSUPPORTED when the posting chain's escrow has no
 * createTasks (post one at a time).
 *
 * Returns { unsignedTx, chain, chainId, taskHashes }: taskHashes in the
 * order the transaction escrows them, which is the order sent. The tx's
 * gasLimit is its estimate plus a fifth, or a size-based fallback
 * (escrow.createTasksGasFallback).
 */
tasksRouter.post('/batch', requireAuth, buildBudget, postingIpBudget, async (req: AuthRequest, res, next) => {
  const from = req.user!.address;
  // Hashes this request claimed, released if it fails after claiming, under
  // a token of its own (a2aStore.claimTaskHash).
  const claimed: string[] = [];
  const claimToken = randomUUID();
  try {
    const request = createTasksSchema.safeParse(req.body);
    if (!request.success) throw new AppError(400, 'VALIDATION_ERROR', zodIssuesText(request.error));
    const { token: requestedToken, tasks } = request.data;
    // The legacy AGENT_API_KEY principal has no wallet to fund from.
    if (from === 'agent') {
      throw new AppError(403, 'FORBIDDEN', 'Tasks are funded from a wallet: authenticate with a wallet-bound key or token');
    }
    await refuseUnapprovedDelegation(from);

    const { chain, label, chainId, token } = postingTarget();
    const { tokenAddress, isNative } = settlementToken(chain, label, token, requestedToken);
    // createTasks takes an ERC-20 only.
    const support = isNative ? BATCH_UNSUPPORTED : await batchCreateSupport(chain);
    if (!support.supported) {
      throw new AppError(
        409,
        'BATCH_UNSUPPORTED',
        `The ${label} escrow can't create several tasks in one transaction (it has no createTasks). Post them one at a time with POST /tasks.`,
      );
    }
    if (tasks.length > support.maxBatch) {
      throw new AppError(400, 'BATCH_TOO_LARGE', `The ${label} escrow takes at most ${support.maxBatch} tasks per transaction; this batch has ${tasks.length}. Split it.`);
    }

    // Each task's own terms, and one task per hash.
    const errors: RowError[] = [];
    const checked: Array<{ index: number; data: TaskTerms; amount: bigint; duration: bigint }> = [];
    const firstByHash = new Map<string, number>();
    tasks.forEach((raw, index) => {
      const parsed = taskTermsSchema.safeParse(raw);
      if (!parsed.success) {
        errors.push({ index, code: 'VALIDATION_ERROR', message: zodIssuesText(parsed.error) });
        return;
      }
      // createTasks builds single-assignee tasks: an open one is refused, never built as one.
      if (parsed.data.open) {
        errors.push({ index, code: 'OPEN_TASK_NOT_BATCHED', message: 'A task that takes submissions from many agents is posted on its own, with POST /tasks.' });
        return;
      }
      const hash = parsed.data.taskHash.toLowerCase();
      const first = firstByHash.get(hash);
      if (first !== undefined) {
        errors.push({
          index,
          code: 'DUPLICATE_TASK_HASH',
          message: `Same taskHash as task ${first + 1}: a task is known by its hash, so a second escrow under it could never be listed. Drop one, or change its brief.`,
        });
        return;
      }
      firstByHash.set(hash, index);
      try {
        const { amount, duration } = checkTaskTerms(parsed.data);
        checkBatchedTask(parsed.data, from, amount, duration);
        checked.push({ index, data: parsed.data, amount, duration });
      } catch (err) {
        errors.push(batchTaskError(index, err));
      }
    });

    // Shared state, read only, in POST /tasks' order: a hash already in use,
    // a hash another poster claimed, a verifier that won't act. Every task is
    // read, so one answer names every task that can't be posted.
    const holder = from.toLowerCase();
    await Promise.all(checked.map(async ({ index, data }) => {
      try {
        await refuseHashInUse(data.taskHash);
        const claimedBy = await a2aStore.getTaskHashClaim(data.taskHash);
        if (claimedBy && claimedBy !== holder) {
          throw new AppError(409, 'TASK_HASH_TAKEN', 'Another poster is already posting a task with this hash — post with a new brief');
        }
        await refuseUnusableVerifier(data, chain, label);
      } catch (err) {
        errors.push(batchTaskError(index, err));
      }
    }));

    // Then the claims, as POST /tasks takes them, once every task passed.
    // Every claim settles before anything is released: a failure mid-way
    // must not release while other claims are still being taken.
    if (errors.length === 0) {
      const outcomes = await Promise.allSettled(checked.map(({ data }) => claimNewTaskHash(data.taskHash, from, claimToken)));
      let failure: unknown = null;
      outcomes.forEach((outcome, i) => {
        const { index, data } = checked[i];
        if (outcome.status === 'fulfilled') {
          if (outcome.value.fresh) claimed.push(data.taskHash);
        } else if (outcome.reason instanceof AppError) {
          errors.push(batchTaskError(index, outcome.reason));
        } else {
          failure ??= outcome.reason;
        }
      });
      if (failure) throw failure;
    }

    if (errors.length > 0) throw invalidRows('INVALID_TASKS', 'task', tasks.length, errors);

    const tx = await escrowService.buildCreateTasksOn(
      chain,
      from,
      tokenAddress,
      checked.map(({ data, amount, duration }) => ({
        taskHash: data.taskHash,
        amount,
        category: 'general',
        locationZone: data.locationZone,
        duration,
        verifierAgent: committedVerifier(data),
      })),
    );

    // Pending until POST /a2a/tasks/index-batch sees the receipt (M5 audit).
    await Promise.all(checked.map(({ data }) =>
      recordPendingLock(from, data.taskHash, data.amount, tokenAddress, chain, token.unit.symbol)));

    const body: ApiResponse = {
      success: true,
      // chain and chainId name where the tx must be sent.
      data: { unsignedTx: tx, chain, chainId, taskHashes: checked.map(({ data }) => data.taskHash.toLowerCase()) },
    };
    rooms.tasks('task:created', { count: checked.length });
    rooms.platform('stats:update', {});
    res.json(JSON.parse(JSON.stringify(body, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )));
  } catch (err) {
    if (claimed.length > 0) await releaseClaims(claimed, from, claimToken);
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

    // The raw deadline is never later than the one the escrow enforces, so
    // this refuses early without another read.
    if (BigInt(Math.floor(Date.now() / 1000)) < task.deadline) {
      throw new AppError(400, 'DEADLINE_NOT_REACHED', 'Cannot reclaim before deadline');
    }

    // The escrow decides whether the claim goes through: the deadline moves by
    // the time it spent paused, a failed verdict leaves the worker an appeal
    // window, and a dispute its own window. A claim it would reject is refused
    // here with the reason instead of handed to the wallet to revert.
    const revert = await escrowService.claimTimeoutRevertOn(chain, from, taskId);
    if (revert) throw await claimTimeoutRefusal(revert, chain, taskId, task.status);

    // Work delivered before the deadline and never judged is not refunded: an
    // upgraded escrow sends it for review (security audit run 1, C18).
    const outcome: 'refund' | 'escalate' =
      task.status === TaskStatus.Submitted && (await escrowService.escalatesUnjudgedWorkOn(chain, taskId))
        ? 'escalate'
        : 'refund';

    const tx = await escrowService.buildClaimTimeoutOn(chain, from, taskId);

    // Record refund accounting event as PENDING (M5 audit): unsigned-tx build
    // only. POST /tasks/:id/confirm-tx flips it once the reclaim lands. An
    // escalation returns nothing to the poster, so it records no refund.
    if (outcome === 'refund') {
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
    }

    const body: ApiResponse = {
      success: true,
      // chain and chainId name where the tx must be sent (a task lives on one chain).
      // outcome says what the tx does: 'refund' returns the escrow to the
      // poster, 'escalate' sends delivered work for review (message explains).
      data: {
        unsignedTx: tx,
        chain,
        chainId: settlementChainConfig(chain).chainId,
        outcome,
        ...(outcome === 'escalate' ? { message: ESCALATE_MESSAGE } : {}),
      },
    };
    const replacer = (key: string, value: any) => typeof value === 'bigint' ? value.toString() : value;
    res.json(JSON.parse(JSON.stringify(body, replacer)));
  } catch (err) {
    next(err);
  }
});

// The windows are BlindEscrow's DISPUTE_WINDOW (14 days) and APPEAL_WINDOW
// (3 days).
const ESCALATE_MESSAGE =
  'This work was delivered before the deadline and never judged, so claiming the timeout sends it for review ' +
  'instead of refunding you. An admin rules on it; with no ruling within 14 days the worker is paid.';

/** Why the escrow would reject a claimTimeout, named by its custom error. */
async function claimTimeoutRefusal(
  revert: string,
  chain: TaskChain,
  taskId: number,
  status: TaskStatus,
): Promise<AppError> {
  switch (revert) {
    case 'EnforcedPause':
      return new AppError(
        409,
        'ESCROW_PAUSED',
        "The escrow is paused. Claim the timeout once it resumes; the time it spends paused is added to the task's deadline.",
      );
    case 'DeadlineNotReached': {
      // Later than getTask().deadline when the escrow was paused meanwhile.
      const deadline = await escrowService.effectiveDeadlineOn(chain, taskId).catch(() => null);
      return new AppError(
        400,
        'DEADLINE_NOT_REACHED',
        deadline
          ? `Cannot reclaim before ${new Date(Number(deadline) * 1000).toISOString()}: the deadline plus the time the escrow spent paused.`
          : 'Cannot reclaim before deadline',
      );
    }
    case 'AppealWindowActive':
      return new AppError(
        409,
        'APPEAL_WINDOW_ACTIVE',
        'The worker can appeal the failed verdict for 3 days after it. Claim the timeout once that window has passed.',
      );
    case 'EscalatedForAdjudication':
      return new AppError(
        409,
        'ESCALATED_FOR_ADJUDICATION',
        'This delivered work was sent for review. An admin rules on it, and with no ruling within 14 days the worker is paid; it does not return to you by timeout.',
      );
    case 'DisputeWindowActive':
      return new AppError(
        409,
        'DISPUTE_WINDOW_ACTIVE',
        'This task is in dispute. An admin rules on it; if there is no ruling within 14 days of the dispute, you can claim the timeout then.',
      );
    case 'NotAgent':
      return new AppError(403, 'FORBIDDEN', 'Only the task agent can reclaim funds');
    case 'InvalidStatus':
      return status === TaskStatus.Funded
        ? new AppError(409, 'USE_CANCEL', 'Nobody took this task. Cancel it instead; that refunds you right away.')
        : new AppError(409, 'INVALID_STATUS', 'This task is already settled; there is nothing to reclaim.');
    default:
      return new AppError(409, 'CLAIM_TIMEOUT_REJECTED', `The escrow would reject this claim (${revert}).`);
  }
}

/**
 * POST /api/v1/tasks/:id/confirm-tx
 *
 * M5 (audit) companion to cancel/timeout: flips the build-time 'pending'
 * refund row to confirmed AFTER verifying the reclaim actually landed
 * on-chain. Requires receipt status=1 plus this task's TaskCancelled (cancel)
 * or DeadlineExpired (timeout) event from the chain's escrow address — logs
 * are address-filtered first so lookalike events from other contracts can't
 * confirm. Idempotent: a repeat matches zero pending rows. A timeout that
 * sent delivered work for review (UnjudgedWorkEscalated) confirms as
 * { escalated: true } and refunds nothing.
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
    let escalated = false;
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
      if (parsed.name === 'UnjudgedWorkEscalated') escalated = true;
    }
    if (!settled && escalated) {
      // claimTimeout on delivered, unjudged work: the escrow moved it to
      // Disputed and kept the funds (security audit run 1, C18). Nothing was
      // refunded and the task is not over: an admin ruling or the worker's
      // releaseUnjudgedWork ends it, and the dispute listener mirrors either.
      // So no refund is confirmed and the A2A state stays open.
      res.json({ success: true, data: { confirmed: true, escalated: true } } as ApiResponse);
      return;
    }
    if (!settled) {
      throw new AppError(
        409,
        'NO_SETTLEMENT_EVENT',
        'Receipt carries no TaskCancelled / DeadlineExpired / UnjudgedWorkEscalated for this task from the escrow — nothing to confirm',
      );
    }

    // The escrow is gone — close the off-chain A2A state too, only when it is
    // the caller's (closeRefundedA2ATask, which the Arc indexer also runs on
    // TaskCancelled). Best-effort: the refund confirmation below must not
    // depend on Redis, and a repeat confirm-tx retries the close.
    try {
      const onChain = await escrowService.getTaskOn(chain, taskId);
      await closeRefundedA2ATask(chain, String(taskId), onChain.taskHash, from, settled, '[tasks] confirm-tx');
    } catch (closeErr) {
      console.warn(`[tasks] confirm-tx: could not close A2A state for task ${taskId}:`, (closeErr as Error).message);
    }

    const { confirmed } = await accountingService.confirmPendingTransactions(String(taskId), ['refund']);
    res.json({ success: true, data: { confirmed: true, alreadyConfirmed: confirmed === 0 } } as ApiResponse);
  } catch (err) {
    next(err);
  }
});
