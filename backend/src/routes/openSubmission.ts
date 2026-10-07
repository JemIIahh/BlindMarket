/**
 * Open-submission routes (docs/OPEN-SUBMISSION-TASKS.md section 2.6): an
 * agent submits to an open task, its poster and verifier read the
 * submissions, and the poster picks the winner. Mounted inside a2aRouter, so
 * under /api/v1/a2a. All 404 while OPEN_SUBMISSION_ENABLED is off.
 *
 * The escrow decides every rule here; these routes check first so nobody is
 * handed a transaction that reverts:
 *   - submitOpen: before the deadline, one per agent, never the poster or the
 *     task's verifier. The result itself stays off-chain, keyed by submitter;
 *     the escrow keeps its evidence hash, the commitment that it was not
 *     changed afterwards.
 *   - selectWinner: the poster, in their pick window, of an agent that
 *     submitted.
 *
 * Results are hidden from everyone but the poster and the task's verifier
 * until submissions close, so no agent can copy another's (section 2.3).
 */

import { Router } from 'express';
import { z } from 'zod';
import { ethers } from 'ethers';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import * as a2aStore from '../services/a2aStore.js';
import * as agentStore from '../services/agentStore.js';
import * as store from '../services/openSubmissionStore.js';
import { buildSelectWinnerOn, buildSubmitOpenOn, escrowFor, getTaskOn } from '../services/escrow.js';
import { resolveCachedTaskByHash, type TaskChain } from '../services/taskChain.js';
import { sameOwnerSubtask } from '../services/delegationGuard.js';
import { storageIdSchema } from '../services/storageId.js';
import { PHASE } from '../services/openSubmissionSweep.js';
import type { A2ATaskMeta, ApiResponse, AuthRequest } from '../types.js';

export const openSubmissionRouter = Router();

const TASK_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Largest resultData kept per submission. There is no cap on submissions, so
 * the full result belongs in storage (rootHash), as single-assignee tasks
 * already send it, and resultData stays small.
 */
export const MAX_RESULT_BYTES = 64 * 1024;

const PHASE_NAMES: Record<number, string> = {
  [PHASE.Submissions]: 'taking submissions',
  [PHASE.CreatorPick]: "in the poster's pick window",
  [PHASE.VerifierPick]: "in its verifier's pick window",
  [PHASE.BackupPick]: "in the backup judge's window",
  [PHASE.AdminResolve]: 'waiting for an admin',
  [PHASE.Closed]: 'closed',
};

const submitOpenSchema = z.object({
  resultData: z.record(z.unknown()),
  rootHash: storageIdSchema.nullable().optional(),
  teeAttestation: z.unknown().optional(),
});

const selectSchema = z.object({
  winner: z.string().refine((a) => ethers.isAddress(a), 'winner must be an address'),
  scorecardHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'scorecardHash must be 32 bytes of hex').optional(),
});

function requireEnabled(): void {
  if (!config.openSubmissionEnabled) {
    throw new AppError(404, 'NOT_FOUND', 'Open submission is not enabled on this server');
  }
}

/** The caller's wallets, lowercased. */
function callerWallets(req: AuthRequest): Set<string> {
  const user = req.user!;
  return new Set([user.address, ...(user.addresses ?? [])].map((a) => a.toLowerCase()));
}

/** The open task behind a hash, and where it lives on-chain. */
async function openTask(rawHash: string): Promise<{ taskHash: string; meta: A2ATaskMeta; chain: TaskChain; taskId: number }> {
  if (!TASK_HASH_RE.test(rawHash)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Task id must be a 0x-prefixed 32-byte hex task hash');
  }
  const taskHash = rawHash.toLowerCase();
  const meta = await a2aStore.getMeta(taskHash);
  if (!meta || meta.submissionMode !== 'open') {
    throw new AppError(404, 'NOT_FOUND', 'No task taking submissions from many agents has that hash');
  }
  const resolved = await resolveCachedTaskByHash(taskHash);
  if (!resolved) {
    throw new AppError(503, 'NOT_INDEXED', 'On-chain task id not indexed yet: retry in a few seconds');
  }
  return { taskHash, meta, chain: resolved.chain, taskId: Number(resolved.taskId) };
}

/** The escrow's phase for an open task, as its enum number. */
async function phaseOf(chain: TaskChain, taskId: number): Promise<number> {
  return Number(await escrowFor(chain).openPhase(taskId));
}

/**
 * POST /api/v1/a2a/tasks/:id/submit-open
 * Body { resultData, rootHash?, teeAttestation? }. Saves the caller's result
 * and returns the unsigned submitOpen for them to sign and send from the same
 * wallet. Until that lands on-chain the caller may send a new result, which
 * replaces it; after, the escrow refuses a second submission.
 */
openSubmissionRouter.post('/tasks/:id/submit-open', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    requireEnabled();
    const body = submitOpenSchema.parse(req.body);
    const { taskHash, meta, chain, taskId } = await openTask(String(req.params.id));
    const address = req.user!.address.toLowerCase();
    if (!ethers.isAddress(address)) {
      throw new AppError(403, 'NOT_REGISTERED', 'Submit from a registered agent wallet');
    }

    const state = await a2aStore.getState(taskHash);
    if (state?.status !== 'collecting') {
      throw new AppError(409, 'SUBMISSIONS_CLOSED', 'This task no longer takes submissions');
    }
    if (meta.posterAddress?.toLowerCase() === address) {
      throw new AppError(403, 'SELF_SUBMIT', 'You posted this task, so you cannot submit to it');
    }
    if (meta.verifierAddress?.toLowerCase() === address) {
      throw new AppError(403, 'IS_VERIFIER', "You are this task's verifier, so you cannot submit to it");
    }
    if (!(await agentStore.getAgent(address))) {
      throw new AppError(403, 'NOT_REGISTERED', 'Register as an agent executor first');
    }
    if (meta.posterAddress && (await sameOwnerSubtask(meta.posterAddress, address))) {
      throw new AppError(403, 'SAME_OWNER', 'This task was posted by an agent with the same owner, so this agent cannot submit to it');
    }
    if (await store.getSubmission(taskHash, address)) {
      throw new AppError(409, 'ALREADY_SUBMITTED', 'You already submitted to this task: one submission per agent');
    }
    // The escrow's deadline decides: a pause moves it past the stored one.
    if (meta.deadline && Math.floor(Date.now() / 1000) >= meta.deadline && (await phaseOf(chain, taskId)) !== PHASE.Submissions) {
      throw new AppError(409, 'DEADLINE_REACHED', 'Submissions closed at the deadline');
    }

    const json = JSON.stringify(body.resultData);
    if (Buffer.byteLength(json) > MAX_RESULT_BYTES) {
      throw new AppError(
        413,
        'RESULT_TOO_LARGE',
        `resultData is over ${MAX_RESULT_BYTES / 1024} KB: put the full result in storage, send its rootHash, and keep resultData short`,
      );
    }
    // Hashed as /submit hashes it, so a verifier checks both kinds alike.
    const evidenceHash = ethers.keccak256(ethers.toUtf8Bytes(json));
    await store.saveResult(taskHash, address, {
      resultData: body.resultData,
      evidenceHash,
      rootHash: body.rootHash ?? null,
      ...(body.teeAttestation !== undefined ? { teeAttestation: body.teeAttestation } : {}),
      savedAt: new Date().toISOString(),
    });
    const unsignedSubmitOpen = await buildSubmitOpenOn(chain, address, taskId, evidenceHash);
    console.log(`[open-submission] ${address.slice(0, 10)}… submitting to ${taskHash.slice(0, 10)}… (task ${taskId} on ${chain})`);
    const response: ApiResponse = {
      success: true,
      data: { taskHash, onChainTaskId: String(taskId), evidenceHash, unsignedSubmitOpen },
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/a2a/tasks/:id/submissions?cursor=&limit=
 * The task's submissions, as the escrow recorded them, each with its result
 * when the saved one matches the on-chain evidence hash (null otherwise).
 * The poster and the task's verifier may read them at any time; anyone else
 * only once submissions have closed. Paged by cursor: pass back `cursor`
 * until it is '0'.
 */
openSubmissionRouter.get('/tasks/:id/submissions', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    requireEnabled();
    const { taskHash, meta, chain, taskId } = await openTask(String(req.params.id));
    const wallets = callerWallets(req);
    const judge =
      (meta.posterAddress && wallets.has(meta.posterAddress.toLowerCase())) ||
      (meta.verifierAddress && wallets.has(meta.verifierAddress.toLowerCase()));
    if (!judge) {
      const nowSec = Math.floor(Date.now() / 1000);
      const stillOpen = !meta.deadline || nowSec < meta.deadline || (await phaseOf(chain, taskId)) === PHASE.Submissions;
      if (stillOpen) {
        throw new AppError(403, 'SUBMISSIONS_HIDDEN', 'Submissions stay hidden until the deadline, so no agent can copy another');
      }
    }

    const cursor = typeof req.query.cursor === 'string' && /^\d+$/.test(req.query.cursor) ? req.query.cursor : '0';
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    const page = await store.pageSubmissions(taskHash, cursor, limit);
    const results = await store.getResults(taskHash, page.submissions.map((s) => s.submitter));
    const submissions = page.submissions.map((s, i) => {
      const r = results[i];
      return {
        submitter: s.submitter,
        ordinal: s.ordinal,
        evidenceHash: s.evidenceHash,
        recordedAt: s.recordedAt,
        result: r && r.evidenceHash === s.evidenceHash ? { resultData: r.resultData, rootHash: r.rootHash ?? null } : null,
      };
    });
    const response: ApiResponse = {
      success: true,
      data: { submissions, cursor: page.cursor, total: await store.recordedSubmissionCount(taskHash) },
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/a2a/tasks/:id/select
 * Body { winner, scorecardHash? }. The poster's pick on a task they review:
 * returns the unsigned selectWinner for the poster's on-chain wallet to sign.
 * Only in the poster's pick window, and only of an agent that submitted.
 */
openSubmissionRouter.post('/tasks/:id/select', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    requireEnabled();
    const body = selectSchema.parse(req.body);
    const { taskHash, meta, chain, taskId } = await openTask(String(req.params.id));
    // The escrow checks msg.sender against the task's on-chain poster.
    const onChain = await getTaskOn(chain, taskId);
    const poster = String(onChain.agent).toLowerCase();
    if (!callerWallets(req).has(poster)) {
      throw new AppError(403, 'NOT_POSTER', 'Only the poster picks the winner of this task');
    }
    if (meta.openPick?.mode !== 'creator') {
      throw new AppError(409, 'VERIFIER_PICKS', "This task's verifier picks its winner");
    }
    const phase = await phaseOf(chain, taskId);
    if (phase !== PHASE.CreatorPick) {
      throw new AppError(409, 'NOT_PICK_WINDOW', `You can pick only in your pick window; this task is ${PHASE_NAMES[phase] ?? 'past it'}`);
    }
    const winner = ethers.getAddress(body.winner);
    if ((await escrowFor(chain).submissionOf(taskId, winner)) === ethers.ZeroHash) {
      throw new AppError(409, 'NOT_A_SUBMITTER', 'That address did not submit to this task');
    }
    const unsignedSelectWinner = await buildSelectWinnerOn(chain, poster, taskId, winner, body.scorecardHash ?? ethers.ZeroHash);
    const response: ApiResponse = {
      success: true,
      data: { taskHash, onChainTaskId: String(taskId), winner: winner.toLowerCase(), unsignedSelectWinner },
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});
