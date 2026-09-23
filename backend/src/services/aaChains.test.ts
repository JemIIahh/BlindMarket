import { describe, it, expect, vi, afterEach } from 'vitest';
import { AA_ADDRESSES } from '../contractAddresses.js';
import { getChainAA } from './aaChains.js';

/**
 * services/aaChains.ts — per-chain paymaster/factory resolution for the
 * external-wallet USDC-gas path. Generated records are the fallback;
 * AA_<CHAIN>_PAYMASTER-style env vars override per field.
 */

const ADDR = /^0x[0-9a-fA-F]{40}$/;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getChainAA', () => {
  it('returns the generated record where one exists', () => {
    const gen = AA_ADDRESSES['base-sepolia' as keyof typeof AA_ADDRESSES];
    const aa = getChainAA('base-sepolia');
    expect(aa).toEqual({
      paymaster: gen.USDCPaymaster,
      factory: gen.BlindAccountFactory,
      entrypoint: gen.EntryPoint,
      usdc: gen.USDC,
    });
    for (const v of Object.values(aa!)) expect(v).toMatch(ADDR);
  });

  it('returns null where no AA exists (Arc) or the chain is unknown', () => {
    expect(getChainAA('arc-testnet')).toBeNull();
    expect(getChainAA('nope')).toBeNull();
  });

  it('prefers env overrides per field, falling back per field', () => {
    const paymaster = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    vi.stubEnv('AA_BASE_SEPOLIA_PAYMASTER', paymaster);
    const aa = getChainAA('base-sepolia');
    expect(aa!.paymaster).toBe(paymaster);
    expect(aa!.factory).toBe(
      (AA_ADDRESSES as Record<string, Record<string, string>>)['base-sepolia'].BlindAccountFactory,
    );
  });

  it('treats an empty override as unset', () => {
    vi.stubEnv('AA_BASE_SEPOLIA_PAYMASTER', '  ');
    expect(getChainAA('base-sepolia')!.paymaster).toBe(
      (AA_ADDRESSES as Record<string, Record<string, string>>)['base-sepolia'].USDCPaymaster,
    );
  });
});
