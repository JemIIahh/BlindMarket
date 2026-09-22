import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * routes/cctp.ts's POST /deposit-intent/:id/confirm is the one place a
 * client-supplied claim (a burn tx hash) gets turned into DB state that later
 * drives an actual USDC mint — so it must independently re-derive success
 * from the source chain's own receipt/calldata rather than trusting the
 * client. This is the test the CCTP plan calls for (§4.4 done-criterion):
 * a forged/mismatched burn tx must be rejected, not silently accepted.
 */

const {
  OWNER, TOKEN_MESSENGER, MINT_RECIPIENT, VALID_HASH,
  getTransaction, getTransactionReceipt, FAKE_SOURCE,
  updateTransfer, rowRef, baseRow,
} = vi.hoisted(() => {
  const OWNER = '0x2222222222222222222222222222222222222222';
  const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
  const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
  const MINT_RECIPIENT = '0x4444444444444444444444444444444444444444';
  const VALID_HASH = '0x' + '11'.repeat(32);

  const getTransaction = vi.fn();
  const getTransactionReceipt = vi.fn();
  const FAKE_SOURCE = {
    chainKey: 'ethereum-sepolia',
    chainId: 11155111,
    domain: 0,
    rpc: { getTransaction, getTransactionReceipt },
    tokenMessengerAddress: TOKEN_MESSENGER,
    messageTransmitterAddress: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    usdcAddress: USDC,
    isTestnet: true,
    label: 'Ethereum Sepolia',
  };

  function baseRow(overrides: Partial<any> = {}) {
    return {
      id: 1,
      idempotency_key: 'k1',
      direction: 'inbound',
      agent_id: null,
      owner_address: OWNER.toLowerCase(),
      source_chain: 'ethereum-sepolia',
      source_domain: 0,
      dest_chain: 'base-sepolia',
      dest_domain: 6,
      usdc_amount_raw: '5000000',
      mint_recipient: MINT_RECIPIENT.toLowerCase(),
      max_fee_raw: '100',
      min_finality_threshold: 1000,
      relay_method: 'forwarding_service',
      stage: 'created',
      approve_tx_hash: null,
      burn_tx_hash: null,
      burn_block_number: null,
      cctp_message_hex: null,
      cctp_attestation_hex: null,
      mint_tx_hash: null,
      error_message: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  const rowRef: { current: any } = { current: baseRow() };
  const updateTransfer = vi.fn(async (_id: number, patch: any) => {
    Object.assign(rowRef.current, patch);
    return rowRef.current;
  });

  return { OWNER, TOKEN_MESSENGER, USDC, MINT_RECIPIENT, VALID_HASH, getTransaction, getTransactionReceipt, FAKE_SOURCE, updateTransfer, rowRef, baseRow };
});

vi.mock('../services/apiKeyStore.js', () => ({
  lookupApiKey: vi.fn(async (candidate: string) =>
    candidate === 'sk_owner' ? { ownerAddress: OWNER } : null,
  ),
}));

vi.mock('../services/cctpChains.js', () => ({
  isCctpConfigured: vi.fn(() => true),
  isSupportedCctpChain: vi.fn(() => true),
  getCctpChain: vi.fn(() => FAKE_SOURCE),
  getSettlementCctpChain: vi.fn(() => ({ ...FAKE_SOURCE, chainKey: 'base-sepolia', domain: 6 })),
  supportedCctpChains: vi.fn(() => [FAKE_SOURCE]),
}));

vi.mock('../services/cctpTransferStore.js', () => ({
  createTransfer: vi.fn(),
  getByIdempotencyKey: vi.fn(),
  getById: vi.fn(async () => rowRef.current),
  updateTransfer,
  listForOwner: vi.fn(async () => []),
  serializeTransfer: vi.fn((t: any) => (t ? { transferId: t.id, stage: t.stage, mintTxHash: t.mint_tx_hash, errorMessage: t.error_message } : null)),
}));

import { cctpRouter } from './cctp.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import { buildDepositForBurnCall, FAST_TRANSFER_FINALITY_THRESHOLD } from '../services/cctp.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/cctp', cctpRouter);
  a.use(globalErrorHandler);
  return a;
}

beforeEach(() => {
  rowRef.current = baseRow();
  updateTransfer.mockClear();
  getTransaction.mockReset();
  getTransactionReceipt.mockReset();
});

describe('POST /api/v1/cctp/deposit-intent/:transferId/confirm', () => {
  it('advances to burn_confirmed when the tx matches the recorded intent', async () => {
    const { data } = buildDepositForBurnCall(FAKE_SOURCE as any, {
      amountRaw: BigInt(rowRef.current.usdc_amount_raw),
      destinationDomain: rowRef.current.dest_domain,
      mintRecipient: MINT_RECIPIENT,
      maxFeeRaw: BigInt(rowRef.current.max_fee_raw),
      minFinalityThreshold: FAST_TRANSFER_FINALITY_THRESHOLD,
    });
    getTransaction.mockResolvedValue({ to: TOKEN_MESSENGER, data });
    getTransactionReceipt.mockResolvedValue({ status: 1, blockNumber: 42 });

    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent/1/confirm')
      .set('X-API-Key', 'sk_owner')
      .send({ burnTxHash: VALID_HASH });

    expect(res.status).toBe(200);
    expect(rowRef.current.stage).toBe('burn_confirmed');
    expect(updateTransfer).toHaveBeenCalledWith(1, expect.objectContaining({ stage: 'burn_confirmed', burn_tx_hash: VALID_HASH }));
  });

  it('rejects a tx with a mismatched amount (forged claim) and does NOT advance the row', async () => {
    const { data } = buildDepositForBurnCall(FAKE_SOURCE as any, {
      amountRaw: 999_000_000n, // does NOT match rowRef.current.usdc_amount_raw (5_000_000)
      destinationDomain: rowRef.current.dest_domain,
      mintRecipient: MINT_RECIPIENT,
      maxFeeRaw: BigInt(rowRef.current.max_fee_raw),
      minFinalityThreshold: FAST_TRANSFER_FINALITY_THRESHOLD,
    });
    getTransaction.mockResolvedValue({ to: TOKEN_MESSENGER, data });
    getTransactionReceipt.mockResolvedValue({ status: 1, blockNumber: 42 });

    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent/1/confirm')
      .set('X-API-Key', 'sk_owner')
      .send({ burnTxHash: VALID_HASH });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CCTP_BURN_MISMATCH');
    expect(rowRef.current.stage).toBe('created'); // unchanged
    expect(updateTransfer).not.toHaveBeenCalled();
  });

  it('rejects a tx with a mismatched mintRecipient (attempted redirection)', async () => {
    const { data } = buildDepositForBurnCall(FAKE_SOURCE as any, {
      amountRaw: BigInt(rowRef.current.usdc_amount_raw),
      destinationDomain: rowRef.current.dest_domain,
      mintRecipient: '0x9999999999999999999999999999999999999999', // NOT the recorded recipient
      maxFeeRaw: BigInt(rowRef.current.max_fee_raw),
      minFinalityThreshold: FAST_TRANSFER_FINALITY_THRESHOLD,
    });
    getTransaction.mockResolvedValue({ to: TOKEN_MESSENGER, data });
    getTransactionReceipt.mockResolvedValue({ status: 1, blockNumber: 42 });

    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent/1/confirm')
      .set('X-API-Key', 'sk_owner')
      .send({ burnTxHash: VALID_HASH });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CCTP_BURN_MISMATCH');
    expect(rowRef.current.stage).toBe('created');
  });

  it('rejects a tx that does not call this chain\'s TokenMessengerV2 at all', async () => {
    getTransaction.mockResolvedValue({ to: '0x0000000000000000000000000000000000dEaD', data: '0x12345678' });

    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent/1/confirm')
      .set('X-API-Key', 'sk_owner')
      .send({ burnTxHash: VALID_HASH });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CCTP_BURN_MISMATCH');
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('rejects a caller who is not the owner of the transfer', async () => {
    // baseRow() defaults owner_address to OWNER (the sk_owner key's address);
    // flip it to someone else to prove the ownership gate actually runs.
    rowRef.current.owner_address = '0x3333333333333333333333333333333333333333';

    const res = await request(app())
      .post('/api/v1/cctp/deposit-intent/1/confirm')
      .set('X-API-Key', 'sk_owner')
      .send({ burnTxHash: VALID_HASH });

    expect(res.status).toBe(404); // owner mismatch reads as not-found, same as agents.ts's pattern
    expect(getTransaction).not.toHaveBeenCalled();
  });
});
