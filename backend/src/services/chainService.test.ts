import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** logChainConfig prints what the settlement chain registry holds. */

const cfg = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('../config.js', () => ({ config: cfg }));

const { logChainConfig } = await import('./chainService.js');

let lines: string[];

beforeEach(() => {
  for (const key of Object.keys(cfg)) delete cfg[key];
  Object.assign(cfg, {
    baseChainId: 84532,
    baseRpcUrl: 'https://sepolia.base.org',
    baseEscrowAddress: '0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf',
    arcChainId: 5042002,
    arcRpcUrl: 'https://rpc.testnet.arc.io',
    arcEscrowAddress: '0x3600000000000000000000000000000000000000',
  });
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logChainConfig', () => {
  it('prints every chain, then the chains this deployment settles on', () => {
    Object.assign(cfg, { arcEscrowAddress: '' });
    logChainConfig();
    expect(lines).toEqual([
      '[chain] Base — chainId: 84532 (testnet), RPC: https://sepolia.base.org, escrow: 0xCca5ab873158b888158AD9Dc36fb4Ee683eFbEBf',
      '[chain] Arc — chainId: 5042002 (testnet), RPC: https://rpc.testnet.arc.io, escrow: (not configured)',
      '[chain] Settles on: Base',
    ]);
  });

  it('marks a chain with no escrow, the zero address included', () => {
    Object.assign(cfg, { baseEscrowAddress: '0x0000000000000000000000000000000000000000', arcEscrowAddress: '' });
    logChainConfig();
    expect(lines).toEqual([
      '[chain] Base — chainId: 84532 (testnet), RPC: https://sepolia.base.org, escrow: (not configured)',
      '[chain] Arc — chainId: 5042002 (testnet), RPC: https://rpc.testnet.arc.io, escrow: (not configured)',
      '[chain] Settles on: (no chain has an escrow)',
    ]);
  });
});