import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * routes/cctp.ts POST /userop + GET /userop-receipt — the external-wallet
 * USDC-gas path. The endpoint is a guarded bundler proxy, not an open one:
 * the sender must be the caller's deployed BlindAccount, the paymaster this
 * chain's, and the batch exactly the row's approve+burn. Bob's UserOp for
 * Alice's transfer, or for another contract, must fail closed.
 */

const { OWNER, OTHER, SMART, PAYMASTER, FACTORY, ENTRYPOINT, USDC, MESSENGER, AMOUNT, FEE, FAKE_SOURCE, rowRef, aaRef, pimlicoRef, receiptRef } = vi.hoisted(() => {
  const OWNER = '0x2222222222222222222222222222222222222222';
  const OTHER = '0x4444444444444444444444444444444444444444';
  const SMART = '0x3333333333333333333333333333333333333333';
  const PAYMASTER = '0x5555555555555555555555555555555555555555';
  const FACTORY = '0x6666666666666666666666666666666666666666';
  const ENTRYPOINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';
  const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
  const MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
  const AMOUNT = 10_000_000n;
  const FEE = 10_000n;
  return {
    OWNER, OTHER, SMART, PAYMASTER, FACTORY, ENTRYPOINT, USDC, MESSENGER, AMOUNT, FEE,
    FAKE_SOURCE: {
      chainKey: 'ethereum-sepolia',
      chainId: 11155111,
      domain: 0,
      rpc: {},
      tokenMessengerAddress: MESSENGER,
      messageTransmitterAddress: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
      usdcAddress: USDC,
      isTestnet: true,
      label: 'Ethereum Sepolia',
      supportsFastTransfer: true,
      usdcGasReserveRaw: 0n,
    },
    rowRef: { current: null as any },
    aaRef: { current: null as any },
    pimlicoRef: { impl: null as null | ((method: string) => unknown) },
    receiptRef: { current: undefined as unknown },
  };
});

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: OWNER };
    next();
  },
}));

vi.mock('../services/cctpChains.js', () => ({
  isCctpConfigured: vi.fn(() => true),
  isSupportedCctpChain: vi.fn((k: string) => k === 'ethereum-sepolia'),
  getCctpChain: vi.fn((k: string) => (k === 'ethereum-sepolia' ? FAKE_SOURCE : null)),
  getSettlementCctpChain: vi.fn(() => null),
  supportedCctpChains: vi.fn(() => [FAKE_SOURCE]),
}));

vi.mock('../services/cctpTransferStore.js', () => ({
  createTransfer: vi.fn(),
  getByIdempotencyKey: vi.fn(),
  getById: vi.fn(async (id: number) => (rowRef.current?.id === id ? rowRef.current : null)),
  updateTransfer: vi.fn(),
  listForOwner: vi.fn(async () => []),
  serializeTransfer: vi.fn((t: any) => (t ? { transferId: t.id, stage: t.stage } : null)),
}));

vi.mock('../services/aaChains.js', () => ({
  getChainAA: vi.fn(() => aaRef.current),
}));

vi.mock('../services/pimlico.js', () => ({
  isPimlicoConfigured: vi.fn(() => true),
  pimlicoRpc: vi.fn(async (chain: string, method: string, _params: unknown[]) => {
    if (pimlicoRef.impl) return pimlicoRef.impl(method);
    if (method === 'eth_estimateUserOperationGas') return { callGasLimit: '0x30d40' };
    if (method === 'eth_sendUserOperation') return '0xophash';
    if (method === 'eth_getUserOperationReceipt') return receiptRef.current;
    throw new Error(`unexpected ${method}`);
  }),
}));

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  class FakeContract {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_addr: string, _abi: unknown, _runner: unknown) {}
    accounts = vi.fn(async () => SMART);
  }
  return { ...actual, Contract: FakeContract, ethers: { ...actual.ethers, Contract: FakeContract } };
});

import { cctpRouter } from './cctp.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import { buildDepositForBurnCall, addressToBytes32 } from '../services/cctp.js';
import { BlindAccountABI } from '../services/aa.js';
import { Interface } from 'ethers';
import { config } from '../config.js';

// config.ts's `cctp.enabled` defaults to false; flip it on for this suite.
(config.cctp as { enabled: boolean }).enabled = true;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/cctp', cctpRouter);
  a.use(globalErrorHandler);
  return a;
}

function baseRow() {
  return {
    id: 7,
    direction: 'inbound',
    owner_address: OWNER.toLowerCase(),
    stage: 'created',
    source_chain: 'ethereum-sepolia',
    source_domain: 0,
    dest_chain: 'arc-testnet',
    dest_domain: 26,
    usdc_amount_raw: AMOUNT.toString(),
    mint_recipient: OWNER,
    max_fee_raw: FEE.toString(),
    min_finality_threshold: 1000,
  };
}

function batchCalldata(burnAmount: bigint = AMOUNT) {
  const approve = new Interface(['function approve(address spender, uint256 amount)'])
    .encodeFunctionData('approve', [MESSENGER, AMOUNT]);
  const burn = buildDepositForBurnCall(FAKE_SOURCE as any, {
    amountRaw: burnAmount,
    destinationDomain: 26,
    mintRecipient: OWNER,
    maxFeeRaw: FEE,
    minFinalityThreshold: 1000,
  });
  return new Interface(BlindAccountABI)
    .encodeFunctionData('executeBatch', [[USDC, burn.to], [0, 0], [approve, burn.data]]);
}

function userOp(callData: string, overrides: Record<string, unknown> = {}) {
  return {
    sender: SMART,
    nonce: '0x0',
    callData,
    callGasLimit: '0x30d40',
    verificationGasLimit: '0x30d40',
    preVerificationGas: '0xc350',
    maxFeePerGas: '0x3b9aca00',
    maxPriorityFeePerGas: '0x3b9aca00',
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: '0x186a0',
    paymasterPostOpGasLimit: '0xc350',
    paymasterData: '0x',
    signature: '0x' + 'ab'.repeat(65),
    ...overrides,
  };
}

beforeEach(() => {
  rowRef.current = baseRow();
  aaRef.current = { paymaster: PAYMASTER, factory: FACTORY, entrypoint: ENTRYPOINT, usdc: USDC };
  pimlicoRef.impl = null;
  receiptRef.current = undefined;
});

describe('POST /api/v1/cctp/userop', () => {
  it('estimates gas for the row\'s exact approve+burn batch', async () => {
    const res = await request(app()).post('/api/v1/cctp/userop')
      .send({ transferId: 7, mode: 'estimate', userOp: userOp(batchCalldata()) });
    expect(res.status).toBe(200);
    expect(res.body.data.gas).toEqual({ callGasLimit: '0x30d40' });
  });

  it('submits a signed matching op', async () => {
    const res = await request(app()).post('/api/v1/cctp/userop')
      .send({ transferId: 7, mode: 'submit', userOp: userOp(batchCalldata()) });
    expect(res.status).toBe(200);
    expect(res.body.data.userOpHash).toBe('0xophash');
  });

  it('refuses a sender that is not the caller\'s account', async () => {
    const res = await request(app()).post('/api/v1/cctp/userop')
      .send({ transferId: 7, mode: 'submit', userOp: userOp(batchCalldata(), { sender: OTHER }) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CCTP_USEROP_NOT_YOUR_ACCOUNT');
  });

  it('refuses a foreign paymaster', async () => {
    const res = await request(app()).post('/api/v1/cctp/userop')
      .send({ transferId: 7, mode: 'submit', userOp: userOp(batchCalldata(), { paymaster: OTHER }) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CCTP_USEROP_PAYMASTER');
  });

  it('refuses a burn that does not match the row', async () => {
    const res = await request(app()).post('/api/v1/cctp/userop')
      .send({ transferId: 7, mode: 'submit', userOp: userOp(batchCalldata(AMOUNT + 1n)) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CCTP_USEROP_BURN_MISMATCH');
  });

  it('refuses a call outside USDC+messenger', async () => {
    const evil = new Interface(BlindAccountABI)
      .encodeFunctionData('execute', [OTHER, 0, '0x']);
    const res = await request(app()).post('/api/v1/cctp/userop')
      .send({ transferId: 7, mode: 'submit', userOp: userOp(evil) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CCTP_USEROP_FORBIDDEN_CALL');
  });

  it('refuses native value, initCode, unsigned submit and non-created rows', async () => {
    const withValue = new Interface(BlindAccountABI)
      .encodeFunctionData('execute', [USDC, 1, '0x']);
    let res = await request(app()).post('/api/v1/cctp/userop')
      .send({ transferId: 7, mode: 'submit', userOp: userOp(withValue) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CCTP_USEROP_VALUE');

    res = await request(app()).post('/api/v1/cctp/userop')
      .send({ transferId: 7, mode: 'submit', userOp: userOp(batchCalldata(), { initCode: '0x1234' }) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CCTP_USEROP_NO_INITCODE');

    res = await request(app()).post('/api/v1/cctp/userop')
      .send({ transferId: 7, mode: 'submit', userOp: userOp(batchCalldata(), { signature: '0x' }) });
    expect(res.status).toBe(400);

    rowRef.current = { ...baseRow(), stage: 'burn_confirmed' };
    res = await request(app()).post('/api/v1/cctp/userop')
      .send({ transferId: 7, mode: 'submit', userOp: userOp(batchCalldata()) });
    expect(res.status).toBe(409);
  });

  it('requires AA on the source chain', async () => {
    aaRef.current = null;
    const res = await request(app()).post('/api/v1/cctp/userop')
      .send({ transferId: 7, mode: 'estimate', userOp: userOp(batchCalldata()) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CCTP_NO_AA');
  });
});

describe('GET /api/v1/cctp/userop-receipt', () => {
  it('reports a found receipt with its L1 hash', async () => {
    receiptRef.current = { success: true, receipt: { transactionHash: '0xaaa' } };
    const res = await request(app()).get('/api/v1/cctp/userop-receipt').query({ chain: 'ethereum-sepolia', hash: '0x' + 'ab'.repeat(32) });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ found: true, success: true, txHash: '0xaaa' });
  });

  it('reports not-found while the bundler has nothing yet', async () => {
    receiptRef.current = null;
    const res = await request(app()).get('/api/v1/cctp/userop-receipt').query({ chain: 'ethereum-sepolia', hash: '0x' + 'ab'.repeat(32) });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ found: false });
  });
});
