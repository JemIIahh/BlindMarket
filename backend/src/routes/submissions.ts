import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import * as escrowService from '../services/escrow.js';
import type { AuthRequest, ApiResponse } from '../types.js';
import * as accountingService from '../services/accountingService.js';
import { recordWorkerPayout, recordWorkerDispute } from '../services/workerPayout.js';
import { payoutCurrency } from '../services/settlementUnits.js';
import { chainRuntime } from '../services/chainRuntime.js';
import { postingChain } from '../services/settlementChains.js';
import { redis } from '../services/redis.js';

export const submissionsRouter = Router();

// The human submission flow runs on the posting chain. It names tasks by
// numeric id, and ids collide across chains, so agent tasks on every settlement
// chain go through routes/a2a.ts, which resolves each task's chain from its hash.

// --- Schemas ---
const submitSchema = z.object({
  taskId: z.number().int().positive(),
  evidenceHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a bytes32 hex string'),
});

const approveSchema = z.object({
  taskId: z.number().int().positive(),
  passed: z.boolean(),
});

const confirmSchema = z.object({
  taskId: z.number().int().positive(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a transaction hash'),
});

/**
 * Shared gate for /verify and /confirm: only the task's poster or its
 * designated per-task verifier may drive verification.
 */
async function authorizeVerifier(taskId: number, from: string) {
  const task = await escrowService.getTask(taskId);
  const ZERO = '0x0000000000000000000000000000000000000000';
  const perTaskVerifier = (await escrowService.getTaskVerifier(taskId).catch(() => ZERO)).toLowerCase();
  const isPoster = task.agent.toLowerCase() === from.toLowerCase();
  const isVerifier = perTaskVerifier !== ZERO && perTaskVerifier === from.toLowerCase();
  if (from === 'agent' || (!isPoster && !isVerifier)) {
    throw new AppError(403, 'FORBIDDEN', 'Only the task poster or its designated verifier can verify this submission');
  }
  return task;
}

/**
 * POST /api/v1/submissions/submit
 * Build unsigned submitEvidence transaction for worker to sign.
 */
submissionsRouter.post('/submit', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { taskId, evidenceHash } = submitSchema.parse(req.body);
    const from = req.user!.address;

    const tx = await escrowService.buildSubmitEvidence(from, taskId, evidenceHash);

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
 * POST /api/v1/submissions/verify
 * Build unsigned completeVerification transaction (verifier/agent auth).
 */
submissionsRouter.post('/verify', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { taskId, passed } = approveSchema.parse(req.body);
    const from = req.user!.address;

    // Authorization: only the task's poster or its designated per-task verifier
    // may drive verification. requireAuth alone previously let any authenticated
    // wallet credit/slash any worker for any taskId.
    await authorizeVerifier(taskId, from);

    // H4 (audit): this endpoint builds an UNSIGNED tx — nothing is settled
    // yet. The accounting/reputation writes that used to fire here credited
    // phantom payouts (and reputation) whenever the caller never broadcast,
    // and double-credited whenever A2A /finalize settled the same task later.
    // All credit now happens in POST /confirm, AFTER receipt verification.
    const tx = await escrowService.buildCompleteVerification(from, taskId, passed);

    const body: ApiResponse = {
      success: true,
      data: {
        unsignedTx: tx,
        note: 'Broadcast the tx, then POST /submissions/confirm with its hash to record the settlement.',
      },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/submissions/confirm
 *
 * H4 (audit) companion to /verify: credits the ledger + reputation for a
 * broadcast completeVerification, AFTER verifying it actually settled
 * on-chain. /verify only builds an unsigned tx, so crediting there wrote
 * phantom payouts whenever the caller never broadcast — and doubled every
 * payout the A2A /finalize path settled.
 *
 * Verification (all must hold):
 *   1. caller passes the same poster/verifier gate as /verify;
 *   2. the tx receipt exists with status=1;
 *   3. the receipt carries THIS task's settlement event from the escrow
 *      address — TaskCompleted(taskId, workerPayout, platformFee), or
 *      VerificationCompleted(taskId, false) for a failed round. Logs are
 *      filtered by emitting address first: parseLog alone can't tell a real
 *      escrow event from a lookalike emitted by an attacker's contract.
 *
 * Credit routing (shared with every other settlement observer):
 *   - passed → recordWorkerPayout, whose a2a:credited NX marker dedups
 *     against /finalize, /verdict and the DisputeResolved listener;
 *   - failed → recordWorkerDispute + the slash ledger row, guarded by a
 *     per-txHash marker (failed rounds legitimately repeat per broadcast).
 */
submissionsRouter.post('/confirm', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { taskId, txHash } = confirmSchema.parse(req.body);
    const from = req.user!.address;

    const task = await authorizeVerifier(taskId, from);

    const runtime = chainRuntime(postingChain());
    const receipt = await runtime.provider.getTransactionReceipt(txHash).catch(() => null);
    if (!receipt || receipt.status !== 1) {
      throw new AppError(409, 'NOT_CONFIRMED', 'Transaction receipt not found or reverted — broadcast the completeVerification tx first');
    }

    const escrowContract = runtime.escrow;
    if (!escrowContract) {
      throw new AppError(503, 'ESCROW_NOT_CONFIGURED', 'Posting chain escrow is not configured');
    }
    const escrowAddr = (await escrowContract.getAddress()).toLowerCase();
    let completed: { workerPayout: bigint; platformFee: bigint } | null = null;
    let failed = false;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== escrowAddr) continue;
      let parsed: { name: string; args: unknown } | null = null;
      try {
        parsed = escrowContract.interface.parseLog(log) as unknown as { name: string; args: unknown };
      } catch {
        continue;
      }
      if (!parsed || typeof parsed.args !== 'object' || parsed.args === null) continue;
      const args = parsed.args as Record<string, unknown>;
      if (args.taskId !== BigInt(taskId)) continue;
      if (parsed.name === 'TaskCompleted') {
        completed = {
          workerPayout: args.workerPayout as bigint,
          platformFee: args.platformFee as bigint,
        };
      } else if (parsed.name === 'VerificationCompleted' && args.passed === false) {
        failed = true;
      }
    }
    if (!completed && !failed) {
      throw new AppError(
        409,
        'NO_SETTLEMENT_EVENT',
        'Receipt carries no TaskCompleted / failed-VerificationCompleted for this task from the escrow — nothing to credit',
      );
    }

    const workerAddr = task.worker;
    const taskHash = task.taskHash as string;

    if (completed) {
      // Gross from the event; recordWorkerPayout splits it with the cached fee.
      // recordWorkerPayout's marker makes this idempotent with /finalize.
      const gross = completed.workerPayout + completed.platformFee;
      await recordWorkerPayout(taskHash, workerAddr, String(taskId), gross, { chain: postingChain(), token: task.token });
      res.json({ success: true, data: { confirmed: true, passed: true } } as ApiResponse);
      return;
    }

    // Failed round: one dispute record per broadcast.
    const marker = `legacy:verify-credited:${txHash.toLowerCase()}`;
    const first = await redis.set(marker, workerAddr.toLowerCase(), 'NX');
    if (first === null) {
      res.json({ success: true, data: { confirmed: true, passed: false, duplicate: true } } as ApiResponse);
      return;
    }
    try {
      await recordWorkerDispute(taskHash, workerAddr);
      await accountingService.recordTransaction({
        address: workerAddr,
        role: 'worker',
        taskId: String(taskId),
        type: 'slash',
        amount: 0,
        unit: payoutCurrency(postingChain(), task.token)?.symbol,
      });
    } catch (hookErr) {
      await redis.del(marker).catch(() => {});
      console.warn('[submissions] confirm-billing hook failed (non-blocking):', hookErr);
    }
    res.json({ success: true, data: { confirmed: true, passed: false } } as ApiResponse);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/submissions/:taskId
 * Get evidence hash from on-chain task.
 */
submissionsRouter.get('/:taskId', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rawId = req.params.taskId as string;
    if (!/^\d+$/.test(rawId)) {
      throw new AppError(400, 'INVALID_TASK_ID', 'Task ID must be a positive integer');
    }
    const taskId = parseInt(rawId, 10);

    const task = await escrowService.getTask(taskId);

    const body: ApiResponse = {
      success: true,
      data: {
        taskId,
        evidenceHash: task.evidenceHash,
        status: task.status,
        submissionAttempts: task.submissionAttempts,
      },
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
