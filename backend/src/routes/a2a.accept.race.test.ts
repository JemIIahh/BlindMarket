import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Race-condition regression test for POST /a2a/tasks/:id/accept.
 *
 * Simulates N concurrent agents all calling /accept on the same task
 * and asserts exactly 1 wins (200) while all others get 409.
 *
 * Run:  npx vitest run backend/src/routes/a2a.accept.race.test.ts
 */

// ── Mocks ──────────────────────────────────────────────────────────────────────

const casLog: Map<string, { agent: string; result: string }[]> = new Map();
const redisStore = new Map<string, string>();

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || '0xagent' };
    next();
  },
}));

vi.mock('../services/a2aStore.js', () => {
  const getMeta = vi.fn(async (taskId: string) => {
    if (taskId.toLowerCase() === 'race-task') {
      return {
        taskId,
        rootHash: '0g:race-brief',
        wrappedKeys: {},
        requiredCapabilities: ['svg_generation'],
        deadline: Math.floor(Date.now() / 1000) + 3600,
        skipKeyWrap: true,
      };
    }
    return null;
  });

  const tryAccept = vi.fn(async (taskId: string, agentAddress: string, _ts: string) => {
    const tid = taskId.toLowerCase();
    const log = casLog.get(tid) || [];
    casLog.set(tid, log);
    if (log.length === 0) {
      log.push({ agent: agentAddress, result: 'won' });
      return { ok: true, state: { status: 'accepted', executorAddress: agentAddress } };
    }
    log.push({ agent: agentAddress, result: 'lost_cas' });
    return { ok: false, currentStatus: 'accepted' };
  });

  const getState = vi.fn(async () => ({ status: 'open' }));

  return {
    getMeta, tryAccept, getState,
    mergeWrappedKeys: vi.fn(async () => {}),
    releaseToOpen: vi.fn(async () => {}),
    tryReleaseAccepted: vi.fn(async () => ({ ok: true })),
    setMeta: vi.fn(async () => {}),
    getPosterTasks: vi.fn(async () => []),
    getExecutorTasks: vi.fn(async () => []),
    browseAgentTasks: vi.fn(async () => []),
    getIndexedHashes: vi.fn(async () => []),
    getOffer: vi.fn(async () => undefined),
    checkOffer: vi.fn(async () => false),
    clearOffer: vi.fn(async () => {}),
    setOffer: vi.fn(async () => {}),
    clearCascade: vi.fn(async () => {}),
    tryExpire: vi.fn(async () => ({ ok: true })),
    listOpenTasks: vi.fn(async () => []),
    cacheDeadline: vi.fn(async () => {}),
    getCachedDeadline: vi.fn(async () => null),
    acquireAcceptLock: vi.fn(async () => true),
    releaseAcceptLock: vi.fn(async () => {}),
    logAcceptAttempt: vi.fn(async () => {}),
    getAcceptAttempts: vi.fn(async () => []),
    startSettlementDeadline: vi.fn(async () => {}),
    clearSettlementDeadline: vi.fn(async () => {}),
    getSettlementDeadlineTTL: vi.fn(async () => -2),
  };
});

vi.mock('../services/agentStore.js', () => ({
  getAgent: vi.fn(async (addr: string) => ({
    address: addr,
    displayName: `Agent ${addr}`,
    capabilities: ['svg_generation'],
    publicKey: '04' + 'cc'.repeat(64),
    tasksCompleted: 5,
    registeredAt: new Date().toISOString(),
  })),
}));

vi.mock('../services/keyCustodyService.js', () => ({
  getKeyCustodyService: vi.fn(() => null),
  isKeyCustodyEnabled: vi.fn(() => false),
}));

vi.mock('../services/a2aSettlement.js', () => ({
  settleAssignment: vi.fn(() => Promise.resolve({ success: true, txHash: '0xtx' })),
  settleVerification: vi.fn(() => Promise.resolve({ success: true, txHash: '0xtx' })),
}));

vi.mock('../services/redis.js', () => {
  const streams = new Map<string, any[][]>();
  return {
    redis: {
      setex: vi.fn(async (key: string, _ttl: number, value: string) => { redisStore.set(key, value); }),
      set: vi.fn(async (key: string, value: string, ...args: any[]) => {
        const nx = args.some((a: any) => a === 'NX');
        if (nx && redisStore.has(key)) return null;
        redisStore.set(key, value);
        return 'OK';
      }),
      get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
      del: vi.fn(async (key: string) => { redisStore.delete(key); }),
      exists: vi.fn(async (key: string) => (redisStore.has(key) ? 1 : 0)),
      ttl: vi.fn(async (key: string) => (redisStore.has(key) ? 120 : -2)),
      pipeline: vi.fn(() => {
        const pipe = {
          xadd: vi.fn((_key: string, _id: string, ..._fieldArgs: string[]) => pipe),
          expire: vi.fn(() => pipe),
          exec: vi.fn(async () => []),
        };
        return pipe;
      }),
      xadd: vi.fn(async (key: string, _id: string, ...fieldArgs: string[]) => {
        if (!streams.has(key)) streams.set(key, []);
        streams.get(key)!.push([fieldArgs]);
      }),
      xrange: vi.fn(async (key: string, _start: string, _end: string) => {
        return streams.get(key) ?? [];
      }),
      scan: vi.fn(async (_cursor: string, _cmd: string, _pattern: string) => ['0', []]),
      eval: vi.fn(async (_script: string, numKeys: number, ...args: any[]) => {
        const stateKey = args[0];
        const executor = args[numKeys + 1];
        const acceptedAt = args[numKeys + 2];
        const raw = redisStore.get(stateKey);
        if (!raw) return ['missing'];
        const s = JSON.parse(raw);
        if (s.status !== 'open') return ['lost', s.status];
        s.status = 'accepted';
        s.executorAddress = executor;
        s.acceptedAt = acceptedAt;
        redisStore.set(stateKey, JSON.stringify(s));
        return ['ok', JSON.stringify(s)];
      }),
    },
  };
});

vi.mock('../services/chain.js', () => ({ provider: {}, escrow: { interface: {}, getAddress: vi.fn() } }));
vi.mock('../services/escrow.js', () => ({ getTask: vi.fn(), feeBps: vi.fn(), getTaskVerifier: vi.fn() }));
vi.mock('../services/escrowEvents.js', () => ({ getTaskIdByHash: vi.fn(), getCachedTaskIdByHash: vi.fn(async () => null) }));
vi.mock('../services/autoVerify.js', () => ({ autoVerify: vi.fn() }));
vi.mock('../services/accountingService.js', () => ({}));
vi.mock('../services/reputation.js', () => ({}));
vi.mock('../services/reputationDecay.js', () => ({}));
vi.mock('../services/bidsStore.js', () => ({ clearBids: vi.fn(async () => undefined) }));

import { a2aRouter } from './a2a.js';

// ── Config ─────────────────────────────────────────────────────────────────────

const TASK_ID = 'race-task';
const NUM_AGENTS = 10;
const TRIALS = 100;

const agents = Array.from({ length: NUM_AGENTS }, (_, i) =>
  `0x${i.toString(16).padStart(40, '0')}`,
);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/a2a', a2aRouter);
  return app;
}

async function acceptTask(app: express.Express, agentAddr: string) {
  return request(app)
    .post(`/api/v1/a2a/tasks/${TASK_ID}/accept`)
    .set('x-test-address', agentAddr)
    .send({})
    .timeout(10_000);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('A2A accept race condition', () => {
  let app: express.Express;

  beforeEach(() => {
    app = makeApp();
    casLog.clear();
    redisStore.clear();
  });

  it(`${TRIALS} trials × ${NUM_AGENTS} agents: exactly 1 winner per trial`, { timeout: 60_000 }, async () => {
    let totalWins = 0;
    let totalLosses = 0;

    for (let trial = 0; trial < TRIALS; trial++) {
      casLog.clear();
      redisStore.clear();

      const promises = agents.map((addr) => acceptTask(app, addr));
      const results = await Promise.all(promises);

      const winners = results.filter((r) => r.status === 200);
      const losers = results.filter((r) => r.status === 409);

      expect(winners.length, `trial ${trial}: expected 1 winner`).toBe(1);
      expect(losers.length, `trial ${trial}: expected ${NUM_AGENTS - 1} losers`).toBe(NUM_AGENTS - 1);

      const log = casLog.get(TASK_ID.toLowerCase()) || [];
      expect(log.filter((e) => e.result === 'won').length, `trial ${trial}: 1 won`).toBe(1);
      expect(log.filter((e) => e.result === 'lost_cas').length, `trial ${trial}: ${NUM_AGENTS - 1} lost`).toBe(NUM_AGENTS - 1);

      totalWins += winners.length;
      totalLosses += losers.length;
    }

    expect(totalWins).toBe(TRIALS);
    expect(totalLosses).toBe(TRIALS * (NUM_AGENTS - 1));
  });

  it('winning agent receives brief rootHash', async () => {
    const promises = agents.map((addr) => acceptTask(app, addr));
    const results = await Promise.all(promises);
    const winner = results.find((r) => r.status === 200);
    expect(winner).toBeDefined();
    expect(winner!.body.data.rootHash).toBe('0g:race-brief');
    expect(winner!.body.data.status).toBe('accepted');
  });

  it('all losers get 409 response', async () => {
    const promises = agents.map((addr) => acceptTask(app, addr));
    const results = await Promise.all(promises);
    const losers = results.filter((r) => r.status === 409);
    expect(losers.length).toBe(NUM_AGENTS - 1);
    for (const loser of losers) {
      expect(loser.status).toBe(409);
    }
  });
});
