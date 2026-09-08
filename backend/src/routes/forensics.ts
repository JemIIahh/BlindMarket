import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest } from '../types.js';
import { forensicStore } from '../services/forensicStore.js';
import { validateForensicReport } from '../services/forensicValidation.js';
import * as custodyVault from '../services/custodyVault.js';
import * as a2aStore from '../services/a2aStore.js';
import { assertTaskExecutor } from '../services/taskParticipant.js';

const router = Router();

const submitSchema = z.object({
  taskId: z.string().min(1),
  signedReport: z.object({
    report: z.object({
      version: z.literal(1),
      taskId: z.string(),
      workerAddress: z.string(),
      timestamp: z.number(),
      exif: z.object({
        make: z.string().optional(),
        model: z.string().optional(),
        dateTime: z.string().optional(),
        dateTimeOriginal: z.string().optional(),
        gpsLat: z.number().optional(),
        gpsLng: z.number().optional(),
        software: z.string().optional(),
        imageWidth: z.number().optional(),
        imageHeight: z.number().optional(),
      }),
      photoSource: z.enum(['camera', 'gallery', 'screenshot', 'edited', 'unknown']),
      phash: z.string().length(16),
      deviceFingerprint: z.object({
        screenWidth: z.number(),
        screenHeight: z.number(),
        hardwareConcurrency: z.number(),
        deviceMemory: z.number().nullable(),
        webglRenderer: z.string(),
        userAgent: z.string(),
        platform: z.string(),
      }),
      freshness: z.object({
        photoAgeMs: z.number().nullable(),
        submissionTimestamp: z.number(),
        isFresh: z.boolean(),
        maxAgeMs: z.number(),
      }),
      tamperingSignals: z.array(z.string()),
      reportHash: z.string(),
    }),
    signature: z.string(),
  }),
});

const deny = (res: any, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });

// POST /api/v1/forensics/submit
//
// SEC-08. This was requireAuth only, and nothing tied the report to the caller
// or to the task it was filed under. Proven before fixing: an unrelated
// authenticated wallet self-signs a report naming its OWN address — so
// ethers.verifyMessage matches and no provenance flag fires — files it under a
// victim's taskHash, and saveReport (last-write-wins) makes it THE forensic
// record for that task. It then reaches the victim's verification prompt via
// verification.ts, inside the block labelled "verified by platform".
//
// Note the asymmetry this closes: GET /:taskId below has always required the
// caller to be a task participant, because the report carries GPS and device
// fingerprints. So a stranger could not READ a report but could WRITE one.
//
// Four bindings, each closing one leg:
router.post('/submit', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const parsed = submitSchema.parse(req.body);
    const { taskId, signedReport } = parsed;
    const { report } = signedReport;

    // 1. The report must be about the task it is filed under. The body taskId
    //    keys the store while report.taskId was never compared to it, so a
    //    report could describe one task and become the record for another.
    if (report.taskId !== taskId) {
      return deny(res, 400, 'TASK_ID_MISMATCH',
        'signedReport.report.taskId does not match the taskId this report is being filed under');
    }

    // 2. Only the task's assigned executor may file its evidence. Uses the
    //    shared predicate rather than req.user.address alone, so an agent
    //    owner acting for their agent (ownerAddress/addresses[]) still passes.
    if (!(await assertTaskExecutor(taskId, req.user))) {
      return deny(res, 403, 'NOT_TASK_EXECUTOR',
        'Only the task\'s assigned executor can submit its forensic report');
    }

    // 3. The report must name that executor. Without this the executor could
    //    still file a report attributing the work — and its GPS and device
    //    fingerprint — to somebody else.
    const state = await a2aStore.getState(taskId);
    const executor = state?.executorAddress?.toLowerCase();
    if (!executor || report.workerAddress.toLowerCase() !== executor) {
      return deny(res, 400, 'WORKER_ADDRESS_MISMATCH',
        'signedReport.report.workerAddress must be the task\'s assigned executor');
    }

    const validation = await validateForensicReport(signedReport);

    // 4. Reject an unprovable signature instead of recording it as a flag and
    //    saving anyway. validateForensicReport pushes signature_mismatch /
    //    signature_invalid and returns normally, and the old code saved
    //    regardless — so a report with no valid signature became the record.
    if (validation.flags.some((f) => f === 'signature_mismatch' || f === 'signature_invalid')) {
      return deny(res, 400, 'INVALID_SIGNATURE',
        'Forensic report signature does not verify against report.workerAddress');
    }

    // saveReport is still last-write-wins, which is now fine: the only caller
    // that reaches it is the task's own executor, so a re-submission overwrites
    // that executor's own earlier report — which is what a retry should do.
    forensicStore.saveReport(taskId, signedReport, validation);

    // Ingest into custody vault for chain-of-custody tracking
    try {
      await custodyVault.ingestEvidence(
        taskId,
        signedReport.report.reportHash,
        signedReport.report.workerAddress,
        JSON.stringify({ type: 'forensic_report', validation }),
      );
    } catch (custodyErr) {
      console.warn('[forensics] Custody ingest failed (non-blocking):', custodyErr);
    }

    res.json({ success: true, data: validation });
  } catch (err: any) {
    if (err?.name === 'ZodError') {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: err.errors?.[0]?.message || 'Invalid input' },
      });
    }
    next(err);
  }
});

// GET /api/v1/forensics/:taskId
router.get('/:taskId', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskId = req.params.taskId as string;
    const data = forensicStore.getReport(taskId);
    if (!data) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'No forensic report for this task' },
      });
    }

    // Authorization: a forensic report carries the worker's GPS coordinates and
    // device fingerprint, so only the task's participants may read it — the
    // poster, the assigned executor, or the designated verifier. requireAuth
    // alone previously let ANY authenticated wallet enumerate reports by taskId.
    const caller = req.user!.address.toLowerCase();
    const [meta, state] = await Promise.all([
      a2aStore.getMeta(taskId),
      a2aStore.getState(taskId),
    ]);
    const allowed = [meta?.posterAddress, meta?.verifierAddress, state?.executorAddress]
      .filter((a): a is string => !!a)
      .map((a) => a.toLowerCase());
    if (!allowed.includes(caller)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Only the task poster, worker, or verifier can view its forensic report' },
      });
    }

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

export { router as forensicsRouter };
