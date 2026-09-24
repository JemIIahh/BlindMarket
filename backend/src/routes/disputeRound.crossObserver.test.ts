import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * One failed verification round is one dispute, whichever observers see it
 * (security audit run 1, C21). The poster fails a manual task through
 * POST /a2a/tasks/:id/verify, then replays that round's settlement tx to
 * POST /submissions/confirm. Both used to record a dispute (a second -10
 * for one on-chain failure), because /confirm deduplicated only on its own
 * tx-hash marker. Mounts the REAL a2aRouter, submissionsRouter and
 * workerPayout over one in-memory Redis; stores, chain and auth are mocked.
 */

const h = vi.hoisted(() => ({
  kv: new Map<string, string>(),
  ESCROW: '0xcccccccccccccccccccccccccccccccccccccccc',
  POSTER: '0x9090000000000000000000000000000000000002',
  EXEC: '0xEcEc000000000000000000000000000000000001',
  TASK: '0x' + 'ab'.repeat(32),
  // The escrow's task as of the settlement block: completeVerification(false)
  // leaves submissionAttempts where the failed round's submitEvidence put it.
  attemptsAtSettlement: 1,
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] };
    next();
  },
}));

vi.mock('../services/redis.js', () => ({
  redis: {
    set: vi.fn(async (k: string, v: string, mode?: string) => {
      if (mode === 'NX' && h.kv.has(k)) return null;
      h.kv.set(k, v);
      return 'OK';
    }),
    get: vi.fn(async (k: string) => h.kv.get(k) ?? null),
    del: vi.fn(async (k: string) => Number(h.kv.delete(k))),
    exists: vi.fn(async (k: string) => Number(h.kv.has(k))),
    pipeline: vi.fn(),
  },
  isAlive: vi.fn(async () => false),
}));

vi.mock('../services/a2aStore.js', () => ({
  getMeta: vi.fn(async () => ({ taskId: h.TASK, posterAddress: h.POSTER, verificationMode: 'manual', chain: 'arc' })),
  getState: vi.fn(async () => ({ taskId: h.TASK, status: 'submitted', executorAddress: h.EXEC, resultData: { output: 'x' } })),
  updateState: vi.fn(async () => undefined),
}));

vi.mock('../services/taskChain.js', () => ({
  resolveTaskByHash: vi.fn(async () => ({ taskId: '7', chain: 'arc' })),
  seedTaskId: vi.fn(async () => undefined),
  isListedTask: vi.fn(async () => true),
}));

vi.mock('../services/settlementChains.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/settlementChains.js')>()),
  postingChain: () => 'arc',
}));

vi.mock('../services/escrow.js', () => ({
  // A2A routes read the live task; it is still Submitted when /verify runs.
  getTaskOn: vi.fn(async () => ({
    status: 2, worker: h.EXEC, submissionAttempts: h.attemptsAtSettlement, amount: 1_000_000n,
    token: '0x3600000000000000000000000000000000000000',
  })),
  // /submissions/confirm's poster gate reads the task (now Verified/failed).
  getTask: vi.fn(async () => ({
    taskId: '7', agent: h.POSTER, worker: h.EXEC, token: '0x3600000000000000000000000000000000000000',
    amount: 1_000_000n, taskHash: h.TASK, evidenceHash: '0xev', status: 3, submissionAttempts: h.attemptsAtSettlement,
  })),
  getTaskVerifier: vi.fn(async () => '0x0000000000000000000000000000000000000000'),
  feeBpsOn: vi.fn(async () => 1000),
}));

const getReceipt = vi.fn();
vi.mock('../services/chainRuntime.js', () => ({
  chainRuntime: () => ({
    provider: { getTransactionReceipt: (...a: unknown[]) => getReceipt(...a) },
    escrow: {
      getAddress: async () => h.ESCROW,
      interface: { parseLog: () => ({ name: 'VerificationCompleted', args: { taskId: 7n, passed: false } }) },
      getTask: vi.fn(async () => ({ submissionAttempts: BigInt(h.attemptsAtSettlement) })),
    },
  }),
}));

vi.mock('../services/a2aSettlement.js', () => ({
  settleAssignment: vi.fn(),
  settleVerification: vi.fn(async () => ({ success: true, txHash: '0x' + '55'.repeat(32) })),
  resolveAssignee: vi.fn(async (addr: string) => addr),
}));

// What recordWorkerDispute writes.
vi.mock('../services/agentStore.js', () => ({
  getAgent: vi.fn(async () => undefined),
  adjustReputation: vi.fn(async () => true),
  creditPayoutOnce: vi.fn(),
  hasEarningsTotal: vi.fn(() => true),
}));
vi.mock('../services/reputationDecay.js', () => ({
  recordDispute: vi.fn(async () => undefined),
  recordTaskCompletion: vi.fn(async () => undefined),
}));
vi.mock('../services/accountingService.js', () => ({ recordTransaction: vi.fn(async () => ({})) }));
vi.mock('../services/skillStatsStore.js', () => ({ recordFailure: vi.fn(async () => undefined), recordCompletion: vi.fn(async () => []) }));
vi.mock('../services/semanticProof.js', () => ({ resolveProofSkillSlug: vi.fn(async () => null), mergeProofKeys: vi.fn(() => []) }));
vi.mock('../services/semanticMatch.js', () => ({ recordShadowOutcome: vi.fn(async () => undefined) }));
vi.mock('../services/badgeStore.js', () => ({ grantEarnedBadge: vi.fn(async () => false) }));
vi.mock('../services/serviceStore.js', () => ({ incrementSoldCount: vi.fn(async () => undefined) }));
vi.mock('../services/creditLedger.js', () => ({ isCredited: vi.fn(async () => false) }));
vi.mock('../services/notificationStore.js', () => ({
  notifyLifecycle: vi.fn(async () => undefined),
  notify: vi.fn(async () => null),
}));
vi.mock('../services/socket.js', () => ({ emitTaskOffer: vi.fn(), emitTaskAvailable: vi.fn(), hasAgentSocket: vi.fn(() => false) }));
vi.mock('../services/deployedAgentStore.js', () => ({
  loadAgentBySmartAccount: vi.fn(async () => null),
  loadAgentByWallet: vi.fn(async () => null),
}));
vi.mock('../services/keyCustodyService.js', () => ({ getKeyCustodyService: vi.fn(() => null), isKeyCustodyEnabled: vi.fn(() => false) }));

const { a2aRouter } = await import('./a2a.js');
const { submissionsRouter } = await import('./submissions.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');
const agentStore = await import('../services/agentStore.js');
const reputationDecay = await import('../services/reputationDecay.js');
const accountingService = await import('../services/accountingService.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use('/api/v1/submissions', submissionsRouter);
  a.use(globalErrorHandler);
  return a;
}

const failRound = () =>
  request(app()).post(`/api/v1/a2a/tasks/${h.TASK}/verify`).set('x-test-address', h.POSTER)
    .send({ passed: false, reasons: ['does not meet the brief'] });
const replay = (txHash: string) =>
  request(app()).post('/api/v1/submissions/confirm').set('x-test-address', h.POSTER).send({ taskId: 7, txHash });

beforeEach(() => {
  vi.clearAllMocks();
  h.kv.clear();
  h.attemptsAtSettlement = 1;
  getReceipt.mockResolvedValue({ status: 1, blockNumber: 50, logs: [{ address: h.ESCROW }] });
});

describe('a failed round seen by /a2a/.../verify and /submissions/confirm', () => {
  it('records one dispute: the replayed settlement tx is a duplicate', async () => {
    const verify = await failRound();
    expect(verify.status).toBe(200);
    expect(verify.body.data.status).toBe('failed');

    const confirm = await replay('0x' + '55'.repeat(32));
    expect(confirm.status).toBe(200);
    expect(confirm.body.data).toMatchObject({ confirmed: true, passed: false, duplicate: true });

    expect(agentStore.adjustReputation).toHaveBeenCalledTimes(1);
    expect(agentStore.adjustReputation).toHaveBeenCalledWith(h.EXEC, -10);
    expect(reputationDecay.recordDispute).toHaveBeenCalledTimes(1);
    expect(accountingService.recordTransaction).not.toHaveBeenCalled();
  });

  it("still records the next round's failure, whichever observer sees it first", async () => {
    await failRound();
    // Round 2: the worker resubmitted (attempts 2) and it failed again,
    // observed first through /confirm, then through /verify.
    h.attemptsAtSettlement = 2;
    const confirm = await replay('0x' + '66'.repeat(32));
    expect(confirm.body.data).toMatchObject({ confirmed: true, passed: false });
    expect(confirm.body.data.duplicate).toBeUndefined();
    await failRound();

    expect(agentStore.adjustReputation).toHaveBeenCalledTimes(2);
    expect(reputationDecay.recordDispute).toHaveBeenCalledTimes(2);
  });
});
