import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { DelegateKind, delegateVersion, receiptProvesCall, SUBMIT_OPEN_DELEGATE_VERSION } from './blindAgentDelegate.js';

/**
 * The relayer's view of BlindAgentDelegate versions and of the escrow event
 * that proves a sponsored submitOpen. Version 1 (deployed on Arc as of
 * 2026-10) has no DELEGATE_VERSION(): the call reverts without data.
 */

const DELEGATE = '0x' + 'de'.repeat(20);
const ESCROW = '0x' + 'e5'.repeat(20);
const WALLET = '0x' + 'a1'.repeat(20);
const OTHER = '0x' + 'b2'.repeat(20);
const EVIDENCE = '0x' + 'ab'.repeat(32);

const events = new ethers.Interface([
  'event OpenSubmission(uint256 indexed taskId, address indexed submitter, bytes32 evidenceHash, uint256 count)',
  'event EvidenceSubmitted(uint256 indexed taskId, address indexed worker, bytes32 evidenceHash, uint8 attempt)',
]);
const log = (name: string, args: unknown[], address = ESCROW) => ({ address, ...events.encodeEventLog(name, args) });

describe('delegateVersion', () => {
  const answering = (answer: () => Promise<string>) => ({ call: answer });

  it("reads a version-2 delegate's DELEGATE_VERSION()", async () => {
    const provider = answering(async () => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [2]));
    expect(await delegateVersion(provider, DELEGATE)).toBe(SUBMIT_OPEN_DELEGATE_VERSION);
  });

  it('reads a revert as version 1', async () => {
    const provider = answering(async () => {
      throw ethers.makeError('missing revert data', 'CALL_EXCEPTION', { action: 'call', data: null, reason: null, transaction: { to: DELEGATE, data: '0x' }, invocation: null, revert: null });
    });
    expect(await delegateVersion(provider, DELEGATE)).toBe(1n);
  });

  it('does not know when the RPC fails or nothing is deployed there', async () => {
    expect(await delegateVersion(answering(async () => { throw ethers.makeError('timeout', 'TIMEOUT', { operation: 'call' }); }), DELEGATE)).toBeNull();
    expect(await delegateVersion(answering(async () => '0x'), DELEGATE)).toBeNull();
  });
});

describe('receiptProvesCall for SubmitOpen', () => {
  it("needs the escrow's OpenSubmission for the task, by the wallet", () => {
    const mine = log('OpenSubmission', [7n, WALLET, EVIDENCE, 3n]);
    expect(receiptProvesCall([mine], ESCROW, DelegateKind.SubmitOpen, 7n, WALLET)).toBe(true);
    expect(receiptProvesCall([mine], ESCROW, DelegateKind.SubmitOpen, 8n, WALLET)).toBe(false);
    expect(receiptProvesCall([log('OpenSubmission', [7n, OTHER, EVIDENCE, 3n])], ESCROW, DelegateKind.SubmitOpen, 7n, WALLET)).toBe(false);
    expect(receiptProvesCall([log('OpenSubmission', [7n, WALLET, EVIDENCE, 3n], OTHER)], ESCROW, DelegateKind.SubmitOpen, 7n, WALLET)).toBe(false);
    // An EvidenceSubmitted is not proof of a submitOpen, nor the reverse.
    const evidence = log('EvidenceSubmitted', [7n, WALLET, EVIDENCE, 1]);
    expect(receiptProvesCall([evidence], ESCROW, DelegateKind.SubmitOpen, 7n, WALLET)).toBe(false);
    expect(receiptProvesCall([mine], ESCROW, DelegateKind.SubmitEvidence, 7n, WALLET)).toBe(false);
    expect(receiptProvesCall([evidence], ESCROW, DelegateKind.SubmitEvidence, 7n, WALLET)).toBe(true);
  });
});
