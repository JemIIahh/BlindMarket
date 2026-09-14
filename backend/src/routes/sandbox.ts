import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { createUserRateLimiter } from '../middleware/rateLimit.js';
import { config } from '../config.js';
import { redis } from '../services/redis.js';
import type { AuthRequest, ApiResponse } from '../types.js';
import railwaySandbox from '../services/railwaySandbox.js';
const { isEnabled, createAndRun, getUsageHistory, calculateAgentCost, listActive } = railwaySandbox;

export const sandboxRouter = Router();

const execSchema = z.object({
  command: z.string().min(1).max(10000),
  setup: z.string().max(10000).optional(),
  taskId: z.string().optional(),
  timeoutSeconds: z.number().int().min(1).max(600).optional(),
});

// ── Spend metering (plan 014) ────────────────────────────────────────────────
// /sandbox/exec runs an arbitrary shell command for up to 600s (execSchema's
// ceiling), unmetered otherwise, billed to the platform. Two brakes:
//   1. a per-principal per-minute rate limit, via the same helper a2a.ts
//      already uses for its own paid routes, and
//   2. a rolling daily cumulative cost cap kept in Redis so it survives
//      restarts and is shared across instances — unlike railwaySandbox.ts's
//      in-memory `usageHistory` array, which resets per-process and is not
//      the right basis for a durable cap. That service is out of scope; this
//      meters the route.
const sandboxExecLimiter = createUserRateLimiter(config.sandboxRatePerMin);

// TTL kept comfortably over 24h so a run near UTC midnight can't have its
// increment silently dropped by the key expiring mid-day; the UTC date is
// already baked into the key so the next day's counter starts fresh anyway.
const SANDBOX_SPEND_KEY_TTL_SECONDS = 2 * 24 * 60 * 60; // 48h

function sandboxSpendKey(address: string): string {
  const utcDay = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `sandbox:spend:${address.toLowerCase()}:${utcDay}`;
}

/**
 * POST /api/v1/sandbox/exec
 * Execute a command in an ephemeral Railway sandbox.
 * Used by agent workers via BACKEND_URL — authenticated with platform token.
 */
sandboxRouter.post('/exec', requireAuth, sandboxExecLimiter, async (req: AuthRequest, res, next) => {
  try {
    if (!isEnabled()) {
      res.status(503).json({
        success: false,
        error: { code: 'SANDBOX_UNAVAILABLE', message: 'Railway sandboxes not configured' },
      });
      return;
    }

    const { command, setup, taskId, timeoutSeconds } = execSchema.parse(req.body);

    // M7 (audit): the only in-tree caller is backend worker.js (platform
    // token → typ 'agent-registration'). Without this gate ANY authenticated
    // principal — any Privy email login, any sk_ owner, the legacy shared
    // key — could run arbitrary shell billed to the platform, sybiling the
    // per-principal caps with fresh accounts. Workers only.
    if (req.user?.typ !== 'agent-registration') {
      res.status(403).json({
        success: false,
        error: {
          code: 'SANDBOX_WORKERS_ONLY',
          message: 'Sandbox execution is restricted to agent worker identities.',
        },
      });
      return;
    }

    const agentId = req.user!.address;
    const spendKey = sandboxSpendKey(agentId);

    // Quota check runs BEFORE createAndRun, so a rejected call never starts a
    // (billable) sandbox run and never consumes quota.
    try {
      const spent = await redis.get(spendKey);
      if (spent !== null && Number(spent) >= config.sandboxDailyCostCapMicro) {
        res.status(429).json({
          success: false,
          error: {
            code: 'SANDBOX_QUOTA_EXCEEDED',
            message: `Daily sandbox spend cap reached (${config.sandboxDailyCostCapMicro} micro-units). Resets at 00:00 UTC.`,
          },
        });
        return;
      }
    } catch (err) {
      // Fail OPEN on a Redis outage: allow the call, log a warning. Redis
      // being down must not take agent execution offline — the per-minute
      // rate limiter above still applies regardless. Deliberate trade-off
      // (plan 014), not an oversight.
      console.warn('[sandbox] spend-cap Redis read failed, failing open:', (err as Error).message);
    }

    const { sandbox, result } = await createAndRun({
      command,
      setup,
      agentId,
      taskId,
      timeoutSeconds,
    });

    const usage = getUsageHistory(agentId).at(-1);
    const costMicroUnits = usage?.costMicroUnits ?? 0;

    try {
      const pipe = redis.pipeline();
      pipe.incrby(spendKey, costMicroUnits);
      pipe.expire(spendKey, SANDBOX_SPEND_KEY_TTL_SECONDS);
      await pipe.exec();
    } catch (err) {
      // Same fail-open posture — losing an increment under-counts the cap
      // (never blocks a legitimate call), which is the safe failure direction.
      console.warn('[sandbox] spend-cap Redis increment failed:', (err as Error).message);
    }

    res.json({
      success: true,
      data: {
        sandboxId: sandbox.id,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationSeconds: usage?.durationSeconds ?? 0,
        costMicroUnits,
      },
    } satisfies ApiResponse);
  } catch (e: any) {
    next(e);
  }
});

/**
 * GET /api/v1/sandbox/usage
 * Get sandbox usage history for the authenticated agent (for billing).
 */
sandboxRouter.get('/usage', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const agentId = req.user!.address;
    const history = getUsageHistory(agentId);
    const cost = calculateAgentCost(agentId);

    res.json({
      success: true,
      data: { history, totalCost: cost },
    } satisfies ApiResponse);
  } catch (e: any) {
    next(e);
  }
});

/**
 * GET /api/v1/sandbox/status
 * Check if Railway sandboxes are enabled and list active sandboxes.
 */
sandboxRouter.get('/status', requireAuth, async (_req: AuthRequest, res, next) => {
  try {
    const active = listActive();
    res.json({
      success: true,
      data: {
        enabled: isEnabled(),
        activeCount: active.length,
        active,
      },
    } satisfies ApiResponse);
  } catch (e: any) {
    next(e);
  }
});
