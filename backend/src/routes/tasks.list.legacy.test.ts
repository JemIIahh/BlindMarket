import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /api/v1/tasks lists the legacy 0G TaskRegistry. Its ids belong to the 0G
 * escrow, so each row is enriched from that escrow, never the posting chain's,
 * where the same number is an unrelated task (security audit run 1, C28).
 */

const OG_HASH = '0x' + '0a'.repeat(32);
const ZERO = '0x0000000000000000000000000000000000000000';

vi.mock('../middleware/auth.js', () => {
  const pass = (_req: any, _res: any, next: any) => next();
  return { requireAuth: pass, optionalAuth: pass };
});
vi.mock('../services/accountingService.js', () => ({ recordTransaction: vi.fn(async () => ({})) }));
vi.mock('../services/registry.js', () => ({
  getOpenTasks: vi.fn(async () => [{ taskId: 7n, agent: '0x1111111111111111111111111111111111111111', reward: 10n ** 18n }]),
  openTaskCount: vi.fn(async () => 1n),
  getTaskMeta: vi.fn(async () => ({ category: 'general', locationZone: 'global' })),
}));
// The posting chain's escrow: must not be read for registry ids.
vi.mock('../services/escrow.js', () => ({
  getTask: vi.fn(async () => ({ token: '0x3600000000000000000000000000000000000000', taskHash: '0x' + 'ab'.repeat(32) })),
}));
vi.mock('../services/chain.js', () => ({
  escrow: { getTask: vi.fn(async () => ({ token: ZERO, taskHash: OG_HASH })) },
  getTokenDecimals: vi.fn(async () => 18),
}));
vi.mock('../services/a2aStore.js', () => ({
  getIndexedHashes: vi.fn(async () => new Set<string>()),
}));
vi.mock('../services/resultVisibility.js', () => ({ canViewerSeeResult: vi.fn(async () => false) }));
vi.mock('../services/socket.js', () => ({ rooms: { tasks: vi.fn(), platform: vi.fn() } }));

const { tasksRouter } = await import('./tasks.js');
const escrowService = await import('../services/escrow.js');
const chain = await import('../services/chain.js');

beforeEach(() => vi.clearAllMocks());

describe('GET /api/v1/tasks — legacy 0G registry list', () => {
  it("enriches each row from the 0G escrow, with 0G decimals, never the posting chain's escrow", async () => {
    const a = express();
    a.use('/api/v1/tasks', tasksRouter);
    const res = await request(a).get('/api/v1/tasks');
    expect(res.status).toBe(200);
    const [row] = res.body.data.tasks;
    expect(row.taskId).toBe('7');
    expect(row.taskHash).toBe(OG_HASH);
    expect(row.token).toBe(ZERO);
    expect(chain.escrow.getTask).toHaveBeenCalledWith(7);
    expect(chain.getTokenDecimals).toHaveBeenCalledWith(ZERO, '0g');
    expect(escrowService.getTask).not.toHaveBeenCalled();
  });
});
