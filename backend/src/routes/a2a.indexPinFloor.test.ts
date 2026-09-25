import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

/**
 * POST /a2a/tasks/index records the escrowed reward and refuses a bare pin
 * below the pinned agent's minReward (security audit run 1, C05).
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
import * as agentStore from '../services/agentStore.js';
import { chainRuntime } from '../services/chainRuntime.js';
import { settlementChainConfig } from '../services/settlementChains.js';

const POSTER = '0x9090000000000000000000000000000000000002';
const PINNED = '0x7777000000000000000000000000000000000007';
const ESCROW = '0x00000000000000000000000000000000000e5c00';
const TASK = '0x' + 'cd'.repeat(32);
const TASK_CREATED = ethers.id('TaskCreated(uint256,address,address,uint256,bytes32,string,string,uint256)');

function index(body: Record<string, unknown>) {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return request(a).post('/api/v1/a2a/tasks/index').set('x-test-address', POSTER)
    .send({ txHash: '0x' + '22'.repeat(32), taskHash: TASK, privacy: 'public', publicBrief: 'Do the thing', ...body });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chainRuntime).mockReturnValue({
    provider: { getTransactionReceipt: vi.fn(async () => ({ status: 1, logs: [{ address: ESCROW, topics: [TASK_CREATED], data: '0x' }] })) },
    escrow: {
      getAddress: vi.fn(async () => ESCROW),
      interface: {
        parseLog: () => ({
          args: { taskId: 9n, taskHash: TASK, agent: POSTER, deadline: 9_999_999_999n, amount: 1n, token: settlementChainConfig('arc').token.address },
        }),
      },
    },
  } as any);
  vi.mocked(a2aStore.getMeta).mockResolvedValue(null as any);
});

describe('POST /tasks/index — minimum reward', () => {
  it('refuses a 1-unit task pinned to an agent with a floor, before anything is listed', async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue({ address: PINNED, minReward: '5000000', supportedChains: ['arc'] } as any);
    const res = await index({ targetExecutor: PINNED });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BELOW_MIN_REWARD');
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });

  it('records the escrowed reward and its unit when the task is listed', async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(null as any);
    await index({});
    expect(a2aStore.setMeta).toHaveBeenCalledWith(expect.objectContaining({
      reward: { amount: '1', unit: settlementChainConfig('arc').token.unit },
    }));
  });
});
