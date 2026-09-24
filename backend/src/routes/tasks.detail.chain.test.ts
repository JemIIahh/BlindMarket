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
    // x-test-addresses: the account's linked wallets, comma-separated.
    const linked = req.headers['x-test-addresses'];
    req.user = { address: '0x1111111111111111111111111111111111111111', ...(linked ? { addresses: String(linked).split(',') } : {}) };
    next();
  };
  return { requireAuth: pass, optionalAuth: pass };
});
vi.mock('../services/accountingService.js', () => ({ recordTransaction: vi.fn(async () => ({})) }));

vi.mock('../services/taskChain.js', () => ({
  resolveCachedTaskByHash: vi.fn(async (hash: string) =>
    hash === BASE_HASH ? { taskId: '7', chain: 'base' } : hash === ARC_HASH ? { taskId: '7', chain: 'arc' } : null),
  resolvePosterTask: vi.fn(async (_id: number, callers: string[]) => ({ chain: 'base', poster: callers[0] })),
  // Arc task 7 is the one ARC_HASH is indexed to; any other id is a duplicate.
  isIndexedTask: vi.fn(async (chain: string, taskId: number | string, hash: string) =>
    chain === 'arc' && String(taskId) === '7' && hash === ARC_HASH),
}));

// Arc is the posting chain whatever this machine's env says.
vi.mock('../services/settlementChains.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../services/settlementChains.js')>();
  return { ...mod, postingChain: () => 'arc' };
});

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
  projectPublicMeta: vi.fn((m: unknown) => m),
  projectPublicState: vi.fn((s: Record<string, unknown>) => ({ ...s })),
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

  it('reads a numeric id on the posting chain, where new tasks live', async () => {
    const res = await get('7');
    expect(res.status).toBe(200);
    expect(res.body.data.chain).toBe('arc');
    expect(escrowService.getTaskOn).toHaveBeenCalledWith('arc', 7);
  });

  it("serves no A2A state for a duplicate funded under another task's hash, even to the duplicate's poster", async () => {
    const a2aStore = await import('../services/a2aStore.js');
    const visibility = await import('../services/resultVisibility.js');
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: ARC_HASH, privacy: undefined } as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({ taskId: ARC_HASH, status: 'verified', resultData: { output: 'secret' } } as any);
    // The caller IS the duplicate's on-chain poster, so the old gate passed.
    vi.mocked(visibility.canViewerSeeResult).mockResolvedValue(true);

    const res = await get('8');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ taskId: '8', a2aMeta: null, a2aState: null, a2aIndexed: false });
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(a2aStore.getMeta).not.toHaveBeenCalled();
    expect(a2aStore.getState).not.toHaveBeenCalled();

    // The task the hash is indexed to still gets its A2A state.
    const own = await get('7');
    expect(own.body.data.a2aState).toMatchObject({ status: 'verified', resultData: { output: 'secret' } });

    vi.mocked(a2aStore.getMeta).mockResolvedValue(undefined);
    vi.mocked(a2aStore.getState).mockResolvedValue(undefined);
    vi.mocked(visibility.canViewerSeeResult).mockResolvedValue(false);
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
    vi.mocked(taskChain.resolvePosterTask).mockResolvedValueOnce({ chain: 'base', poster: '0x1111111111111111111111111111111111111111' });
    const res = await post('7/cancel');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ chain: 'base', chainId: 84532 });
    expect(res.body.data.unsignedTx.to).toBe('0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf');
  });

  it.each(['cancel', 'timeout', 'confirm-tx'])('%s resolves only on the chain the client names', async (route) => {
    vi.mocked(taskChain.resolvePosterTask).mockResolvedValueOnce({ chain: 'arc', poster: '0x1111111111111111111111111111111111111111' });
    await post(`7/${route}`).send({ chain: 'arc', txHash: '0x' + '11'.repeat(32) });
    expect(taskChain.resolvePosterTask).toHaveBeenCalledWith(7, ['0x1111111111111111111111111111111111111111'], 'arc');
  });

  it('searches every chain when the client names none', async () => {
    await post('7/cancel').send({});
    expect(taskChain.resolvePosterTask).toHaveBeenCalledWith(7, ['0x1111111111111111111111111111111111111111'], undefined);
  });

  it('rejects a chain this backend does not know', async () => {
    const res = await post('7/cancel').send({ chain: '0g' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe('INVALID_CHAIN');
    expect(taskChain.resolvePosterTask).not.toHaveBeenCalled();
  });

  it.each([
    ['cancel', 'buildCancelTaskOn'],
    ['timeout', 'buildClaimTimeoutOn'],
  ] as const)('%s is built for the linked wallet that posted, not the session address', async (route, builder) => {
    const LINKED = '0xbb8021dc9a063f4f2525f532faa3fe1907599026';
    vi.mocked(taskChain.resolvePosterTask).mockResolvedValueOnce({ chain: 'arc', poster: LINKED });
    const res = await post(`7/${route}`).set('x-test-addresses', `0x1111111111111111111111111111111111111111,${LINKED}`).send({ chain: 'arc' });
    expect(res.status).toBe(200);
    expect(taskChain.resolvePosterTask).toHaveBeenCalledWith(7, ['0x1111111111111111111111111111111111111111', LINKED], 'arc');
    expect(escrowService[builder]).toHaveBeenCalledWith('arc', LINKED, 7);
  });

  it('refuses when the caller does not own the id on the named chain', async () => {
    vi.mocked(taskChain.resolvePosterTask).mockResolvedValueOnce(null);
    const res = await post('7/cancel').send({ chain: 'arc' });
    expect(res.status).toBe(403);
    expect(escrowService.buildCancelTaskOn).not.toHaveBeenCalled();
  });
});