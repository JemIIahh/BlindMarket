import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Direct unit tests for advance()'s stage-transition logic — the poller
 * is the piece that actually drives a transfer from a raw burn tx to a
 * completed mint, and had zero direct coverage before this (only
 * indirectly touched by route tests, which never reach the poller at all
 * since it runs on its own interval). No other poller/listener in this
 * codebase (e.g. agentFactoryListener.ts) has a dedicated unit test either
 * — those are verified via the Base E2E harness instead — but the
 * transition logic here is dense enough (7 stages, several branches each)
 * that mocked unit coverage is worth the departure.
 */

const { getTransactionReceipt, FAKE_SOURCE, FAKE_DEST, pollIrisAttestation, updateTransfer } = vi.hoisted(() => {
  const getTransactionReceipt = vi.fn();
  const fakeSource = {
    chainKey: 'ethereum-sepolia', chainId: 11155111, domain: 0,
    rpc: { getTransactionReceipt },
    tokenMessengerAddress: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    messageTransmitterAddress: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    isTestnet: true, label: 'Ethereum Sepolia',
  };
  const fakeDest = { ...fakeSource, chainKey: 'base-sepolia', domain: 6, usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', label: 'Base Sepolia' };
  return {
    getTransactionReceipt,
    FAKE_SOURCE: fakeSource,
    FAKE_DEST: fakeDest,
    pollIrisAttestation: vi.fn(),
    updateTransfer: vi.fn(async () => ({})),
  };
});

vi.mock('../config.js', () => ({ config: { cctp: { irisApiBase: 'https://iris-api-sandbox.circle.com' } } }));

vi.mock('./cctpChains.js', () => ({
  isCctpConfigured: vi.fn(() => true),
  getCctpChain: vi.fn((k: string) => (k === 'ethereum-sepolia' ? FAKE_SOURCE : k === 'base-sepolia' ? FAKE_DEST : null)),
}));

vi.mock('./cctp.js', () => ({ pollIrisAttestation }));

vi.mock('./cctpTransferStore.js', () => ({ listNonTerminal: vi.fn(), updateTransfer }));

import { advance } from './cctpAttestationPoller.js';

function row(stage: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    idempotency_key: 'k1',
    direction: 'outbound',
    agent_id: 'agent-1',
    owner_address: '0x2222222222222222222222222222222222222222',
    source_chain: 'ethereum-sepolia',
    source_domain: 0,
    dest_chain: 'base-sepolia',
    dest_domain: 6,
    usdc_amount_raw: '5000000',
    mint_recipient: '0x4444444444444444444444444444444444444444',
    max_fee_raw: '100000',
    min_finality_threshold: 1000,
    relay_method: 'forwarding_service',
    stage,
    approve_tx_hash: null,
    burn_tx_hash: '0x' + '11'.repeat(32),
    burn_block_number: null,
    cctp_message_hex: null,
    cctp_attestation_hex: null,
    mint_tx_hash: null,
    error_message: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as any;
}

beforeEach(() => {
  getTransactionReceipt.mockReset();
  pollIrisAttestation.mockReset();
  updateTransfer.mockClear();
});

describe('advance() — burn_submitted', () => {
  it('leaves the row unchanged while the receipt is still pending', async () => {
    getTransactionReceipt.mockResolvedValue(null);
    await advance(row('burn_submitted'));
    expect(updateTransfer).not.toHaveBeenCalled();
  });

  it('advances to burn_confirmed once the receipt is mined', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 1, blockNumber: 999 });
    await advance(row('burn_submitted'));
    expect(updateTransfer).toHaveBeenCalledWith(1, { stage: 'burn_confirmed', burn_block_number: '999' });
  });

  it('fails the row if the burn transaction reverted', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 0, blockNumber: 999 });
    await advance(row('burn_submitted'));
    expect(updateTransfer).toHaveBeenCalledWith(1, { stage: 'failed', error_message: 'burn transaction reverted' });
  });

  it('fails immediately if burn_submitted has no burn_tx_hash (data corruption guard)', async () => {
    await advance(row('burn_submitted', { burn_tx_hash: null }));
    expect(updateTransfer).toHaveBeenCalledWith(1, { stage: 'failed', error_message: 'burn_submitted with no burn_tx_hash recorded' });
    expect(getTransactionReceipt).not.toHaveBeenCalled();
  });
});

describe('advance() — burn_confirmed / attestation_pending / attestation_ready (Iris polling)', () => {
  it('does nothing for an inbound row that has no burn_tx_hash yet (awaiting /confirm)', async () => {
    await advance(row('burn_confirmed', { burn_tx_hash: null }));
    expect(pollIrisAttestation).not.toHaveBeenCalled();
    expect(updateTransfer).not.toHaveBeenCalled();
  });

  it('moves to attestation_pending when Iris has not indexed the message yet', async () => {
    pollIrisAttestation.mockResolvedValue(null);
    await advance(row('burn_confirmed'));
    expect(updateTransfer).toHaveBeenCalledWith(1, { stage: 'attestation_pending' });
  });

  it('does not re-write attestation_pending if already there and still pending', async () => {
    pollIrisAttestation.mockResolvedValue({ status: 'pending_confirmations', message: '0xmsg', attestation: null });
    await advance(row('attestation_pending'));
    expect(updateTransfer).not.toHaveBeenCalled();
  });

  it('advances attestation_pending -> attestation_ready once Iris signs, with no forwardTxHash yet', async () => {
    pollIrisAttestation.mockResolvedValue({ status: 'complete', message: '0xmsg', attestation: '0xatt' });
    await advance(row('attestation_pending'));
    expect(updateTransfer).toHaveBeenCalledWith(1, { stage: 'attestation_ready', cctp_message_hex: '0xmsg', cctp_attestation_hex: '0xatt' });
  });

  it('jumps straight to mint_confirmed when Forwarding Service has already completed the mint (forwardTxHash present)', async () => {
    pollIrisAttestation.mockResolvedValue({ status: 'complete', message: '0xmsg', attestation: '0xatt', forwardTxHash: '0xminted' });
    await advance(row('burn_confirmed')); // even before reaching attestation_ready
    expect(updateTransfer).toHaveBeenCalledWith(1, {
      stage: 'mint_confirmed', cctp_message_hex: '0xmsg', cctp_attestation_hex: '0xatt', mint_tx_hash: '0xminted',
    });
  });

  it('does not re-write attestation_ready while still waiting on the Forwarding Service, and does not warn before the stall threshold', async () => {
    pollIrisAttestation.mockResolvedValue({ status: 'complete', message: '0xmsg', attestation: '0xatt' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await advance(row('attestation_ready', { updated_at: new Date().toISOString() }));
    expect(updateTransfer).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('logs a stall warning once attestation_ready has sat unminted past the 10-minute threshold', async () => {
    pollIrisAttestation.mockResolvedValue({ status: 'complete', message: '0xmsg', attestation: '0xatt' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const staleUpdatedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    await advance(row('attestation_ready', { updated_at: staleUpdatedAt }));
    expect(updateTransfer).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('may need manual self-relay'));
    warnSpy.mockRestore();
  });

  it('logs (but does not block on) a delayReason from Iris, e.g. insufficient_fee', async () => {
    pollIrisAttestation.mockResolvedValue({ status: 'pending_confirmations', message: '0xmsg', attestation: null, delayReason: 'insufficient_fee' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await advance(row('burn_confirmed'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('insufficient_fee'));
    warnSpy.mockRestore();
  });
});

describe('advance() — mint_submitted (manual self-relay in flight)', () => {
  it('leaves the row unchanged while the mint receipt is still pending', async () => {
    getTransactionReceipt.mockResolvedValue(null);
    await advance(row('mint_submitted', { mint_tx_hash: '0xmint' }));
    expect(updateTransfer).not.toHaveBeenCalled();
  });

  it('advances to mint_confirmed once the mint receipt is mined', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 1 });
    await advance(row('mint_submitted', { mint_tx_hash: '0xmint' }));
    expect(updateTransfer).toHaveBeenCalledWith(1, { stage: 'mint_confirmed' });
  });

  it('fails the row if the mint transaction reverted', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 0 });
    await advance(row('mint_submitted', { mint_tx_hash: '0xmint' }));
    expect(updateTransfer).toHaveBeenCalledWith(1, { stage: 'failed', error_message: 'mint transaction reverted' });
  });
});

describe('advance() — misconfiguration guard', () => {
  it('fails the row if its source chain is no longer configured', async () => {
    await advance(row('burn_submitted', { source_chain: 'polygon' }));
    expect(updateTransfer).toHaveBeenCalledWith(1, { stage: 'failed', error_message: 'source chain polygon no longer configured' });
  });
});
