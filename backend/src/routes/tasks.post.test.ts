import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

/**
 * POST /api/v1/tasks builds the createTask tx on the posting chain: Base when
 * it has an escrow and 0G otherwise, or the chain POSTING_CHAIN names. The
 * token must be that chain's settlement token; anything else would revert
 * on-chain or be refused by /a2a/tasks/index after the poster paid gas.
 */

const { POSTER, USDC, BASE_ESCROW, OG_ESCROW, cfg, chain } = vi.hoisted(() => ({
  POSTER: '0x1111111111111111111111111111111111111111',
  USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  BASE_ESCROW: '0xbbbb000000000000000000000000000000000001',
  OG_ESCROW: '0x0a0a000000000000000000000000000000000002',
  cfg: {} as Record<string, unknown>,
  chain: {} as Record<string, unknown>,
}));
const NATIVE = ethers.ZeroAddress;
const VERIFIER = '0x4444444444444444444444444444444444444444';
const TASK = '0x' + 'cd'.repeat(32);

const abi = JSON.parse(readFileSync(new URL('../abi/BlindEscrow.json', import.meta.url), 'utf-8'));
const iface = new ethers.Interface(Array.isArray(abi) ? abi : abi.abi);

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

const hashClaim = vi.hoisted(() => ({ claimTaskHash: vi.fn(async (_hash: string, poster: string) => ({ poster: poster.toLowerCase(), mine: true })) }));
vi.mock('../services/a2aStore.js', () => hashClaim);

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
    postingChain: '',
    ogChainId: 16602,
    blindEscrowAddress: OG_ESCROW,
    baseChainId: 84532,
    baseEscrowAddress: BASE_ESCROW,
    baseUsdcAddress: USDC,
  });
  Object.assign(chain, {
    provider: {},
    escrow: new ethers.Contract(OG_ESCROW, iface),
    baseProvider: {},
    baseEscrow: new ethers.Contract(BASE_ESCROW, iface),
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
      expect.objectContaining({ type: 'escrow_lock', amount: 5, status: 'pending' }),
    );
  });

  it('accepts the USDC address in any case, and builds with the configured spelling', async () => {
    expect((await post({ token: USDC.toLowerCase() })).status).toBe(200);
    // Mixed case with a bad checksum: ethers would refuse to encode it.
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

  it('refuses native 0G with 400, before building or booking anything', async () => {
    const res = await post({ token: NATIVE });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOKEN_NOT_SETTLEMENT');
    expect(res.body.error.message).toContain('USDC on Base');
    expect(chain.buildUnsignedTx).not.toHaveBeenCalled();
    expect(accountingService.recordTransaction).not.toHaveBeenCalled();
  });

  it('posts on 0G when POSTING_CHAIN says so', async () => {
    cfg.postingChain = '0g';
    const res = await post({ token: NATIVE });
    expect(res.status).toBe(200);
    expect(res.body.data.unsignedTx.to).toBe(OG_ESCROW);
    expect(res.body.data).toMatchObject({ chain: '0g', chainId: 16602 });
    expect((await post({ token: USDC })).body.error.code).toBe('TOKEN_NOT_SETTLEMENT');
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
    expect(hashClaim.claimTaskHash.mock.invocationCallOrder[0]).toBeLessThan((chain.buildUnsignedTx as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  });
});

describe('POST /tasks on a deployment without a Base escrow', () => {
  beforeEach(() => {
    cfg.baseEscrowAddress = '';
    chain.baseEscrow = null;
  });

  it('builds createTask against the 0G escrow, sending the amount as value', async () => {
    const res = await post({ token: NATIVE });
    expect(res.status).toBe(200);
    const { unsignedTx } = res.body.data;
    expect(unsignedTx.to).toBe(OG_ESCROW);
    expect(unsignedTx.value).toBe('5000000');
    expect(methodOf(unsignedTx)).toBe('createTask');
    expect(res.body.data).toMatchObject({ chain: '0g', chainId: 16602 });
    expect(chain.getTokenDecimals).toHaveBeenCalledWith(NATIVE, '0g');
  });

  it('refuses USDC with 400', async () => {
    const res = await post({ token: USDC });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOKEN_NOT_SETTLEMENT');
    expect(res.body.error.message).toContain('0G on 0G');
  });

  it('refuses with 503 when POSTING_CHAIN names Base, which has no escrow here', async () => {
    cfg.postingChain = 'base';
    const res = await post({ token: USDC });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CHAIN_NOT_CONFIGURED');
    expect(chain.buildUnsignedTx).not.toHaveBeenCalled();
  });

  it('refuses with 503 rather than build a tx to the zero address', async () => {
    cfg.blindEscrowAddress = NATIVE;
    chain.escrow = new ethers.Contract(NATIVE, iface);
    const res = await post({ token: NATIVE });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CHAIN_NOT_CONFIGURED');
    expect(chain.buildUnsignedTx).not.toHaveBeenCalled();
  });
});
