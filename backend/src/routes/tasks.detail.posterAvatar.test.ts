import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /api/v1/tasks/:id carries the poster's avatar on its public a2aMeta,
 * and still strips the brief's key material.
 */
const ARC_HASH = '0x' + '0a'.repeat(32);
const POSTER = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const AVATAR = { top: ['fro'], eyes: ['happy'], backgroundColor: ['F5B642'] };

const store = vi.hoisted(() => ({ rows: new Map<string, string>() }));

vi.mock('../services/redis.js', () => {
  const pipeline = () => {
    const keys: string[] = [];
    const pipe = {
      get(key: string) {
        keys.push(key);
        return pipe;
      },
      exec: async () => keys.map((k) => [null, store.rows.get(k) ?? null]),
    };
    return pipe;
  };
  return { redis: { get: vi.fn(), set: vi.fn(), pipeline } };
});

vi.mock('../middleware/auth.js', () => {
  const pass = (_req: any, _res: any, next: any) => next();
  return { requireAuth: pass, optionalAuth: pass };
});
vi.mock('../services/accountingService.js', () => ({ recordTransaction: vi.fn(async () => ({})) }));
vi.mock('../services/taskChain.js', () => ({
  resolveCachedTaskByHash: vi.fn(async (hash: string) => (hash === ARC_HASH ? { taskId: '7', chain: 'arc' } : null)),
  resolvePosterTask: vi.fn(),
  isIndexedTask: vi.fn(async () => true),
}));
vi.mock('../services/settlementChains.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../services/settlementChains.js')>();
  return { ...mod, postingChain: () => 'arc' };
});
vi.mock('../services/escrow.js', () => ({
  getTaskOn: vi.fn(async (_chain: string, taskId: number) => ({
    taskId: String(taskId),
    agent: POSTER,
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
vi.mock('../services/registry.js', () => ({ getTaskMeta: vi.fn(async () => null) }));
vi.mock('../services/chain.js', () => ({ getTokenDecimals: vi.fn(async () => 6) }));
vi.mock('../services/a2aStore.js', async () => {
  const real = await vi.importActual<typeof import('../services/a2aStore.js')>('../services/a2aStore.js');
  return {
    getIndexedHashes: vi.fn(async () => new Set([ARC_HASH])),
    getMeta: vi.fn(async () => ({
      taskId: ARC_HASH,
      targetExecutorType: 'agent',
      verificationMode: 'manual',
      requiredCapabilities: [],
      posterAddress: POSTER,
      rootHash: '0xroot',
      wrappedKeys: { '0xagent': 'deadbeefslice' },
      keyCustodyBlob: { keyId: 'kid', blob: 'custodyblob' },
    })),
    getState: vi.fn(async () => null),
    projectPublicMeta: real.projectPublicMeta,
    projectPublicState: real.projectPublicState,
  };
});
vi.mock('../services/resultVisibility.js', () => ({ canViewerSeeResult: vi.fn(async () => false) }));
vi.mock('../services/socket.js', () => ({ rooms: { tasks: vi.fn(), platform: vi.fn() } }));

const { tasksRouter } = await import('./tasks.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');

function get(id: string) {
  const app = express();
  app.use('/api/v1/tasks', tasksRouter);
  app.use(globalErrorHandler);
  return request(app).get(`/api/v1/tasks/${id}`);
}

beforeEach(() => store.rows.clear());

describe('GET /api/v1/tasks/:id posterAvatar', () => {
  it("adds the poster's avatar to the public a2aMeta", async () => {
    store.rows.set(`profile:avatar:${POSTER.toLowerCase()}`, JSON.stringify(AVATAR));
    const res = await get(ARC_HASH);
    expect(res.status).toBe(200);
    expect(res.body.data.a2aMeta).toMatchObject({ posterAddress: POSTER, posterAvatar: AVATAR, hasEncryptedBrief: true });
    expect(res.body.data.a2aMeta.rootHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('deadbeefslice');
    expect(JSON.stringify(res.body)).not.toContain('custodyblob');
  });

  it('sends no posterAvatar when the poster never made one', async () => {
    const res = await get(ARC_HASH);
    expect(res.status).toBe(200);
    expect(res.body.data.a2aMeta.posterAddress).toBe(POSTER);
    expect(res.body.data.a2aMeta).not.toHaveProperty('posterAvatar');
  });
});
