import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

/**
 * POST /api/v1/tasks builds the createTask tx on the posting chain: Base when
 * it has an escrow, Arc otherwise. The token must be that chain's settlement
 * token; anything else would revert on-chain or be refused by
 * /a2a/tasks/index after the poster paid gas.
 */

const { POSTER, USDC, BASE_ESCROW, cfg, chain } = vi.hoisted(() => ({
  POSTER: '0x1111111111111111111111111111111111111111',
  USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  BASE_ESCROW: '0xbbbb000000000000000000000000000000000001',
  cfg: {} as Record<string, unknown>,
  chain: {} as Record<string, unknown>,
}));
const NATIVE = ethers.ZeroAddress;
const VERIFIER = '0x4444444444444444444444444444444444444444';
const TASK = '0x' + 'cd'.repeat(32);

const abi = JSON.parse(readFileSync(new URL('../abi/BlindEscrow.json', import.meta.url), 'utf-8'));
const iface = new ethers.Interface(Array.isArray(abi) ? abi : abi.abi);

const { verifierOptedOut, verifierOffChain } = vi.hoisted(() => ({ verifierOptedOut: { value: false }, verifierOffChain: { value: false } }));
vi.mock('../services/verifierDuty.js', () => ({
  hostedVerifierNotOptedIn: vi.fn(async () => verifierOptedOut.value),
  verifierChainUnsupported: vi.fn(async () => verifierOffChain.value),
  VERIFIER_NOT_OPTED_IN_MESSAGE: 'not opted in',
}));
// Whether a hosted agent may post is services/delegationGuard.ts's own test;
// here every caller may, unless a test says otherwise.
const { refuseUnapprovedDelegation } = vi.hoisted(() => ({ refuseUnapprovedDelegation: vi.fn(async (_poster: string) => {}) }));
vi.mock('../services/delegationGuard.js', () => ({ refuseUnapprovedDelegation }));
vi.mock('../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../config.js')>();
  Object.assign(cfg, mod.config);
  return { ...mod, config: cfg };
});

// escrow.ts is real: it picks the contract through chainRuntime, which reads
// these bindings.
vi.mock('../services/chain.js', () => chain);

vi.mock('../middleware/auth.js', () => {
  const gate = (req: any, _res: any, next: any) => {
    req.user = { address: POSTER };
    next();
  };
  return { requireAuth: gate, optionalAuth: gate };
});

vi.mock('../services/accountingService.js', () => ({
  recordTransaction: vi.fn(async () => ({})),
  confirmPendingTransactions: vi.fn(async () => ({ confirmed: 0 })),
}));

vi.mock('../services/socket.js', () => ({
  rooms: { tasks: vi.fn(), platform: vi.fn() },
}));

const hashClaim = vi.hoisted(() => ({
  claimTaskHash: vi.fn(async (_hash: string, poster: string) => ({ poster: poster.toLowerCase(), mine: true })),
  getMeta: vi.fn(async (_hash: string): Promise<unknown> => undefined),
}));
vi.mock('../services/a2aStore.js', () => hashClaim);
const openSupport = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../services/batchSupport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/batchSupport.js')>()),
  openCreateSupport: openSupport,
}));
// The escrow hash index: which escrow task, if any, a hash already names.
const hashIndex = vi.hoisted(() => ({ resolveCachedTaskByHash: vi.fn(async (_hash: string): Promise<unknown> => null) }));
vi.mock('../services/taskChain.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/taskChain.js')>()),
  resolveCachedTaskByHash: hashIndex.resolveCachedTaskByHash,
}));

const { tasksRouter } = await import('./tasks.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');
const accountingService = await import('../services/accountingService.js');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/tasks', tasksRouter);
  a.use(globalErrorHandler);
  return a;
}

function post(extra: Record<string, unknown>) {
  return request(app())
    .post('/api/v1/tasks')
    .send({ taskHash: TASK, amount: '5000000', locationZone: 'global', duration: '3600', ...extra });
}

/** The escrow method a built tx calls. */
function methodOf(tx: { data: string; value?: string }) {
  return iface.parseTransaction({ data: tx.data, value: tx.value ?? 0 })!.name;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(cfg, {
    baseChainId: 84532,
    baseEscrowAddress: BASE_ESCROW,
    baseUsdcAddress: USDC,
    arcEscrowAddress: '',
  });
  Object.assign(chain, {
    provider: {},
    escrow: null,
    baseProvider: {},
    baseEscrow: new ethers.Contract(BASE_ESCROW, iface),
    arcProvider: {},
    arcEscrow: null,
    getTokenDecimals: vi.fn(async (token: string) => (token === NATIVE ? 18 : 6)),
    buildUnsignedTx: vi.fn(async (contract: ethers.Contract, method: string, args: unknown[], from: string, value?: bigint) => ({
      to: await contract.getAddress(),
      data: contract.interface.encodeFunctionData(method, args),
      from,
      ...(value !== undefined ? { value } : {}),
    })),
  });
});

describe('POST /tasks on a deployment with a Base escrow', () => {
  it('builds createTask against the Base escrow, in USDC, with no value', async () => {
    const res = await post({ token: USDC });
    expect(res.status).toBe(200);
    const { unsignedTx, chain: posted, chainId } = res.body.data;
    expect(unsignedTx.to).toBe(BASE_ESCROW);
    expect(unsignedTx.value).toBeUndefined();
    expect(methodOf(unsignedTx)).toBe('createTask');
    expect(posted).toBe('base');
    expect(chainId).toBe(84532);
    expect(chain.getTokenDecimals).toHaveBeenCalledWith(USDC, 'base');
    expect(accountingService.recordTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ unit: 'USDC', type: 'escrow_lock', amount: 5, status: 'pending' }),
    );
  });

  it('accepts the USDC address in any case, and builds with the configured spelling', async () => {
    expect((await post({ token: USDC.toLowerCase() })).status).toBe(200);
    const badChecksum = USDC.replace('036Cb', '036cb');
    expect(badChecksum).not.toBe(USDC);
    const res = await post({ token: badChecksum });
    expect(res.status).toBe(200);
    expect(iface.parseTransaction({ data: res.body.data.unsignedTx.data })!.args.token).toBe(USDC);
    expect(chain.getTokenDecimals).toHaveBeenLastCalledWith(USDC, 'base');
  });

  it('still builds when BASE_USDC_ADDRESS is spelled with a bad checksum', async () => {
    cfg.baseUsdcAddress = USDC.replace('036Cb', '036cb');
    for (const token of [USDC, USDC.toLowerCase()]) {
      const res = await post({ token });
      expect(res.status).toBe(200);
      expect(iface.parseTransaction({ data: res.body.data.unsignedTx.data })!.args.token).toBe(USDC);
    }
  });

  it('commits a designated verifier on the Base escrow', async () => {
    const res = await post({ token: USDC, verificationMode: 'agent', verifierAddress: VERIFIER });
    expect(res.status).toBe(200);
    expect(res.body.data.unsignedTx.to).toBe(BASE_ESCROW);
    expect(methodOf(res.body.data.unsignedTx)).toBe('createTaskWithVerifier');
  });

  it('refuses a hosted verifier whose owner has not opted in, before building (audit run 1, C04)', async () => {
    verifierOptedOut.value = true;
    try {
      const res = await post({ token: USDC, verificationMode: 'agent', verifierAddress: VERIFIER });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('VERIFIER_NOT_OPTED_IN');
    } finally {
      verifierOptedOut.value = false;
    }
  });

  it("refuses a verifier agent that doesn't settle on the posting chain, before building: the index would refuse it after funding", async () => {
    verifierOffChain.value = true;
    try {
      const res = await post({ token: USDC, verificationMode: 'agent', verifierAddress: VERIFIER });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('VERIFIER_CHAIN_UNSUPPORTED');
      expect(chain.buildUnsignedTx).not.toHaveBeenCalled();
    } finally {
      verifierOffChain.value = false;
    }
  });

  it("refuses a hosted agent whose owner hasn't allowed delegation, before claiming the hash or building", async () => {
    const { AppError } = await import('../middleware/errorHandler.js');
    refuseUnapprovedDelegation.mockRejectedValueOnce(new AppError(403, 'DELEGATION_DISABLED', 'not allowed'));
    const res = await post({ token: USDC });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DELEGATION_DISABLED');
    expect(refuseUnapprovedDelegation).toHaveBeenCalledWith(POSTER);
    expect(hashClaim.claimTaskHash).not.toHaveBeenCalled();
    expect(chain.buildUnsignedTx).not.toHaveBeenCalled();
  });

  it('refuses native value with 400, before building or booking anything', async () => {
    const res = await post({ token: NATIVE });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOKEN_NOT_SETTLEMENT');
    expect(res.body.error.message).toContain('USDC on Base');
    expect(chain.buildUnsignedTx).not.toHaveBeenCalled();
    expect(accountingService.recordTransaction).not.toHaveBeenCalled();
  });
});

describe('POST /tasks claims the task hash for its poster', () => {
  it('refuses with 409 before building when another poster holds the hash', async () => {
    hashClaim.claimTaskHash.mockResolvedValueOnce({ poster: '0x000000000000000000000000000000000000dead', mine: false });
    const res = await post({ token: USDC });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_HASH_TAKEN');
    expect(chain.buildUnsignedTx).not.toHaveBeenCalled();
    expect(accountingService.recordTransaction).not.toHaveBeenCalled();
  });

  it('claims the hash for the caller, once, before building', async () => {
    const res = await post({ token: USDC });
    expect(res.status).toBe(200);
    expect(hashClaim.claimTaskHash).toHaveBeenCalledTimes(1);
    expect(hashClaim.claimTaskHash.mock.calls[0][0]).toBe(TASK);
    // Under a token of this request's own (a2aStore.claimTaskHash).
    expect((hashClaim.claimTaskHash.mock.calls[0] as unknown[])[2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(hashClaim.claimTaskHash.mock.invocationCallOrder[0]).toBeLessThan((chain.buildUnsignedTx as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });
});

// A public task's hash is the hash of its brief's text, so posting the same
// public brief again reused a hash that already names a task. The listing
// was refused after the poster had paid for the second escrow.
describe('POST /tasks refuses a hash already in use, before anything is funded', () => {
  it('when a task is already listed under it', async () => {
    hashClaim.getMeta.mockResolvedValueOnce({ taskId: TASK, posterAddress: '0x1111111111111111111111111111111111111111' });
    const res = await post({ token: USDC });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_HASH_IN_USE');
    expect(res.body.error.message).toMatch(/change the brief.*Nothing was charged/);
    expect(hashClaim.claimTaskHash).not.toHaveBeenCalled();
    expect(chain.buildUnsignedTx).not.toHaveBeenCalled();
    expect(accountingService.recordTransaction).not.toHaveBeenCalled();
  });

  it('when an escrow task already carries it, and names that task', async () => {
    hashIndex.resolveCachedTaskByHash.mockResolvedValueOnce({ chain: 'arc', taskId: '1' });
    const res = await post({ token: USDC });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('TASK_HASH_IN_USE');
    expect(res.body.error.message).toContain('(arc task 1)');
    expect(chain.buildUnsignedTx).not.toHaveBeenCalled();
  });

  it('builds a new hash as before', async () => {
    const res = await post({ token: USDC });
    expect(res.status).toBe(200);
    expect(hashClaim.getMeta).toHaveBeenCalledWith(TASK);
    expect(hashIndex.resolveCachedTaskByHash).toHaveBeenCalledWith(TASK);
  });
});

describe('POST /tasks with no settlement chain configured', () => {
  beforeEach(() => {
    cfg.baseEscrowAddress = '';
    chain.baseEscrow = null;
  });

  it('refuses with 503 rather than build a tx to the zero address', async () => {
    const res = await post({ token: NATIVE });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CHAIN_NOT_CONFIGURED');
    expect(chain.buildUnsignedTx).not.toHaveBeenCalled();
  });
});
describe('POST /tasks refuses an amount or duration that is not a whole number', () => {
  it.each([['1.5'], ['1e6'], ['-5'], ['0'], ['abc'], [' 5']])('amount %j → 400 INVALID_AMOUNT, and the hash is not claimed', async (amount) => {
    const res = await post({ token: USDC, amount });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_AMOUNT');
    expect(hashClaim.claimTaskHash).not.toHaveBeenCalled();
  });

  it.each([['1.5'], ['0'], ['one hour']])('duration %j → 400 INVALID_DURATION, and the hash is not claimed', async (duration) => {
    const res = await post({ token: USDC, duration });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_DURATION');
    expect(hashClaim.claimTaskHash).not.toHaveBeenCalled();
  });

  it('still takes 0x hex, which BigInt() always read', async () => {
    const res = await post({ token: USDC, amount: '0x4c4b40', duration: '0xe10' });
    expect(res.status).toBe(200);
    const args = iface.parseTransaction({ data: res.body.data.unsignedTx.data })!.args;
    expect(args.amount).toBe(5_000_000n);
  });
});

describe('POST /tasks for a task many agents submit to', () => {
  const open = (o: Record<string, unknown>) => post({ token: USDC, verificationMode: 'agent', verifierAddress: VERIFIER, privacy: 'public', ...o });
  const args = (res: request.Response) => iface.parseTransaction({ data: res.body.data.unsignedTx.data })!.args;
  beforeEach(() => {
    cfg.openSubmissionEnabled = true;
    openSupport.mockResolvedValue(true);
  });

  it('builds createTaskOpen with the verifier picking, from the deadline', async () => {
    const res = await open({ open: { mode: 'agent', creatorWindow: 0 } });
    expect(res.status).toBe(200);
    expect(methodOf(res.body.data.unsignedTx)).toBe('createTaskOpen');
    const a = args(res);
    expect([a.verifierAgent, Number(a.mode), Number(a.creatorWindow)]).toEqual([VERIFIER, 0, 0]);
  });

  it('builds the poster picking first, for their window', async () => {
    const res = await open({ open: { mode: 'creator', creatorWindow: 86_400 } });
    expect(res.status).toBe(200);
    const a = args(res);
    expect([Number(a.mode), Number(a.creatorWindow)]).toEqual([1, 86_400]);
  });

  it('refuses while open submission is off, so nothing is funded that cannot be listed', async () => {
    cfg.openSubmissionEnabled = false;
    const res = await open({ open: { mode: 'agent', creatorWindow: 0 } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OPEN_SUBMISSION_DISABLED');
  });

  it('needs a verifier that is not the poster', async () => {
    const none = await post({ token: USDC, privacy: 'public', open: { mode: 'agent', creatorWindow: 0 } });
    expect(none.body.error.code).toBe('OPEN_TASK_NEEDS_VERIFIER');
    const self = await open({ verifierAddress: POSTER, open: { mode: 'agent', creatorWindow: 0 } });
    expect(self.body.error.code).toBe('INVALID_VERIFIER');
  });

  it("holds the poster's window to the escrow's limits, and none when the verifier picks", async () => {
    for (const o of [{ mode: 'creator', creatorWindow: 600 }, { mode: 'creator', creatorWindow: 8 * 86_400 }, { mode: 'agent', creatorWindow: 3600 }]) {
      const res = await open({ open: o });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_PICK_WINDOW');
    }
  });

  it('is public: refuses a private brief, or one with wrapped keys, which the index would refuse after funding', async () => {
    for (const o of [{ privacy: undefined }, { privacy: 'private' }, { wrappedKeys: { [VERIFIER.toLowerCase()]: 'ab'.repeat(97) } }]) {
      const res = await open({ ...o, open: { mode: 'agent', creatorWindow: 0 } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('OPEN_TASK_MUST_BE_PUBLIC');
    }
  });

  it("refuses when the posting chain's escrow has no createTaskOpen yet", async () => {
    openSupport.mockResolvedValue(false);
    const res = await open({ open: { mode: 'agent', creatorWindow: 0 } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OPEN_SUBMISSION_UNSUPPORTED');
  });

  it('refuses before claiming the task hash', async () => {
    cfg.openSubmissionEnabled = false;
    await open({ open: { mode: 'agent', creatorWindow: 0 } });
    cfg.openSubmissionEnabled = true;
    await open({ open: { mode: 'creator', creatorWindow: 60 } });
    await open({ privacy: 'private', open: { mode: 'agent', creatorWindow: 0 } });
    openSupport.mockResolvedValue(false);
    await open({ open: { mode: 'agent', creatorWindow: 0 } });
    expect(hashClaim.claimTaskHash).not.toHaveBeenCalled();
  });
});
