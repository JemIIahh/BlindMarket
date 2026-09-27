import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /api/v1/a2a/tasks shows each poster's avatar on their tasks, looked up
 * by the posterAddress the public meta already carries, and still strips the
 * key material.
 */
const store = vi.hoisted(() => ({ rows: new Map<string, string>(), fail: false }));

vi.mock('../services/redis.js', () => {
  const pipeline = () => {
    const keys: string[] = [];
    const pipe = {
      get(key: string) {
        keys.push(key);
        return pipe;
      },
      exec: async () => {
        if (store.fail) throw new Error('Command timed out');
        return keys.map((k) => [null, store.rows.get(k) ?? null]);
      },
    };
    return pipe;
  };
  return { redis: { get: vi.fn(), set: vi.fn(), exists: vi.fn(), pipeline }, isAlive: vi.fn() };
});

const POSTER = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const OTHER = '0x2222222222222222222222222222222222222222';
const AVATAR = { top: ['bob'], eyes: ['wink'], mouth: ['smile'] };

vi.mock('../services/a2aStore.js', async () => {
  const real = await vi.importActual<typeof import('../services/a2aStore.js')>('../services/a2aStore.js');
  const task = (id: string, posterAddress: string) => ({
    meta: {
      taskId: id,
      targetExecutorType: 'agent',
      verificationMode: 'manual',
      requiredCapabilities: [],
      posterAddress,
      rootHash: '0xroot',
      wrappedKeys: { '0xagent': 'deadbeefslice' },
      routingSummary: 'Summarise a PDF',
    },
    state: { taskId: id, status: 'open' },
  });
  return {
    browseAgentTasks: vi.fn(async () => [task('0x01', POSTER), task('0x02', OTHER)]),
    projectPublicEntry: real.projectPublicEntry,
  };
});

// Import-side-effect-heavy modules — same stubs as the other a2a route tests.
vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn() }));
vi.mock('../services/reputation.js', () => ({ getReputationWithScore: vi.fn() }));
vi.mock('../services/reputationDecay.js', () => ({ getDecayedReputation: vi.fn() }));
vi.mock('../services/keyCustodyService.js', () => ({ getKeyCustodyService: vi.fn(() => null), isKeyCustodyEnabled: vi.fn(() => false) }));
vi.mock('../services/a2aSettlement.js', () => ({ settleAssignment: vi.fn(), settleVerification: vi.fn() }));
vi.mock('../services/chain.js', () => ({ provider: {}, escrow: { interface: {}, getAddress: vi.fn() } }));
vi.mock('../services/escrow.js', () => ({ getTask: vi.fn(), feeBps: vi.fn(), getTaskVerifier: vi.fn() }));
vi.mock('../services/autoVerify.js', () => ({ autoVerify: vi.fn() }));
vi.mock('../services/accountingService.js', () => ({}));
vi.mock('../services/bidsStore.js', () => ({}));
vi.mock('../services/taskChain.js', () => ({ resolveTaskByHash: vi.fn(), resolveTaskChainById: vi.fn() }));

const { a2aRouter } = await import('./a2a.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');

const app = express();
app.use('/api/v1/a2a', a2aRouter);
app.use(globalErrorHandler);

beforeEach(() => {
  store.rows.clear();
  store.fail = false;
});

describe('GET /api/v1/a2a/tasks posterAvatar', () => {
  it("puts the poster's avatar on their tasks' meta and nothing on a poster without one", async () => {
    store.rows.set(`profile:avatar:${POSTER.toLowerCase()}`, JSON.stringify(AVATAR));
    const res = await request(app).get('/api/v1/a2a/tasks');
    expect(res.status).toBe(200);
    const [mine, theirs] = res.body.data.tasks;
    expect(mine.meta).toMatchObject({ taskId: '0x01', posterAddress: POSTER, posterAvatar: AVATAR, routingSummary: 'Summarise a PDF' });
    expect(theirs.meta.posterAvatar).toBeUndefined();
    expect(mine.state).toEqual({ taskId: '0x01', status: 'open' });
    // Still the public projection: no key material, no ciphertext pointer.
    expect(JSON.stringify(res.body)).not.toContain('deadbeefslice');
    expect(mine.meta.rootHash).toBeUndefined();
    expect(res.body.data.total).toBe(2);
  });

  it('still lists every task when the avatar lookup fails', async () => {
    store.fail = true;
    const res = await request(app).get('/api/v1/a2a/tasks');
    expect(res.status).toBe(200);
    expect(res.body.data.tasks).toHaveLength(2);
    expect(res.body.data.tasks[0].meta.posterAvatar).toBeUndefined();
  });
});
