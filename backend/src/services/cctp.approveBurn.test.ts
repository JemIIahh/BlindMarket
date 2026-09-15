import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * executeApproveAndDepositForBurn — Phase A's approve-then-burn. The burn
 * pulls USDC via transferFrom, so it must only ever be sent after an approve
 * that was actually mined, and (because Base Sepolia's RPC serves stale reads
 * right after a write) with its nonce/gas pinned rather than looked up.
 * ethers.Contract is faked so the call ORDER and the overrides are observable.
 */

const { calls, approveReceiptRef, approveWaitErrorRef, burnArgsRef } = vi.hoisted(() => ({
  calls: [] as string[],
  approveReceiptRef: { current: { status: 1 } as { status: number } | null },
  approveWaitErrorRef: { current: null as Error | null },
  burnArgsRef: { current: null as unknown[] | null },
}));

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  class FakeContract {
    constructor(private readonly addr: string) {}
    approve = vi.fn(async (spender: string, amount: bigint) => {
      calls.push(`approve:${this.addr}:${spender}:${amount}`);
      return {
        hash: '0xapprove',
        nonce: 7,
        wait: async () => {
          if (approveWaitErrorRef.current) throw approveWaitErrorRef.current;
          calls.push('approve:mined');
          return approveReceiptRef.current;
        },
      };
    });
    depositForBurnWithHook = vi.fn(async (...args: unknown[]) => {
      calls.push(`burn:${this.addr}`);
      burnArgsRef.current = args;
      return { hash: '0xburn' };
    });
  }
  return { ...actual, Contract: FakeContract, ethers: { ...actual.ethers, Contract: FakeContract } };
});

import { executeApproveAndDepositForBurn, CCTP_BURN_GAS_LIMIT } from './cctp.js';
import type { CctpChainConfig } from './cctpChains.js';

const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const SOURCE: CctpChainConfig = {
  chainKey: 'base-sepolia',
  chainId: 84532,
  domain: 6,
  rpc: {} as never,
  tokenMessengerAddress: TOKEN_MESSENGER,
  messageTransmitterAddress: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
  usdcAddress: USDC,
  isTestnet: true,
  label: 'Base Sepolia',
  supportsFastTransfer: true,
  usdcGasReserveRaw: 0n,
};

const PARAMS = {
  amountRaw: 1_000_000n,
  destinationDomain: 26,
  mintRecipient: '0x2222222222222222222222222222222222222222',
  maxFeeRaw: 20_000n,
  minFinalityThreshold: 1000,
};

beforeEach(() => {
  calls.length = 0;
  approveReceiptRef.current = { status: 1 };
  approveWaitErrorRef.current = null;
  burnArgsRef.current = null;
});

describe('executeApproveAndDepositForBurn', () => {
  it('approves exactly the amount on USDC, waits for it to be mined, THEN burns on TokenMessengerV2', async () => {
    const result = await executeApproveAndDepositForBurn(SOURCE, {} as never, PARAMS);

    expect(calls).toEqual([
      `approve:${USDC}:${TOKEN_MESSENGER}:1000000`,
      'approve:mined',
      `burn:${TOKEN_MESSENGER}`,
    ]);
    expect(result).toEqual({ approveTxHash: '0xapprove', txHash: '0xburn' });
  });

  it('pins the burn to nonce = approve nonce + 1 and a fixed gas limit (no stale-RPC lookups)', async () => {
    await executeApproveAndDepositForBurn(SOURCE, {} as never, PARAMS);

    const overrides = burnArgsRef.current?.at(-1);
    expect(overrides).toEqual({ nonce: 8, gasLimit: CCTP_BURN_GAS_LIMIT });
  });

  it('never sends the burn when the approve reverted', async () => {
    approveReceiptRef.current = { status: 0 };
    await expect(executeApproveAndDepositForBurn(SOURCE, {} as never, PARAMS)).rejects.toThrow(/approve/);
    expect(calls.some((c) => c.startsWith('burn:'))).toBe(false);
  });

  it('never sends the burn when waiting on the approve fails', async () => {
    approveWaitErrorRef.current = new Error('transaction execution reverted');
    await expect(executeApproveAndDepositForBurn(SOURCE, {} as never, PARAMS)).rejects.toThrow(/reverted/);
    expect(calls.some((c) => c.startsWith('burn:'))).toBe(false);
  });
});
