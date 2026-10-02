import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

/**
 * Who POST /a2a/tasks/index announces a new task to.
 *
 * - A task pinned to one executor was broadcast to every agent; their doomed
 *   accepts held the accept lock and made the target wait out a 409.
 *
 * Mounts the REAL a2aRouter, mocked like a2a.indexCaps.test.ts.
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
  setOffer: vi.fn(() => Promise.resolve()),
  setCascade: vi.fn(() => Promise.resolve()),
  // Long enough that no advance timer fires during a test.
  CASCADE_OFFER_MS: 60_000,
}));

vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock('../services/agentScorer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/agentScorer.js')>()),
  rankAgents: vi.fn(),
  pickExplorationAgent: vi.fn(() => Promise.resolve(null)),
}));
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
  // Every ranked agent is connected, so liveness drops nobody.
  hasAgentSocket: vi.fn(() => true),
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
// Semantic routing off, as on a stack with SEMANTIC_ROUTING_ENABLED=false:
// the capability-tag ranking alone builds the queue.
vi.mock('../services/semanticMatch.js', () => ({
  recordMatchShadow: vi.fn(() => Promise.resolve()),
  semanticRoutingEligible: vi.fn(() => false),
  semanticCascadeRanking: vi.fn(() => Promise.resolve(null)),
  buildTaskRoutingText: vi.fn(() => ''),
  markShadowRoutedBy: vi.fn(() => Promise.resolve()),
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
import { rankAgents, pickExplorationAgent } from '../services/agentScorer.js';
import { emitTaskAvailable, emitTaskOffer } from '../services/socket.js';

const POSTER = '0x9090000000000000000000000000000000000002';
const OTHER = '0x0b0b000000000000000000000000000000000004';
const TARGET = '0x5b1b000000000000000000000000000000000003';
const ESCROW = '0x00000000000000000000000000000000000e5c00';
const TASK = '0x' + 'ab'.repeat(32);
const TASK_CREATED = ethers.id('TaskCreated(uint256,address,address,uint256,bytes32,string,string,uint256)');

const body = (extra: Record<string, unknown> = {}) => ({
  txHash: '0x' + '11'.repeat(32),
  taskHash: TASK,
  verificationMode: 'manual',
  rootHash: '0x' + 'cd'.repeat(32),
  privacy: 'public',
  publicBrief: 'Summarise this escrow in two sentences',
  requiredCapabilities: ['summarization'],
  ...extra,
});

function index(payload: Record<string, unknown>) {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return request(a).post('/api/v1/a2a/tasks/index').set('x-test-address', POSTER).send(payload);
}

const scored = (address: string, score: number) =>
  ({ address, score, displayName: address.slice(0, 6), capabilities: ['summarization'], breakdown: {} }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chainRuntime).mockReturnValue({
    provider: {
      getTransactionReceipt: vi.fn(async () => ({ status: 1, logs: [{ address: ESCROW, topics: [TASK_CREATED], data: '0x' }] })),
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
  vi.mocked(a2aStore.getMeta).mockResolvedValue(undefined);
  // The tag ranking puts the poster first, as it did live.
  vi.mocked(rankAgents).mockResolvedValue([scored(POSTER, 4.17), scored(OTHER, 3.6)]);
});

describe('POST /tasks/index — a pinned task', () => {
  it('is announced to its target alone, never broadcast or offered', async () => {
    const res = await index(body({ targetExecutor: TARGET }));
    expect(res.status).toBe(200);
    expect(emitTaskAvailable).toHaveBeenCalledTimes(1);
    expect(emitTaskAvailable).toHaveBeenCalledWith(TASK, { requiredCapabilities: ['summarization'], chain: 'arc' }, TARGET.toLowerCase());
    expect(emitTaskOffer).not.toHaveBeenCalled();
    expect(rankAgents).not.toHaveBeenCalled();
  });
});
