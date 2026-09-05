import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Plan 014 — durable cumulative spend cap on POST /api/v1/sandbox/exec.
 *
 * /sandbox/exec runs an arbitrary shell command for up to 600s
 * (execSchema's ceiling), billed to the platform, and was previously
 * unmetered beyond the global per-IP limiter. This suite covers the Redis
 * spend cap ONLY (test 1 below is the regression test — it fails on
 * `main` today, before this cap existed). We mount the REAL sandboxRouter
 * so route wiring, the quota-then-createAndRun ordering, and response
 * shapes are exercised; only railwaySandbox and redis are mocked so no real
 * process is spawned and no real Redis is touched.
 *
 * The matrix:
 *   1. over the daily cap             → 429 SANDBOX_QUOTA_EXCEEDED, createAndRun NEVER called (regression test)
 *   2. under the cap                  → run proceeds, counter incremented by the returned costMicroUnits
 *   3. keyed per principal            → caller A over cap gets 429; caller B (different address) still succeeds
 *   4. Redis read throws              → fail OPEN: call allowed, createAndRun still runs
 *   5. Railway unconfigured (503)     → quota check never runs; no read, no increment, no createAndRun
 */

// ── Mocks (hoisted by vitest above the imports below) ────────────────────────

vi.mock('../middleware/auth.js', () => ({
  // Inject the authenticated address from a header so each request can pick
  // its caller, bypassing Privy/JWT entirely — same pattern as
  // a2a.accept.test.ts.
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || '0xagent' };
    next();
  },
}));

// vi.mock factories are hoisted above top-level const declarations, so the
// mock objects they reference must be created via vi.hoisted (not a plain
// const) or the factory sees a TDZ ReferenceError.
//
// Loosely typed (any[] / string | null) rather than inferred from the first
// mock implementation — vitest infers a narrow return type (e.g. `never[]`
// from `() => []`, `Promise<null>` from `() => Promise.resolve(null)`) that
// then rejects every later mockResolvedValue/mockReturnValue with real data.
const { railwaySandboxMock, redisMock } = vi.hoisted(() => ({
  railwaySandboxMock: {
    isEnabled: vi.fn<() => boolean>(() => true),
    createAndRun: vi.fn<(...args: any[]) => Promise<any>>(),
    getUsageHistory: vi.fn<(agentId?: string) => any[]>(() => []),
    calculateAgentCost: vi.fn(() => ({ totalSeconds: 0, totalCostMicroUnits: 0 })),
    listActive: vi.fn<() => any[]>(() => []),
  },
  redisMock: {
    get: vi.fn<(key: string) => Promise<string | null>>(() => Promise.resolve(null)),
    pipeline: vi.fn<() => any>(),
  },
}));

vi.mock('../services/railwaySandbox.js', () => ({ default: railwaySandboxMock }));
vi.mock('../services/redis.js', () => ({ redis: redisMock }));

import { sandboxRouter } from './sandbox.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import { config } from '../config.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/sandbox', sandboxRouter);
  a.use(globalErrorHandler);
  return a;
}

function execAs(address: string, body: Record<string, unknown> = { command: 'echo hi' }) {
  return request(app())
    .post('/api/v1/sandbox/exec')
    .set('x-test-address', address)
    .send(body);
}

/** A pipeline stub recording incrby/expire calls, matching redis.ts's usage style. */
function pipelineStub() {
  const stub = {
    incrby: vi.fn(() => stub),
    expire: vi.fn(() => stub),
    exec: vi.fn(() => Promise.resolve([])),
  };
  return stub;
}

const CAP = config.sandboxDailyCostCapMicro;

beforeEach(() => {
  vi.clearAllMocks();
  railwaySandboxMock.isEnabled.mockReturnValue(true);
  redisMock.get.mockResolvedValue(null);
  redisMock.pipeline.mockImplementation(() => pipelineStub());
  railwaySandboxMock.createAndRun.mockResolvedValue({
    sandbox: { id: 'sbx-1' },
    result: { stdout: 'ok', stderr: '', exitCode: 0 },
  });
});

describe('POST /sandbox/exec — daily spend cap (plan 014)', () => {
  it('1) REGRESSION: a principal already at/over the daily cap gets 429 and createAndRun is never called', async () => {
    redisMock.get.mockResolvedValue(String(CAP)); // exactly at the cap → "at or above" rejects

    const res = await execAs('0xover0000000000000000000000000000000001');

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('SANDBOX_QUOTA_EXCEEDED');
    expect(railwaySandboxMock.createAndRun).not.toHaveBeenCalled();
    expect(redisMock.pipeline).not.toHaveBeenCalled(); // rejected call consumes no quota
  });

  it('2) under the cap: the run proceeds and the counter is incremented by the returned costMicroUnits', async () => {
    redisMock.get.mockResolvedValue(String(CAP - 1000));
    railwaySandboxMock.getUsageHistory.mockReturnValue([
      { sandboxId: 'sbx-1', durationSeconds: 3, costMicroUnits: 3000 },
    ]);

    const res = await execAs('0xunder000000000000000000000000000000002');

    expect(res.status).toBe(200);
    expect(res.body.data.costMicroUnits).toBe(3000);
    expect(railwaySandboxMock.createAndRun).toHaveBeenCalledTimes(1);
    const pipe = redisMock.pipeline.mock.results[0]!.value;
    expect(pipe.incrby).toHaveBeenCalledWith(
      expect.stringContaining('sandbox:spend:0xunder000000000000000000000000000000002:'),
      3000,
    );
    expect(pipe.expire).toHaveBeenCalled();
  });

  it('3) keyed per principal: caller A over cap gets 429 while caller B (different address) still succeeds', async () => {
    const A = '0xprincipala00000000000000000000000000003';
    const B = '0xprincipalb00000000000000000000000000004';
    railwaySandboxMock.getUsageHistory.mockReturnValue([
      { sandboxId: 'sbx-1', durationSeconds: 1, costMicroUnits: 500 },
    ]);

    // A's spend is at the cap; B's is far under it. redis.get is keyed by the
    // full spend key (which embeds the address), so route the mock on that.
    redisMock.get.mockImplementation((key: string) =>
      Promise.resolve(key.includes(A.toLowerCase()) ? String(CAP) : '0'),
    );

    const resA = await execAs(A);
    expect(resA.status).toBe(429);
    expect(resA.body.error.code).toBe('SANDBOX_QUOTA_EXCEEDED');

    const resB = await execAs(B);
    expect(resB.status).toBe(200);

    // Only B's (allowed) run ever reached createAndRun / the counter increment.
    expect(railwaySandboxMock.createAndRun).toHaveBeenCalledTimes(1);
  });

  it('4) Redis read throws: fails OPEN — the call is allowed and createAndRun still runs', async () => {
    redisMock.get.mockRejectedValue(new Error('ECONNREFUSED'));
    railwaySandboxMock.getUsageHistory.mockReturnValue([
      { sandboxId: 'sbx-1', durationSeconds: 2, costMicroUnits: 2000 },
    ]);

    const res = await execAs('0xredisdown00000000000000000000000000005');

    expect(res.status).toBe(200);
    expect(railwaySandboxMock.createAndRun).toHaveBeenCalledTimes(1);
  });

  it('5) Railway unconfigured: still 503 SANDBOX_UNAVAILABLE — quota check never runs and consumes no quota', async () => {
    railwaySandboxMock.isEnabled.mockReturnValue(false);

    const res = await execAs('0xdisabled000000000000000000000000000006');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SANDBOX_UNAVAILABLE');
    expect(redisMock.get).not.toHaveBeenCalled();
    expect(redisMock.pipeline).not.toHaveBeenCalled();
    expect(railwaySandboxMock.createAndRun).not.toHaveBeenCalled();
  });
});
