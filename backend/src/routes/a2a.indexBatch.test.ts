import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

/**
 * POST /a2a/tasks/index-batch lists the tasks one transaction funded
 * (docs/BULK-POSTING.md): each listed task is matched to its TaskCreated
 * event by hash and goes through POST /tasks/index's own checks and writes.
 * requireAuth is not authorization: the caller must be each task's on-chain
 * poster, and only the escrow's own events count. POST /tasks/index keeps
 * refusing a receipt with several events.
 *
 * Mounts the REAL a2aRouter with the real BlindEscrow ABI decoding real
 * TaskCreated logs; stores, auth and the chain runtime are mocked, as in
 * a2a.indexCaps.test.ts.
 *
 * Run: npx vitest run src/routes/a2a.indexBatch.test.ts
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
// The per-wallet and per-IP budgets have their own test (middleware/rateLimit.walletBudget.test.ts).
vi.mock('../middleware/rateLimit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/rateLimit.js')>()),
  createWalletBudget: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  postingIpBudget: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../services/settlementChains.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/settlementChains.js')>()),
  receiptSearchOrder: () => ['arc'],
}));
vi.mock('../services/taskChain.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/taskChain.js')>()),
  seedTaskId: vi.fn(() => Promise.resolve()),
  resolveCachedTaskByHash: vi.fn(async () => null),
}));

import { a2aRouter } from './a2a.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import * as a2aStore from '../services/a2aStore.js';
import { chainRuntime } from '../services/chainRuntime.js';
import { resolveCachedTaskByHash, seedTaskId } from '../services/taskChain.js';
import { emitTaskAvailable } from '../services/socket.js';
import { getTaskVerifierOn } from '../services/escrow.js';

const abi = JSON.parse(readFileSync(new URL('../abi/BlindEscrow.json', import.meta.url), 'utf-8'));
const iface = new ethers.Interface(Array.isArray(abi) ? abi : abi.abi);

const POSTER = '0x9090000000000000000000000000000000000002';
const STRANGER = '0x5555000000000000000000000000000000000005';
const ESCROW = '0x00000000000000000000000000000000000e5c00';
const FOREIGN = '0x000000000000000000000000000000000000f0e1';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const TX = '0x' + '11'.repeat(32);
const ROOT = '0x' + 'cd'.repeat(32);
const hash = (i: number) => '0x' + (0xa0 + i).toString(16).repeat(32);

/** A TaskCreated log as the escrow at `address` emits it. */
function taskCreated(taskId: number, taskHash: string, { agent = POSTER, address = ESCROW } = {}) {
  const { data, topics } = iface.encodeEventLog('TaskCreated', [
    taskId, agent, ARC_USDC, 1_000_000n, taskHash, 'general', 'global', 9_999_999_999n,
  ]);
  return { address, data, topics, transactionHash: TX, blockNumber: 100 };
}

/** A TaskVerifierSet log: the escrow at `address` committed `verifier` as `taskId`'s settler. */
function verifierSet(taskId: number, verifier: string, address = ESCROW) {
  const { data, topics } = iface.encodeEventLog('TaskVerifierSet', [taskId, verifier]);
  return { address, data, topics, transactionHash: TX, blockNumber: 100 };
}

const getReceipt = vi.fn();
const getLogs = vi.fn();

function receiptWith(...logs: Array<{ address: string; data: string; topics: readonly string[] }>) {
  getReceipt.mockResolvedValue({ status: 1, logs, blockNumber: 100 });
}

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return a;
}

const listing = (i: number, extra: Record<string, unknown> = {}) => ({ taskHash: hash(i), verificationMode: 'manual', rootHash: ROOT, ...extra });
const indexBatch = (tasks: unknown[], caller = POSTER, extra: Record<string, unknown> = {}) =>
  request(app()).post('/api/v1/a2a/tasks/index-batch').set('x-test-address', caller).send({ txHash: TX, tasks, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  getReceipt.mockReset();
  getLogs.mockReset();
  vi.mocked(chainRuntime).mockReturnValue({
    provider: { getTransactionReceipt: getReceipt, getLogs, getBlockNumber: vi.fn(async () => 1000) },
    escrow: new ethers.Contract(ESCROW, iface),
  } as any);
  vi.mocked(a2aStore.getMeta).mockResolvedValue(undefined);
  vi.mocked(a2aStore.getTaskHashClaim).mockResolvedValue(null);
  vi.mocked(resolveCachedTaskByHash).mockResolvedValue(null);
});

describe('POST /a2a/tasks/index-batch', () => {
  it('lists two tasks funded by one transaction, each under its own escrow task', async () => {
    receiptWith(taskCreated(7, hash(0)), taskCreated(8, hash(1)));
    const res = await indexBatch([listing(0), listing(1)]);
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([
      { taskHash: hash(0), onChainTaskId: '7', indexed: true },
      { taskHash: hash(1), onChainTaskId: '8', indexed: true },
    ]);
    // The receipt is read once for the whole batch.
    expect(getReceipt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(seedTaskId).mock.calls).toEqual(expect.arrayContaining([['arc', hash(0), '7'], ['arc', hash(1), '8']]));
    const metas = vi.mocked(a2aStore.setMeta).mock.calls.map((c) => c[0]);
    expect(metas.map((m) => [m.taskId, m.posterAddress, m.chain])).toEqual(expect.arrayContaining([
      [hash(0), POSTER, 'arc'],
      [hash(1), POSTER, 'arc'],
    ]));
    expect(emitTaskAvailable).toHaveBeenCalledTimes(2);
  });

  it('lists a receipt with a single task (a Phase 1 transaction)', async () => {
    receiptWith(taskCreated(7, hash(0)));
    const res = await indexBatch([listing(0)]);
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([{ taskHash: hash(0), onChainTaskId: '7', indexed: true }]);
  });

  it('answers NOT_IN_RECEIPT for a listed task the transaction did not fund, and lists the rest', async () => {
    receiptWith(taskCreated(7, hash(0)));
    const res = await indexBatch([listing(0), listing(1)]);
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([
      { taskHash: hash(0), onChainTaskId: '7', indexed: true },
      { taskHash: hash(1), error: { code: 'NOT_IN_RECEIPT', message: expect.any(String) } },
    ]);
    expect(vi.mocked(a2aStore.setMeta).mock.calls.map((c) => c[0].taskId)).toEqual([hash(0)]);
  });

  it("ignores a lookalike TaskCreated from another contract: that task is NOT_IN_RECEIPT", async () => {
    receiptWith(taskCreated(7, hash(0)), taskCreated(8, hash(1), { address: FOREIGN }));
    const res = await indexBatch([listing(0), listing(1)]);
    expect(res.body.data.results[0]).toMatchObject({ indexed: true, onChainTaskId: '7' });
    expect(res.body.data.results[1]).toEqual({ taskHash: hash(1), error: { code: 'NOT_IN_RECEIPT', message: expect.any(String) } });
    expect(vi.mocked(a2aStore.setMeta).mock.calls.map((c) => c[0].taskId)).toEqual([hash(0)]);
  });

  it('refuses a caller who is not the on-chain poster, writing nothing', async () => {
    receiptWith(taskCreated(7, hash(0)), taskCreated(8, hash(1)));
    const res = await indexBatch([listing(0), listing(1)], STRANGER);
    expect(res.status).toBe(200);
    expect(res.body.data.results.map((r: any) => r.error?.code)).toEqual(['NOT_TASK_AGENT', 'NOT_TASK_AGENT']);
    expect(seedTaskId).not.toHaveBeenCalled();
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });

  it('checks the poster per task: a task another wallet funded in the same receipt is refused', async () => {
    receiptWith(taskCreated(7, hash(0)), taskCreated(8, hash(1), { agent: STRANGER }));
    const res = await indexBatch([listing(0), listing(1)]);
    expect(res.body.data.results[0]).toMatchObject({ indexed: true });
    expect(res.body.data.results[1].error.code).toBe('NOT_TASK_AGENT');
  });

  it("keeps a listing's first poster, as the single route does", async () => {
    receiptWith(taskCreated(7, hash(0)), taskCreated(8, hash(1)));
    vi.mocked(a2aStore.getMeta).mockImplementation(async (h: string) =>
      (h === hash(1) ? { taskId: hash(1), posterAddress: STRANGER, chain: 'arc' } : undefined) as any);
    const res = await indexBatch([listing(0), listing(1)]);
    expect(res.body.data.results[0]).toMatchObject({ indexed: true });
    expect(res.body.data.results[1].error.code).toBe('TASK_HASH_TAKEN');
  });

  it('re-lists a task its poster already listed, on the same terms', async () => {
    receiptWith(taskCreated(7, hash(0)));
    vi.mocked(a2aStore.getMeta).mockResolvedValue({
      taskId: hash(0), posterAddress: POSTER, chain: 'arc', chainId: 5042002, verificationMode: 'manual', rootHash: ROOT, requiredCapabilities: [],
    } as any);
    vi.mocked(resolveCachedTaskByHash).mockResolvedValue({ chain: 'arc', taskId: '7' });
    const res = await indexBatch([listing(0)]);
    expect(res.body.data.results).toEqual([{ taskHash: hash(0), onChainTaskId: '7', indexed: true }]);
  });

  it('refuses a hash listed twice in one request, the second time', async () => {
    receiptWith(taskCreated(7, hash(0)));
    const res = await indexBatch([listing(0), listing(0)]);
    expect(res.body.data.results[0]).toMatchObject({ indexed: true });
    expect(res.body.data.results[1]).toEqual({ taskHash: hash(0), error: { code: 'DUPLICATE_TASK_HASH', message: expect.stringMatching(/^Task 1 lists the same taskHash/) } });
    expect(a2aStore.setMeta).toHaveBeenCalledTimes(1);
  });

  it('refuses a hash the receipt funded twice as ambiguous', async () => {
    receiptWith(taskCreated(7, hash(0)), taskCreated(8, hash(0)));
    const res = await indexBatch([listing(0)]);
    expect(res.body.data.results).toEqual([{ taskHash: hash(0), error: { code: 'MULTIPLE_TASK_CREATED', message: expect.any(String) } }]);
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });

  it("refuses a task's own terms per item, before reading the chain for it", async () => {
    receiptWith(taskCreated(7, hash(0)), taskCreated(8, hash(1)));
    const res = await indexBatch([listing(0, { verificationMode: 'oracle' }), listing(1), { taskHash: 'nope' }]);
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([
      { taskHash: hash(0), error: { code: 'VERIFICATION_MODE_UNSUPPORTED', message: expect.any(String) } },
      { taskHash: hash(1), onChainTaskId: '8', indexed: true },
      // A malformed hash is not echoed back.
      { taskHash: '', error: { code: 'VALIDATION_ERROR', message: expect.stringContaining('taskHash') } },
    ]);
  });

  it('reads no receipt when no listed task passes its own checks', async () => {
    const res = await indexBatch([listing(0, { verificationMode: 'oracle' })]);
    expect(res.status).toBe(200);
    expect(res.body.data.results[0].error.code).toBe('VERIFICATION_MODE_UNSUPPORTED');
    expect(getReceipt).not.toHaveBeenCalled();
  });

  it('fails the whole request for a receipt it cannot use', async () => {
    getReceipt.mockResolvedValue({ status: 0, logs: [] });
    expect((await indexBatch([listing(0)])).body.error.code).toBe('TX_REVERTED');
    receiptWith(taskCreated(7, hash(0), { address: FOREIGN }));
    const res = await indexBatch([listing(0)]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_TASK_CREATED');
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });

  it('finds a user-op funding transaction by any listed hash in the escrow logs', async () => {
    const logs = [taskCreated(7, hash(0)), taskCreated(8, hash(1))];
    getLogs.mockResolvedValue([logs[1]]);
    getReceipt.mockImplementation(async (h: string) => (h === TX ? { status: 1, logs, blockNumber: 100 } : null));
    const res = await request(app()).post('/api/v1/a2a/tasks/index-batch').set('x-test-address', POSTER)
      .send({ txHash: '0x' + '99'.repeat(32), isUserOp: true, tasks: [listing(0), listing(1)] });
    expect(res.status).toBe(200);
    expect(res.body.data.results.map((r: any) => r.onChainTaskId)).toEqual(['7', '8']);
    expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ address: ESCROW }));
  });

  it('answers a malformed request with readable text, not zod JSON', async () => {
    const res = await request(app()).post('/api/v1/a2a/tasks/index-batch').set('x-test-address', POSTER).send({ tasks: [listing(0)] });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'VALIDATION_ERROR', message: 'txHash: Required' });
  });

  it('takes 1 to 50 tasks', async () => {
    expect((await indexBatch([])).status).toBe(400);
    expect((await indexBatch(Array.from({ length: 51 }, (_, i) => listing(i)))).status).toBe(400);
    expect(getReceipt).not.toHaveBeenCalled();
  });
});

// Only a task's on-chain verifier can settle it, so an escrow that commits one
// can't be listed as auto or manual (security review): the verifier, not the
// advertised mode, would decide.
describe('a listing whose escrow commits a verifier', () => {
  const VERIFIER = '0x7777000000000000000000000000000000000007';
  const indexOne = (body: Record<string, unknown>) =>
    request(app()).post('/api/v1/a2a/tasks/index').set('x-test-address', POSTER).send({ txHash: TX, ...body });

  it('index-batch refuses that task as manual or auto, per item, and lists the rest', async () => {
    receiptWith(taskCreated(7, hash(0)), verifierSet(7, VERIFIER), taskCreated(8, hash(1)), taskCreated(9, hash(2)), verifierSet(9, VERIFIER));
    const res = await indexBatch([
      listing(0),
      listing(1),
      listing(2, { verificationMode: 'auto', verificationCriteria: { min_length: 40 } }),
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data.results.map((r: any) => r.error?.code ?? r.onChainTaskId)).toEqual(['VERIFIER_MODE_MISMATCH', '8', 'VERIFIER_MODE_MISMATCH']);
    expect(res.body.data.results[0].error.message).toContain(VERIFIER);
    expect(vi.mocked(a2aStore.setMeta).mock.calls.map((c) => c[0].taskId)).toEqual([hash(1)]);
    expect(vi.mocked(seedTaskId).mock.calls.map((c) => c[1])).toEqual([hash(1)]);
  });

  it("ignores a TaskVerifierSet from another contract, or for another task", async () => {
    receiptWith(taskCreated(7, hash(0)), verifierSet(7, VERIFIER, FOREIGN), taskCreated(8, hash(1)), verifierSet(99, VERIFIER));
    const res = await indexBatch([listing(0), listing(1)]);
    expect(res.body.data.results.map((r: any) => r.onChainTaskId)).toEqual(['7', '8']);
  });

  it('the single route refuses it too, writing nothing', async () => {
    receiptWith(taskCreated(7, hash(0)), verifierSet(7, VERIFIER));
    const res = await indexOne(listing(0, { verificationMode: 'auto', verificationCriteria: { contains_keywords: ['done'] } }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERIFIER_MODE_MISMATCH');
    expect(res.body.error.message).toContain('cancel task 7');
    expect(seedTaskId).not.toHaveBeenCalled();
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });

  it('still lists it in agent mode naming that verifier', async () => {
    receiptWith(taskCreated(7, hash(0)), verifierSet(7, VERIFIER));
    vi.mocked(getTaskVerifierOn).mockResolvedValue(VERIFIER);
    const res = await indexOne(listing(0, { verificationMode: 'agent', verifierAddress: VERIFIER, privacy: 'public', publicBrief: 'Sum it up' }));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ taskHash: hash(0), onChainTaskId: '7', indexed: true });
  });

  it('lists a manual task whose escrow commits no verifier, as before', async () => {
    receiptWith(taskCreated(7, hash(0)));
    expect((await indexOne(listing(0))).status).toBe(200);
  });
});

describe('POST /a2a/tasks/index — one task per receipt', () => {
  const indexOne = (body: Record<string, unknown>) =>
    request(app()).post('/api/v1/a2a/tasks/index').set('x-test-address', POSTER).send({ txHash: TX, ...body });

  it('still refuses a receipt with several TaskCreated events as ambiguous', async () => {
    receiptWith(taskCreated(7, hash(0)), taskCreated(8, hash(1)));
    const res = await indexOne(listing(0));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MULTIPLE_TASK_CREATED');
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });

  it('lists a single-task receipt, ignoring a lookalike event from another contract', async () => {
    receiptWith(taskCreated(7, hash(0)), taskCreated(9, hash(0), { address: FOREIGN }));
    const res = await indexOne(listing(0));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ taskHash: hash(0), onChainTaskId: '7', indexed: true });
  });

  it('refuses a claimed hash that is not the one the receipt funded', async () => {
    receiptWith(taskCreated(7, hash(1)));
    const res = await indexOne(listing(0));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('HASH_MISMATCH');
  });

  it('refuses a caller who is not the on-chain poster', async () => {
    receiptWith(taskCreated(7, hash(0)));
    const res = await request(app()).post('/api/v1/a2a/tasks/index').set('x-test-address', STRANGER).send({ txHash: TX, ...listing(0) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_TASK_AGENT');
  });
});
