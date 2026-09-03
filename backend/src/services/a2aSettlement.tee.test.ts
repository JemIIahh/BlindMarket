/**
 * TEE attestation handling in the settlement bridge.
 *
 * The attestation travels in the worker agent's own /submit payload, so the
 * `verified` flag inside it is a claim by the party being paid. These tests pin
 * the two properties that matter: the signature is checked against the
 * configured enclave key rather than taken on trust, and the signed text is
 * encoded to bytes before it can reach the ABI encoder.
 *
 * Run: npx vitest run src/services/a2aSettlement.tee.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Wallet, toUtf8Bytes, hexlify, AbiCoder } from 'ethers';

const teeWallet = Wallet.createRandom();
const rogueWallet = Wallet.createRandom();

// The bridge pulls the expected signer off config; stub the module so the test
// doesn't need the full env the real config requires at import time.
vi.mock('../config.js', () => ({
  config: { teeSignerAddress: teeWallet.address },
}));

// chain.js opens RPC providers on import — not needed for pure helpers.
vi.mock('./chain.js', () => ({
  escrowAsMarketplace: null,
  marketplaceSigner: null,
  baseEscrowAsMarketplace: null,
  baseMarketplaceSigner: null,
}));
vi.mock('./escrowEvents.js', () => ({ getTaskIdByHash: vi.fn() }));
vi.mock('./baseEscrowEvents.js', () => ({ getBaseTaskIdByHash: vi.fn() }));
vi.mock('./a2aStore.js', () => ({ getState: vi.fn(), updateState: vi.fn(), getMeta: vi.fn() }));
vi.mock('./socket.js', () => ({ rooms: {} }));

const { isTeeAttestationValid, normalizeSignedText } = await import('./a2aSettlement.js');

// What a 0G enclave actually signs: a commitment over an inference
// request/response pair. It names no task and no verdict.
const ATTESTATION_TEXT = '0g-tee-commitment:req=0xabc,res=0xdef';

let goodSig: string;
let rogueSig: string;

beforeEach(async () => {
  goodSig = await teeWallet.signMessage(ATTESTATION_TEXT);
  rogueSig = await rogueWallet.signMessage(ATTESTATION_TEXT);
});

describe('normalizeSignedText', () => {
  it('hex-encodes plain text so it survives ABI encoding as bytes', () => {
    const normalized = normalizeSignedText(ATTESTATION_TEXT);
    expect(normalized).toBe(hexlify(toUtf8Bytes(ATTESTATION_TEXT)));

    // The raw string is what the provider returns and what the bridge used to
    // pass straight through — ethers rejects it for a `bytes` parameter.
    const coder = AbiCoder.defaultAbiCoder();
    expect(() => coder.encode(['bytes'], [ATTESTATION_TEXT])).toThrow();
    expect(() => coder.encode(['bytes'], [normalized])).not.toThrow();
  });

  it('leaves an already-hex value alone', () => {
    const hex = '0xdeadbeef';
    expect(normalizeSignedText(hex)).toBe(hex);
  });
});

describe('isTeeAttestationValid', () => {
  it('accepts a signature from the configured enclave key', () => {
    expect(isTeeAttestationValid({ signature: goodSig, signedText: ATTESTATION_TEXT })).toBe(true);
  });

  it('rejects a signature from any other key', () => {
    expect(isTeeAttestationValid({ signature: rogueSig, signedText: ATTESTATION_TEXT })).toBe(false);
  });

  it('ignores a self-reported verified flag on an unsigned attestation', () => {
    // The worker asserting its own attestation is valid must not be enough.
    expect(
      isTeeAttestationValid({ signature: '0xnotasignature', signedText: ATTESTATION_TEXT, verified: true }),
    ).toBe(false);
  });

  it('rejects a signature over different text than the one supplied', () => {
    expect(isTeeAttestationValid({ signature: goodSig, signedText: 'different text' })).toBe(false);
  });

  it('rejects an empty or partial attestation', () => {
    expect(isTeeAttestationValid(null)).toBe(false);
    expect(isTeeAttestationValid(undefined)).toBe(false);
    expect(isTeeAttestationValid({ signature: '', signedText: ATTESTATION_TEXT })).toBe(false);
    expect(isTeeAttestationValid({ signature: goodSig, signedText: '' })).toBe(false);
  });
});
