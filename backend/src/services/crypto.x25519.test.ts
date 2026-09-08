import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { ethers } from 'ethers';
import { eciesEncrypt, eciesDecrypt } from './crypto.js';

/**
 * eciesEncrypt dispatches to the X25519 branch for any 32-byte (Ed25519)
 * recipient key. That branch was broken in both directions: encrypt did
 * Diffie-Hellman of the ephemeral keypair with ITSELF, and decrypt did DH of
 * the recipient keypair with itself, so the two sides never agreed on a
 * secret. On top of that the private key was wrapped with the Ed25519 OID
 * (1.3.101.112) instead of X25519's (1.3.101.110) and a length header one
 * byte short, so createPrivateKey threw before it could even fail on the key.
 *
 * Encrypting appeared to work, which is what made it dangerous: a brief
 * sealed to an Ed25519 key could be written and never opened by anyone.
 * Latent rather than live — every registered agent carries a 65-byte
 * secp256k1 key — but it was one Ed25519 registration away from stranding
 * briefs permanently.
 *
 * Surfaced by turning on noUnusedLocals: the recipient's converted key and
 * the blob's ephemeral key were both computed and then never read.
 */
function ed25519Identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
    priv: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex'),
  };
}

describe('ECIES over Ed25519/X25519', () => {
  it('round-trips a payload to an Ed25519 recipient', () => {
    const { pub, priv } = ed25519Identity();
    const secret = Buffer.from('the brief nobody must lose');
    expect(eciesDecrypt(eciesEncrypt(secret, pub), priv)).toEqual(secret);
  });

  // KNOWN LIMITATION, not fixed here. eciesDecrypt discriminates the two
  // schemes by BLOB LENGTH: X25519 only when length is in [61, 94). An X25519
  // blob is 60 + plaintext bytes, so anything from 34 bytes of plaintext up
  // produces a >=94-byte blob that is handed to the secp256k1 decryptor and
  // dies with "Public key is not valid for specified curve". Measured, not
  // inferred: 33 bytes round-trips, 100 does not. Fixing it needs a version
  // byte in the format (or removing the X25519 path, which no registered agent
  // uses), which is a wire-format decision and its own change. This test pins
  // the ceiling so it is visible rather than folklore.
  it('has a 33-byte ceiling today — the length-based scheme discriminator', () => {
    const { pub, priv } = ed25519Identity();
    const small = Buffer.from('x'.repeat(33));
    expect(eciesDecrypt(eciesEncrypt(small, pub), priv)).toEqual(small);

    const tooBig = Buffer.from('x'.repeat(34));
    expect(() => eciesDecrypt(eciesEncrypt(tooBig, pub), priv)).toThrow();
  });

  it('produces a fresh ephemeral key per call — same input, different blob', () => {
    const { pub } = ed25519Identity();
    const secret = Buffer.from('same input');
    expect(eciesEncrypt(secret, pub).equals(eciesEncrypt(secret, pub))).toBe(false);
  });

  it('a different recipient cannot open it', () => {
    const alice = ed25519Identity();
    const mallory = ed25519Identity();
    const blob = eciesEncrypt(Buffer.from('for alice only'), alice.pub);
    expect(() => eciesDecrypt(blob, mallory.priv)).toThrow();
  });

  it('leaves the secp256k1 path every live agent actually uses untouched', () => {
    // All 20 registered agents carry a 65-byte secp256k1 key, so this is the
    // branch that matters in production. ethers derives the keypair rather
    // than hand-slicing DER.
    const w = ethers.Wallet.createRandom();
    const secret = Buffer.from('secp256k1 payload of a realistic length, well over 34 bytes');
    const blob = eciesEncrypt(secret, w.publicKey);
    expect(eciesDecrypt(blob, w.privateKey.slice(2))).toEqual(secret);
  });
});
