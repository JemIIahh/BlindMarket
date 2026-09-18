import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /api/v1/tasks/:id reads the 0G TaskRegistry only for a task on a chain
 * whose registry entry has one. The registry is keyed by 0G escrow ids, so
 * reading it with a Base task's id would attach an unrelated 0G task's meta.
 */

const BASE_HASH = '0x' + 'ba'.repeat(32);
const OG_HASH = '0x' + '0a'.repeat(32);

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
    hash === BASE_HASH ? { taskId: '7', chain: 'base' } : hash === OG_HASH ? { taskId: '7', chain: '0g' } : null),
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
    taskHash: OG_HASH,
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

describe('GET /tasks/:id and the TaskRegistry', () => {
  it('does not read the 0G TaskRegistry for a Base task', async () => {
    const res = await get(BASE_HASH);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ chain: 'base', taskId: '7', meta: null });
    expect(escrowService.getTaskOn).toHaveBeenCalledWith('base', 7);
    expect(registryService.getTaskMeta).not.toHaveBeenCalled();
  });

  it('reads it for a 0G task found by hash', async () => {
    const res = await get(OG_HASH);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ chain: '0g', meta: { category: 'general' } });
    expect(registryService.getTaskMeta).toHaveBeenCalledWith(7);
  });

  it('names the unit each task is escrowed in, next to its decimals', async () => {
    // Native 0G on 0G; the mocked escrow returns address(0) as the token.
    const og = await get(OG_HASH);
    expect(og.body.data).toMatchObject({ chain: '0g', symbol: '0G', decimals: 18 });
    // The Base escrow record also says address(0), which is NOT Base's
    // settlement token (USDC): the unit is unknown, so no symbol is claimed.
    const base = await get(BASE_HASH);
    expect(base.body.data).toMatchObject({ chain: 'base', symbol: null });
  });

  it('reads it for a numeric id, which names a 0G task', async () => {
    const res = await get('7');
    expect(res.status).toBe(200);
    expect(res.body.data.chain).toBe('0g');
    expect(escrowService.getTaskOn).toHaveBeenCalledWith('0g', 7);
    expect(registryService.getTaskMeta).toHaveBeenCalledWith(7);
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
    for (const route of ['7/cancel', '7/timeout']) {
      vi.mocked(taskChain.resolveTaskChainById).mockResolvedValueOnce('base');
      const res = await post(route);
      expect(res.status, route).toBe(200);
      expect(res.body.data).toMatchObject({ chain: 'base', chainId: 84532 });
      expect(res.body.data.unsignedTx.to).toBe('0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf');
    }
    vi.mocked(taskChain.resolveTaskChainById).mockResolvedValueOnce('0g');
    const og = await post('7/cancel');
    // The 0G chain id of this test's config (16602 in the test env).
    expect(og.body.data).toMatchObject({ chain: '0g', chainId: 16602 });
  });
});
