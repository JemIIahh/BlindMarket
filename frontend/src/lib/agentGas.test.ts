import { describe, expect, it } from 'vitest';
import { formatMinGas, minGasBalance } from './agentGas';

const GWEI = 10n ** 9n;

describe('minGasBalance', () => {
  it("is one worker transaction's gas budget, in the 6-decimal USDC the agent page shows", () => {
    // Arc mainnet, read 2026-10-02: base fee 20 gwei, so ethers' maxFeePerGas is 40 gwei.
    expect(minGasBalance(40n * GWEI, 6)).toBe(8_000n); // 0.008 USDC
    // Arc testnet the same day: 45 gwei.
    expect(minGasBalance(45n * GWEI, 6)).toBe(9_000n);
  });

  it('rounds a fraction of a unit up', () => {
    expect(minGasBalance(40n * GWEI + 1n, 6)).toBe(8_001n);
  });

  it('leaves an 18-decimal amount as it is', () => {
    expect(minGasBalance(40n * GWEI, 18)).toBe(200_000n * 40n * GWEI);
  });
});

describe('formatMinGas', () => {
  it('shows the amount plainly, to at most 4 decimals, rounded up', () => {
    expect(formatMinGas(8_000n, 6)).toBe('0.008');
    expect(formatMinGas(12_000n, 6)).toBe('0.012');
    expect(formatMinGas(13_500n, 6)).toBe('0.0135');
    expect(formatMinGas(12_001n, 6)).toBe('0.0121');
    expect(formatMinGas(1_000_000n, 6)).toBe('1');
  });
});
