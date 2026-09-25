import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * POST /tasks builds the createTask tx the poster signs. Modes the platform
 * cannot settle must be refused HERE — POST /a2a/tasks/index refuses them too,
 * but only after the escrow is funded.
 *
 * Run: npx vitest run src/routes/tasks.createGate.test.ts
 */

const { AGENT, ESCROW, USDC } = vi.hoisted(() => ({
  AGENT: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ESCROW: '0xcccccccccccccccccccccccccccccccccccccccc',
  USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
}));

vi.mock('../middleware/auth.js', () => {
  const gate = (req: any, _res: any, next: any) => { req.user = { address: AGENT }; next(); };
  return { requireAuth: gate, optionalAuth: gate };
});
// A Base stack: the posting chain is Base and its settlement token USDC.
vi.mock('../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../config.js')>();
  return {
    ...mod,
    config: { ...mod.config, baseEscrowAddress: ESCROW, baseUsdcAddress: USDC, arcEscrowAddress: '' },
  };
});
vi.mock('../services/taskChain.js', () => ({ resolveTaskChainById: vi.fn(), resolveCachedTaskByHash: vi.fn(async () => null) }));

const buildCreateTask = vi.fn(async () => ({ to: ESCROW, data: '0xcreate' }));
vi.mock('../services/escrow.js', () => ({
  buildCreateTaskOn: (...a: unknown[]) => buildCreateTask(...(a as [])),
}));
vi.mock('../services/chain.js', () => ({
  getTokenDecimals: vi.fn(async () => 6),
  provider: null, baseProvider: null, escrow: null, baseEscrow: null,
}));
vi.mock('../services/accountingService.js', () => ({ recordTransaction: vi.fn(async () => ({})) }));
vi.mock('../services/socket.js', () => ({ rooms: { tasks: vi.fn(), platform: vi.fn() } }));
vi.mock('../services/a2aStore.js', () => ({
  claimTaskHash: vi.fn(async (_hash: string, poster: string) => ({ poster: poster.toLowerCase(), mine: true })),
  getMeta: vi.fn(async () => undefined),
}));
vi.mock('../services/database.js', () => ({ getDb: vi.fn() }));
vi.mock('../services/neonDb.js', () => ({ getPool: vi.fn() }));

import { tasksRouter } from './tasks.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/tasks', tasksRouter);
  a.use(globalErrorHandler);
  return a;
}

const create = (extra: Record<string, unknown>) =>
  request(app()).post('/api/v1/tasks').send({
    taskHash: '0x' + 'ab'.repeat(32),
    token: USDC,
    amount: '1000',
    locationZone: 'global',
    duration: '3600',
    targetExecutorType: 'agent',
    ...extra,
  });

beforeEach(() => vi.clearAllMocks());

describe('POST /tasks verification-mode gate', () => {
  it("refuses 'oracle' before building a tx", async () => {
    const res = await create({ verificationMode: 'oracle' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VERIFICATION_MODE_UNSUPPORTED');
    expect(buildCreateTask).not.toHaveBeenCalled();
  });

  it.each([
    ['no criteria', undefined],
    ['empty criteria', {}],
    ['only pass_threshold', { pass_threshold: 60 }],
    ['only max_length', { max_length: 500 }],
    ['empty arrays and strings', { contains_keywords: [], required_fields: [], expected_answer: '', rubric: [] }],
  ])("refuses 'auto' with %s", async (_label, verificationCriteria) => {
    const res = await create({ verificationMode: 'auto', verificationCriteria });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUTO_CRITERIA_REQUIRED');
    expect(buildCreateTask).not.toHaveBeenCalled();
  });

  it.each([
    ['min_length', { min_length: 40 }],
    ['contains_keywords', { contains_keywords: ['report'] }],
    ['expected_schema', { expected_schema: { type: 'object' } }],
  ])("lets 'auto' through with %s", async (_label, verificationCriteria) => {
    const res = await create({ verificationMode: 'auto', verificationCriteria });
    expect(res.status).toBe(200);
    expect(buildCreateTask).toHaveBeenCalled();
  });

  it.each([
    ['nested quantifier', '(a+)+$'],
    ['does not compile', '(['],
  ])("refuses 'auto' with a regex_pattern that cannot run (%s)", async (_label, regex_pattern) => {
    const res = await create({ verificationMode: 'auto', verificationCriteria: { min_length: 40, regex_pattern } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REGEX_PATTERN_UNUSABLE');
    expect(buildCreateTask).not.toHaveBeenCalled();
  });

  it("lets 'auto' through with a plain regex_pattern", async () => {
    const res = await create({ verificationMode: 'auto', verificationCriteria: { regex_pattern: '^\\d{4}-\\d{2}$' } });
    expect(res.status).toBe(200);
  });

  it('does not gate manual or unspecified modes', async () => {
    expect((await create({ verificationMode: 'manual' })).status).toBe(200);
    expect((await create({})).status).toBe(200);
  });
});
