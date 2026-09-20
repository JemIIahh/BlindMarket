import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /api/v1/tasks/:id resolves a task's chain and reports the unit its
 * reward is escrowed in. The 0G TaskRegistry is no longer coupled to a
 * settlement chain, so task `meta` is null for every settlement chain.
 */

const BASE_HASH = '0x' + 'ba'.repeat(32);
const ARC_HASH = '0x' + '0a'.repeat(32);

vi.mock('../middleware/auth.js', () => {
  const pass = (req: any, _res: any, next: any) => {
    req.user = { address: '0x1111111111111111111111111111111111111111' };
    next();
  };
  return { requireAuth: pass, optionalAuth: pass };
});
vi.mock('../services/accountingService.js', () => ({ recordTransaction: vi.fn(async () => ({})) }));

vi.mock('../services/taskChain.js', () => ({
  resolveCachedTaskByHash: vi.fn(async (hash: string) =>
    hash === BASE_HASH ? { taskId: '7', chain: 'base' } : hash === ARC_HASH ? { taskId: '7', chain: 'arc' } : null),
  resolveTaskChainById: vi.fn(async () => 'base'),
}));

vi.mock('../services/escrow.js', () => ({
  buildCancelTaskOn: vi.fn(async () => ({ to: '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf', data: '0xcancel' })),
  buildClaimTimeoutOn: vi.fn(async () => ({ to: '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf', data: '0xtimeout' })),
  getTaskOn: vi.fn(async (_chain: string, taskId: number) => ({
    taskId: String(taskId),
    agent: '0x1111111111111111111111111111111111111111',
    worker: '0x0000000000000000000000000000000000000000',
    token: '0x0000000000000000000000000000000000000000',
    amount: 5n,
    taskHash: ARC_HASH,
    evidenceHash: '0x' + '00'.repeat(32),
    status: 0,
    createdAt: 1n,
    deadline: 2n,
    submissionAttempts: 0,
  })),
}));

vi.mock('../services/registry.js', () => ({
  getTaskMeta: vi.fn(async () => ({ category: 'general', locationZone: 'global' })),
}));

vi.mock('../services/chain.js', () => ({ getTokenDecimals: vi.fn(async () => 18) }));

vi.mock('../services/a2aStore.js', () => ({
  getIndexedHashes: vi.fn(async () => new Set<string>()),
  getMeta: vi.fn(async () => null),
  getState: vi.fn(async () => null),
}));

vi.mock('../services/resultVisibility.js', () => ({ canViewerSeeResult: vi.fn(async () => false) }));

vi.mock('../services/socket.js', () => ({ rooms: { tasks: vi.fn(), platform: vi.fn() } }));

const { tasksRouter } = await import('./tasks.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');
const registryService = await import('../services/registry.js');
const escrowService = await import('../services/escrow.js');
const taskChain = await import('../services/taskChain.js');

function get(id: string) {
  const a = express();
  a.use('/api/v1/tasks', tasksRouter);
  a.use(globalErrorHandler);
  return request(a).get(`/api/v1/tasks/${id}`);
}

beforeEach(() => vi.clearAllMocks());

describe('GET /tasks/:id', () => {
  it('resolves a Base task and does not read the 0G TaskRegistry', async () => {
    const res = await get(BASE_HASH);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ chain: 'base', taskId: '7', meta: null });
    expect(escrowService.getTaskOn).toHaveBeenCalledWith('base', 7);
    expect(registryService.getTaskMeta).not.toHaveBeenCalled();
  });

  it('resolves an Arc task, meta stays null (no settlement chain has a TaskRegistry)', async () => {
    const res = await get(ARC_HASH);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ chain: 'arc', meta: null });
    expect(registryService.getTaskMeta).not.toHaveBeenCalled();
  });

  it('claims no symbol for address(0), which is not a settlement token on Base or Arc', async () => {
    const base = await get(BASE_HASH);
    expect(base.body.data).toMatchObject({ chain: 'base', symbol: null });
    const arc = await get(ARC_HASH);
    expect(arc.body.data).toMatchObject({ chain: 'arc', symbol: null });
  });

  it('reads a numeric id for the resolved chain', async () => {
    const res = await get('7');
    expect(res.status).toBe(200);
    expect(res.body.data.chain).toBe('base');
    expect(escrowService.getTaskOn).toHaveBeenCalledWith('base', 7);
  });
});


describe('cancel and claim-timeout say which chain their transaction is for', () => {
  const post = (p: string) => {
    const a = express();
    a.use(express.json());
    a.use('/api/v1/tasks', tasksRouter);
    a.use(globalErrorHandler);
    return request(a).post(`/api/v1/tasks/${p}`);
  };

  it('returns chain and chainId with the unsigned tx, like POST /tasks', async () => {
    vi.mocked(taskChain.resolveTaskChainById).mockResolvedValueOnce('base');
    const res = await post('7/cancel');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ chain: 'base', chainId: 84532 });
    expect(res.body.data.unsignedTx.to).toBe('0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf');
  });
});