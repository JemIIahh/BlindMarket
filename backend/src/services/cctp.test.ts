import { describe, it, expect, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';
import {
  addressToBytes32,
  buildDepositForBurnCall,
  decodeDepositForBurnCalldata,
  estimateMaxFeeRaw,
  FAST_TRANSFER_FINALITY_THRESHOLD,
} from './cctp.js';
import type { CctpChainConfig } from './cctpChains.js';

const FAKE_SOURCE: CctpChainConfig = {
  chainKey: 'base-sepolia',
  chainId: 84532,
  domain: 6,
  rpc: {} as never,
  tokenMessengerAddress: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
  messageTransmitterAddress: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
  usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  isTestnet: true,
  label: 'Base Sepolia',
};

describe('addressToBytes32', () => {
  it('left-pads a 20-byte address to 32 bytes', () => {
    const padded = addressToBytes32('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(padded).toHaveLength(66); // 0x + 64 hex chars
    expect(padded.toLowerCase().endsWith('036cbd53842c5426634e7929541ec2318f3dcf7e')).toBe(true);
  });
});

describe('buildDepositForBurnCall / decodeDepositForBurnCalldata round-trip', () => {
  it('decodes exactly what was encoded', () => {
    const params = {
      amountRaw: 5_000_000n,
      destinationDomain: 0,
      mintRecipient: '0x2222222222222222222222222222222222222222',
      maxFeeRaw: 1234n,
      minFinalityThreshold: FAST_TRANSFER_FINALITY_THRESHOLD,
    };
    const { to, data } = buildDepositForBurnCall(FAKE_SOURCE, params);
    expect(to).toBe(FAKE_SOURCE.tokenMessengerAddress);

    const decoded = decodeDepositForBurnCalldata(data);
    expect(decoded.amount).toBe(params.amountRaw);
    expect(decoded.destinationDomain).toBe(params.destinationDomain);
    expect(decoded.mintRecipient.toLowerCase()).toBe(addressToBytes32(params.mintRecipient).toLowerCase());
    expect(decoded.burnToken.toLowerCase()).toBe(FAKE_SOURCE.usdcAddress.toLowerCase());
    expect(decoded.destinationCaller).toBe(ethers.ZeroHash); // permissionless — anyone may relay
    expect(decoded.maxFee).toBe(params.maxFeeRaw);
    expect(decoded.minFinalityThreshold).toBe(params.minFinalityThreshold);
  });
});

describe('estimateMaxFeeRaw', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('computes bps fee + forwardFee.medium from the Iris fee-quote response', async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify([
          { finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 90, medium: 110, high: 160 } },
          { finalityThreshold: 2000, minimumFee: 0 },
        ]),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    // amount 1,000,000 (1 USDC) * 1 bps (0.01%) = 100, + forwardFee.medium 110 = 210
    const fee = await estimateMaxFeeRaw('https://iris-api-sandbox.circle.com', 6, 0, 1_000_000n, FAST_TRANSFER_FINALITY_THRESHOLD);
    expect(fee).toBe(210n);
  });

  it('throws when Iris returns no matching quote', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;
    await expect(
      estimateMaxFeeRaw('https://iris-api-sandbox.circle.com', 6, 0, 1_000_000n, FAST_TRANSFER_FINALITY_THRESHOLD),
    ).rejects.toThrow(/no fee quote/);
  });
});
