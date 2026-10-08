/**
 * Open-submission routes (docs/OPEN-SUBMISSION-TASKS.md sections 2.6, 16): an
 * agent submits to an open task, its poster and verifier read the
 * submissions, and the poster or the verifier picks the winner, with a
 * scorecard the escrow anchors. A verifier lists its work with
 * open-verifications. Mounted inside a2aRouter, so under /api/v1/a2a. All 404
 * while OPEN_SUBMISSION_ENABLED is off.
 *
 * The escrow decides every rule here; these routes check first so nobody is
 * handed a transaction that reverts:
 *   - submitOpen: before the deadline, one per agent, never the poster or the
 *     task's verifier. The result itself stays off-chain, keyed by submitter;
 *     the escrow keeps its evidence hash (openEvidenceHash: the resultData
 *     and its storage pointer), the commitment that neither was changed
 *     afterwards.
 *   - selectWinner: the poster, in their pick window, of an agent that
 *     submitted. selectWinnerByVerifier: the task's verifier, in its window.
 *     A judge may send its scorecard with the pick; the escrow anchors its
 *     hash, and the indexer keeps the scorecard once the pick lands.
 *
 * Results are hidden from everyone but the poster and the task's verifier
 * until submissions close, so no agent can copy another's (section 2.3).
 *
 * A sent result is held for an hour; the indexer keeps it only once the
 * submitter's on-chain submission carries its evidence hash
 * (openSubmissionStore.keepResult). So nothing is stored for long without an
 * on-chain submission, and a result can't be swapped after one. A result
 * whose hold lapsed first is kept when its submitter sends it again: the
 * escrow's submissionOf proves it is the committed one.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ethers } from 'ethers';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { createWalletBudget } from '../middleware/rateLimit.js';
import * as a2aStore from '../services/a2aStore.js';
import * as agentStore from '../services/agentStore.js';
import * as store from '../services/openSubmissionStore.js';
import { buildSelectWinnerByVerifierOn, buildSelectWinnerOn, buildSubmitOpenOn, escrowFor, getTaskOn, getTaskVerifierOn } from '../services/escrow.js';
import { onCurrentNetwork } from '../services/chainScope.js';
import { resolveCachedTaskByHash, type TaskChain } from '../services/taskChain.js';
import { ownAgentOf, sameOwnerSubtask } from '../services/delegationGuard.js';
import { storageIdSchema } from '../services/storageId.js';
import { PHASE } from '../services/openSubmissionSweep.js';
import type { A2ATaskMeta, ApiResponse, AuthRequest } from '../types.js';
import type { RequestHandler } from 'express';

export const openSubmissionRouter = Router();

const TASK_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Largest result kept per submission (resultData, rootHash and attestation
 * together). There is no cap on submissions, so the full result belongs in
 * storage (rootHash), as single-assignee tasks already send it, and what is
 * sent here stays small.
 */
export const MAX_RESULT_BYTES = 64 * 1024;

/** Each wallet's submit-open calls (middleware/rateLimit.ts). */
const submitBudget = createWalletBudget({ name: 'submissions', perMinute: 20 });
/** Each wallet's select calls: each may hold a scorecard for a day. */
const pickBudget = createWalletBudget({ name: 'picks', perMinute: 10 });

/** Largest scorecard a judge may send with a pick. */
export const MAX_SCORECARD_BYTES = 32 * 1024;

/** How long past its verifier's window, as listed, a task stays on GET /open-verifications: a pause moves the window later. */
const VERIFIER_LIST_SLACK_SEC = 30 * 86_400;
/** Most tasks GET /open-verifications returns: live windows first. */
const VERIFIER_LIST_MAX = 50;
/** The escrow's VERIFIER_PICK_WINDOW. */
const VERIFIER_PICK_WINDOW_SEC = 48 * 3600;

/** 404 before anything else while open submission is off, signed in or not. */
const enabledOnly: RequestHandler = (_req, _res, next) => {
  if (!config.openSubmissionEnabled) {
    next(new AppError(404, 'NOT_FOUND', 'Open submission is not enabled on this server'));
    return;
  }
  next();
};

/**
 * An open submission's evidence hash: keccak256 of the JSON of BOTH the
 * resultData and the storage pointer. /submit hashes the resultData alone,
 * but there one executor works alone. Here the full result lives behind
 * rootHash and every result becomes readable at the deadline: left out of
 * the commitment, a pointer attached afterwards could point at a copy of a
 * competitor's work (third review of #142). Storage ids are content hashes,
 * so the committed pointer can't change what it points at either.
 */
export function openEvidenceHash(resultData: Record<string, unknown>, rootHash: string | null): string {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ resultData, rootHash })));
}

const PHASE_NAMES: Record<number, string> = {
  [PHASE.Submissions]: 'taking submissions',
  [PHASE.CreatorPick]: "in the poster's pick window",
  [PHASE.VerifierPick]: "in its verifier's pick window",
  [PHASE.BackupPick]: "in the backup judge's window",
  [PHASE.AdminResolve]: 'waiting for an admin',
  [PHASE.Closed]: 'closed',
};

// The attestation as POST /submit takes it (routes/a2a.ts submitSchema).
const submitOpenSchema = z.object({
  resultData: z.record(z.unknown()),
  rootHash: storageIdSchema.nullable().optional(),
  teeAttestation: z.object({
    signature: z.string(),
    signer: z.string().optional(),
    signedText: z.string(),
    chatID: z.string().optional(),
    verified: z.boolean().optional(),
  }).nullable().optional(),
});

const selectSchema = z.object({
  winner: z.string().refine((a) => ethers.isAddress(a), 'winner must be an address'),
  scorecardHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'scorecardHash must be 32 bytes of hex').optional(),
  /** The judge's scores and reasons. Its hash goes on-chain with the pick. */
  scorecard: z.record(z.unknown()).optional(),
});

/**
 * A scorecard's hash, as the escrow anchors it: keccak256 of its JSON as this
 * server parsed it. Send the scorecard and sign with the scorecardHash
 * returned; a hash computed from your own text can differ (key order).
 */
export function scorecardHashOf(scorecard: Record<string, unknown>): string {
  return store.scorecardHashOf(scorecard);
}

/** When the task verifier's pick window opens, from the listing: after the poster's window, if they review. */
function verifierWindowOpensAt(meta: A2ATaskMeta): number | null {
  if (!meta.deadline) return null;
  return meta.deadline + (meta.openPick?.mode === 'creator' ? meta.openPick.creatorWindow ?? 0 : 0);
}

/** The caller's wallets, lowercased. */
function callerWallets(req: AuthRequest): Set<string> {
  const user = req.user!;
  return new Set([user.address, ...(user.addresses ?? [])].map((a) => a.toLowerCase()));
}

/** The open task behind a hash, and where it lives on-chain. */
async function openTask(rawHash: string): Promise<{ taskHash: string; meta: A2ATaskMeta; chain: TaskChain; taskId: number; ref: store.TaskRef }> {
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
  return { taskHash, meta, chain: resolved.chain, taskId: Number(resolved.taskId), ref: store.taskRef(resolved.chain, resolved.taskId) };
}

/**
 * True when `agent` belongs to `judge`'s owner: `judge` is a hosted agent and
 * `agent` is one of its owner's agents (or the owner's wallet), or `judge` is
 * a person and `agent` is their own agent. Such an agent must not be judged
 * by them.
 */
async function judgesOwnAgent(agent: string, judge: string): Promise<boolean> {
  return (await sameOwnerSubtask(judge, agent)) || (await ownAgentOf(agent, [judge]));
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
openSubmissionRouter.post('/tasks/:id/submit-open', enabledOnly, requireAuth, submitBudget, async (req: AuthRequest, res, next) => {
  try {
    const body = submitOpenSchema.parse(req.body);
    const { taskHash, meta, chain, taskId, ref } = await openTask(String(req.params.id));
    const address = req.user!.address.toLowerCase();
    if (!ethers.isAddress(address)) {
      throw new AppError(403, 'NOT_REGISTERED', 'Submit from a registered agent wallet');
    }

    const state = await a2aStore.getState(taskHash);
    if (state?.status !== 'collecting') {
      throw new AppError(409, 'SUBMISSIONS_CLOSED', 'This task no longer takes submissions');
    }
    if (meta.verifierAddress?.toLowerCase() === address) {
      throw new AppError(403, 'IS_VERIFIER', "You are this task's verifier, so you cannot submit to it");
    }
    if (!(await agentStore.getAgent(address))) {
      throw new AppError(403, 'NOT_REGISTERED', 'Register as an agent executor first');
    }

    // The escrow's own view: its poster, this agent's submission, its pause.
    // The indexer's record can lag, and a second submitOpen would revert.
    const escrow = escrowFor(chain);
    const [onChain, alreadySubmitted, paused] = await Promise.all([
      getTaskOn(chain, taskId),
      escrow.submissionOf(taskId, address),
      escrow.paused(),
    ]);
    const posters = [String(onChain.agent), meta.posterAddress].filter((a): a is string => !!a).map((a) => a.toLowerCase());
    if (posters.includes(address)) {
      throw new AppError(403, 'SELF_SUBMIT', 'You posted this task, so you cannot submit to it');
    }

    const sent = { resultData: body.resultData, rootHash: body.rootHash ?? null, teeAttestation: body.teeAttestation ?? undefined };
    if (Buffer.byteLength(JSON.stringify(sent)) > MAX_RESULT_BYTES) {
      throw new AppError(
        413,
        'RESULT_TOO_LARGE',
        `The result is over ${MAX_RESULT_BYTES / 1024} KB: put the full result in storage, send its rootHash, and keep resultData short`,
      );
    }
    const evidenceHash = openEvidenceHash(body.resultData, body.rootHash ?? null);
    const result = {
      resultData: body.resultData,
      evidenceHash,
      rootHash: body.rootHash ?? null,
      ...(body.teeAttestation ? { teeAttestation: body.teeAttestation } : {}),
      savedAt: new Date().toISOString(),
    };

    if (alreadySubmitted !== ethers.ZeroHash) {
      // Already on-chain. The same result again is the way back for one whose
      // hold expired before the indexer saw the submission (an outage, a late
      // broadcast): the escrow's commitment proves it is the one submitted.
      if (String(alreadySubmitted).toLowerCase() === evidenceHash.toLowerCase()) {
        // The attestation is not in the commitment: not kept this way.
        const { teeAttestation: _uncommitted, ...committed } = result;
        const kept = await store.keepCommittedResult(ref, address, committed);
        const response: ApiResponse = {
          success: true,
          data: { taskHash, onChainTaskId: String(taskId), evidenceHash, alreadyOnChain: true, kept },
        };
        res.json(response);
        return;
      }
      throw new AppError(409, 'ALREADY_SUBMITTED', 'You already submitted to this task: one submission per agent');
    }
    if (paused) {
      throw new AppError(409, 'ESCROW_PAUSED', 'The escrow is paused: submissions wait until it resumes');
    }
    if (meta.posterAddress && (await sameOwnerSubtask(meta.posterAddress, address))) {
      throw new AppError(403, 'SAME_OWNER', 'This task was posted by an agent with the same owner, so this agent cannot submit to it');
    }
    // The poster reads every result and may pick the winner: their own agent
    // could take the reward back.
    if (await ownAgentOf(address, posters)) {
      throw new AppError(403, 'OWN_AGENT', "This is the poster's own agent, so it cannot submit to their task");
    }
    // So does the task's verifier: an agent of its owner could copy the best
    // result and be picked.
    if (meta.verifierAddress && (await judgesOwnAgent(address, meta.verifierAddress))) {
      throw new AppError(403, 'VERIFIER_SAME_OWNER', "This agent has the same owner as the task's verifier, so it cannot submit to the task");
    }
    // The escrow's deadline decides: a pause moves it past the stored one.
    if (meta.deadline && Math.floor(Date.now() / 1000) >= meta.deadline && (await phaseOf(chain, taskId)) !== PHASE.Submissions) {
      throw new AppError(409, 'DEADLINE_REACHED', 'Submissions closed at the deadline');
    }

    if (!(await store.takeHeldSlot(address, ref, Math.floor(Date.now() / 1000)))) {
      throw new AppError(
        429,
        'TOO_MANY_HELD',
        `You have ${store.MAX_HELD} results waiting for their on-chain submissions: send those, or wait an hour for them to lapse`,
      );
    }
    await store.savePendingResult(ref, address, result);
    const unsignedSubmitOpen = await buildSubmitOpenOn(chain, address, taskId, evidenceHash);
    console.log(`[open-submission] ${address.slice(0, 10)}… submitting to ${taskHash.slice(0, 10)}… (task ${ref})`);
    const response: ApiResponse = {
      success: true,
      data: {
        taskHash,
        onChainTaskId: String(taskId),
        evidenceHash,
        unsignedSubmitOpen,
        // The result is kept once this submitOpen lands, if it lands within the hour.
        resultHeldForSec: store.PENDING_RESULT_TTL_SEC,
      },
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
openSubmissionRouter.get('/tasks/:id/submissions', enabledOnly, requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { meta, chain, taskId, ref } = await openTask(String(req.params.id));
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
    // Each kept result may be up to MAX_RESULT_BYTES: small pages.
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);
    const page = await store.pageSubmissions(ref, cursor, limit);
    const results = await store.getResults(ref, page.submissions.map((s) => s.submitter));
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
      data: { submissions, cursor: page.cursor, total: await store.recordedSubmissionCount(ref) },
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/a2a/tasks/:id/select
 * Body { winner, scorecard?, scorecardHash? }. A judge's pick, as an unsigned
 * transaction for the judge's on-chain wallet to sign:
 *   - the poster, on a task they review, in their pick window: selectWinner;
 *   - the task's verifier, in its window: selectWinnerByVerifier.
 * A caller holding both wallets gets the one whose window is open. Only of an
 * agent that submitted, and not of the judge's own agents. A scorecard sent
 * with the pick is held (one per judge per task, the last one sent) and its
 * hash goes into the transaction; the indexer keeps it once the pick lands.
 * Sign with the scorecardHash returned. A scorecardHash alone is anchored as
 * sent.
 */
openSubmissionRouter.post('/tasks/:id/select', enabledOnly, requireAuth, pickBudget, async (req: AuthRequest, res, next) => {
  try {
    const body = selectSchema.parse(req.body);
    const { taskHash, meta, chain, taskId, ref } = await openTask(String(req.params.id));

    let scorecardHash = body.scorecardHash ?? ethers.ZeroHash;
    if (body.scorecard) {
      if (Buffer.byteLength(JSON.stringify(body.scorecard)) > MAX_SCORECARD_BYTES) {
        throw new AppError(413, 'SCORECARD_TOO_LARGE', `The scorecard is over ${MAX_SCORECARD_BYTES / 1024} KB: keep the reasons short`);
      }
      const computed = scorecardHashOf(body.scorecard);
      if (body.scorecardHash && body.scorecardHash.toLowerCase() !== computed.toLowerCase()) {
        throw new AppError(400, 'SCORECARD_MISMATCH', 'scorecardHash is not the hash of the scorecard as parsed here: send the scorecard alone and sign with the scorecardHash returned');
      }
      scorecardHash = computed;
    }

    // The escrow checks msg.sender against the task's on-chain poster or verifier.
    const wallets = callerWallets(req);
    const [onChain, onChainVerifier, phase] = await Promise.all([
      getTaskOn(chain, taskId),
      getTaskVerifierOn(chain, taskId),
      phaseOf(chain, taskId),
    ]);
    const poster = String(onChain.agent).toLowerCase();
    const verifier = String(onChainVerifier).toLowerCase();
    const isPoster = wallets.has(poster);
    const isVerifier = verifier !== ethers.ZeroAddress && wallets.has(verifier);
    if (!isPoster && !isVerifier) {
      throw new AppError(403, 'NOT_A_JUDGE', "Only the poster, or the task's verifier in its window, picks the winner of this task");
    }
    const byVerifier = isVerifier && (!isPoster || phase === PHASE.VerifierPick);
    const judge = byVerifier ? verifier : poster;
    if (!byVerifier && meta.openPick?.mode !== 'creator') {
      throw new AppError(409, 'VERIFIER_PICKS', "This task's verifier picks its winner");
    }
    if (phase !== (byVerifier ? PHASE.VerifierPick : PHASE.CreatorPick)) {
      throw new AppError(409, 'NOT_PICK_WINDOW', `You can pick only in your pick window; this task is ${PHASE_NAMES[phase] ?? 'past it'}`);
    }
    // selectWinner and selectWinnerByVerifier are whenNotPaused. A pause also moves the window later.
    if (await escrowFor(chain).paused()) {
      throw new AppError(409, 'ESCROW_PAUSED', 'The escrow is paused: picks wait until it resumes');
    }
    const winner = ethers.getAddress(body.winner);
    // No judge pays itself (the escrow refuses SelfAssignment), or its own agents.
    if (winner.toLowerCase() === judge) {
      throw new AppError(409, 'SELF_PICK', 'A judge cannot pick itself');
    }
    if ((await escrowFor(chain).submissionOf(taskId, winner)) === ethers.ZeroHash) {
      throw new AppError(409, 'NOT_A_SUBMITTER', 'That address did not submit to this task');
    }
    if (await judgesOwnAgent(winner, judge)) {
      throw new AppError(409, 'OWN_AGENT_PICK', "That agent has the same owner as you, so you cannot pick it");
    }
    const build = byVerifier ? buildSelectWinnerByVerifierOn : buildSelectWinnerOn;
    const unsigned = await build(chain, judge, taskId, winner, scorecardHash);
    if (body.scorecard) await store.savePendingScorecard(ref, byVerifier ? 'task_verifier' : 'creator', body.scorecard);
    const response: ApiResponse = {
      success: true,
      data: {
        taskHash,
        onChainTaskId: String(taskId),
        winner: winner.toLowerCase(),
        scorecardHash,
        ...(byVerifier ? { unsignedSelectWinnerByVerifier: unsigned } : { unsignedSelectWinner: unsigned }),
      },
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/a2a/tasks/:id/scorecard
 * The judge's scorecard for a task whose winner was picked (or that was
 * voided): the one whose hash the escrow anchored with the pick. Readable by
 * any signed-in caller, like the results once submissions close.
 */
openSubmissionRouter.get('/tasks/:id/scorecard', enabledOnly, requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const { taskHash, ref } = await openTask(String(req.params.id));
    const [kept, outcome] = await Promise.all([store.getScorecard(ref), store.getOutcome(ref)]);
    if (!outcome) {
      throw new AppError(404, 'NOT_CLOSED', 'No winner has been picked for this task yet');
    }
    if (!kept) {
      const anchored = !!outcome.scorecardHash && !/^0x0*$/.test(outcome.scorecardHash);
      throw anchored
        ? new AppError(404, 'SCORECARD_NOT_SENT', "The judge anchored a scorecard, but this server doesn't hold it: whoever has it can POST it here")
        : new AppError(404, 'NO_SCORECARD', 'The judge anchored no scorecard for this task');
    }
    const response: ApiResponse = {
      success: true,
      data: { taskHash, outcome: outcome.kind, judge: outcome.judge, winner: outcome.winner ?? null, ...kept },
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/a2a/tasks/:id/scorecard
 * Body { scorecard }. Keeps a scorecard whose hash is the one the escrow
 * anchored with the task's pick or void. The way back for one whose hold
 * lapsed before the indexer saw the pick, or a backup judge's or admin's,
 * which never went through /select. Content-addressed: anyone holding it may
 * send it.
 */
openSubmissionRouter.post('/tasks/:id/scorecard', enabledOnly, requireAuth, pickBudget, async (req: AuthRequest, res, next) => {
  try {
    const { scorecard } = z.object({ scorecard: z.record(z.unknown()) }).parse(req.body);
    if (Buffer.byteLength(JSON.stringify(scorecard)) > MAX_SCORECARD_BYTES) {
      throw new AppError(413, 'SCORECARD_TOO_LARGE', `The scorecard is over ${MAX_SCORECARD_BYTES / 1024} KB`);
    }
    const { taskHash, ref } = await openTask(String(req.params.id));
    const outcome = await store.getOutcome(ref);
    if (!outcome?.scorecardHash || /^0x0*$/.test(outcome.scorecardHash)) {
      throw new AppError(409, 'NOT_ANCHORED', 'No scorecard hash was anchored for this task');
    }
    const scorecardHash = scorecardHashOf(scorecard);
    if (scorecardHash.toLowerCase() !== outcome.scorecardHash.toLowerCase()) {
      throw new AppError(400, 'SCORECARD_MISMATCH', 'That is not the scorecard the escrow anchored');
    }
    const kept = await store.keepAnchoredScorecard(ref, scorecardHash, scorecard);
    const response: ApiResponse = { success: true, data: { taskHash, scorecardHash, kept } };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/a2a/open-verifications
 * Open tasks the caller is the verifier of (its wallets' verifier index),
 * from when its pick window opens, as listed (the deadline, or the end of the
 * poster's window on a task they review), until 30 days after that window
 * closes: a pause moves it later, so the worker asks the escrow's openPhase
 * before judging. Live windows first, soonest close first, then the rest. The
 * judge gets the full verification criteria, answer key included, as GET
 * /verifications gives a single-assignee task's verifier.
 */
openSubmissionRouter.get('/open-verifications', enabledOnly, requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const wallets = callerWallets(req);
    const nowSec = Math.floor(Date.now() / 1000);
    const seen = new Set<string>();
    const indexed = (await Promise.all([...wallets].map((w) => a2aStore.getVerifierTasks(w)))).flat();
    const mine = indexed
      .filter(({ meta, state }) => {
        if (seen.has(meta.taskId)) return false;
        seen.add(meta.taskId);
        if (meta.submissionMode !== 'open' || state.status !== 'collecting' || !onCurrentNetwork(meta)) return false;
        if (!meta.verifierAddress || !wallets.has(meta.verifierAddress.toLowerCase())) return false;
        const opensAt = verifierWindowOpensAt(meta);
        return opensAt !== null && nowSec >= opensAt && nowSec < opensAt + VERIFIER_PICK_WINDOW_SEC + VERIFIER_LIST_SLACK_SEC;
      })
      .map((t) => ({ ...t, closesAt: verifierWindowOpensAt(t.meta)! + VERIFIER_PICK_WINDOW_SEC }))
      .sort((a, b) => {
        const aLive = nowSec < a.closesAt;
        const bLive = nowSec < b.closesAt;
        if (aLive !== bLive) return aLive ? -1 : 1;
        return aLive ? a.closesAt - b.closesAt : b.closesAt - a.closesAt;
      })
      .slice(0, VERIFIER_LIST_MAX);
    const tasks = await Promise.all(mine.map(async ({ meta, closesAt }) => {
      const resolved = await resolveCachedTaskByHash(meta.taskId).catch(() => null);
      return {
        meta: { ...a2aStore.projectPublicMeta(meta), ...(meta.verificationCriteria ? { verificationCriteria: meta.verificationCriteria } : {}) },
        onChainTaskId: resolved ? String(resolved.taskId) : null,
        submissions: resolved ? await store.recordedSubmissionCount(store.taskRef(resolved.chain, resolved.taskId)) : 0,
        window: { opensAt: closesAt - VERIFIER_PICK_WINDOW_SEC, closesAt },
      };
    }));
    const response: ApiResponse = { success: true, data: { tasks } };
    res.json(response);
  } catch (err) {
    next(err);
  }
});
