import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { createUserRateLimiter } from '../middleware/rateLimit.js';
import { AppError } from '../middleware/errorHandler.js';
import { config } from '../config.js';
import * as verificationService from '../services/verification.js';
import * as a2aStore from '../services/a2aStore.js';
import { assertTaskParticipant, assertTaskExecutor } from '../services/taskParticipant.js';
import { forensicStore } from '../services/forensicStore.js';
import type { AuthRequest, ApiResponse, A2ATaskMeta } from '../types.js';

export const verificationRouter = Router();

// --- Schemas ---

const verifySchema = z.object({
  // taskHash, not the numeric on-chain id: ids collide across 0G and Base, so
  // a number cannot identify a task, cannot be authorized against, and cannot
  // key the forensic store (which — like every other A2A surface — is keyed by
  // hash; the old `String(numericId)` lookup here never matched a real report).
  taskHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'taskHash must be a bytes32 hex string'),
  taskCategory: z.string().min(1).max(100),
  // Supplemental only, and only from the poster/verifier — see the role gate in
  // the handler. The standard being judged against is built server-side.
  taskRequirements: z.string().min(1).max(5000).optional(),
  evidenceSummary: z.string().min(1).max(10000),
});

// Per-principal rate limit (plan 014): every call spends a paid 0G Compute
// inference. Rate is bounded here; WHO may call for a given task is enforced
// by assertTaskParticipant in the handler.
const verifyLimiter = createUserRateLimiter(config.verifyRatePerMin);

/**
 * The standard a submission is judged against, assembled from what the POSTER
 * recorded at task creation — never from the request body.
 *
 * The privacy model constrains this: on a private task the platform genuinely
 * cannot read the brief, so the authoritative material is the poster's own
 * machine-readable acceptance criteria, their public routing summary, and the
 * declared capabilities. Only a task the poster explicitly marked public has a
 * plaintext brief to include, and only then is it included.
 */
function buildAuthoritativeRequirements(meta: A2ATaskMeta): string {
  const parts: string[] = [];
  if (meta.privacy === 'public' && meta.publicBrief) {
    parts.push(`Task brief (public): ${meta.publicBrief}`);
  }
  if (meta.routingSummary) {
    parts.push(`Poster's summary of what they need: ${meta.routingSummary}`);
  }
  if (meta.requiredCapabilities?.length) {
    parts.push(`Required capabilities: ${meta.requiredCapabilities.join(', ')}`);
  }
  if (meta.verificationCriteria && Object.keys(meta.verificationCriteria).length > 0) {
    parts.push(
      `Acceptance criteria recorded by the poster: ${JSON.stringify(meta.verificationCriteria)}`,
    );
  }
  return parts.join('\n');
}

/**
 * POST /api/v1/verification/verify
 *
 * Trigger Sealed Inference verification of submitted evidence.
 * The agent decrypts evidence client-side, then sends a summary here.
 * The backend forwards it to 0G Compute TEE for AI evaluation.
 *
 * Auth: `requireAuth` + the caller must be a PARTY to the task (poster,
 * designated verifier, or assigned executor). Previously this was
 * `requireAuth` only, so any authenticated wallet could burn a paid inference
 * on any task id and receive a `teeVerified` verdict for a task it had
 * nothing to do with.
 *
 * The standard being judged against is built from the poster's recorded task
 * metadata, not from the request body. A caller may add supplemental
 * requirements text ONLY if they are the poster or the designated verifier —
 * the executor supplying both the requirements and the evidence is
 * self-grading, which is what made the old free-text field unsound.
 */
verificationRouter.post('/verify', requireAuth, verifyLimiter, async (req: AuthRequest, res, next) => {
  try {
    const input = verifySchema.parse(req.body);
    const taskHash = input.taskHash;

    const meta = await a2aStore.getMeta(taskHash);
    if (!meta) {
      throw new AppError(404, 'NOT_FOUND', 'Task not found or not A2A-enabled');
    }

    // Gate BEFORE spending a paid inference.
    const isParticipant = await assertTaskParticipant(taskHash, req.user);
    if (!isParticipant) {
      throw new AppError(
        403,
        'NOT_TASK_PARTICIPANT',
        'Only the task poster, its designated verifier, or its assigned executor can request verification for this task',
      );
    }

    // Role gate for supplemental requirements. Poster and verifier can never
    // also be the executor (blocked by SELF_ACCEPT / SELF_VERIFICATION), so
    // "is the executor" is a sufficient test for "is the party being judged".
    let claimedRequirements: string | undefined;
    let claimedBy: 'poster' | 'verifier' | undefined;
    if (input.taskRequirements) {
      const isExecutor = await assertTaskExecutor(taskHash, req.user);
      if (isExecutor) {
        throw new AppError(
          403,
          'EXECUTOR_CANNOT_SET_REQUIREMENTS',
          'The assigned executor cannot supply the requirements it is judged against. Submit evidence only; the acceptance criteria come from the task the poster created.',
        );
      }
      claimedRequirements = input.taskRequirements;
      claimedBy = meta.verifierAddress &&
        [req.user?.address, req.user?.ownerAddress, ...(req.user?.addresses ?? [])]
          .some((a) => typeof a === 'string' && a.toLowerCase() === meta.verifierAddress!.toLowerCase())
        ? 'verifier'
        : 'poster';
    }

    const taskRequirements = buildAuthoritativeRequirements(meta);
    if (!taskRequirements && !claimedRequirements) {
      // Nothing the poster recorded and nothing a privileged party supplied —
      // there is no standard to judge against. Fail closed rather than ask the
      // model to rule on an empty rubric (it would pass almost anything).
      throw new AppError(
        409,
        'NO_REQUIREMENTS',
        'This task records no acceptance criteria, routing summary, or public brief to verify against. Add verification criteria to the task, or have the poster/verifier supply requirements with the request.',
      );
    }

    // Forensic reports are keyed by taskHash (see routes/forensics.ts), which
    // is why this lookup only started matching once the id space was fixed.
    //
    // Provenance gate: the prompt presents this section to the model as
    // "platform-verified metadata" and tells it to lower confidence on failed
    // checks. But POST /forensics/submit is requireAuth-only with a
    // body-supplied taskId, and validateForensicReport RECORDS a bad signature
    // as a flag rather than rejecting the report. An unsigned or mis-signed
    // report therefore has unproven provenance and must not be dressed up as
    // platform-verified — attaching one would let a third party steer a
    // verdict on someone else's task. Drop those; keep validly-signed ones.
    const stored = forensicStore.getReport(taskHash);
    const badProvenance = stored?.validation.flags.some(
      (f) => f === 'signature_mismatch' || f === 'signature_invalid',
    );
    if (stored && badProvenance) {
      console.warn(
        `[verification] dropping forensic report for ${taskHash.slice(0, 10)}… — unproven provenance (${stored.validation.flags.join(', ')})`,
      );
    }
    const forensicData = badProvenance ? null : stored;
    const verificationInput: verificationService.VerificationRequest = {
      taskId: taskHash,
      taskCategory: input.taskCategory,
      taskRequirements,
      claimedRequirements,
      claimedBy,
      evidenceSummary: input.evidenceSummary,
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
