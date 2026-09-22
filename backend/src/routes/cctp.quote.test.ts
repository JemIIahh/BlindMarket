import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /api/v1/cctp/quote — public, side-effect-free fee preview so the UI
 * can show "you'll receive ~X" before the user commits to a chain switch +
 * signature. See CctpFundModal.tsx / GasBar.tsx for the callers.
 */

const { FAKE_SOURCE, FAKE_DEST, FAKE_ARC } = vi.hoisted(() => {
  const fakeSource = {
    chainKey: 'ethereum-sepolia', chainId: 11155111, domain: 0, rpc: {},
    tokenMessengerAddress: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitterAddress: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    isTestnet: true, label: 'Ethereum Sepolia',
    supportsFastTransfer: true, usdcGasReserveRaw: 0n,
  };
  const fakeDest = { ...fakeSource, chainKey: 'base-sepolia', chainId: 84532, domain: 6, usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', label: 'Base Sepolia' };
  const fakeArc = {
    ...fakeSource, chainKey: 'arc-testnet', chainId: 5042002, domain: 26,
    usdcAddress: '0x3600000000000000000000000000000000000000', label: 'Arc Testnet',
    supportsFastTransfer: false, usdcGasReserveRaw: 50_000n,
  };
  return { FAKE_SOURCE: fakeSource, FAKE_DEST: fakeDest, FAKE_ARC: fakeArc };
});

vi.mock('../services/cctpChains.js', () => ({
  isCctpConfigured: vi.fn(() => true),
  isSupportedCctpChain: vi.fn((k: string) => k === 'ethereum-sepolia' || k === 'base-sepolia' || k === 'arc-testnet'),
  getCctpChain: vi.fn((k: string) => (k === 'ethereum-sepolia' ? FAKE_SOURCE : k === 'base-sepolia' ? FAKE_DEST : k === 'arc-testnet' ? FAKE_ARC : null)),
  getSettlementCctpChain: vi.fn(() => FAKE_DEST),
  supportedCctpChains: vi.fn(() => [FAKE_SOURCE, FAKE_DEST, FAKE_ARC]),
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

  it('quotes an Arc-sourced route at Standard Transfer (2000); ETH-gas sources stay Fast (1000)', async () => {
    await request(app()).get('/api/v1/cctp/quote').query({ sourceChain: 'arc-testnet', destChain: 'base-sepolia', amountRaw: '10000000' });
    expect(vi.mocked(estimateMaxFeeRaw).mock.calls[0][4]).toBe(2000);

    await request(app()).get('/api/v1/cctp/quote').query({ sourceChain: 'ethereum-sepolia', destChain: 'base-sepolia', amountRaw: '10000000' });
    expect(vi.mocked(estimateMaxFeeRaw).mock.calls[1][4]).toBe(1000);
  });
});

describe('GET /api/v1/cctp/config', () => {
  it('publishes each chain\'s gas reserve as a string — non-zero only where gas is paid in USDC', async () => {
    const res = await request(app()).get('/api/v1/cctp/config');
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.data.chains.map((c: { chainKey: string; usdcGasReserveRaw: string }) => [c.chainKey, c.usdcGasReserveRaw]));
    expect(byKey).toEqual({ 'ethereum-sepolia': '0', 'base-sepolia': '0', 'arc-testnet': '50000' });
  });

  it('reports the Base chain its CCTP uses, so the frontend can refuse a mismatched deployment', async () => {
    const res = await request(app()).get('/api/v1/cctp/config');
    expect(res.body.data.baseChainId).toBe(84532); // FAKE_DEST = the Base Sepolia leg
    expect(res.body.data.network).toBe('testnet');
  });
});
