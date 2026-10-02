import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  authorizationSigner,
  delegationDesignator,
  isDelegatedTo,
  signAuthorization,
  signSetCodeTx,
} from './eip7702.js';

/**
 * The hand-built EIP-7702 encodings (the backend's ethers 6.13 has none)
 * against vectors produced by ethers 6.17's own Wallet.authorize and type-4
 * Transaction, from the same throwaway key.
 */

const key = new ethers.SigningKey('0x' + '42'.repeat(32));
const wallet = ethers.computeAddress(key.publicKey);
const DELEGATE = '0x1234567890AbcdEF1234567890aBcdef12345678';
const ETHERS_6_17 = {
  "auth_5042002_7": {
    "chainId": "5042002",
    "address": "0x1234567890AbcdEF1234567890aBcdef12345678",
    "nonce": "7",
    "yParity": 1,
    "r": "0xe384a513b69ec44a1a7cd563ad6b8c4608ff8ed5739931c00aba316fb8041697",
    "s": "0x19f4adb854e4498c84a179da9e146919e87ec077d1716439652ad0ef87d25759"
  },
  "auth_5042_0": {
    "chainId": "5042",
    "address": "0x1234567890AbcdEF1234567890aBcdef12345678",
    "nonce": "0",
    "yParity": 0,
    "r": "0xac104bb49e15faa72e7fe1257d27bbed7ee5c05e4ced9c6db3eff9ad776ffb10",
    "s": "0x6cab72c2fdc6de42b898fbd8aeb3e3ae8e45a4ab3bb7d983b929d9dc1c4ac9ec"
  },
  "tx": {
    "raw": "0x04f8d0834cef5203808509502f90008302a3c89417c5185167401ed00cf5f5b2fc97d9bbfdb7d0258084deadbeefc0f85ff85d834cef52941234567890abcdef1234567890abcdef123456780701a0e384a513b69ec44a1a7cd563ad6b8c4608ff8ed5739931c00aba316fb8041697a019f4adb854e4498c84a179da9e146919e87ec077d1716439652ad0ef87d2575901a0a2362e51770beb157e0096e3f73c1bc293ba9dd40139f4b67c54f732e4ffec43a07eabec321266c4405b9d991d5c54ca79d0dec5e11cd177134bbd4e9a14259404",
    "hash": "0x1e16f245e89a3adea60242cbd7d3f3f9eeb62cad224949f5b6c540477e2dc875"
  },
  "tx_noauth": {
    "raw": "0x04f866834cef52800101825208941234567890abcdef1234567890abcdef123456788080c0c001a0eac94b1a75d24a963763b889052af3771533d33c42eca188a2bd4220a05387c3a00e28a12b59c3f3e41ad23f7bd92a18f45ebecaa4bfe09c6f12a9a0d81c3a875e",
    "hash": "0x0333e80f7c9fbef6453dc8fd758f7bd849af9b33ba8fecfbdf53e5a40fbee850"
  }
} as const;

describe('authorizations', () => {
  it.each([
    ['auth_5042002_7', 5042002n, 7n],
    ['auth_5042_0', 5042n, 0n],
  ] as const)('match ethers 6.17 for %s', (name, chainId, nonce) => {
    const expected = ETHERS_6_17[name];
    const auth = signAuthorization(key, { chainId, address: DELEGATE, nonce });
    expect({ yParity: auth.yParity, r: auth.r, s: auth.s }).toEqual({ yParity: expected.yParity, r: expected.r, s: expected.s });
    expect(authorizationSigner(auth)).toBe(wallet);
  });

  it('recover no signer from a tampered authorization', () => {
    const auth = signAuthorization(key, { chainId: 5042002n, address: DELEGATE, nonce: 7n });
    expect(authorizationSigner({ ...auth, chainId: 5042n })).not.toBe(wallet);
    expect(authorizationSigner({ ...auth, yParity: 5 })).toBeNull();
  });
});

describe('type-4 transactions', () => {
  it('serialize and hash like ethers 6.17, with an authorization', () => {
    const auth = signAuthorization(key, { chainId: 5042002n, address: DELEGATE, nonce: 7n });
    const signed = signSetCodeTx(key, {
      chainId: 5042002n, nonce: 3, maxPriorityFeePerGas: 0n, maxFeePerGas: 40n * 10n ** 9n, gasLimit: 173_000n,
      to: wallet, data: '0xdeadbeef', authorizationList: [auth],
    });
    expect(signed).toEqual(ETHERS_6_17.tx);
  });

  it('serialize and hash like ethers 6.17, with an empty list', () => {
    const signed = signSetCodeTx(key, {
      chainId: 5042002n, nonce: 0, maxPriorityFeePerGas: 1n, maxFeePerGas: 1n, gasLimit: 21_000n,
      to: DELEGATE, data: '0x', authorizationList: [],
    });
    expect(signed).toEqual(ETHERS_6_17.tx_noauth);
  });
});

describe('delegation designator', () => {
  it('is 0xef0100 followed by the delegate', () => {
    expect(delegationDesignator(DELEGATE)).toBe('0xef01001234567890abcdef1234567890abcdef12345678');
    expect(isDelegatedTo('0xEF01001234567890ABCDEF1234567890ABCDEF12345678', DELEGATE)).toBe(true);
    expect(isDelegatedTo('0x', DELEGATE)).toBe(false);
    expect(isDelegatedTo('0xef0100' + '00'.repeat(20), DELEGATE)).toBe(false);
  });
});
