import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * routes/cctp.ts POST /deposit-intent — Phase B (inbound) intent building.
 * No test existed for this endpoint before (only /confirm was covered) —
 * this fills that gap: allowance-gated approveTx inclusion, same-chain and
 * unsupported-chain rejection, fee-vs-amount rejection, and idempotent
 * replay (a second call with the same key must not create a second row).
 */

const { OWNER, TOKEN_MESSENGER, SOURCE_USDC, FAKE_SOURCE, FAKE_DEST, FAKE_ARC, createTransfer, existingRef, allowanceRef, allowanceErrorRef, nativeBalanceRef } = vi.hoisted(() => {
  const OWNER = '0x2222222222222222222222222222222222222222';
  const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
  const SOURCE_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
  const nativeBalanceRef = { current: 0n };
  const fakeSource = {
    chainKey: 'ethereum-sepolia',
    chainId: 11155111,
    domain: 0,
    rpc: { getBalance: vi.fn(async () => 0n) },
    tokenMessengerAddress: TOKEN_MESSENGER,
    messageTransmitterAddress: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    usdcAddress: SOURCE_USDC,
    isTestnet: true,
    label: 'Ethereum Sepolia',
    supportsFastTransfer: true,
    usdcGasReserveRaw: 0n,
  };
  const fakeDest = {
    ...fakeSource,
    chainKey: 'base-sepolia',
    domain: 6,
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    label: 'Base Sepolia',
  };
  // Arc: USDC is the gas token (native balance is 18-dec), no Fast Transfer.
  const fakeArc = {
    ...fakeSource,
    chainKey: 'arc-testnet',
    chainId: 5042002,
    domain: 26,
    rpc: { getBalance: vi.fn(async () => nativeBalanceRef.current) },
    usdcAddress: '0x3600000000000000000000000000000000000000',
    label: 'Arc Testnet',
    supportsFastTransfer: false,
    usdcGasReserveRaw: 50_000n, // 0.05 USDC
  };
  return {
    OWNER,
    TOKEN_MESSENGER,
    SOURCE_USDC,
    FAKE_SOURCE: fakeSource,
    FAKE_DEST: fakeDest,
    FAKE_ARC: fakeArc,
    createTransfer: vi.fn(async (opts: any) => ({ id: 1, ...opts })),
    existingRef: { current: null as any },
    allowanceRef: { current: 0n },
    allowanceErrorRef: { current: null as Error | null },
    nativeBalanceRef,
  };
});

vi.mock('../services/apiKeyStore.js', () => ({
  lookupApiKey: vi.fn(async (candidate: string) =>
    candidate === 'sk_owner' ? { ownerAddress: OWNER } : null,
  ),
}));

vi.mock('../services/cctpChains.js', () => ({
  isCctpConfigured: vi.fn(() => true),
  isSupportedCctpChain: vi.fn((k: string) => k === 'ethereum-sepolia' || k === 'base-sepolia' || k === 'arc-testnet'),
  getCctpChain: vi.fn((k: string) => (k === 'ethereum-sepolia' ? FAKE_SOURCE : k === 'base-sepolia' ? FAKE_DEST : k === 'arc-testnet' ? FAKE_ARC : null)),
  getSettlementCctpChain: vi.fn(() => FAKE_DEST),
  supportedCctpChains: vi.fn(() => [FAKE_SOURCE, FAKE_DEST, FAKE_ARC]),
}));

vi.mock('../services/cctp.js', async () => {
  const actual = await vi.importActual<typeof import('../services/cctp.js')>('../services/cctp.js');
  return {
    ...actual,
    estimateMaxFeeRaw: vi.fn(async (_base: string, _src: number, _dst: number, amount: bigint) => amount / 100n), // 1%
  };
});

vi.mock('../services/cctpTransferStore.js', () => ({
  createTransfer,
  getByIdempotencyKey: vi.fn(async () => existingRef.current),
  getById: vi.fn(),
  updateTransfer: vi.fn(),
  listForOwner: vi.fn(async () => []),
  serializeTransfer: vi.fn((t: any) => (t ? { transferId: t.id, stage: t.stage } : null)),
}));

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  class FakeContract {
    interface = new actual.Interface(['function approve(address spender, uint256 amount) returns (bool)']);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_addr: string, _abi: unknown, _runner: unknown) {}
    allowance = vi.fn(async () => {
      if (allowanceErrorRef.current) throw allowanceErrorRef.current;
      return allowanceRef.current;
    });
  }
  return { ...actual, Contract: FakeContract, ethers: { ...actual.ethers, Contract: FakeContract } };
});

import { cctpRouter } from './cctp.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import { estimateMaxFeeRaw, decodeDepositForBurnCalldata } from '../services/cctp.js';
import { config } from '../config.js';

// config.ts's `cctp.enabled` defaults to false; flip it on for this suite
// (same fix as routes/agentsCctp.test.ts — see that file for why mutating
// the real config object beats setting CCTP_ENABLED via process.env).
(config.cctp as { enabled: boolean }).enabled = true;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/cctp', cctpRouter);
  a.use(globalErrorHandler);
  return a;
}

beforeEach(() => {
  existingRef.current = null;
  allowanceRef.current = 0n;
  allowanceErrorRef.current = null;
  nativeBalanceRef.current = 0n;
  createTransfer.mockClear();
  FAKE_SOURCE.rpc.getBalance.mockClear();
  FAKE_ARC.rpc.getBalance.mockClear();
  vi.mocked(estimateMaxFeeRaw).mockClear();
});

// USDC's native (gas) view on Arc is 18-dec; amounts in this API are 6-dec.
const NATIVE_PER_RAW = 10n ** 12n;

describe('POST /api/v1/cctp/deposit-intent', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await request(app()).post('/api/v1/cctp/deposit-intent').send({ sourceChain: 'ethereum-sepolia', amountRaw: '5000000', idempotencyKey: 'k1' });
    expect(res.status).toBe(401);
  });

  it('includes an approveTx when the source-chain allowance is insufficient', async () => {
    allowanceRef.current = 0n;
    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent')
      .set('X-API-Key', 'sk_owner')
      .send({ sourceChain: 'ethereum-sepolia', amountRaw: '5000000', idempotencyKey: 'k-approve' });

    expect(res.status).toBe(200);
    expect(res.body.data.approveTx).toBeTruthy();
    expect(res.body.data.approveTx.to).toBe(SOURCE_USDC);
    expect(res.body.data.burnTx.to).toBe(TOKEN_MESSENGER);
    expect(createTransfer).toHaveBeenCalledTimes(1);
  });

  it('omits approveTx when the allowance already covers the amount', async () => {
    allowanceRef.current = 10_000_000n;
    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent')
      .set('X-API-Key', 'sk_owner')
      .send({ sourceChain: 'ethereum-sepolia', amountRaw: '5000000', idempotencyKey: 'k-noapprove' });

    expect(res.status).toBe(200);
    expect(res.body.data.approveTx).toBeUndefined();
  });

  it('rejects sourceChain === the Base leg', async () => {
    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent')
      .set('X-API-Key', 'sk_owner')
      .send({ sourceChain: 'base-sepolia', amountRaw: '5000000', idempotencyKey: 'k-same' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CCTP_SAME_CHAIN');
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it('rejects an unsupported source chain', async () => {
    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent')
      .set('X-API-Key', 'sk_owner')
      .send({ sourceChain: 'solana', amountRaw: '5000000', idempotencyKey: 'k-unsupported' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CCTP_UNSUPPORTED_CHAIN');
  });

  it('rejects a non-positive amount before ever quoting a fee', async () => {
    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent')
      .set('X-API-Key', 'sk_owner')
      .send({ sourceChain: 'ethereum-sepolia', amountRaw: '0', idempotencyKey: 'k-zero' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(vi.mocked(estimateMaxFeeRaw)).not.toHaveBeenCalled();
  });

  it('rejects an amount too small to cover the quoted fee', async () => {
    vi.mocked(estimateMaxFeeRaw).mockResolvedValueOnce(5_000_000n); // fee >= amount
    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent')
      .set('X-API-Key', 'sk_owner')
      .send({ sourceChain: 'ethereum-sepolia', amountRaw: '5000000', idempotencyKey: 'k-tiny' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CCTP_INSUFFICIENT_USDC');
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it('replays an existing transfer for a reused idempotencyKey without creating a second row', async () => {
    existingRef.current = { id: 7, stage: 'burn_confirmed' };
    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent')
      .set('X-API-Key', 'sk_owner')
      .send({ sourceChain: 'ethereum-sepolia', amountRaw: '5000000', idempotencyKey: 'k-repeat' });

    expect(res.status).toBe(200);
    expect(res.body.data.existing).toBe(true);
    expect(res.body.data.transfer.transferId).toBe(7);
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it('never reads the native balance for an ETH-gas source chain', async () => {
    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent')
      .set('X-API-Key', 'sk_owner')
      .send({ sourceChain: 'ethereum-sepolia', amountRaw: '5000000', idempotencyKey: 'k-eth-nobal' });
    expect(res.status).toBe(200);
    expect(FAKE_SOURCE.rpc.getBalance).not.toHaveBeenCalled();
  });

  it('leaves no transfer row behind when a source-chain read fails', async () => {
    allowanceErrorRef.current = new Error('rpc down');
    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent')
      .set('X-API-Key', 'sk_owner')
      .send({ sourceChain: 'ethereum-sepolia', amountRaw: '5000000', idempotencyKey: 'k-rpc-down' });
    expect(res.status).toBe(500);
    expect(createTransfer).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/cctp/deposit-intent — Arc (USDC is the gas token)', () => {
  const AMOUNT = 5_000_000n; // 5 USDC
  const RESERVE = 50_000n; // 0.05 USDC, FAKE_ARC.usdcGasReserveRaw

  it('refuses a full-balance bridge — nothing left for gas — before creating any row', async () => {
    nativeBalanceRef.current = AMOUNT * NATIVE_PER_RAW; // exactly the amount, zero headroom
    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent')
      .set('X-API-Key', 'sk_owner')
      .send({ sourceChain: 'arc-testnet', amountRaw: AMOUNT.toString(), idempotencyKey: 'k-arc-full' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CCTP_INSUFFICIENT_GAS_HEADROOM');
    expect(res.body.error.details).toEqual({ reserveRaw: '50000', maxAmountRaw: (AMOUNT - RESERVE).toString() });
    expect(res.body.error.message).toContain('0.05 USDC');
    expect(res.body.error.message).toContain('4.95 USDC');
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it('refuses one native wei short of amount + reserve (compared in the 18-dec view, no truncation slack)', async () => {
    nativeBalanceRef.current = (AMOUNT + RESERVE) * NATIVE_PER_RAW - 1n;
    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent')
      .set('X-API-Key', 'sk_owner')
      .send({ sourceChain: 'arc-testnet', amountRaw: AMOUNT.toString(), idempotencyKey: 'k-arc-short' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CCTP_INSUFFICIENT_GAS_HEADROOM');
    expect(createTransfer).not.toHaveBeenCalled();
  });

  it('accepts exactly amount + reserve, and requests Standard Transfer (2000) in the row, the fee quote, and the burn calldata', async () => {
    nativeBalanceRef.current = (AMOUNT + RESERVE) * NATIVE_PER_RAW;
    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent')
      .set('X-API-Key', 'sk_owner')
      .send({ sourceChain: 'arc-testnet', amountRaw: AMOUNT.toString(), idempotencyKey: 'k-arc-ok' });

    expect(res.status).toBe(200);
    expect(FAKE_ARC.rpc.getBalance).toHaveBeenCalledTimes(1);
    expect(vi.mocked(estimateMaxFeeRaw).mock.calls[0][4]).toBe(2000);
    expect(createTransfer).toHaveBeenCalledWith(expect.objectContaining({ sourceDomain: 26, minFinalityThreshold: 2000 }));
    expect(res.body.data.approveTx.to).toBe('0x3600000000000000000000000000000000000000');
    expect(decodeDepositForBurnCalldata(res.body.data.burnTx.data).minFinalityThreshold).toBe(2000);
  });
});
