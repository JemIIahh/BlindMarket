import { Router } from 'express';
import { requireAuth, requireFounder } from '../middleware/auth.js';
import * as a2aStore from '../services/a2aStore.js';
import { shadowReport } from '../services/semanticMatch.js';
import { backfillAgentEmbeddings } from '../services/agentEmbedding.js';
import { getPool } from '../services/neonDb.js';
import { embeddingModelId, embeddingsConfigured } from '../services/embeddingService.js';
import { diagnoseStuckTasks, forceReleaseTask, rewindSubmittedTask } from '../services/stuckTasks.js';
import type { AuthRequest } from '../types.js';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler.js';
import { gasSponsorSettings } from '../services/gasSponsorConfig.js';
import { setControls } from '../services/gasSponsorStore.js';
import { gasSponsorReport } from '../services/gasSponsorRelayer.js';

export const adminRouter = Router();

/**
 * POST /api/v1/admin/backfill-embeddings  { force?: boolean }
 *
 * One-time (idempotent) op: embed every registered executor that has no
 * current vector (or ?force to re-embed all). Existing prod agents were
 * deployed before the embedding code and start with NULL vectors — until
 * they're embedded, semantic matching has nothing to rank them by. Founder-
 * gated; safe to re-run. Runs synchronously; may take a while on a large
 * roster (one embedding call per agent), so callers should allow a generous
 * timeout.
 */
adminRouter.post('/backfill-embeddings', requireAuth, requireFounder, async (req: AuthRequest, res, next) => {
  try {
    const force = !!(req.body as { force?: boolean })?.force;
    const result = await backfillAgentEmbeddings({ force });
    res.json({ success: true, data: { ...result, model: embeddingModelId(), real: embeddingsConfigured() } });
  } catch (err) { next(err); }
});

/**
 * GET /api/v1/admin/embedding-coverage
 *
 * How many registered executors carry a vector, by model — so we can see
 * whether the backfill worked and whether they're REAL (voyage) vs mock.
 */
adminRouter.get('/embedding-coverage', requireAuth, requireFounder, async (_req: AuthRequest, res, next) => {
  try {
    const db = await getPool();
    const [total, withVec, byModel] = await Promise.all([
      db.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM agent_executors'),
      db.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM agent_executors WHERE embedding IS NOT NULL'),
      db.query<{ embedding_model: string | null; n: string }>(
        'SELECT embedding_model, COUNT(*)::text AS n FROM agent_executors WHERE embedding IS NOT NULL GROUP BY embedding_model',
      ),
    ]);
    res.json({
      success: true,
      data: {
        totalAgents: Number(total.rows[0]?.n ?? 0),
        embedded: Number(withVec.rows[0]?.n ?? 0),
        activeModel: embeddingModelId(),
        byModel: Object.fromEntries(byModel.rows.map((r) => [r.embedding_model ?? 'null', Number(r.n)])),
      },
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/v1/admin/match-shadow
 *
 * Semantic-matching shadow report (Phase 1): hit@1 / hit@3 / MRR of the
 * semantic vs capability-tag rankings against who actually accepted each
 * task, plus the most recent rows. This is the tuning loop's evidence;
 * "flip-ready" = semantic ≥ tag on MRR without a lower settled rate.
 */
adminRouter.get('/match-shadow', requireAuth, requireFounder, async (req: AuthRequest, res, next) => {
  try {
    const limit = parseInt(req.query.limit as string) || 200;
    res.json({ success: true, data: await shadowReport(limit) });
  } catch (err) { next(err); }
});

/**
 * POST /api/v1/admin/tasks/:id/skip-wrap
 *
 * Sets skipKeyWrap=true on a stranded pre-key-custody task, bypassing the
 * NEEDS_WRAP gate so any agent can accept it regardless of key wrap state.
 * Only callable by addresses listed in FOUNDER_ADDRESSES.
 */
adminRouter.post('/tasks/:id/skip-wrap', requireAuth, requireFounder, async (req: AuthRequest, res) => {
  const { id } = req.params;
  if (!id) {
    res.status(400).json({ error: 'Missing task id' });
    return;
  }

  const meta = await a2aStore.getMeta(id);
  if (!meta) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  meta.skipKeyWrap = true;
  await a2aStore.setMeta(meta);

  console.log(`[admin] skipKeyWrap=true set for task ${id} by ${req.user?.address}`);
  res.json({ ok: true, taskId: id });
});

/**
 * GET /api/v1/admin/stuck-tasks
 *
 * Diagnostic for "cooked" tasks: every task sitting in a non-terminal,
 * non-open off-chain state, with the evidence needed to judge whether it can
 * be freed (off-chain age, executor + agent liveness, on-chain status, and a
 * verdict). Read-only. Logic lives in services/stuckTasks.ts, shared with
 * scripts/stuck-tasks.ts.
 *
 * Founder-only. There are no founder addresses configured yet, so use the
 * script until there are.
 */
adminRouter.get('/stuck-tasks', requireAuth, requireFounder, async (_req: AuthRequest, res, next) => {
  try {
    const tasks = await diagnoseStuckTasks();
    res.json({ success: true, data: { tasks, total: tasks.length } });
  } catch (err) { next(err); }
});

/**
 * POST /api/v1/admin/tasks/:id/force-release
 *
 * Founder-only version of POST /api/v1/a2a/tasks/:id/release for tasks whose
 * executor is gone. Same on-chain guard — refuses past-Funded tasks. Logic
 * lives in services/stuckTasks.ts, shared with scripts/force-release.ts.
 *
 * Founder-only. There are no founder addresses configured yet, so use the
 * script until there are.
 */
adminRouter.post('/tasks/:id/force-release', requireAuth, requireFounder, async (req: AuthRequest, res, next) => {
  try {
    const result = await forceReleaseTask(req.params.id as string, req.user?.address ?? 'admin-route');
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

/**
 * POST /api/v1/admin/tasks/:id/rewind
 *
 * Rewinds one task from off-chain 'submitted' back to 'accepted' when the
 * escrow is still Assigned to the recorded executor (evidence never
 * broadcast). The owning worker's resume then re-drives it end-to-end.
 * Same guards as services/stuckTasks.ts#rewindSubmittedTask.
 *
 * Founder-only. There are no founder addresses configured yet, so use
 * scripts/rewind-submitted.ts until there are.
 */
adminRouter.post('/tasks/:id/rewind', requireAuth, requireFounder, async (req: AuthRequest, res, next) => {
  try {
    const result = await rewindSubmittedTask(req.params.id as string, req.user?.address ?? 'admin-route');
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// GET /api/v1/admin/gas-sponsor — sponsored agent gas at a glance: whether
// it runs here (and why not), the pause/kill controls, the sponsor's balance
// and what the last hour and day spent.
adminRouter.get('/gas-sponsor', requireAuth, requireFounder, async (_req: AuthRequest, res, next) => {
  try {
    res.json({ success: true, data: await gasSponsorReport() });
  } catch (err) {
    next(err);
  }
});

const sponsorControlsSchema = z.object({
  paused: z.boolean().optional(),
  killed: z.boolean().optional(),
  reason: z.string().trim().min(1).max(500),
}).refine((b) => b.paused !== undefined || b.killed !== undefined, { message: 'set paused or killed' });

// POST /api/v1/admin/gas-sponsor/controls — pause or kill sponsored gas
// without a restart (docs/AGENT-GAS-FUNDING.md). Pause stops new reservations;
// tasks already reserved still get their submit sponsored. Kill stops every
// send at once, reserved ones included. Body: { paused?, killed?, reason }.
adminRouter.post('/gas-sponsor/controls', requireAuth, requireFounder, async (req: AuthRequest, res, next) => {
  try {
    const parsed = sponsorControlsSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', parsed.error.issues.map((i) => i.message).join('; '));
    const settings = gasSponsorSettings();
    if (!settings.enabled) throw new AppError(409, 'GAS_SPONSOR_OFF', `Sponsored gas is off here: ${settings.reason}`);
    const { paused, killed, reason } = parsed.data;
    const controls = await setControls(settings.chainId, { paused, killed }, reason, req.user!.address);
    console.warn(`[gasSponsor] controls set by ${req.user!.address}: paused=${controls.paused} killed=${controls.killed} (${reason})`);
    res.json({ success: true, data: controls });
  } catch (err) {
    next(err);
  }
});
