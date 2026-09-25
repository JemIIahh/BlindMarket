import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

/**
 * POST /a2a/tasks/index re-index keeps the terms a task was first listed on
 * (security audit run 1, C01). Mounts the REAL a2aRouter; the receipt, escrow,
 * stores and auth are mocked, the same way a2a.lifecycleGuards.test.ts does.
 */

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || '0xagent' };
    next();
  },
}));

vi.mock('../services/a2aStore.js', () => ({
  getMeta: vi.fn(),
  getState: vi.fn(),
  setMeta: vi.fn(() => Promise.resolve()),
  getTaskHashClaim: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn() }));
vi.mock('../services/keyCustodyService.js', () => ({
  getKeyCustodyService: vi.fn(() => null),
  isKeyCustodyEnabled: vi.fn(() => false),
}));
vi.mock('../services/redis.js', () => ({
  redis: { set: vi.fn(), get: vi.fn(), exists: vi.fn(), pipeline: vi.fn() },
  isAlive: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('../services/deployedAgentStore.js', () => ({
  loadAgentBySmartAccount: vi.fn(() => Promise.resolve(null)),
  loadAgentByWallet: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../services/socket.js', () => ({
  emitTaskOffer: vi.fn(),
  emitTaskAvailable: vi.fn(),
  hasAgentSocket: vi.fn(() => false),
}));
vi.mock('../services/chain.js', () => ({
  provider: { getTransactionReceipt: vi.fn() },
  baseProvider: { getTransactionReceipt: vi.fn() },
  baseEscrow: { interface: {}, getAddress: vi.fn() },
}));
vi.mock('../services/escrow.js', () => ({ getTaskOn: vi.fn(), getTask: vi.fn(), getTaskVerifierOn: vi.fn() }));
vi.mock('../services/a2aSettlement.js', () => ({
  settleAssignment: vi.fn(),
  settleVerification: vi.fn(),
  resolveAssignee: vi.fn(async (addr: string) => addr),
}));
vi.mock('../services/notificationStore.js', () => ({
  notifyLifecycle: vi.fn(() => Promise.resolve()),
  notify: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../services/workerPayout.js', () => ({
  recordWorkerPayout: vi.fn(() => Promise.resolve()),
  recordWorkerDispute: vi.fn(() => Promise.resolve()),
}));
vi.mock('../services/chainRuntime.js', () => ({ chainRuntime: vi.fn() }));
vi.mock('../services/settlementChains.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/settlementChains.js')>()),
  receiptSearchOrder: () => ['arc'],
}));
vi.mock('../services/taskChain.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/taskChain.js')>()),
  seedTaskId: vi.fn(() => Promise.resolve()),
}));

import { a2aRouter } from './a2a.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as a2aStore from '../services/a2aStore.js';
import { chainRuntime } from '../services/chainRuntime.js';
import { seedTaskId } from '../services/taskChain.js';

const POSTER = '0x9090000000000000000000000000000000000002';
const STRANGER = '0x5555000000000000000000000000000000000005';
const ESCROW = '0x00000000000000000000000000000000000e5c00';
const TASK = '0x' + 'ab'.repeat(32);
const TASK_CREATED = ethers.id('TaskCreated(uint256,address,address,uint256,bytes32,string,string,uint256)');

const listedBody = {
  txHash: '0x' + '11'.repeat(32),
  taskHash: TASK,
  verificationMode: 'auto',
  verificationCriteria: { contains_keywords: ['alpha'], pass_threshold: 70 },
  rootHash: '0xroot',
  requiredCapabilities: ['web_research'],
};

function storedMeta() {
  return {
    taskId: TASK,
    targetExecutorType: 'agent',
    posterAddress: POSTER,
    chain: 'arc',
    verificationMode: 'auto',
    verificationCriteria: { contains_keywords: ['alpha'], pass_threshold: 70 },
    rootHash: '0xroot',
    requiredCapabilities: ['web_research'],
    wrappedKeys: { [POSTER]: 'blob' },
  };
}

function index(caller: string, body: Record<string, unknown>) {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return request(a).post('/api/v1/a2a/tasks/index').set('x-test-address', caller).send(body);
}

beforeEach(() => {
  vi.clearAllMocks();
  // One confirmed createTask receipt from the escrow, created by POSTER.
  vi.mocked(chainRuntime).mockReturnValue({
    provider: {
      getTransactionReceipt: vi.fn(async () => ({
        status: 1,
        logs: [{ address: ESCROW, topics: [TASK_CREATED], data: '0x' }],
      })),
    },
    escrow: {
      getAddress: vi.fn(async () => ESCROW),
      interface: {
        parseLog: () => ({
          args: {
            taskId: 7n,
            taskHash: TASK,
            agent: POSTER,
            deadline: 9_999_999_999n,
            amount: 1_000_000n,
            token: '0x3600000000000000000000000000000000000000',
          },
        }),
      },
    },
  } as any);
  vi.mocked(a2aStore.getMeta).mockResolvedValue(storedMeta() as any);
});

describe('POST /tasks/index — re-index keeps the listed terms', () => {
  it('switching an already-listed auto task to manual → 409 TERMS_IMMUTABLE, nothing written', async () => {
    const res = await index(POSTER, { ...listedBody, verificationMode: 'manual' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TERMS_IMMUTABLE');
    expect(res.body.error.message).toContain('verificationMode');
    expect(seedTaskId).not.toHaveBeenCalled();
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });

  it('swapping the criteria or the brief pointer → 409 TERMS_IMMUTABLE', async () => {
    const criteria = await index(POSTER, { ...listedBody, verificationCriteria: { contains_keywords: ['beta'] } });
    expect(criteria.body.error.code).toBe('TERMS_IMMUTABLE');
    const brief = await index(POSTER, { ...listedBody, rootHash: '0xother' });
    expect(brief.body.error.code).toBe('TERMS_IMMUTABLE');
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });

  it('a retry with the original body passes the terms check', async () => {
    const res = await index(POSTER, { ...listedBody });
    expect(res.body.error?.code).not.toBe('TERMS_IMMUTABLE');
    expect(seedTaskId).toHaveBeenCalled();
  });

  it('a stranger is still refused by the poster check first', async () => {
    const res = await index(STRANGER, { ...listedBody, verificationMode: 'manual' });
    expect(res.body.error.code).toBe('NOT_TASK_AGENT');
  });
});
