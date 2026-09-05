import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import type { AuthRequest } from '../types.js';
import * as custodyVault from '../services/custodyVault.js';
import { assertTaskParticipant, assertTaskExecutor } from '../services/taskParticipant.js';

export const custodyRouter = Router();

const ingestSchema = z.object({
  taskId: z.string().min(1),
  evidenceHash: z.string().min(1),
  dataSnapshot: z.string().optional(),
});

// POST /api/v1/custody/ingest
custodyRouter.post('/ingest', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { taskId, evidenceHash, dataSnapshot } = ingestSchema.parse(req.body);

    // Authorization: only the task's assigned executor may append custody
    // entries — the poster and verifier are readers here, not submitters.
    // requireAuth alone previously let ANY authenticated wallet forge an
    // entry into any taskId's "tamper-evident" chain.
    const allowed = await assertTaskExecutor(taskId, req.user);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: "Only the task's assigned executor can submit custody evidence" },
      });
    }

    const submitter = req.user!.address;
    const entry = await custodyVault.ingestEvidence(taskId, evidenceHash, submitter, dataSnapshot);
    res.status(201).json({ success: true, data: entry });
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

// GET /api/v1/custody/:taskId/chain
custodyRouter.get('/:taskId/chain', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskId = req.params.taskId as string;

    // Authorization: the chain includes data_snapshot — the evidence content
    // itself — so only the task's poster, verifier, or assigned executor may
    // read it. Must run BEFORE logAuditEvent below, or a rejected caller
    // still writes a 'viewed' row attributing the access to them.
    const allowed = await assertTaskParticipant(taskId, req.user);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Only the task poster, worker, or verifier can view its custody chain' },
      });
    }

    const chain = await custodyVault.getCustodyChain(taskId);

    // Auto-log "viewed" event
    const firstEntry = chain[0];
    if (firstEntry) {
      await custodyVault.logAuditEvent(taskId, firstEntry.id, 'viewed', req.user!.address);
    }

    res.json({ success: true, data: { chain } });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/custody/:taskId/verify
custodyRouter.get('/:taskId/verify', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskId = req.params.taskId as string;

    // Authorization: same participant gate as /chain — the verdict and the
    // entries it is computed over are task-scoped evidence.
    const allowed = await assertTaskParticipant(taskId, req.user);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Only the task poster, worker, or verifier can verify its custody chain' },
      });
    }

    const result = await custodyVault.verifyIntegrity(taskId);

    // Auto-log "integrity_check"
    await custodyVault.logAuditEvent(taskId, null, 'integrity_check', req.user!.address, `Result: ${result.valid ? 'pass' : 'fail'}`);

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/custody/:taskId/audit
custodyRouter.get('/:taskId/audit', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const taskId = req.params.taskId as string;

    // Authorization: the audit log is "who viewed what, when" for this task —
    // same participant gate as /chain and /verify.
    const allowed = await assertTaskParticipant(taskId, req.user);
    if (!allowed) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Only the task poster, worker, or verifier can view its audit log' },
      });
    }

    const audit = await custodyVault.getAuditLog(taskId);
    res.json({ success: true, data: { audit } });
  } catch (err) {
    next(err);
  }
});
