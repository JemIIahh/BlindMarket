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

const AGENT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ESCROW = '0xcccccccccccccccccccccccccccccccccccccccc';

vi.mock('../middleware/auth.js', () => {
  const gate = (req: any, _res: any, next: any) => { req.user = { address: AGENT }; next(); };
  return { requireAuth: gate, optionalAuth: gate };
});
vi.mock('../config.js', () => ({ config: { baseEscrowAddress: '' } }));
vi.mock('../services/taskChain.js', () => ({ resolveTaskChainById: vi.fn() }));

const buildCreateTask = vi.fn(async () => ({ to: ESCROW, data: '0xcreate' }));
vi.mock('../services/escrow.js', () => ({
  buildCreateTask: (...a: unknown[]) => buildCreateTask(...(a as [])),
  buildCreateTaskBase: vi.fn(),
}));
vi.mock('../services/chain.js', () => ({
  getTokenDecimals: vi.fn(async () => 18),
  provider: null, baseProvider: null, escrow: null, baseEscrow: null,
}));
vi.mock('../services/accountingService.js', () => ({ recordTransaction: vi.fn(async () => ({})) }));
vi.mock('../services/socket.js', () => ({ rooms: { tasks: vi.fn(), platform: vi.fn() } }));
vi.mock('../services/a2aStore.js', () => ({}));
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
    token: '0x0000000000000000000000000000000000000000',
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

  it('does not gate manual or unspecified modes', async () => {
    expect((await create({ verificationMode: 'manual' })).status).toBe(200);
    expect((await create({})).status).toBe(200);
  });
});
