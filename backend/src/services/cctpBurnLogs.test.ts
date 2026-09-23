import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { DEPOSIT_FOR_BURN_ABI, logsContainBurn, addressToBytes32 } from './cctp.js';

/**
 * services/cctp.ts logsContainBurn — the /confirm bundle path proves a
 * UserOp-submitted burn from receipt logs (the L1 tx targets the EntryPoint,
 * so tx.to/calldata checks can't apply). Fixtures are encoded with the real
 * event fragment, so a wrong field order fails here instead of in prod.
 */

const MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const DEPOSITOR = '0x3333333333333333333333333333333333333333';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const AMOUNT = 10_000_000n;
const DEST_DOMAIN = 26;

const iface = new ethers.Interface(DEPOSIT_FOR_BURN_ABI);

function burnLog(overrides: {
  messenger?: string;
  depositor?: string;
  amount?: bigint;
  recipient?: string;
  destDomain?: number;
} = {}) {
  const { topics, data } = iface.encodeEventLog('DepositForBurn', [
    7n, // nonce
    USDC, // burnToken
    overrides.amount ?? AMOUNT,
    overrides.depositor ?? DEPOSITOR,
    addressToBytes32(overrides.recipient ?? RECIPIENT),
    overrides.destDomain ?? DEST_DOMAIN,
    addressToBytes32(MESSENGER), // destinationTokenMessenger
    ethers.ZeroHash, // destinationCaller
    1000n, // maxFee
    1000, // minFinalityThreshold
  ]);
  return {
    address: overrides.messenger ?? MESSENGER,
    topics: [...topics],
    data,
  };
}

const expected = {
  messenger: MESSENGER,
  depositor: DEPOSITOR,
  amount: AMOUNT,
  mintRecipient: addressToBytes32(RECIPIENT),
  destDomain: DEST_DOMAIN,
};

describe('logsContainBurn', () => {
  it('finds the expected burn among unrelated logs', () => {
    const logs = [
      { address: USDC, topics: [ethers.id('Transfer(address,address,uint256)')], data: '0x' },
      burnLog(),
    ];
    expect(logsContainBurn(logs, expected)).toBe(true);
  });

  it('rejects a burn from another depositor, amount, recipient, domain or messenger', () => {
    expect(logsContainBurn([burnLog({ depositor: RECIPIENT })], expected)).toBe(false);
    expect(logsContainBurn([burnLog({ amount: AMOUNT + 1n })], expected)).toBe(false);
    expect(logsContainBurn([burnLog({ recipient: DEPOSITOR })], expected)).toBe(false);
    expect(logsContainBurn([burnLog({ destDomain: 6 })], expected)).toBe(false);
    expect(logsContainBurn([burnLog({ messenger: USDC })], expected)).toBe(false);
  });

  it('skips undecodable logs instead of throwing', () => {
    const bad = burnLog();
    bad.topics = [bad.topics[0]]; // wrong arity for the fragment
    expect(logsContainBurn([bad], expected)).toBe(false);
    expect(logsContainBurn([], expected)).toBe(false);
  });
});
