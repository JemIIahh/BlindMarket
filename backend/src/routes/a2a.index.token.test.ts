import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

/**
 * POST /api/v1/a2a/tasks/index only indexes a task escrowed in the token its
 * chain settles in, and a "Use now" task only when that token is the one
 * service prices are written in. Before this, a 0G task escrowing 1,000,000
 * wei passed a 1 USDC service price, and a task in any allowed token was
 * booked as if it were the settlement token.
 */

const { POSTER, AGENT, USDC, BASE_ESCROW, chain, cfg } = vi.hoisted(() => ({
  POSTER: '0x1111111111111111111111111111111111111111',
  AGENT: '0x2222222222222222222222222222222222222222',
  USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  BASE_ESCROW: '0xbbbb000000000000000000000000000000000001',
  // The route reads these bindings per request, so tests can swap them.
  chain: {
    provider: null as any,
    escrow: null as any,
    baseProvider: null as any,
    baseEscrow: null as any,
  },
  cfg: {} as Record<string, unknown>,
}));
const OTHER_TOKEN = '0x3333333333333333333333333333333333333333';
const NATIVE = ethers.ZeroAddress;
const OG_ESCROW = '0x0a0a000000000000000000000000000000000002';
const TASK = '0x' + 'cd'.repeat(32);
const TX = '0x' + 'ef'.repeat(32);

const abi = JSON.parse(readFileSync(new URL('../abi/BlindEscrow.json', import.meta.url), 'utf-8'));
const iface = new ethers.Interface(Array.isArray(abi) ? abi : abi.abi);

vi.mock('../services/chain.js', () => chain);

vi.mock('../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../config.js')>();
  Object.assign(cfg, mod.config);
  return { ...mod, config: cfg };
});

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: POSTER };
    next();
  },
}));

vi.mock('../services/a2aStore.js', () => ({
  getMeta: vi.fn(async () => null),
  setMeta: vi.fn(async () => undefined),
  getState: vi.fn(),
  updateState: vi.fn(),
}));

vi.mock('../services/taskChain.js', () => ({
  seedTaskId: vi.fn(async () => undefined),
  resolveTaskByHash: vi.fn(),
}));

vi.mock('../services/serviceStore.js', () => ({
  getActiveService: vi.fn(async () => ({ id: 9, agent_address: AGENT, price_raw: '1000000' })),
}));

// The pinned-executor chain check reads the executor; keep it off any real
// database (config loads backend/.env).
vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn(async () => undefined) }));
vi.mock('../services/escrow.js', () => ({
  getTaskVerifierBase: vi.fn(async () => '0x4444444444444444444444444444444444444444'),
  getTaskVerifier: vi.fn(async () => '0x4444444444444444444444444444444444444444'),
}));

vi.mock('../services/accountingService.js', () => ({
  confirmPendingTransactions: vi.fn(async () => undefined),
}));

vi.mock('../services/semanticMatch.js', () => ({
  recordMatchShadow: vi.fn(),
  semanticRoutingEligible: vi.fn(() => false),
  buildTaskRoutingText: vi.fn(() => ''),
}));

vi.mock('../services/socket.js', () => ({
  emitTaskOffer: vi.fn(),
  emitTaskAvailable: vi.fn(),
}));

vi.mock('../services/redis.js', () => ({
  redis: { set: vi.fn(), get: vi.fn(), exists: vi.fn(), pipeline: vi.fn() },
}));

vi.mock('../services/a2aSettlement.js', () => ({
  settleAssignment: vi.fn(),
  settleVerification: vi.fn(),
  resolveAssignee: vi.fn(async (addr: string) => addr),
}));

vi.mock('../services/workerPayout.js', () => ({
  recordWorkerPayout: vi.fn(),
  recordWorkerDispute: vi.fn(),
}));

vi.mock('../services/notificationStore.js', () => ({
  notifyLifecycle: vi.fn(async () => undefined),
  notify: vi.fn(async () => null),
}));

const { a2aRouter } = await import('./a2a.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');
const a2aStore = await import('../services/a2aStore.js');
const taskChain = await import('../services/taskChain.js');
const agentStore = await import('../services/agentStore.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/a2a', a2aRouter);
  a.use(globalErrorHandler);
  return a;
}

function escrowAt(address: string) {
  return { getAddress: vi.fn(async () => address), interface: iface };
}

function receiptFor(escrowAddress: string, token: string, amount: bigint) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const log = iface.encodeEventLog('TaskCreated', [7n, POSTER, token, amount, TASK, 'general', '', deadline]);
  return { status: 1, blockNumber: 100, logs: [{ address: escrowAddress, topics: log.topics, data: log.data }] };
}

/** Fund the task on Base: the Base provider returns the receipt. */
function onBase(token: string, amount: bigint) {
  chain.baseProvider = { getTransactionReceipt: vi.fn(async () => receiptFor(BASE_ESCROW, token, amount)) };
  chain.baseEscrow = escrowAt(BASE_ESCROW);
}

/** Fund the task on 0G. Shortcut: the Base provider and escrow are removed
 *  while config still names a Base escrow, a pair real chain.ts never builds.
 *  The route only compares escrow identity and settlementToken() reads config
 *  alone, so the answer is the one a Base deployment gives for a 0G task,
 *  without waiting out the Base receipt retries (3 x 3 s). */
function onZeroG(token: string, amount: bigint) {
  chain.baseProvider = null;
  chain.baseEscrow = null;
  chain.provider = { getTransactionReceipt: vi.fn(async () => receiptFor(OG_ESCROW, token, amount)) };
}

function index(extra: Record<string, unknown> = {}) {
  return request(app()).post('/api/v1/a2a/tasks/index').send({ txHash: TX, taskHash: TASK, ...extra });
}

const useNow = { serviceId: 9, targetExecutor: AGENT };

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(cfg, { baseEscrowAddress: BASE_ESCROW, baseUsdcAddress: USDC, cascadeEnabled: false });
  chain.escrow = escrowAt(OG_ESCROW);
});

describe('POST /tasks/index settlement token', () => {
  it('indexes a Base task escrowed in the configured USDC', async () => {
    onBase(USDC, 5_000_000n);
    const res = await index();
    expect(res.status).toBe(200);
    expect(taskChain.seedTaskId).toHaveBeenCalledWith('base', TASK, '7');
    expect(vi.mocked(a2aStore.setMeta).mock.calls[0][0]).toMatchObject({ chain: 'base' });
  });

  it('indexes a 0G task escrowed in native 0G', async () => {
    onZeroG(NATIVE, 10n ** 18n);
    const res = await index();
    expect(res.status).toBe(200);
    expect(taskChain.seedTaskId).toHaveBeenCalledWith('0g', TASK, '7');
    expect(vi.mocked(a2aStore.setMeta).mock.calls[0][0]).toMatchObject({ chain: '0g' });
  });

  it.each([
    ['a Base task in another token', () => onBase(OTHER_TOKEN, 5_000_000n)],
    ['a 0G task in an ERC-20', () => onZeroG(USDC, 5_000_000n)],
  ])('refuses %s before writing anything', async (_label, fund) => {
    fund();
    const res = await index();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TOKEN_NOT_SETTLEMENT');
    expect(taskChain.seedTaskId).not.toHaveBeenCalled();
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });
});

describe('POST /tasks/index "Use now" price check', () => {
  it('refuses a 0G task for a USDC-priced service, even when the raw amount is larger', async () => {
    onZeroG(NATIVE, 2_000_000n);
    const res = await index(useNow);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SERVICE_TOKEN_MISMATCH');
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });

  it('accepts a Base USDC task paying the price', async () => {
    onBase(USDC, 1_000_000n);
    const res = await index(useNow);
    expect(res.status).toBe(200);
    expect(vi.mocked(a2aStore.setMeta).mock.calls[0][0]).toMatchObject({ serviceId: 9, targetExecutor: AGENT });
  });

  it('accepts a native 0G task on a 0G-only deployment, where prices are in 0G', async () => {
    cfg.baseEscrowAddress = '';
    onZeroG(NATIVE, 1_000_000n);
    const res = await index(useNow);
    expect(res.status).toBe(200);
    expect(vi.mocked(a2aStore.setMeta).mock.calls[0][0]).toMatchObject({ chain: '0g', serviceId: 9 });
  });

  it('still refuses a Base USDC task below the price', async () => {
    onBase(USDC, 999_999n);
    const res = await index(useNow);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNDERPAID');
  });
});

describe('POST /tasks/index settlement chain of the pinned agent and the verifier', () => {
  const VERIFIER = '0x4444444444444444444444444444444444444444';
  const executor = (supportedChains: string[] | null, address: string = AGENT) => ({
    address, displayName: 'a', capabilities: [], publicKey: '04', reputation: 50,
    tasksCompleted: 0, registeredAt: '', supportedChains,
  });

  beforeEach(() => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(undefined);
  });

  it('refuses a task pinned to a registered agent that does not settle on its chain', async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(executor(['0g']) as never);
    onBase(USDC, 1_000_000n);
    const res = await index(useNow);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TARGET_CHAIN_UNSUPPORTED');
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });

  it('indexes a task pinned to a legacy agent on Base', async () => {
    vi.mocked(agentStore.getAgent).mockResolvedValue(executor(null) as never);
    onBase(USDC, 1_000_000n);
    expect((await index(useNow)).status).toBe(200);
  });

  it('refuses a task whose designated verifier does not settle on its chain', async () => {
    vi.mocked(agentStore.getAgent).mockImplementation(async (addr: string) =>
      (addr.toLowerCase() === VERIFIER ? executor(['0g'], VERIFIER) : undefined) as never);
    onBase(USDC, 5_000_000n);
    const res = await index({ verificationMode: 'agent', verifierAddress: VERIFIER, privacy: 'public', publicBrief: 'do it' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VERIFIER_CHAIN_UNSUPPORTED');
    expect(a2aStore.setMeta).not.toHaveBeenCalled();
  });
});
