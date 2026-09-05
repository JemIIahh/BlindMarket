import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { createUserRateLimiter } from '../middleware/rateLimit.js';
import { config } from '../config.js';
import * as verificationService from '../services/verification.js';
import { forensicStore } from '../services/forensicStore.js';
import type { AuthRequest, ApiResponse } from '../types.js';

export const verificationRouter = Router();

// --- Schemas ---

const verifySchema = z.object({
  taskId: z.number().int().positive(),
  taskCategory: z.string().min(1).max(100),
  taskRequirements: z.string().min(1).max(5000),
  evidenceSummary: z.string().min(1).max(10000),
});

// Per-principal rate limit (plan 014): every call spends a paid 0G Compute
// inference. This bounds call RATE only — it does NOT check that the caller
// is a party to `taskId` (see maintenance notes in plan 014; the right helper,
// `assertTaskParticipant`, arrives with PR #35 and isn't in master yet).
const verifyLimiter = createUserRateLimiter(config.verifyRatePerMin);

/**
 * POST /api/v1/verification/verify
 *
 * Trigger Sealed Inference verification of submitted evidence.
 * The agent decrypts evidence client-side, then sends a summary here.
 * The backend forwards it to 0G Compute TEE for AI evaluation.
 *
 * Auth: Agent only (the agent who created the task triggers verification).
 */
verificationRouter.post('/verify', requireAuth, verifyLimiter, async (req: AuthRequest, res, next) => {
  try {
    const input = verifySchema.parse(req.body);

    // Auto-lookup forensic data if available for this task
    const forensicData = forensicStore.getReport(String(input.taskId));
    const verificationInput: verificationService.VerificationRequest = {
      ...input,
      ...(forensicData && {
        forensicReport: forensicData.signedReport.report,
        forensicValidation: forensicData.validation,
      }),
    };

    const result = await verificationService.verifyEvidence(verificationInput);

    const body: ApiResponse = {
      success: true,
      data: {
        taskId: result.taskId,
        passed: result.passed,
        confidence: result.confidence,
        reasoning: result.reasoning,
        model: result.model,
        teeVerified: result.teeVerified,
        timestamp: result.timestamp,
      },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/verification/providers
 *
 * List available 0G Compute inference providers.
 * Useful for the frontend to show available TEE services.
 */
verificationRouter.get('/providers', requireAuth, async (_req: AuthRequest, res, next) => {
  try {
    const providers = await verificationService.listProviders();

    const body: ApiResponse = {
      success: true,
      data: { providers },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/verification/status
 *
 * Check if 0G Compute is configured and available.
 */
verificationRouter.get('/status', async (_req, res) => {
  const body: ApiResponse = {
    success: true,
    data: {
      configured: verificationService.isConfigured(),
      message: verificationService.isConfigured()
        ? '0G Sealed Inference is configured and ready'
        : '0G Compute not configured — using local stub for development',
    },
  };
  res.json(body);
});
