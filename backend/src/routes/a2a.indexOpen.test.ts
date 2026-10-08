import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

/**
 * Listing an open-submission task (docs/OPEN-SUBMISSION-TASKS.md). Whether a
 * task is open comes from the escrow's own OpenTaskCreated event in the
 * funding receipt, never from the request. With OPEN_SUBMISSION_ENABLED off
 * such a task is refused before anything is written; on, it is listed as
 * 'open' and never offered, broadcast or accepted. GET /open-tasks lists the
 * ones still taking submissions.
 *
 * Mounts the REAL a2aRouter with the real BlindEscrow ABI, as in
 * a2a.indexBatch.test.ts, whose mocks this repeats.
 */

const flag = vi.hoisted(() => ({ on: true }));
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>();
  return {
    ...real,
    config: new Proxy(real.config, {
      get: (target, prop) => (prop === 'openSubmissionEnabled' ? flag.on : Reflect.get(target, prop)),
    }),
  };
});
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || '0xagent' };
    next();
  },
}));
vi.mock('../services/a2aStore.js', async () => ({
  getMeta: vi.fn(),
  getState: vi.fn(),
  setMeta: vi.fn(() => Promise.resolve()),
  getTaskHashClaim: vi.fn(() => Promise.resolve(null)),
  listOpenSubmissionTasks: vi.fn(() => Promise.resolve([])),
  pruneOpenSubmissionIndex: vi.fn(() => Promise.resolve()),
  // The real projection: GET /open-tasks is public.
  projectPublicEntry: (await vi.importActual<typeof import('../services/a2aStore.js')>('../services/a2aStore.js')).projectPublicEntry,
}));
// Counts by on-chain task: three on arc:20, none anywhere else.
vi.mock('../services/openSubmissionStore.js', () => ({
  taskRef: (chain: string, taskId: string) => `${chain}:${taskId}`,
  recordedSubmissionCount: vi.fn(async (ref: string) => (ref === 'arc:20' ? 3 : 0)),
}));
vi.mock('../services/avatarStore.js', () => ({ withPosterAvatars: vi.fn(async (metas: unknown[]) => metas) }));
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
import { emitTaskAvailable, emitTaskOffer } from '../services/socket.js';
import { getTaskVerifierOn } from '../services/escrow.js';
import { settlementChainConfig } from '../services/settlementChains.js';

const abi = JSON.parse(readFileSync(new URL('../abi/BlindEscrow.json', import.meta.url), 'utf-8'));
const iface = new ethers.Interface(Array.isArray(abi) ? abi : abi.abi);

const POSTER = '0x9090000000000000000000000000000000000002';
const VERIFIER = '0x7070000000000000000000000000000000000007';
const ESCROW = '0x00000000000000000000000000000000000e5c00';
const FOREIGN = '0x000000000000000000000000000000000000f0e1';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
const TX = '0x' + '11'.repeat(32);
const ROOT = '0x' + 'cd'.repeat(32);
const HASH = '0x' + 'a1'.repeat(32);

const log = (name: string, args: unknown[], address = ESCROW) => {
  const { data, topics } = iface.encodeEventLog(name, args);
  return { address, data, topics, transactionHash: TX, blockNumber: 100 };
};
const taskCreated = (taskId: number, taskHash = HASH) =>
  log('TaskCreated', [taskId, POSTER, ARC_USDC, 1_000_000n, taskHash, 'general', 'global', 9_999_999_999n]);
const verifierSet = (taskId: number) => log('TaskVerifierSet', [taskId, VERIFIER]);
// PickMode 1 = CreatorReview, with a 24 h window.
const openCreated = (taskId: number, address = ESCROW) => log('OpenTaskCreated', [taskId, 1, 86_400], address);
// PickMode 0 = AgentManaged: no creator window.
const openCreatedAgentManaged = (taskId: number) => log('OpenTaskCreated', [taskId, 0, 0]);

const getReceipt = vi.fn();
const receiptWith = (...logs: unknown[]) => getReceipt.mockResolvedValue({ status: 1, logs, blockNumber: 100 });

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return a;
}

const openListing = (extra: Record<string, unknown> = {}) => ({
  txHash: TX,
  taskHash: HASH,
  verificationMode: 'agent',
  verifierAddress: VERIFIER,
  privacy: 'public',
  publicBrief: 'Write a haiku about escrow.',
  rootHash: ROOT,
  ...extra,
});
const index = (body: Record<string, unknown>) =>
  request(app()).post('/api/v1/a2a/tasks/index').set('x-test-address', POSTER).send(body);
const written = () => vi.mocked(a2aStore.setMeta).mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  flag.on = true;
  getReceipt.mockReset();
  vi.mocked(chainRuntime).mockReturnValue({
    provider: { getTransactionReceipt: getReceipt, getLogs: vi.fn(async () => []), getBlockNumber: vi.fn(async () => 1000) },
    escrow: new ethers.Contract(ESCROW, iface),
  } as any);
  vi.mocked(a2aStore.getMeta).mockResolvedValue(undefined);
  vi.mocked(getTaskVerifierOn).mockResolvedValue(VERIFIER);
});

describe('POST /tasks/index — an open-submission task', () => {
  it('is listed as open, with its pick mode from the event, and never offered or broadcast', async () => {
    receiptWith(taskCreated(7), verifierSet(7), openCreated(7));
    const res = await index(openListing());
    expect(res.status).toBe(200);
    expect(written()).toHaveLength(1);
    expect(written()[0]).toMatchObject({ taskId: HASH, submissionMode: 'open', openPick: { mode: 'creator', creatorWindow: 86_400 }, privacy: 'public' });
    expect(seedTaskId).toHaveBeenCalledWith('arc', HASH, '7');
    expect(emitTaskAvailable).not.toHaveBeenCalled();
    expect(emitTaskOffer).not.toHaveBeenCalled();
  });

  it('reads an agent-managed task, where the verifier picks, from the event too', async () => {
    receiptWith(taskCreated(7), verifierSet(7), openCreatedAgentManaged(7));
    await index(openListing());
    expect(written()[0]).toMatchObject({ submissionMode: 'open', openPick: { mode: 'agent', creatorWindow: 0 } });
  });

  it('is refused while open submission is off, before anything is written', async () => {
    flag.on = false;
    receiptWith(taskCreated(7), verifierSet(7), openCreated(7));
    const res = await index(openListing());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OPEN_SUBMISSION_DISABLED');
    expect(seedTaskId).not.toHaveBeenCalled();
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });

  it.each([
    ['private', { privacy: undefined, publicBrief: undefined }, 'OPEN_TASK_MUST_BE_PUBLIC'],
    ['not judged by its verifier', { verificationMode: 'manual', verifierAddress: undefined }, 'OPEN_TASK_NEEDS_VERIFIER'],
    ['pinned to one agent', { targetExecutor: '0x' + '4'.repeat(40) }, 'OPEN_TASK_PINNED'],
  ])('is refused when %s, before anything is written', async (_why, extra, code) => {
    receiptWith(taskCreated(7), verifierSet(7), openCreated(7));
    const res = await index(openListing(extra));
    expect(res.body.error.code).toBe(code);
    expect(seedTaskId).not.toHaveBeenCalled();
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });

  it('cannot be made open by a lookalike event from another contract', async () => {
    receiptWith(taskCreated(7), verifierSet(7), openCreated(7, FOREIGN));
    const res = await index(openListing());
    expect(res.status).toBe(200);
    expect(written()[0].submissionMode).toBeUndefined();
    expect(emitTaskAvailable).toHaveBeenCalled();
  });

  it('cannot switch a task listed as single to open, or back', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: HASH, posterAddress: POSTER, privacy: 'public', verificationMode: 'agent', verifierAddress: VERIFIER, requiredCapabilities: [], targetExecutorType: 'agent', chain: 'arc', chainId: settlementChainConfig('arc').chainId } as any);
    receiptWith(taskCreated(7), verifierSet(7), openCreated(7));
    const res = await index(openListing());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TERMS_IMMUTABLE');
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });

  it('leaves a single-assignee task exactly as before, with the flag on', async () => {
    receiptWith(taskCreated(7), verifierSet(7));
    const res = await index(openListing());
    expect(res.status).toBe(200);
    expect(written()[0].submissionMode).toBeUndefined();
    expect(written()[0].openPick).toBeUndefined();
    expect(emitTaskAvailable).toHaveBeenCalled();
  });

  it('is found the same way through index-batch', async () => {
    receiptWith(taskCreated(7), verifierSet(7), openCreated(7));
    const { txHash: _tx, ...task } = openListing();
    const res = await request(app()).post('/api/v1/a2a/tasks/index-batch').set('x-test-address', POSTER).send({ txHash: TX, tasks: [task] });
    expect(res.body.data.results).toEqual([{ taskHash: HASH, onChainTaskId: '7', indexed: true }]);
    expect(written()[0]).toMatchObject({ submissionMode: 'open' });
    expect(emitTaskAvailable).not.toHaveBeenCalled();
  });
});

describe('POST /tasks/:id/accept', () => {
  it('refuses an open-submission task: agents submit to it instead', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: HASH, submissionMode: 'open', targetExecutorType: 'agent', requiredCapabilities: [] } as any);
    const res = await request(app()).post(`/api/v1/a2a/tasks/${HASH}/accept`).set('x-test-address', '0x' + '5'.repeat(40)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OPEN_SUBMISSION_TASK');
  });
});

describe('GET /open-tasks', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const entry = (taskId: string, deadline: number, status = 'collecting', chainId = settlementChainConfig('arc').chainId) => ({
    meta: { taskId, deadline, chain: 'arc', chainId, posterAddress: POSTER, submissionMode: 'open' },
    state: { taskId, status },
  });

  it('is not there while open submission is off', async () => {
    flag.on = false;
    expect((await request(app()).get('/api/v1/a2a/open-tasks')).status).toBe(404);
  });

  it('lists the tasks still taking submissions, soonest deadline first, with their counts', async () => {
    // Each listing's hash → its on-chain task: the store counts by that.
    vi.mocked(resolveCachedTaskByHash).mockImplementation(async (hash: string) =>
      hash === '0xsooner' ? { chain: 'arc', taskId: '20' } : hash === '0xlater' ? { chain: 'arc', taskId: '21' } : null);
    vi.mocked(a2aStore.listOpenSubmissionTasks).mockResolvedValue([
      entry('0xlater', nowSec + 7200),
      entry('0xpast', nowSec - 60),
      entry('0xsooner', nowSec + 600),
      entry('0xclosed', nowSec + 600, 'completed'),
      entry('0xothernet', nowSec + 600, 'collecting', 1),
    ] as any);
    const res = await request(app()).get('/api/v1/a2a/open-tasks');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.tasks.map((t: any) => [t.meta.taskId, t.submissions])).toEqual([['0xsooner', 3], ['0xlater', 0]]);
    // The escrow's id, so a worker can check its own submission before working.
    expect(res.body.data.tasks.map((t: any) => t.onChainTaskId)).toEqual(['20', '21']);
    // The finished one leaves the index, so the list does not grow forever.
    await vi.waitFor(() => expect(a2aStore.pruneOpenSubmissionIndex).toHaveBeenCalledWith(['0xclosed']));
  });

  it('lists a task whose on-chain id is not cached yet, with no id and no count', async () => {
    vi.mocked(resolveCachedTaskByHash).mockRejectedValueOnce(new Error('redis down'));
    vi.mocked(a2aStore.listOpenSubmissionTasks).mockResolvedValue([entry('0xfresh', nowSec + 600)] as any);
    const res = await request(app()).get('/api/v1/a2a/open-tasks');
    expect(res.status).toBe(200);
    expect(res.body.data.tasks.map((t: any) => [t.meta.taskId, t.onChainTaskId, t.submissions])).toEqual([['0xfresh', null, 0]]);
  });

  it('is public, so it strips key material and private state like GET /tasks', async () => {
    const leaky = entry('0xleaky', nowSec + 600);
    Object.assign(leaky.meta, { wrappedKeys: { [POSTER]: 'SECRET-SLICE' }, keyCustodyBlob: { keyId: 'k', blob: 'SECRET-BLOB' } });
    Object.assign(leaky.state, { resultData: 'SECRET-RESULT', assignError: 'internal' });
    vi.mocked(a2aStore.listOpenSubmissionTasks).mockResolvedValue([leaky] as any);
    const res = await request(app()).get('/api/v1/a2a/open-tasks');
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET|internal/);
    expect(res.body.data.tasks[0].meta).toMatchObject({ taskId: '0xleaky', submissionMode: 'open' });
  });
});
