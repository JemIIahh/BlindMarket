import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Oracle-mode gap: POST /api/v1/verification/verify was `requireAuth` only.
 * Any authenticated wallet could name any task, supply BOTH the requirements
 * and the evidence as free text, and get back a `teeVerified` verdict — while
 * burning a paid 0G Compute inference. Two holes, closed here:
 *
 *   1. no participant check — the caller need not be party to the task;
 *   2. self-grading — the executor defined the bar it was judged against.
 *
 * Mounts the REAL verificationRouter so wiring, status codes and the response
 * shape are exercised; auth, a2aStore, the participant helpers, the forensic
 * store and the (paid) verification service are mocked. Style follows
 * custody.test.ts, which covers the same gate on the custody routes.
 */

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || '0xoutsider' };
    next();
  },
}));

vi.mock('../middleware/rateLimit.js', () => ({
  createUserRateLimiter: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../services/a2aStore.js', () => ({
  getMeta: vi.fn(),
  getState: vi.fn(),
}));

vi.mock('../services/taskParticipant.js', () => ({
  assertTaskParticipant: vi.fn(),
  assertTaskExecutor: vi.fn(),
}));

vi.mock('../services/forensicStore.js', () => ({
  forensicStore: { getReport: vi.fn(() => null) },
}));

vi.mock('../services/verification.js', () => ({
  verifyEvidence: vi.fn(),
  listProviders: vi.fn(),
  isConfigured: vi.fn(() => true),
}));

import { verificationRouter } from './verification.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as a2aStore from '../services/a2aStore.js';
import * as taskParticipant from '../services/taskParticipant.js';
import * as verificationService from '../services/verification.js';

const TASK = '0x' + 'ab'.repeat(32);
const POSTER = '0xposter0000000000000000000000000000000001';
const EXECUTOR = '0xexecutor000000000000000000000000000000002';
const VERIFIER = '0xverifier000000000000000000000000000000003';
const OUTSIDER = '0xoutsider000000000000000000000000000000009';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/verification', verificationRouter);
  a.use(globalErrorHandler);
  return a;
}

function post(address: string, body: Record<string, unknown>) {
  return request(app())
    .post('/api/v1/verification/verify')
    .set('x-test-address', address)
    .send(body);
}

const VALID_BODY = {
  taskHash: TASK,
  taskCategory: 'data_processing',
  evidenceSummary: 'Extracted 412 rows and wrote them to the output file.',
};

beforeEach(() => {
  vi.clearAllMocks();
  (a2aStore.getMeta as any).mockResolvedValue({
    taskId: TASK,
    posterAddress: POSTER,
    verifierAddress: VERIFIER,
    requiredCapabilities: ['data_processing'],
    verificationCriteria: { min_length: 20 },
  });
  (taskParticipant.assertTaskParticipant as any).mockResolvedValue(true);
  (taskParticipant.assertTaskExecutor as any).mockResolvedValue(false);
  (verificationService.verifyEvidence as any).mockResolvedValue({
    taskId: TASK, passed: true, confidence: 0.9, reasoning: 'ok',
    model: 'm', providerAddress: '0xp', teeVerified: true, timestamp: 1,
  });
});

describe('POST /verification/verify — participant gate', () => {
  it('rejects a caller who is not a party to the task, without spending an inference', async () => {
    (taskParticipant.assertTaskParticipant as any).mockResolvedValue(false);

    const res = await post(OUTSIDER, VALID_BODY);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_TASK_PARTICIPANT');
    expect(verificationService.verifyEvidence).not.toHaveBeenCalled();
  });

  it('404s an unknown task before any authorization or spend', async () => {
    (a2aStore.getMeta as any).mockResolvedValue(null);

    const res = await post(POSTER, VALID_BODY);

    expect(res.status).toBe(404);
    expect(verificationService.verifyEvidence).not.toHaveBeenCalled();
  });

  it('allows a participant through', async () => {
    const res = await post(POSTER, VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.data.passed).toBe(true);
    expect(verificationService.verifyEvidence).toHaveBeenCalledTimes(1);
  });

  it('rejects the legacy numeric taskId shape', async () => {
    const res = await post(POSTER, {
      taskId: 42,
      taskCategory: 'data_processing',
      evidenceSummary: 'done',
    });

    expect(res.status).toBe(400);
    expect(verificationService.verifyEvidence).not.toHaveBeenCalled();
  });
});

describe('POST /verification/verify — requirements provenance', () => {
  it('judges against the poster-recorded criteria, not the request body', async () => {
    await post(POSTER, VALID_BODY);

    const arg = (verificationService.verifyEvidence as any).mock.calls[0][0];
    // Built server-side from meta — capabilities and the poster's criteria.
    expect(arg.taskRequirements).toContain('data_processing');
    expect(arg.taskRequirements).toContain('min_length');
    expect(arg.taskId).toBe(TASK);
  });

  it('refuses to let the executor supply the requirements it is judged against', async () => {
    (taskParticipant.assertTaskExecutor as any).mockResolvedValue(true);

    const res = await post(EXECUTOR, {
      ...VALID_BODY,
      taskRequirements: 'Any output at all is acceptable.',
    });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EXECUTOR_CANNOT_SET_REQUIREMENTS');
    expect(verificationService.verifyEvidence).not.toHaveBeenCalled();
  });

  it('lets the executor verify — it just cannot define the bar', async () => {
    (taskParticipant.assertTaskExecutor as any).mockResolvedValue(true);

    const res = await post(EXECUTOR, VALID_BODY);

    expect(res.status).toBe(200);
    const arg = (verificationService.verifyEvidence as any).mock.calls[0][0];
    expect(arg.claimedRequirements).toBeUndefined();
  });

  it('accepts supplemental requirements from the verifier, marked as claimed', async () => {
    const res = await post(VERIFIER, {
      ...VALID_BODY,
      taskRequirements: 'The brief asked for a CSV keyed by customer id.',
    });

    expect(res.status).toBe(200);
    const arg = (verificationService.verifyEvidence as any).mock.calls[0][0];
    expect(arg.claimedRequirements).toContain('CSV');
    expect(arg.claimedBy).toBe('verifier');
    // The authoritative block is still the poster's, not the claim.
    expect(arg.taskRequirements).toContain('min_length');
  });

  it('fails closed when the task records no criteria to judge against', async () => {
    (a2aStore.getMeta as any).mockResolvedValue({
      taskId: TASK,
      posterAddress: POSTER,
      requiredCapabilities: [],
    });

    const res = await post(POSTER, VALID_BODY);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_REQUIREMENTS');
    expect(verificationService.verifyEvidence).not.toHaveBeenCalled();
  });
});

describe('POST /verification/verify — forensic provenance', () => {
  it('drops a forensic report whose signature did not verify', async () => {
    const { forensicStore } = await import('../services/forensicStore.js');
    (forensicStore.getReport as any).mockReturnValue({
      signedReport: { report: { workerAddress: EXECUTOR, reportHash: '0xabc' } },
      validation: { overallScore: 10, passed: false, checks: [], flags: ['signature_mismatch'] },
    });

    const res = await post(POSTER, VALID_BODY);

    expect(res.status).toBe(200);
    const arg = (verificationService.verifyEvidence as any).mock.calls[0][0];
    expect(arg.forensicReport).toBeUndefined();
    expect(arg.forensicValidation).toBeUndefined();
  });

  it('keeps a validly-signed forensic report', async () => {
    const { forensicStore } = await import('../services/forensicStore.js');
    (forensicStore.getReport as any).mockReturnValue({
      signedReport: { report: { workerAddress: EXECUTOR, reportHash: '0xabc' } },
      validation: { overallScore: 90, passed: true, checks: [], flags: [] },
    });

    const res = await post(POSTER, VALID_BODY);

    expect(res.status).toBe(200);
    const arg = (verificationService.verifyEvidence as any).mock.calls[0][0];
    expect(arg.forensicReport).toBeDefined();
  });
});
