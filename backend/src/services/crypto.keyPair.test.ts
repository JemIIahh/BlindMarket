import { describe, it, expect, vi } from 'vitest';
import { Wallet } from 'ethers';

/**
 * generateKeyPair is the hosted agent's wallet key (agentRunner.deployAgent
 * builds `new Wallet('0x' + privateKey)` from it). Node's
 * ECDH.getPrivateKey() drops leading zero bytes, so about 1 key in 256 came
 * back 31 bytes long and that deploy failed with 500 "invalid private key"
 * (seen in a local run; ~75 in 20,000 keys measured). A key with a leading
 * zero byte is forced here so the case is tested every run, not 1 run in 256.
 */

// A valid secp256k1 scalar whose first byte is zero.
const LEADING_ZERO_KEY = Buffer.from('00' + 'ab'.repeat(31), 'hex');
const forceKey = vi.hoisted(() => ({ on: false }));

vi.mock('crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('crypto')>();
  return {
    ...real,
    createECDH: (curve: string) => {
      const ecdh = real.createECDH(curve);
      if (!forceKey.on) return ecdh;
      return {
        generateKeys: () => { ecdh.setPrivateKey(LEADING_ZERO_KEY); return ecdh.getPublicKey(); },
        getPrivateKey: (...a: unknown[]) => (ecdh.getPrivateKey as (...x: unknown[]) => unknown)(...a),
        getPublicKey: (...a: unknown[]) => (ecdh.getPublicKey as (...x: unknown[]) => unknown)(...a),
      };
    },
  };
});

const { generateKeyPair } = await import('./crypto.js');

describe('generateKeyPair', () => {
  it('keeps a leading zero byte: 64 hex, a usable wallet key, matching its public key', () => {
    forceKey.on = true;
    try {
      const { privateKey, publicKey } = generateKeyPair();
      expect(privateKey).toBe(LEADING_ZERO_KEY.toString('hex'));
      expect(privateKey).toHaveLength(64);
      const wallet = new Wallet(`0x${privateKey}`);
      expect(wallet.signingKey.publicKey).toBe(`0x${publicKey}`);
    } finally {
      forceKey.on = false;
    }
  });

  // 2000 key generations: well under a second alone, but past the 5 s default
  // when the whole suite loads every core.
  it('always returns a 32-byte private key and a 65-byte uncompressed public key', () => {
    for (let i = 0; i < 2000; i++) {
      const { privateKey, publicKey } = generateKeyPair();
      expect(privateKey).toMatch(/^[0-9a-f]{64}$/);
      expect(publicKey).toMatch(/^04[0-9a-f]{128}$/);
    }
  }, 20_000);
});
