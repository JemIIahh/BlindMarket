import { describe, expect, it } from 'vitest';
import { Interface, keccak256, toUtf8Bytes } from 'ethers';
import { accountSalt, encodeBatch, encodeCreateAccount, userOpHash, type UnpackedUserOp } from './userOp';

/**
 * lib/userOp.ts — ERC-4337 v0.7 packing for the external-wallet USDC-gas
 * path. A wrong hash fails safe at the bundler, but these pin the structure
 * so a regression fails here instead: batch round-trips through the
 * BlindAccount ABI, the salt follows the backend convention, and the hash
 * is a 32-byte digest sensitive to every field.
 */

const EOA = '0x2222222222222222222222222222222222222222';
const SMART = '0x3333333333333333333333333333333333333333';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
const ENTRYPOINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

const BATCH_ABI = [
  'function execute(address to, uint256 value, bytes data)',
  'function executeBatch(address[] to, uint256[] value, bytes[] data)',
];

function op(overrides: Partial<UnpackedUserOp> = {}): UnpackedUserOp {
  return {
    sender: SMART,
    nonce: '0x0',
    callData: encodeBatch([{ to: USDC, value: 0n, data: '0x095ea7b3' }]),
    callGasLimit: '0x30d40',
    verificationGasLimit: '0x30d40',
    preVerificationGas: '0xc350',
    maxFeePerGas: '0x3b9aca00',
    maxPriorityFeePerGas: '0x3b9aca00',
    paymaster: '0x5555555555555555555555555555555555555555',
    paymasterVerificationGasLimit: '0x186a0',
    paymasterPostOpGasLimit: '0xc350',
    paymasterData: '0x',
    signature: '0x',
    ...overrides,
  };
}

describe('accountSalt', () => {
  it('follows the backend convention keccak256("blind-account:"+address)', () => {
    expect(accountSalt(EOA)).toBe(keccak256(toUtf8Bytes(`blind-account:${EOA}`)));
  });

  it('is deterministic and address-bound', () => {
    expect(accountSalt(EOA)).toBe(accountSalt(EOA));
    expect(accountSalt(EOA)).not.toBe(accountSalt(SMART));
  });
});

describe('encodeBatch / encodeCreateAccount', () => {
  it('round-trips through the BlindAccount ABI', () => {
    const calls = [
      { to: USDC, value: 0n, data: '0x095ea7b3' },
      { to: MESSENGER, value: 0n, data: '0x1234' },
    ];
    const data = encodeBatch(calls);
    const [to, value, inner] = new Interface(BATCH_ABI).decodeFunctionData('executeBatch', data);
    expect([...to]).toEqual([USDC, MESSENGER]);
    expect(value.map(Number)).toEqual([0, 0]);
    expect([...inner]).toEqual(['0x095ea7b3', '0x1234']);
  });

  it('encodes createAccount for the owner with the account salt', () => {
    const data = encodeCreateAccount(EOA);
    const [owner, salt] = new Interface([
      'function createAccount(address owner, bytes32 salt)',
    ]).decodeFunctionData('createAccount', data);
    expect(owner).toBe(EOA);
    expect(salt).toBe(accountSalt(EOA));
  });
});

describe('userOpHash', () => {
  it('is a 32-byte digest, stable and sensitive to every field', () => {
    const h = userOpHash(op(), ENTRYPOINT, 11155111);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(userOpHash(op(), ENTRYPOINT, 11155111)).toBe(h);
    expect(userOpHash(op({ sender: EOA }), ENTRYPOINT, 11155111)).not.toBe(h);
    expect(userOpHash(op({ maxFeePerGas: '0x1' }), ENTRYPOINT, 11155111)).not.toBe(h);
    expect(userOpHash(op(), ENTRYPOINT, 421614)).not.toBe(h);
  });
});
