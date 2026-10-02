import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';

/**
 * A task brief can tell a hosted agent to call delegate_to_agent, which pays a
 * sub-task's reward from the agent's wallet: a poster could have it pay their
 * own agent. Delegation is the owner's opt-in, off by default, and the backend
 * enforces it where a sub-task becomes takeable — listing it (POST
 * /tasks/index; POST /tasks is covered in tasks.post.test.ts) — whatever the
 * worker did. /accept also refuses a sub-task taken by an agent of the
 * poster's own owner. Mounts the REAL a2aRouter and the REAL delegationGuard;
 * the agent store, receipt, escrow and auth are mocked, as in
 * a2a.indexCaps.test.ts.
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
  acquireAcceptLock: vi.fn(() => Promise.resolve(true)),
  releaseAcceptLock: vi.fn(() => Promise.resolve()),
  logAcceptAttempt: vi.fn(() => Promise.resolve()),
  tryAccept: vi.fn(),
  getOffer: vi.fn(() => Promise.resolve(undefined)),
  checkOffer: vi.fn(() => Promise.resolve(false)),
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
const hosted = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('../services/deployedAgentStore.js', () => ({
  loadAgentByWallet: vi.fn(async (a: string) => hosted.get(a.toLowerCase()) ?? null),
  loadAgentBySmartAccount: vi.fn(async () => null),
  // Same rows, queried by owner as the real one does (owner or linked owner).
  walletsOfOwners: vi.fn(async (owners: string[]) => {
    const want = owners.map((o) => o.toLowerCase());
    return [...hosted.values()]
      .filter((a) => [a.ownerAddress, ...((a.authorizedOwners as string[] | undefined) ?? [])].some((o) => want.includes(String(o).toLowerCase())))
      .map((a) => String(a.walletAddress).toLowerCase());
  }),
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
import * as agentStore from '../services/agentStore.js';
import { chainRuntime } from '../services/chainRuntime.js';
import { settleAssignment } from '../services/a2aSettlement.js';

const OWNER = '0x0000000000000000000000000000000000000a11';
const OTHER_OWNER = '0x0000000000000000000000000000000000000b22';
const POSTING_AGENT = '0x9090000000000000000000000000000000000002'; // a hosted agent's wallet
const SIBLING_AGENT = '0x5b1b000000000000000000000000000000000003'; // another of OWNER's agents
const STRANGER_AGENT = '0x5c1c000000000000000000000000000000000004'; // OTHER_OWNER's agent
const ESCROW = '0x00000000000000000000000000000000000e5c00';
const TASK = '0x' + 'ab'.repeat(32);
const TASK_CREATED = ethers.id('TaskCreated(uint256,address,address,uint256,bytes32,string,string,uint256)');

/** A hosted agent as POST /agents/deploy saves it: no delegationEnabled field at all. */
const deployed = (wallet: string, owner: string, extra: Record<string, unknown> = {}) =>
  hosted.set(wallet.toLowerCase(), { id: `agent-${wallet.slice(2, 6)}`, ownerAddress: owner, walletAddress: wallet, ...extra });

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return a;
}

// The body worker.js delegate_to_agent sends to /tasks/index.
const indexBody = {
  txHash: '0x' + '11'.repeat(32),
  taskHash: TASK,
  verificationMode: 'auto',
  verificationCriteria: { min_length: 10 },
  requiredCapabilities: ['summarization'],
  rootHash: '0x' + 'cd'.repeat(32),
  wrappedKeys: {},
};
const list = () => request(app()).post('/api/v1/a2a/tasks/index').set('x-test-address', POSTING_AGENT).send(indexBody);
const accept = (executor: string) => request(app()).post(`/api/v1/a2a/tasks/${TASK}/accept`).set('x-test-address', executor);

beforeEach(() => {
  vi.clearAllMocks();
  hosted.clear();
  vi.mocked(chainRuntime).mockReturnValue({
    provider: { getTransactionReceipt: vi.fn(async () => ({ status: 1, logs: [{ address: ESCROW, topics: [TASK_CREATED], data: '0x' }] })) },
    escrow: {
      getAddress: vi.fn(async () => ESCROW),
      interface: {
        parseLog: () => ({
          args: { taskId: 7n, taskHash: TASK, agent: POSTING_AGENT, deadline: 9_999_999_999n, amount: 10_000n, token: '0x3600000000000000000000000000000000000000' },
        }),
      },
    },
  } as any);
  vi.mocked(a2aStore.getMeta).mockResolvedValue(undefined);
  vi.mocked(a2aStore.acquireAcceptLock).mockResolvedValue(true);
});

describe('listing a sub-task a hosted agent funded (POST /tasks/index)', () => {
  it('is refused for a freshly deployed agent: delegation is off unless the owner turned it on', async () => {
    deployed(POSTING_AGENT, OWNER);
    const res = await list();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DELEGATION_DISABLED');
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });

  it('is refused when the owner turned delegation off', async () => {
    deployed(POSTING_AGENT, OWNER, { delegationEnabled: false });
    expect((await list()).body.error.code).toBe('DELEGATION_DISABLED');
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });

  it('goes through once the owner turned delegation on', async () => {
    deployed(POSTING_AGENT, OWNER, { delegationEnabled: true });
    const res = await list();
    expect(res.status).toBe(200);
    expect(a2aStore.setMeta).toHaveBeenCalledTimes(1);
  });

  it('leaves a poster that is not a hosted agent alone', async () => {
    const res = await list();
    expect(res.status).toBe(200);
  });
});

describe('/accept on a sub-task a hosted agent posted', () => {
  beforeEach(() => {
    deployed(POSTING_AGENT, OWNER, { delegationEnabled: true });
    deployed(SIBLING_AGENT, OWNER);
    deployed(STRANGER_AGENT, OTHER_OWNER);
    // An encrypted sub-task with no key slice for anyone: an accept that gets
    // past the owner check stops at NEEDS_WRAP, before the CAS.
    vi.mocked(a2aStore.getMeta).mockResolvedValue({
      taskId: TASK, posterAddress: POSTING_AGENT, rootHash: '0xroot', wrappedKeys: {}, requiredCapabilities: [],
    } as any);
    vi.mocked(agentStore.getAgent).mockImplementation(async (address: string) => ({ address, capabilities: [], publicKey: '04' + 'ab'.repeat(64) }) as any);
  });

  it('is refused for another agent of the same owner', async () => {
    const res = await accept(SIBLING_AGENT);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SAME_OWNER');
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
    expect(settleAssignment).not.toHaveBeenCalled();
  });

  it("is refused for the owner's own wallet", async () => {
    expect((await accept(OWNER)).body.error.code).toBe('SAME_OWNER');
  });

  it('is refused when the owners overlap through a linked owner wallet', async () => {
    deployed(STRANGER_AGENT, OTHER_OWNER, { authorizedOwners: [OWNER] });
    expect((await accept(STRANGER_AGENT)).body.error.code).toBe('SAME_OWNER');
  });

  it("passes the check for another owner's agent", async () => {
    const res = await accept(STRANGER_AGENT);
    expect(res.body.error.code).not.toBe('SAME_OWNER');
    expect(res.body.error.code).toBe('NEEDS_WRAP');
  });

  it('does not apply to a task a person posted', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({
      taskId: TASK, posterAddress: OWNER, rootHash: '0xroot', wrappedKeys: {}, requiredCapabilities: [],
    } as any);
    expect((await accept(SIBLING_AGENT)).body.error.code).toBe('NEEDS_WRAP');
  });
});
