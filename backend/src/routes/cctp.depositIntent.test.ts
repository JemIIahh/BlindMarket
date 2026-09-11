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

const { OWNER, TOKEN_MESSENGER, SOURCE_USDC, FAKE_SOURCE, FAKE_DEST, createTransfer, existingRef, allowanceRef } = vi.hoisted(() => {
  const OWNER = '0x2222222222222222222222222222222222222222';
  const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
  const SOURCE_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
  const fakeSource = {
    chainKey: 'ethereum-sepolia',
    chainId: 11155111,
    domain: 0,
    rpc: {},
    tokenMessengerAddress: TOKEN_MESSENGER,
    messageTransmitterAddress: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    usdcAddress: SOURCE_USDC,
    isTestnet: true,
    label: 'Ethereum Sepolia',
  };
  const fakeDest = {
    ...fakeSource,
    chainKey: 'base-sepolia',
    domain: 6,
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    label: 'Base Sepolia',
  };
  return {
    OWNER,
    TOKEN_MESSENGER,
    SOURCE_USDC,
    FAKE_SOURCE: fakeSource,
    FAKE_DEST: fakeDest,
    createTransfer: vi.fn(async (opts: any) => ({ id: 1, ...opts })),
    existingRef: { current: null as any },
    allowanceRef: { current: 0n },
  };
});

vi.mock('../services/apiKeyStore.js', () => ({
  lookupApiKey: vi.fn(async (candidate: string) =>
    candidate === 'sk_owner' ? { ownerAddress: OWNER } : null,
  ),
}));

vi.mock('../services/cctpChains.js', () => ({
  isCctpConfigured: vi.fn(() => true),
  isSupportedCctpChain: vi.fn((k: string) => k === 'ethereum-sepolia' || k === 'base-sepolia'),
  getCctpChain: vi.fn((k: string) => (k === 'ethereum-sepolia' ? FAKE_SOURCE : k === 'base-sepolia' ? FAKE_DEST : null)),
  getBaseCctpChain: vi.fn(() => FAKE_DEST),
  supportedCctpChains: vi.fn(() => [FAKE_SOURCE, FAKE_DEST]),
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
    allowance = vi.fn(async () => allowanceRef.current);
  }
  return { ...actual, Contract: FakeContract, ethers: { ...actual.ethers, Contract: FakeContract } };
});

import { cctpRouter } from './cctp.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import { estimateMaxFeeRaw } from '../services/cctp.js';
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
  createTransfer.mockClear();
  vi.mocked(estimateMaxFeeRaw).mockClear();
});

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
});
