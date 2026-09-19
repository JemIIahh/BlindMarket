import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /api/v1/a2a/tasks/posted enriches each task with its on-chain record.
 * Rewards are amounts in the escrow token's smallest unit, and a poster's list
 * mixes chains — a Base task in 6-decimal USDC next to a 0G task in
 * 18-decimal native 0G — so the row must say which unit each reward is in.
 * The web app used to guess from the chain key alone.
 */

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: '0xposter' };
    next();
  },
}));

vi.mock('../services/a2aStore.js', () => ({
  getMeta: vi.fn(),
  tryAccept: vi.fn(),
  mergeWrappedKeys: vi.fn(),
  releaseToOpen: vi.fn(),
  setMeta: vi.fn(),
  getState: vi.fn(),
  updateState: vi.fn(),
  getPosterTasks: vi.fn(),
  getExecutorTasks: vi.fn(),
  getVerifierTasks: vi.fn(),
  browseAgentTasks: vi.fn(),
  getIndexedHashes: vi.fn(),
  getOffer: vi.fn(() => Promise.resolve(undefined)),
  checkOffer: vi.fn(() => Promise.resolve(false)),
  clearOffer: vi.fn(() => Promise.resolve()),
  setOffer: vi.fn(() => Promise.resolve()),
  clearCascade: vi.fn(() => Promise.resolve()),
  tryExpire: vi.fn(() => Promise.resolve({ ok: true })),
  listOpenTasks: vi.fn(() => Promise.resolve([])),
  cacheDeadline: vi.fn(() => Promise.resolve()),
  getCachedDeadline: vi.fn(() => Promise.resolve(null)),
  acquireAcceptLock: vi.fn(() => Promise.resolve(true)),
  releaseAcceptLock: vi.fn(() => Promise.resolve()),
  logAcceptAttempt: vi.fn(() => Promise.resolve()),
  getAcceptAttempts: vi.fn(() => Promise.resolve([])),
  startSettlementDeadline: vi.fn(() => Promise.resolve()),
  clearSettlementDeadline: vi.fn(() => Promise.resolve()),
  getSettlementDeadlineTTL: vi.fn(() => Promise.resolve(-2)),
}));
vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn(async () => undefined) }));
vi.mock('../services/keyCustodyService.js', () => ({
  getKeyCustodyService: vi.fn(() => null),
  isKeyCustodyEnabled: vi.fn(() => false),
}));
vi.mock('../services/a2aSettlement.js', () => ({
  settleAssignment: vi.fn(),
  settleVerification: vi.fn(),
}));
vi.mock('../services/redis.js', () => ({
  redis: { set: vi.fn(), get: vi.fn(), exists: vi.fn(), pipeline: vi.fn() },
}));
vi.mock('../services/chain.js', () => ({
  provider: {},
  escrow: { interface: {}, getAddress: vi.fn() },
  // A value no chain defaults to, so a fallback that guesses by chain fails.
  getTokenDecimals: vi.fn(async () => 7),
}));
vi.mock('../services/escrow.js', () => ({ getTask: vi.fn(), getTaskOn: vi.fn(), feeBps: vi.fn(), getTaskVerifier: vi.fn() }));
vi.mock('../services/escrowEvents.js', () => ({
  getTaskIdByHash: vi.fn(),
  getCachedTaskIdByHash: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../services/autoVerify.js', () => ({ autoVerify: vi.fn() }));
vi.mock('../services/accountingService.js', () => ({}));
vi.mock('../services/reputation.js', () => ({}));
vi.mock('../services/reputationDecay.js', () => ({}));
vi.mock('../services/bidsStore.js', () => ({}));
vi.mock('../services/taskChain.js', () => ({
  resolveTaskByHash: vi.fn(),
  resolveTaskChainById: vi.fn(),
}));

const cfg = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../config.js')>();
  Object.assign(cfg, mod.config);
  return { ...mod, config: cfg };
});

import { a2aRouter } from './a2a.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as a2aStore from '../services/a2aStore.js';
import * as taskChain from '../services/taskChain.js';
import * as escrowService from '../services/escrow.js';

const app = express();
app.use(express.json());
app.use('/api/v1/a2a', a2aRouter);
app.use(globalErrorHandler);

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ZERO = '0x0000000000000000000000000000000000000000';
const OTHER_TOKEN = '0x1111111111111111111111111111111111111111';
const HASH_BASE = '0x' + 'ba'.repeat(32);
const HASH_OG = '0x' + '0a'.repeat(32);
const HASH_ODD = '0x' + '0d'.repeat(32);
const HASH_NEW = '0x' + '0e'.repeat(32);
const WORKER = '0x2222222222222222222222222222222222222222';

const posted = (taskId: string) => ({
  meta: { taskId, posterAddress: '0xposter', requiredCapabilities: [], wrappedKeys: {} },
  state: { taskId, status: 'open' },
});

const onChain = (token: string, amount: bigint) => ({
  agent: '0xposter',
  worker: WORKER,
  token,
  amount,
  taskHash: HASH_BASE,
  evidenceHash: '0x' + '00'.repeat(32),
  status: 1,
  createdAt: 1n,
  deadline: 2n,
  submissionAttempts: 0,
});

async function listPosted() {
  const res = await request(app).get('/api/v1/a2a/tasks/posted');
  expect(res.status).toBe(200);
  return Object.fromEntries(res.body.data.tasks.map((t: any) => [t.meta.taskId, t]));
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(cfg, {
    ogChainId: 16602,
    blindEscrowAddress: '0x037529B296a89E6Dd1abAF84D413cb2dD70C5be5',
    baseChainId: 84532,
    baseEscrowAddress: '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf',
    baseUsdcAddress: USDC,
    postingChain: '',
  });
  vi.mocked(a2aStore.getPosterTasks).mockResolvedValue([posted(HASH_BASE), posted(HASH_OG), posted(HASH_ODD), posted(HASH_NEW)] as any);
  vi.mocked(taskChain.resolveTaskByHash).mockImplementation(async (h: string) =>
    h === HASH_BASE ? { taskId: '7', chain: 'base' } : h === HASH_OG ? { taskId: '7', chain: '0g' } : h === HASH_ODD ? { taskId: '8', chain: '0g' } : null,
  );
  vi.mocked(escrowService.getTaskOn).mockImplementation(async (chain: string, taskId: number) => {
    if (chain === 'base') return onChain(USDC, 5_000_000n) as any;
    return taskId === 8 ? (onChain(OTHER_TOKEN, 3n) as any) : (onChain(ZERO, 10n ** 18n) as any);
  });
});

describe('GET /a2a/tasks/posted on-chain rows', () => {
  it('keeps every field the web app reads today', async () => {
    const rows = await listPosted();
    expect(rows[HASH_BASE].onChain).toMatchObject({
      taskId: '7',
      chain: 'base',
      status: 1,
      reward: '5000000',
      token: USDC,
      worker: WORKER,
      createdAt: '1',
      deadline: '2',
    });
    expect(rows[HASH_OG].onChain).toMatchObject({ taskId: '7', chain: '0g', reward: '1000000000000000000', token: ZERO });
    expect(rows[HASH_NEW].onChain).toBeNull();
    expect(rows[HASH_BASE]).toMatchObject({ wrapCount: 0, hasCustody: false });
  });

  it('names the unit each reward is in, per task', async () => {
    const rows = await listPosted();
    expect(rows[HASH_BASE].onChain).toMatchObject({ chain: 'base', symbol: 'USDC', decimals: 6 });
    expect(rows[HASH_OG].onChain).toMatchObject({ chain: '0g', symbol: '0G', decimals: 18 });
  });

  it('claims no symbol for a token that is not the chain’s settlement token, but still gives its decimals', async () => {
    const rows = await listPosted();
    // getTokenDecimals is mocked to read 7 for the unknown token.
    expect(rows[HASH_ODD].onChain).toMatchObject({ chain: '0g', token: OTHER_TOKEN, symbol: null, decimals: 7 });
  });

  it('follows the configured token, not the chain name', async () => {
    cfg.baseUsdcAddress = OTHER_TOKEN;
    const rows = await listPosted();
    expect(rows[HASH_BASE].onChain).toMatchObject({ symbol: null });
  });
});
