import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTRACT_ADDRESSES } from './contractAddresses';

/**
 * The app's Arc network follows VITE_NETWORK, just like 0G and Base.
 * mainnet → Arc mainnet (5042), testnet → Arc testnet (5042002). The build is
 * single-tier now; no chain-id env overrides remain. Each case re-imports the
 * config under its own env.
 */

// '' rather than unset, so a developer's local env can't leak in.
const CLEARED = {
  VITE_NETWORK: '',
  VITE_BASE_RPC_URL: '',
  VITE_ARC_RPC_URL: '',
  VITE_ARC_ESCROW_ADDRESS: '',
  VITE_ARC_USDC_ADDRESS: '',
  VITE_ARC_AGENT_FACTORY_ADDRESS: '',
};

async function load(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries({ ...CLEARED, ...env })) vi.stubEnv(key, value);
  return { ...(await import('./constants')), ...(await import('./chains')) };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const TESTNET = CONTRACT_ADDRESSES.arcTestnet;
const ids = (chains: readonly { id: number }[]) => chains.map((c) => c.id);

describe('Arc network', () => {
  it('is Arc testnet with no VITE_NETWORK, as a local testnet build', async () => {
    const c = await load();
    expect(c.ARC_CHAIN_ID).toBe(5042002);
    expect(c.arcChain).toMatchObject({ id: 5042002, name: 'Arc Testnet', rpcUrls: { default: { http: ['https://rpc.testnet.arc.io'] } } });
    expect(c.ARC_RPC_URL).toBe('https://rpc.testnet.arc.io');
    expect(c.SETTLEMENT_CCTP_CHAIN_KEY).toBe('arc-testnet');
    expect(c.ARC_CHAIN_CONFIG).toMatchObject({ chainId: '0x4cef52', chainName: 'Arc Testnet', blockExplorerUrls: ['https://testnet.arcscan.app'] });
    expect(c.ARC_AGENT_FACTORY_ADDRESS).toBe(TESTNET.agentFactory);
    expect(c.ARC_ESCROW_ADDRESS).toBe(TESTNET.blindEscrow);
    // Arc, then the testnet CCTP sources ending in the settlement Base Sepolia.
    expect(ids(c.privySupportedChains)).toEqual([5042002, 11155111, 421614, 11155420, 80002, 84532]);
  });

  it('moves with VITE_NETWORK: mainnet puts Arc on mainnet too', async () => {
    const c = await load({ VITE_NETWORK: 'mainnet' });
    expect(c.BASE_CHAIN_ID).toBe(8453);
    expect(c.ARC_CHAIN_ID).toBe(5042);
    expect(c.arcChain.id).toBe(5042);
    expect(c.SETTLEMENT_CCTP_CHAIN_KEY).toBe('arc');
    // CCTP follows Arc, so its sources go mainnet.
    expect(ids(c.cctpSourceChains)).toEqual([1, 42161, 137, 8453]);
    expect(ids(c.privySupportedChains)).toEqual([5042, 1, 42161, 137, 8453]);
  });

  it('is Arc mainnet with VITE_NETWORK=mainnet, next to Base mainnet', async () => {
    const c = await load({ VITE_NETWORK: 'mainnet' });
    expect(c.arcChain).toMatchObject({
      id: 5042,
      name: 'Arc',
      nativeCurrency: { symbol: 'USDC', decimals: 18 },
      rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
      blockExplorers: { default: { url: 'https://explorer.arc.io' } },
    });
    expect(c.ARC_CHAIN_CONFIG).toMatchObject({ chainId: '0x13b2', chainName: 'Arc', blockExplorerUrls: ['https://explorer.arc.io'] });
    expect(c.SETTLEMENT_CCTP_CHAIN_KEY).toBe('arc');
    // Never the testnet contracts: a deploy fee sent there would be lost.
    expect(c.ARC_AGENT_FACTORY_ADDRESS).not.toBe(TESTNET.agentFactory);
    expect(c.ARC_ESCROW_ADDRESS).not.toBe(TESTNET.blindEscrow);
  });

  it('reads through a keyed VITE_ARC_RPC_URL, but copyable text gets the public RPC', async () => {
    const c = await load({ VITE_ARC_RPC_URL: 'https://arc.example/v1/secret-key' });
    expect(c.ARC_RPC_URL).toBe('https://arc.example/v1/secret-key');
    expect(c.arcChain.rpcUrls.default.http).toEqual(['https://arc.example/v1/secret-key']);
    expect(c.ARC_PUBLIC_RPC_URL).toBe('https://rpc.testnet.arc.io');
    expect(c.arcPublicRpcUrl(5042)).toBe('https://rpc.mainnet.arc.io');
    expect(c.arcPublicRpcUrl(5042002)).toBe('https://rpc.testnet.arc.io');
  });
});
