import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

/**
 * Who POST /a2a/tasks/index announces a new task to.
 *
 * - The capability-tag ranking scores every registered agent, the task's own
 *   poster included, so a sub-task an agent posted was offered first to that
 *   same agent (seen live: task:offer to the poster, score 4.17), spending an
 *   exclusive window on an accept that 403s SELF_ACCEPT. Agents of the
 *   posting agent's owner are dropped the same way (SAME_OWNER).
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
  walletsOfOwners: vi.fn(() => Promise.resolve([])),
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
// Sponsored gas on, so every announcement carries the hint sponsorHint gives.
vi.mock('../services/gasSponsorConfig.js', () => ({ gasSponsorSettings: () => ({ enabled: true }) }));
vi.mock('../services/gasSponsorEligibility.js', () => ({ sponsorHint: vi.fn(async () => false) }));
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
import { loadAgentByWallet, walletsOfOwners } from '../services/deployedAgentStore.js';
import { sponsorHint } from '../services/gasSponsorEligibility.js';

const POSTER = '0x9090000000000000000000000000000000000002';
const OTHER = '0x0b0b000000000000000000000000000000000004';
const OWNER = '0x0000000000000000000000000000000000000a11';
const SIBLING = '0x5150000000000000000000000000000000000005'; // another of OWNER's agents
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
  vi.mocked(loadAgentByWallet).mockResolvedValue(null);
  vi.mocked(walletsOfOwners).mockResolvedValue([]);
  // The tag ranking puts the poster first, as it did live.
  vi.mocked(rankAgents).mockResolvedValue([scored(POSTER, 4.17), scored(OTHER, 3.6)]);
});

describe('POST /tasks/index — cascade candidates', () => {
  it("never offers the task to its own poster, and keeps it out of the stored queue", async () => {
    const res = await index(body());
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(emitTaskOffer).toHaveBeenCalled());
    expect(emitTaskOffer).toHaveBeenCalledWith(OTHER, TASK, expect.any(Object), 3.6, expect.any(Number));
    expect(emitTaskOffer).not.toHaveBeenCalledWith(POSTER, expect.anything(), expect.anything(), expect.anything(), expect.anything());
    expect(a2aStore.setOffer).toHaveBeenCalledWith(TASK, expect.objectContaining({ address: OTHER }));
    const queue = vi.mocked(a2aStore.setCascade).mock.calls[0][1];
    expect(queue.map((e) => e.address)).toEqual([OTHER]);
  });

  it('bars the poster from the exploration slot too', async () => {
    await index(body());
    await vi.waitFor(() => expect(pickExplorationAgent).toHaveBeenCalled());
    const barred = vi.mocked(pickExplorationAgent).mock.calls[0][5];
    expect(barred).toEqual(new Set([POSTER.toLowerCase()]));
  });

  it("on a hosted agent's sub-task, never offers it to another agent of the same owner", async () => {
    // POSTER is a hosted agent of OWNER (delegation on, or the listing is refused); SIBLING is OWNER's too.
    vi.mocked(loadAgentByWallet).mockImplementation(async (a: string) =>
      a.toLowerCase() === POSTER ? ({ id: 'p', ownerAddress: OWNER, authorizedOwners: [], walletAddress: POSTER, delegationEnabled: true } as never) : null);
    vi.mocked(walletsOfOwners).mockResolvedValue([POSTER, SIBLING]);
    vi.mocked(rankAgents).mockResolvedValue([scored(POSTER, 4.17), scored(SIBLING, 4.0), scored(OTHER, 3.6)]);

    expect((await index(body())).status).toBe(200);
    await vi.waitFor(() => expect(emitTaskOffer).toHaveBeenCalled());
    expect(emitTaskOffer).toHaveBeenCalledWith(OTHER, TASK, expect.any(Object), 3.6, expect.any(Number));
    expect(vi.mocked(a2aStore.setCascade).mock.calls[0][1].map((e) => e.address)).toEqual([OTHER]);
    expect(vi.mocked(pickExplorationAgent).mock.calls[0][5]).toEqual(new Set([POSTER, OWNER, SIBLING]));
    // One owner lookup for the whole build, not one per candidate.
    expect(walletsOfOwners).toHaveBeenCalledTimes(1);
    expect(walletsOfOwners).toHaveBeenCalledWith([OWNER]);
  });

  it('broadcasts instead when the poster was the only candidate', async () => {
    vi.mocked(rankAgents).mockResolvedValue([scored(POSTER, 4.17)]);
    await index(body());
    await vi.waitFor(() => expect(emitTaskAvailable).toHaveBeenCalled());
    expect(emitTaskOffer).not.toHaveBeenCalled();
    expect(emitTaskAvailable).toHaveBeenCalledWith(TASK, { requiredCapabilities: ['summarization'], chain: 'arc' }, undefined);
  });
});

describe('POST /tasks/index — a pinned task', () => {
  it("carries the sponsored-gas hint for its target, asked about that target", async () => {
    // The meta the index writes is what the hint is computed from.
    const saved = new Map<string, unknown>();
    vi.mocked(a2aStore.setMeta).mockImplementation(async (m: any) => { saved.set(m.taskId, m); });
    vi.mocked(a2aStore.getMeta).mockImplementation(async (id: string) => saved.get(id) as never);
    vi.mocked(sponsorHint).mockResolvedValue(true);
    try {
      await index(body({ targetExecutor: TARGET }));
      await vi.waitFor(() => expect(emitTaskAvailable).toHaveBeenCalled());
      expect(emitTaskAvailable).toHaveBeenCalledWith(TASK, expect.objectContaining({ gasSponsored: true }), TARGET.toLowerCase());
      expect(sponsorHint).toHaveBeenCalledWith(expect.objectContaining({ targetExecutor: TARGET.toLowerCase() }), TARGET.toLowerCase());
    } finally {
      vi.mocked(sponsorHint).mockResolvedValue(false);
      vi.mocked(a2aStore.setMeta).mockImplementation(async () => {});
    }
  });

  it('is announced to its target alone, never broadcast or offered', async () => {
    const res = await index(body({ targetExecutor: TARGET }));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(emitTaskAvailable).toHaveBeenCalled());
    expect(emitTaskAvailable).toHaveBeenCalledTimes(1);
    expect(emitTaskAvailable).toHaveBeenCalledWith(TASK, { requiredCapabilities: ['summarization'], chain: 'arc' }, TARGET.toLowerCase());
    expect(emitTaskOffer).not.toHaveBeenCalled();
    expect(rankAgents).not.toHaveBeenCalled();
  });
});
