import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

/**
 * POST /api/v1/tasks/batch builds one createTasks for several tasks
 * (docs/BULK-POSTING.md). Every task gets POST /tasks' checks; the batch is
 * all or nothing, naming each refused task by index and releasing the hash
 * claims it took; an escrow without createTasks is 409 BATCH_UNSUPPORTED.
 *
 * Run: npx vitest run src/routes/tasks.batch.test.ts
 */

const { POSTER, USDC, BASE_ESCROW, cfg, chain } = vi.hoisted(() => ({
  POSTER: '0x1111111111111111111111111111111111111111',
  USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  BASE_ESCROW: '0xbbbb000000000000000000000000000000000001',
  cfg: {} as Record<string, unknown>,
  chain: {} as Record<string, unknown>,
}));
const VERIFIER = '0x4444444444444444444444444444444444444444';
const OTHER = '0x000000000000000000000000000000000000dead';

const abi = JSON.parse(readFileSync(new URL('../abi/BlindEscrow.json', import.meta.url), 'utf-8'));
const iface = new ethers.Interface(Array.isArray(abi) ? abi : abi.abi);

const { verifierOptedOut } = vi.hoisted(() => ({ verifierOptedOut: { value: false } }));
vi.mock('../services/verifierDuty.js', () => ({
  hostedVerifierNotOptedIn: vi.fn(async () => verifierOptedOut.value),
  VERIFIER_NOT_OPTED_IN_MESSAGE: 'not opted in',
}));
vi.mock('../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../config.js')>();
  Object.assign(cfg, mod.config);
  return { ...mod, config: cfg };
});
// escrow.ts is real: it picks the contract through chainRuntime, which reads these.
vi.mock('../services/chain.js', () => chain);
vi.mock('../middleware/auth.js', () => {
  const gate = (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || POSTER };
    next();
  };
  return { requireAuth: gate, optionalAuth: gate };
});
vi.mock('../services/accountingService.js', () => ({
  recordTransaction: vi.fn(async () => ({})),
  confirmPendingTransactions: vi.fn(async () => ({ confirmed: 0 })),
}));
vi.mock('../services/socket.js', () => ({ rooms: { tasks: vi.fn(), platform: vi.fn() } }));
// The per-wallet and per-IP budgets have their own test (middleware/rateLimit.walletBudget.test.ts).
vi.mock('../middleware/rateLimit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/rateLimit.js')>()),
  createWalletBudget: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  postingIpBudget: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const store = vi.hoisted(() => ({
  claimTaskHash: vi.fn(async (_hash: string, poster: string) => ({ poster: poster.toLowerCase(), mine: true, fresh: true })),
  getTaskHashClaim: vi.fn(async (_hash: string): Promise<string | null> => null),
  releaseTaskHashClaim: vi.fn(async () => true),
  getMeta: vi.fn(async (_hash: string): Promise<unknown> => undefined),
}));
vi.mock('../services/a2aStore.js', () => store);
const hashIndex = vi.hoisted(() => ({ resolveCachedTaskByHash: vi.fn(async (_hash: string): Promise<unknown> => null) }));
vi.mock('../services/taskChain.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/taskChain.js')>()),
  resolveCachedTaskByHash: hashIndex.resolveCachedTaskByHash,
}));
const support = vi.hoisted(() => ({ batchCreateSupport: vi.fn(async () => ({ supported: true, maxBatch: 50 })) }));
vi.mock('../services/batchSupport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/batchSupport.js')>()),
  batchCreateSupport: support.batchCreateSupport,
}));

const { tasksRouter } = await import('./tasks.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');
const accountingService = await import('../services/accountingService.js');

function app() {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use('/api/v1/tasks', tasksRouter);
  a.use(globalErrorHandler);
  return a;
}

const hash = (i: number) => '0x' + (i + 1).toString(16).padStart(64, '0');
const task = (i: number, extra: Record<string, unknown> = {}) => ({
  taskHash: hash(i),
  amount: String(1_000_000 * (i + 1)),
  locationZone: 'global',
  duration: '86400',
  verificationMode: 'manual',
  ...extra,
});
const batch = (tasks: unknown[], token = USDC, caller = POSTER) =>
  request(app()).post('/api/v1/tasks/batch').set('x-test-address', caller).send({ token, tasks });

const estimateGas = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations: put back the ones tests override.
  store.claimTaskHash.mockImplementation(async (_hash: string, poster: string) => ({ poster: poster.toLowerCase(), mine: true, fresh: true }));
  store.getTaskHashClaim.mockImplementation(async () => null);
  hashIndex.resolveCachedTaskByHash.mockImplementation(async () => null);
  verifierOptedOut.value = false;
  estimateGas.mockResolvedValue(3_000_000n);
  Object.assign(cfg, { baseChainId: 84532, baseEscrowAddress: BASE_ESCROW, baseUsdcAddress: USDC, arcEscrowAddress: '' });
  Object.assign(chain, {
    provider: {},
    escrow: null,
    baseProvider: { estimateGas },
    baseEscrow: new ethers.Contract(BASE_ESCROW, iface),
    arcProvider: {},
    arcEscrow: null,
    getTokenDecimals: vi.fn(async () => 6),
    buildUnsignedTx: vi.fn(async (contract: ethers.Contract, method: string, args: unknown[], from: string, value?: bigint) => ({
      to: await contract.getAddress(),
      data: contract.interface.encodeFunctionData(method, args),
      from,
      ...(value !== undefined ? { value } : {}),
    })),
  });
});

describe('POST /tasks/batch — a valid batch', () => {
  it('builds one createTasks with every task in order, and names the hashes and the chain', async () => {
    const tasks = [task(0), task(1, { verificationMode: 'agent', verifierAddress: VERIFIER }), task(2)];
    const res = await batch(tasks);
    expect(res.status).toBe(200);
    const { unsignedTx, chain: posted, chainId, taskHashes } = res.body.data;
    expect(posted).toBe('base');
    expect(chainId).toBe(84532);
    expect(taskHashes).toEqual([hash(0), hash(1), hash(2)]);
    expect(unsignedTx.to).toBe(BASE_ESCROW);
    expect(unsignedTx.value).toBeUndefined();
    const parsed = iface.parseTransaction({ data: unsignedTx.data })!;
    expect(parsed.name).toBe('createTasks');
    expect(parsed.args[0]).toBe(USDC);
    expect((parsed.args[1] as ethers.Result[]).map((t) => [t.taskHash, t.amount, t.category, t.locationZone, t.duration, t.verifierAgent])).toEqual([
      [hash(0), 1_000_000n, 'general', 'global', 86_400n, ethers.ZeroAddress],
      [hash(1), 2_000_000n, 'general', 'global', 86_400n, VERIFIER],
      [hash(2), 3_000_000n, 'general', 'global', 86_400n, ethers.ZeroAddress],
    ]);
    // Its own gas: the estimate plus a fifth, not one task's limit.
    expect(unsignedTx.gasLimit).toBe(3_600_000);
  });

  it('claims every hash for the caller and books each escrow as pending', async () => {
    const res = await batch([task(0), task(1)]);
    expect(res.status).toBe(200);
    expect(store.claimTaskHash.mock.calls.map((c) => c[0])).toEqual([hash(0), hash(1)]);
    expect(accountingService.recordTransaction).toHaveBeenCalledTimes(2);
    expect(accountingService.recordTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: hash(1), type: 'escrow_lock', amount: 2, unit: 'USDC', status: 'pending' }),
    );
    expect(store.releaseTaskHashClaim).not.toHaveBeenCalled();
  });

  it('takes a single task too', async () => {
    const res = await batch([task(0)]);
    expect(res.status).toBe(200);
    expect(res.body.data.taskHashes).toEqual([hash(0)]);
  });
});

describe('POST /tasks/batch — all or nothing', () => {
  it('refuses the batch with 400 naming each invalid task by index, claiming nothing', async () => {
    const res = await batch([
      task(0),
      task(1, { amount: '1.5' }),
      task(2, { verificationMode: 'oracle' }),
      task(3, { verificationMode: 'auto' }),
      task(4, { locationZone: '' }),
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TASKS');
    expect(res.body.error.details.errors).toEqual([
      { index: 1, code: 'INVALID_AMOUNT', message: expect.stringContaining('whole number') },
      { index: 2, code: 'VERIFICATION_MODE_UNSUPPORTED', message: expect.any(String) },
      { index: 3, code: 'AUTO_CRITERIA_REQUIRED', message: expect.any(String) },
      { index: 4, code: 'VALIDATION_ERROR', message: expect.stringContaining('locationZone') },
    ]);
    expect(store.claimTaskHash).not.toHaveBeenCalled();
    expect(chain.buildUnsignedTx).not.toHaveBeenCalled();
    expect(accountingService.recordTransaction).not.toHaveBeenCalled();
  });

  it('sums the refused tasks up in the message, by row, and lists them all in error.details.errors', async () => {
    const res = await batch([task(0), task(1, { amount: '0' }), task(2), task(3, { verificationMode: 'oracle' }), task(4)]);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'INVALID_TASKS',
        // Counted from 1 in the message; 0-based in details.errors[].index.
        message: expect.stringMatching(/^2 of 5 tasks are invalid: task 2: amount must be a whole number above 0.*; task 4: verificationMode='oracle' is not supported/),
        details: { errors: [expect.objectContaining({ index: 1 }), expect.objectContaining({ index: 3 })] },
      },
    });
  });

  it('names at most five rows in the message, and every one in the details', async () => {
    const res = await batch(Array.from({ length: 7 }, (_, i) => task(i, { amount: '0' })));
    expect(res.body.error.message).toMatch(/^7 of 7 tasks are invalid: task 1: .*; task 5: [^;]*; …$/);
    expect(res.body.error.details.errors.map((e: any) => e.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('repeats no raw input: not a rejected value, nor a free-form key', async () => {
    const res = await batch([
      task(0, { verificationMode: 'SECRET-MODE' }),
      task(1, { wrappedKeys: { 'not-an-address-SECRET': 'ab' } }),
      task(2, { wrappedKeys: { '0x1111111111111111111111111111111111111111': 'zz-SECRET-BLOB' } }),
    ]);
    expect(res.status).toBe(400);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('SECRET');
    expect(res.body.error.details.errors[0].message).toContain("verificationMode: must be one of 'manual', 'auto', 'oracle', 'agent'");
    expect(res.body.error.details.errors[1].message).toContain('wrappedKeys.[key]');
  });

  it('answers a malformed batch with readable text, not zod JSON', async () => {
    const res = await request(app()).post('/api/v1/tasks/batch').send({ token: USDC, tasks: 'all of them' });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'VALIDATION_ERROR', message: 'tasks: Expected array, received string' });
  });

  it('names every refused task at once, from its own terms and from shared state', async () => {
    hashIndex.resolveCachedTaskByHash.mockImplementation(async (h: string) => (h === hash(2) ? { chain: 'arc', taskId: '9' } : null));
    verifierOptedOut.value = true;
    const res = await batch([
      task(0, { duration: '0' }),
      task(1),
      task(2),
      task(3, { verificationMode: 'agent', verifierAddress: VERIFIER }),
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error.details.errors.map((e: any) => [e.index, e.code])).toEqual([
      [0, 'INVALID_DURATION'],
      [2, 'TASK_HASH_IN_USE'],
      [3, 'VERIFIER_NOT_OPTED_IN'],
    ]);
    expect(res.body.error.details.errors[1].message).toContain('(arc task 9)');
    expect(store.claimTaskHash).not.toHaveBeenCalled();
  });

  it("refuses a hash another poster claimed, without claiming anything", async () => {
    store.getTaskHashClaim.mockImplementation(async (h: string) => (h === hash(1) ? OTHER : null));
    const res = await batch([task(0), task(1)]);
    expect(res.status).toBe(400);
    expect(res.body.error.details.errors).toEqual([{ index: 1, code: 'TASK_HASH_TAKEN', message: expect.any(String) }]);
    expect(store.claimTaskHash).not.toHaveBeenCalled();
  });

  it('releases the claims it took when a claim is lost to a race, and keeps ones the caller already held', async () => {
    store.claimTaskHash.mockImplementation(async (h: string, poster: string) => {
      if (h === hash(2)) return { poster: OTHER, mine: false, fresh: false };
      if (h === hash(1)) return { poster: poster.toLowerCase(), mine: true, fresh: false };
      return { poster: poster.toLowerCase(), mine: true, fresh: true };
    });
    const res = await batch([task(0), task(1), task(2), task(3)]);
    expect(res.status).toBe(400);
    expect(res.body.error.details.errors).toEqual([{ index: 2, code: 'TASK_HASH_TAKEN', message: expect.any(String) }]);
    // Taken by this request: 0 and 3. Task 1's was already the caller's.
    expect(store.releaseTaskHashClaim.mock.calls.map((c) => c[0]).sort()).toEqual([hash(0), hash(3)]);
    expect(store.releaseTaskHashClaim.mock.calls.every((c) => c[1] === POSTER)).toBe(true);
    // Released only under the token this request claimed with (a2aStore.claimTaskHash).
    const tokens = new Set((store.claimTaskHash.mock.calls as unknown[][]).map((c) => c[2]));
    expect(tokens.size).toBe(1);
    const [token] = [...tokens];
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect((store.releaseTaskHashClaim.mock.calls as unknown[][]).every((c) => c[2] === token)).toBe(true);
    expect(chain.buildUnsignedTx).not.toHaveBeenCalled();
  });

  it('releases every claim it took when the store fails on another, even ones that land after the failure', async () => {
    store.claimTaskHash.mockImplementation(async (h: string, poster: string) => {
      if (h === hash(1)) throw new Error('redis down');
      await new Promise((r) => setTimeout(r, h === hash(0) ? 10 : 30));
      return { poster: poster.toLowerCase(), mine: true, fresh: true };
    });
    const res = await batch([task(0), task(1), task(2)]);
    expect(res.status).toBe(500);
    expect(store.releaseTaskHashClaim.mock.calls.map((c) => c[0]).sort()).toEqual([hash(0), hash(2)]);
    expect(chain.buildUnsignedTx).not.toHaveBeenCalled();
  });

  it('releases its claims when building fails after them', async () => {
    (chain.buildUnsignedTx as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('encode failed'));
    const res = await batch([task(0), task(1)]);
    expect(res.status).toBe(500);
    expect(store.releaseTaskHashClaim.mock.calls.map((c) => c[0]).sort()).toEqual([hash(0), hash(1)]);
  });

  it('refuses a hash twice in one batch, whatever its letter case', async () => {
    const res = await batch([task(0), task(1), task(2, { taskHash: hash(0).toUpperCase().replace('0X', '0x') })]);
    expect(res.status).toBe(400);
    expect(res.body.error.details.errors).toEqual([
      { index: 2, code: 'DUPLICATE_TASK_HASH', message: expect.stringContaining('Same taskHash as task 1') },
    ]);
    expect(store.claimTaskHash).not.toHaveBeenCalled();
  });
});

describe('POST /tasks/batch — what would revert the whole batch on-chain', () => {
  it.each([
    ['a zero hash', { taskHash: '0x' + '0'.repeat(64) }, 'EMPTY_HASH'],
    ['a duration under an hour', { duration: '3599' }, 'INVALID_DURATION'],
    ['a duration over 90 days', { duration: String(90 * 86_400 + 1) }, 'INVALID_DURATION'],
    ['an amount past uint256', { amount: (1n << 256n).toString() }, 'INVALID_AMOUNT'],
    ['the poster as verifier', { verificationMode: 'agent', verifierAddress: POSTER }, 'INVALID_VERIFIER'],
    ['a verifier that is not an EVM address', { verificationMode: 'agent', verifierAddress: '0x' + 'ab'.repeat(32) }, 'INVALID_VERIFIER'],
    ['agent verification with no verifier', { verificationMode: 'agent' }, 'NO_VERIFIER'],
  ])('refuses %s', async (_label, extra, code) => {
    const res = await batch([task(0), task(1, extra)]);
    expect(res.status).toBe(400);
    expect(res.body.error.details.errors).toEqual([{ index: 1, code, message: expect.any(String) }]);
  });

  it('takes the duration bounds themselves', async () => {
    const res = await batch([task(0, { duration: '3600' }), task(1, { duration: String(90 * 86_400) })]);
    expect(res.status).toBe(200);
  });
});

describe('POST /tasks/batch — the batch as a whole', () => {
  it('409 BATCH_UNSUPPORTED when the escrow has no createTasks, before claiming anything', async () => {
    support.batchCreateSupport.mockResolvedValueOnce({ supported: false, maxBatch: 0 });
    const res = await batch([task(0), task(1)]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BATCH_UNSUPPORTED');
    expect(support.batchCreateSupport).toHaveBeenCalledWith('base');
    expect(store.claimTaskHash).not.toHaveBeenCalled();
    expect(chain.buildUnsignedTx).not.toHaveBeenCalled();
  });

  it("refuses more tasks than the escrow's maxBatch", async () => {
    support.batchCreateSupport.mockResolvedValueOnce({ supported: true, maxBatch: 2 });
    const res = await batch([task(0), task(1), task(2)]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BATCH_TOO_LARGE');
    expect(store.claimTaskHash).not.toHaveBeenCalled();
  });

  it('takes 1 to 50 tasks', async () => {
    expect((await batch([])).status).toBe(400);
    expect((await batch(Array.from({ length: 51 }, (_, i) => task(i)))).status).toBe(400);
    const res = await batch(Array.from({ length: 50 }, (_, i) => task(i)));
    expect(res.status).toBe(200);
    expect(res.body.data.taskHashes).toHaveLength(50);
  });

  it("refuses a token that is not the posting chain's, before claiming anything", async () => {
    const res = await batch([task(0)], ethers.ZeroAddress);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOKEN_NOT_SETTLEMENT');
    expect(store.claimTaskHash).not.toHaveBeenCalled();
  });

  it('503 when the posting chain has no escrow', async () => {
    cfg.baseEscrowAddress = '';
    chain.baseEscrow = null;
    const res = await batch([task(0)]);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CHAIN_NOT_CONFIGURED');
  });

  it('refuses the legacy agent key, which has no wallet to fund from', async () => {
    const res = await batch([task(0)], USDC, 'agent');
    expect(res.status).toBe(403);
    expect(store.claimTaskHash).not.toHaveBeenCalled();
  });
});
