import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Plan 011: the chain-of-custody routes (GET /:taskId/chain, /verify,
 * /audit, POST /ingest) were gated by requireAuth and NOTHING else — no
 * check that the caller is a party to the task named in the path.
 * getCustodyChain does `SELECT *`, and that includes `data_snapshot`, the
 * evidence content itself, so any authenticated wallet could read any
 * task's evidence by iterating ids; and POST /ingest let anyone forge an
 * entry into a record the product presents as tamper-evident.
 *
 * We mount the REAL custodyRouter so route wiring, status codes, and the
 * response shape are exercised; only auth, a2aStore (for participant
 * lookup), and custodyVault (the data layer) are mocked — modelled on
 * a2a.accept.test.ts's mocking style.
 */

// ── Mocks (hoisted by vitest above the imports below) ────────────────────────

vi.mock('../middleware/auth.js', () => ({
  // Inject the authenticated address from a header so each request can pick
  // its caller. Bypasses Privy/JWT entirely.
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || '0xoutsider' };
    next();
  },
}));

vi.mock('../services/a2aStore.js', () => ({
  getMeta: vi.fn(),
  getState: vi.fn(),
}));

vi.mock('../services/custodyVault.js', () => ({
  ingestEvidence: vi.fn(),
  getCustodyChain: vi.fn(),
  getAuditLog: vi.fn(),
  verifyIntegrity: vi.fn(),
  logAuditEvent: vi.fn(),
}));

import { custodyRouter } from './custody.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as a2aStore from '../services/a2aStore.js';
import * as custodyVault from '../services/custodyVault.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TASK = '0xtaskhash';
const POSTER = '0xposter0000000000000000000000000000000001';
const EXECUTOR = '0xexecutor000000000000000000000000000000002';
const VERIFIER = '0xverifier000000000000000000000000000000003';
const OUTSIDER = '0xoutsider000000000000000000000000000000009';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/custody', custodyRouter);
  a.use(globalErrorHandler);
  return a;
}

function getChain(address: string) {
  return request(app()).get(`/api/v1/custody/${TASK}/chain`).set('x-test-address', address);
}

function getVerify(address: string) {
  return request(app()).get(`/api/v1/custody/${TASK}/verify`).set('x-test-address', address);
}

function getAudit(address: string) {
  return request(app()).get(`/api/v1/custody/${TASK}/audit`).set('x-test-address', address);
}

function postIngest(address: string, body: Record<string, unknown> = {}) {
  return request(app())
    .post('/api/v1/custody/ingest')
    .set('x-test-address', address)
    .send({ taskId: TASK, evidenceHash: '0xhash', ...body });
}

const SECRET_SNAPSHOT = 'SECRET_EVIDENCE_CONTENT';

function mockChainEntry(overrides: Partial<any> = {}) {
  return {
    id: 1,
    task_id: TASK,
    evidence_hash: '0xhash',
    submitter: EXECUTOR,
    data_snapshot: SECRET_SNAPSHOT,
    integrity_hash: 'abc',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(a2aStore.getMeta).mockResolvedValue({
    taskId: TASK,
    posterAddress: POSTER,
    verifierAddress: VERIFIER,
    requiredCapabilities: [],
  } as any);
  vi.mocked(a2aStore.getState).mockResolvedValue({
    taskId: TASK,
    status: 'accepted',
    executorAddress: EXECUTOR,
  } as any);
});

// ── GET /:taskId/chain ───────────────────────────────────────────────────────

describe('GET /:taskId/chain — authorization', () => {
  it('regression: a non-participant gets 403 and no data_snapshot leaks in the body', async () => {
    vi.mocked(custodyVault.getCustodyChain).mockResolvedValue([mockChainEntry()] as any);

    const res = await getChain(OUTSIDER);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(JSON.stringify(res.body)).not.toContain(SECRET_SNAPSHOT);
    expect(custodyVault.getCustodyChain).not.toHaveBeenCalled();
  });

  it('a rejected request writes NO audit row', async () => {
    await getChain(OUTSIDER);

    expect(custodyVault.logAuditEvent).not.toHaveBeenCalled();
  });

  it('the poster gets 200', async () => {
    vi.mocked(custodyVault.getCustodyChain).mockResolvedValue([mockChainEntry()] as any);

    const res = await getChain(POSTER);

    expect(res.status).toBe(200);
    expect(res.body.data.chain).toHaveLength(1);
  });

  it('the assigned executor gets 200', async () => {
    vi.mocked(custodyVault.getCustodyChain).mockResolvedValue([mockChainEntry()] as any);

    const res = await getChain(EXECUTOR);

    expect(res.status).toBe(200);
  });

  it('the designated verifier gets 200', async () => {
    vi.mocked(custodyVault.getCustodyChain).mockResolvedValue([mockChainEntry()] as any);

    const res = await getChain(VERIFIER);

    expect(res.status).toBe(200);
  });

  it('an allowed caller still gets the "viewed" audit row logged', async () => {
    vi.mocked(custodyVault.getCustodyChain).mockResolvedValue([mockChainEntry()] as any);

    await getChain(POSTER);

    expect(custodyVault.logAuditEvent).toHaveBeenCalledWith(TASK, 1, 'viewed', POSTER);
  });
});

// ── GET /:taskId/verify ──────────────────────────────────────────────────────

describe('GET /:taskId/verify — authorization', () => {
  it('a non-participant gets 403', async () => {
    const res = await getVerify(OUTSIDER);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(custodyVault.verifyIntegrity).not.toHaveBeenCalled();
  });

  it('a participant (verifier) gets 200', async () => {
    vi.mocked(custodyVault.verifyIntegrity).mockResolvedValue({ valid: true, entries: [] } as any);

    const res = await getVerify(VERIFIER);

    expect(res.status).toBe(200);
  });
});

// ── GET /:taskId/audit ───────────────────────────────────────────────────────

describe('GET /:taskId/audit — authorization', () => {
  it('a non-participant gets 403', async () => {
    const res = await getAudit(OUTSIDER);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(custodyVault.getAuditLog).not.toHaveBeenCalled();
  });

  it('a participant (executor) gets 200', async () => {
    vi.mocked(custodyVault.getAuditLog).mockResolvedValue([] as any);

    const res = await getAudit(EXECUTOR);

    expect(res.status).toBe(200);
  });
});

// ── POST /ingest ─────────────────────────────────────────────────────────────

describe('POST /ingest — authorization (stricter: executor-only)', () => {
  it('a non-executor (outsider) is rejected with 403', async () => {
    const res = await postIngest(OUTSIDER);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(custodyVault.ingestEvidence).not.toHaveBeenCalled();
  });

  it('the poster is rejected with 403 — posters are readers, not submitters', async () => {
    const res = await postIngest(POSTER);

    expect(res.status).toBe(403);
    expect(custodyVault.ingestEvidence).not.toHaveBeenCalled();
  });

  it('the verifier is rejected with 403 — verifiers are readers, not submitters', async () => {
    const res = await postIngest(VERIFIER);

    expect(res.status).toBe(403);
    expect(custodyVault.ingestEvidence).not.toHaveBeenCalled();
  });

  it('the assigned executor is accepted with 201', async () => {
    vi.mocked(custodyVault.ingestEvidence).mockResolvedValue(mockChainEntry() as any);

    const res = await postIngest(EXECUTOR);

    expect(res.status).toBe(201);
    expect(custodyVault.ingestEvidence).toHaveBeenCalledWith(TASK, '0xhash', EXECUTOR, undefined);
  });

  it('a task with no assigned executor yet rejects everyone (nothing legitimate to ingest)', async () => {
    vi.mocked(a2aStore.getState).mockResolvedValue({
      taskId: TASK,
      status: 'open',
    } as any);

    const res = await postIngest(EXECUTOR);

    expect(res.status).toBe(403);
    expect(custodyVault.ingestEvidence).not.toHaveBeenCalled();
  });
});
