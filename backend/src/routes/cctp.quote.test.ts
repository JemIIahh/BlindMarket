import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /api/v1/cctp/quote — public, side-effect-free fee preview so the UI
 * can show "you'll receive ~X" before the user commits to a chain switch +
 * signature. See CctpFundModal.tsx / GasBar.tsx for the callers.
 */

const { FAKE_SOURCE, FAKE_DEST } = vi.hoisted(() => {
  const fakeSource = {
    chainKey: 'ethereum-sepolia', chainId: 11155111, domain: 0, rpc: {},
    tokenMessengerAddress: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitterAddress: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    isTestnet: true, label: 'Ethereum Sepolia',
  };
  const fakeDest = { ...fakeSource, chainKey: 'base-sepolia', domain: 6, usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', label: 'Base Sepolia' };
  return { FAKE_SOURCE: fakeSource, FAKE_DEST: fakeDest };
});

vi.mock('../services/cctpChains.js', () => ({
  isCctpConfigured: vi.fn(() => true),
  isSupportedCctpChain: vi.fn((k: string) => k === 'ethereum-sepolia' || k === 'base-sepolia'),
  getCctpChain: vi.fn((k: string) => (k === 'ethereum-sepolia' ? FAKE_SOURCE : k === 'base-sepolia' ? FAKE_DEST : null)),
  getBaseCctpChain: vi.fn(() => FAKE_DEST),
  supportedCctpChains: vi.fn(() => [FAKE_SOURCE, FAKE_DEST]),
}));

vi.mock('../services/cctp.js', async () => {
  const actual = await vi.importActual<typeof import('../services/cctp.js')>('../services/cctp.js');
  return { ...actual, estimateMaxFeeRaw: vi.fn() };
});

vi.mock('../services/cctpTransferStore.js', () => ({
  createTransfer: vi.fn(), getByIdempotencyKey: vi.fn(), getById: vi.fn(),
  updateTransfer: vi.fn(), listForOwner: vi.fn(async () => []), serializeTransfer: vi.fn(),
}));

import { cctpRouter } from './cctp.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import { config } from '../config.js';
import { estimateMaxFeeRaw } from '../services/cctp.js';

(config.cctp as { enabled: boolean }).enabled = true;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/cctp', cctpRouter);
  a.use(globalErrorHandler);
  return a;
}

beforeEach(() => {
  vi.mocked(estimateMaxFeeRaw).mockReset();
  vi.mocked(estimateMaxFeeRaw).mockResolvedValue(100_000n); // 1% of 10_000_000, the default test amount
});

describe('GET /api/v1/cctp/quote', () => {
  it('returns the fee and net receive amount for a valid route', async () => {
    const res = await request(app()).get('/api/v1/cctp/quote').query({ sourceChain: 'ethereum-sepolia', destChain: 'base-sepolia', amountRaw: '10000000' });
    expect(res.status).toBe(200);
    expect(res.body.data.maxFeeRaw).toBe('100000');
    expect(res.body.data.estimatedReceiveRaw).toBe('9900000');
  });

  it('rejects sourceChain === destChain', async () => {
    const res = await request(app()).get('/api/v1/cctp/quote').query({ sourceChain: 'base-sepolia', destChain: 'base-sepolia', amountRaw: '10000000' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CCTP_SAME_CHAIN');
  });

  it('rejects an unsupported chain', async () => {
    const res = await request(app()).get('/api/v1/cctp/quote').query({ sourceChain: 'solana', destChain: 'base-sepolia', amountRaw: '10000000' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CCTP_UNSUPPORTED_CHAIN');
  });

  it('rejects a non-positive amount', async () => {
    const res = await request(app()).get('/api/v1/cctp/quote').query({ sourceChain: 'ethereum-sepolia', destChain: 'base-sepolia', amountRaw: '0' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('surfaces a clean error when the fee quote fails, without an unhandled exception', async () => {
    vi.mocked(estimateMaxFeeRaw).mockRejectedValueOnce(new Error('iris down'));
    const res = await request(app()).get('/api/v1/cctp/quote').query({ sourceChain: 'ethereum-sepolia', destChain: 'base-sepolia', amountRaw: '10000000' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('CCTP_FEE_QUOTE_FAILED');
  });

  it('clamps estimatedReceiveRaw to 0 rather than going negative when the fee exceeds the amount', async () => {
    vi.mocked(estimateMaxFeeRaw).mockResolvedValueOnce(999_999_999n);
    const res = await request(app()).get('/api/v1/cctp/quote').query({ sourceChain: 'ethereum-sepolia', destChain: 'base-sepolia', amountRaw: '10000000' });
    expect(res.status).toBe(200);
    expect(res.body.data.estimatedReceiveRaw).toBe('0');
  });
});
