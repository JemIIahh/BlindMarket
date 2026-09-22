import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Executors declare the settlement chains their code can sign for, and the
 * backend never hands a task on another chain to them. Accepting assigns a
 * task on-chain and can't be undone, so a worker that can't sign there would
 * strand it. Executors registered by older code have no declaration and are
 * treated as the legacy set, 0G and Base.
 */

const { AGENT, VERIFIER } = vi.hoisted(() => ({
  AGENT: '0xagent0000000000000000000000000000000001',
  VERIFIER: '0xverifier00000000000000000000000000000002',
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || '0xagent0000000000000000000000000000000001' };
    next();
  },
}));

vi.mock('../services/a2aStore.js', () => ({
  getMeta: vi.fn(),
  tryAccept: vi.fn(),
  getState: vi.fn(async () => null),
  updateState: vi.fn(),
  getOffer: vi.fn(async () => undefined),
  tryExpire: vi.fn(async () => ({ ok: true })),
  logAcceptAttempt: vi.fn(async () => undefined),
  acquireAcceptLock: vi.fn(async () => true),
  releaseAcceptLock: vi.fn(async () => undefined),
  getVerifierTasks: vi.fn(async () => []),
  startSettlementDeadline: vi.fn(async () => undefined),
  clearSettlementDeadline: vi.fn(async () => undefined),
  clearOffer: vi.fn(async () => undefined),
  clearCascade: vi.fn(async () => undefined),
}));
vi.mock('../services/agentStore.js', () => ({
  getAgent: vi.fn(),
  registerAgent: vi.fn(async () => undefined),
  listAgents: vi.fn(async () => []),
}));
vi.mock('../services/bidsStore.js', () => ({ addBid: vi.fn(async () => undefined), clearBids: vi.fn(async () => undefined) }));
vi.mock('../services/agentEmbedding.js', () => ({ recomputeForWalletBestEffort: vi.fn() }));
vi.mock('../services/taskChain.js', () => ({ resolveTaskByHash: vi.fn(), seedTaskId: vi.fn() }));
vi.mock('../services/keyCustodyService.js', () => ({
  getKeyCustodyService: vi.fn(() => null),
  isKeyCustodyEnabled: vi.fn(() => false),
}));
vi.mock('../services/a2aSettlement.js', () => ({
  settleAssignment: vi.fn(async () => ({ success: true, txHash: '0xtx', chain: 'base' })),
  settleVerification: vi.fn(),
  resolveAssignee: vi.fn(async (a: string) => a),
}));
vi.mock('../services/redis.js', () => ({ redis: { set: vi.fn(), get: vi.fn(), exists: vi.fn(), pipeline: vi.fn() } }));
vi.mock('../services/chain.js', () => ({ provider: {}, escrow: { interface: {}, getAddress: vi.fn() }, baseEscrow: null }));
vi.mock('../services/escrow.js', () => ({ getTask: vi.fn(), feeBps: vi.fn(), getTaskVerifier: vi.fn() }));
vi.mock('../services/escrowEvents.js', () => ({ getTaskIdByHash: vi.fn(), getCachedTaskIdByHash: vi.fn(async () => null) }));
vi.mock('../services/autoVerify.js', () => ({ autoVerify: vi.fn() }));
vi.mock('../services/accountingService.js', () => ({}));
vi.mock('../services/reputation.js', () => ({}));
vi.mock('../services/reputationDecay.js', () => ({}));
vi.mock('../services/workerPayout.js', () => ({ recordWorkerPayout: vi.fn(), recordWorkerDispute: vi.fn() }));
vi.mock('../services/notificationStore.js', () => ({ notifyLifecycle: vi.fn(async () => undefined), notify: vi.fn(async () => null) }));

const { a2aRouter } = await import('./a2a.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');
const a2aStore = await import('../services/a2aStore.js');
const agentStore = await import('../services/agentStore.js');
const bidsStore = await import('../services/bidsStore.js');
const taskChain = await import('../services/taskChain.js');
const { settleAssignment } = await import('../services/a2aSettlement.js');
const { supportsChain, supportsTaskChain, LEGACY_SUPPORTED_CHAINS } = await import('../services/executorChains.js');

const TASK = '0xtaskhash';
const PUBKEY = '04' + 'ab'.repeat(64);

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return a;
}

function executor(supportedChains?: string[] | null, address = AGENT) {
  return { address, displayName: 'a', capabilities: [], publicKey: PUBKEY, reputation: 50, tasksCompleted: 0, registeredAt: '', supportedChains };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(a2aStore.tryAccept).mockResolvedValue({ ok: true, state: {} } as any);
  vi.mocked(a2aStore.getState).mockResolvedValue(null as any);
  vi.mocked(agentStore.getAgent).mockResolvedValue(undefined);
});

describe('supportsChain', () => {
  it('treats an executor with no declaration as Base only', () => {
    expect(LEGACY_SUPPORTED_CHAINS).toEqual(['base']);
    expect(supportsChain({ supportedChains: null }, 'base')).toBe(true);
    expect(supportsChain({}, 'arc')).toBe(false);
    expect(supportsChain({ supportedChains: undefined }, 'arc')).toBe(false);
  });

  it('follows a declaration, and does not filter when no chain is given (listings, ranking)', () => {
    expect(supportsChain({ supportedChains: ['arc'] }, 'base')).toBe(false);
    expect(supportsChain({ supportedChains: ['arc', 'base', 'arc'] }, 'arc')).toBe(true);
    expect(supportsChain({ supportedChains: [] }, undefined)).toBe(true);
    expect(supportsChain({ supportedChains: [] }, null)).toBe(true);
  });

  it('requires both legacy chains to hand over a task with no recorded chain', () => {
    expect(supportsTaskChain({ supportedChains: null }, undefined)).toBe(true);
    expect(supportsTaskChain({ supportedChains: ['base', 'arc'] }, null)).toBe(true);
    expect(supportsTaskChain({ supportedChains: ['arc'] }, undefined)).toBe(false);
    expect(supportsTaskChain({ supportedChains: ['arc'] }, undefined)).toBe(false);
    expect(supportsTaskChain({ supportedChains: ['arc'] }, 'arc')).toBe(true);
  });
});

describe('POST /accept', () => {
  const accept = () => request(app()).post(`/api/v1/a2a/tasks/${TASK}/accept`).set('x-test-address', AGENT);

  it('refuses a task on a chain the executor did not declare, before the CAS and any on-chain step', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, requiredCapabilities: [], chain: 'base' } as any);
    vi.mocked(agentStore.getAgent).mockResolvedValue(executor(['arc']) as any);

    const res = await accept();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHAIN_UNSUPPORTED');
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
    expect(settleAssignment).not.toHaveBeenCalled();
    expect(a2aStore.logAcceptAttempt).toHaveBeenCalledWith(TASK, AGENT, 'rejected_precheck');
  });

  it('refuses a chain a legacy executor cannot know', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, requiredCapabilities: [], chain: 'arc' } as any);
    vi.mocked(agentStore.getAgent).mockResolvedValue(executor(null) as any);
    expect((await accept()).body.error.code).toBe('CHAIN_UNSUPPORTED');
  });

  it('refuses a task indexed before chains were recorded to an executor that lacks the legacy chain', async () => {
    // Such a task may be on Base.
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, requiredCapabilities: [] } as any);
    vi.mocked(agentStore.getAgent).mockResolvedValue(executor(['arc']) as any);
    const res = await accept();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHAIN_UNSUPPORTED');
    expect(res.body.error.message).toMatch(/Base/);
  });

  it.each([
    ['a legacy executor on Base', null, 'base'],
    ['a declared executor on its chain', ['base'], 'base'],
    ['a legacy executor on a task indexed before chains were recorded', null, undefined],
    ['an executor declaring both chains on such a task', ['arc', 'base', 'arc'], undefined],
  ])('accepts %s', async (_label, declared, chain) => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, requiredCapabilities: [], chain } as any);
    vi.mocked(agentStore.getAgent).mockResolvedValue(executor(declared as string[] | null) as any);
    const res = await accept();
    expect(res.status).toBe(200);
    expect(settleAssignment).toHaveBeenCalledWith(TASK, AGENT);
  });

  it('still lets an executor already assigned re-confirm, even on a chain it no longer declares', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, requiredCapabilities: [], chain: 'base' } as any);
    vi.mocked(agentStore.getAgent).mockResolvedValue(executor(['arc']) as any);
    vi.mocked(a2aStore.getState).mockResolvedValue({ status: 'accepted', executorAddress: AGENT } as any);
    const res = await accept();
    expect(res.status).toBe(200);
    expect(a2aStore.tryAccept).not.toHaveBeenCalled();
    expect(settleAssignment).toHaveBeenCalledWith(TASK, AGENT);
  });
});

describe('POST /bid', () => {
  const bid = () => request(app()).post(`/api/v1/a2a/tasks/${TASK}/bid`).set('x-test-address', AGENT);

  it('refuses a bid on a chain the executor did not declare', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, requiredCapabilities: [], chain: 'base' } as any);
    vi.mocked(agentStore.getAgent).mockResolvedValue(executor(['arc']) as any);
    const res = await bid();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHAIN_UNSUPPORTED');
    expect(bidsStore.addBid).not.toHaveBeenCalled();
  });

  it('records a bid from a legacy executor on Base', async () => {
    vi.mocked(a2aStore.getMeta).mockResolvedValue({ taskId: TASK, requiredCapabilities: [], chain: 'base' } as any);
    vi.mocked(agentStore.getAgent).mockResolvedValue(executor(null) as any);
    expect((await bid()).status).toBe(200);
    expect(bidsStore.addBid).toHaveBeenCalled();
  });
});

describe('POST /register', () => {
  const register = (body: Record<string, unknown>) =>
    request(app()).post('/api/v1/a2a/register').set('x-test-address', AGENT)
      .send({ displayName: 'a', capabilities: [], publicKey: PUBKEY, ...body });

  it('stores declared chains lowercased and deduplicated, including keys this backend does not know', async () => {
    const res = await register({ supportedChains: ['Base', 'base', 'arc', 'Arc'] });
    expect(res.status).toBe(201);
    expect(agentStore.registerAgent).toHaveBeenCalledWith(expect.objectContaining({ supportedChains: ['base', 'arc'] }));
  });

  it('stores null when the field is omitted (older code)', async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(executor(['arc', 'base', 'arc']) as any);
    const res = await register({});
    expect(res.status).toBe(200);
    expect(agentStore.registerAgent).toHaveBeenCalledWith(expect.objectContaining({ supportedChains: null }));
  });

  it.each([
    ['a malformed chain key', ['base; drop']],
    ['an empty list', []],
  ])('rejects %s', async (_label, supportedChains) => {
    const res = await register({ supportedChains });
    expect(res.status).toBe(400);
    expect(agentStore.registerAgent).not.toHaveBeenCalled();
  });
});

describe('GET /verifications and GET /executors', () => {
  it('lists a task the verifier cannot settle, flagged, instead of hiding it', async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(executor(['arc'], VERIFIER) as any);
    vi.mocked(a2aStore.getVerifierTasks).mockResolvedValue([
      { meta: { taskId: '0xa' }, state: { status: 'awaiting_verification' } },
      { meta: { taskId: '0xb' }, state: { status: 'awaiting_verification' } },
    ] as any);
    vi.mocked(taskChain.resolveTaskByHash).mockImplementation(async (hash: string) =>
      (hash === '0xa' ? { taskId: '1', chain: 'base' } : { taskId: '2', chain: 'arc' }) as any);

    const res = await request(app()).get('/api/v1/a2a/verifications').set('x-test-address', VERIFIER);
    expect(res.status).toBe(200);
    expect(res.body.data.verifications.map((v: any) => [v.meta.taskId, v.chain, v.chainSupported])).toEqual([
      ['0xa', 'base', false],
      ['0xb', 'arc', true],
    ]);
  });

  it('shows each executor\'s declared chains and can filter by chain', async () => {
    vi.mocked(agentStore.listAgents).mockResolvedValue([
      executor(null, '0x1111111111111111111111111111111111111111'),
      executor(['arc'], '0x2222222222222222222222222222222222222222'),
      executor(['arc', 'base', 'arc'], '0x3333333333333333333333333333333333333333'),
    ] as any);

    const all = await request(app()).get('/api/v1/a2a/executors');
    expect(all.body.data.executors.map((e: any) => e.supportedChains)).toEqual([null, ['arc'], ['arc', 'base', 'arc']]);

    const onBase = await request(app()).get('/api/v1/a2a/executors?chain=base');
    expect(onBase.body.data.executors.map((e: any) => e.address)).toEqual([
      '0x1111111111111111111111111111111111111111',
      '0x3333333333333333333333333333333333333333',
    ]);
  });
});
