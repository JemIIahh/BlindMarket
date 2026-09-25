import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

/**
 * POST /a2a/tasks/index bounds and de-duplicates requiredCapabilities
 * (security audit run 1, C13). Each stored tag is a per-skill proof credit at
 * settlement, so five copies of one tag turned one settlement into five
 * completions. Mounts the REAL a2aRouter; the receipt, escrow, stores and
 * auth are mocked, the same way a2a.lifecycleGuards.test.ts does.
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

vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn(() => Promise.resolve(undefined)) }));
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
vi.mock('../services/accountingService.js', () => ({
  confirmPendingTransactions: vi.fn(() => Promise.resolve()),
}));
vi.mock('../services/semanticMatch.js', () => ({
  recordMatchShadow: vi.fn(() => Promise.resolve()),
  semanticRoutingEligible: vi.fn(() => false),
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

const POSTER = '0x9090000000000000000000000000000000000002';
const TARGET = '0x5b1b000000000000000000000000000000000003';
const ESCROW = '0x00000000000000000000000000000000000e5c00';
const TASK = '0x' + 'ab'.repeat(32);
const TASK_CREATED = ethers.id('TaskCreated(uint256,address,address,uint256,bytes32,string,string,uint256)');

// A public task pinned to one agent: no key material, and it broadcasts
// instead of entering the cascade, so the index runs to setMeta.
const body = (requiredCapabilities: string[]) => ({
  txHash: '0x' + '11'.repeat(32),
  taskHash: TASK,
  verificationMode: 'manual',
  rootHash: '0x' + 'cd'.repeat(32),
  privacy: 'public',
  publicBrief: 'Clean up this CSV',
  targetExecutor: TARGET,
  requiredCapabilities,
});

function index(payload: Record<string, unknown>) {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return request(a).post('/api/v1/a2a/tasks/index').set('x-test-address', POSTER).send(payload);
}

const getReceipt = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  getReceipt.mockResolvedValue({ status: 1, logs: [{ address: ESCROW, topics: [TASK_CREATED], data: '0x' }] });
  vi.mocked(chainRuntime).mockReturnValue({
    provider: { getTransactionReceipt: getReceipt },
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
  vi.mocked(a2aStore.getMeta).mockResolvedValue(undefined);
});

describe('POST /tasks/index — requiredCapabilities', () => {
  it('stores a repeated tag once', async () => {
    const res = await index(body(['data_processing', 'data_processing', 'translation', 'data_processing', 'data_processing']));
    expect(res.status).toBe(200);
    expect(a2aStore.setMeta).toHaveBeenCalledTimes(1);
    expect(vi.mocked(a2aStore.setMeta).mock.calls[0][0].requiredCapabilities).toEqual(['data_processing', 'translation']);
  });

  // The chain key alone survives a move to another network (chainScope), so
  // the listing records the network too.
  it('records the network the task was listed on', async () => {
    const res = await index(body(['translation']));
    expect(res.status).toBe(200);
    expect(vi.mocked(a2aStore.setMeta).mock.calls[0][0]).toMatchObject({ chain: 'arc', chainId: 5042002 });
  });

  it('refuses more than 20 entries before reading the chain', async () => {
    const res = await index(body(Array(21).fill('translation')));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(getReceipt).not.toHaveBeenCalled();
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });
});
