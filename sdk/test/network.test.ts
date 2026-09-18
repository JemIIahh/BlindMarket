import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors/index.js';
import { networks, resolveNetwork, type Network } from '../src/network/index.js';

describe('networks', () => {
  it('testnet preset matches 0G Galileo', () => {
    expect(networks.testnet.chainId).toBe(16602);
    expect(networks.testnet.contracts.escrow).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(networks.testnet.contracts.registry).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(networks.testnet.contracts.reputation).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(networks.testnet.contracts.usdc).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(networks.testnet.rpc.length).toBeGreaterThan(0);
    expect(networks.testnet.indexer).toBeTruthy();
    expect(networks.testnet.broker).toBeTruthy();
  });

  it('testnet addresses match contracts/deployments/0g-testnet.json', () => {
    expect(networks.testnet.contracts.escrow).toBe('0xFd4F93F5A7BE144c405D1D8fbEC63Fb776207681');
    expect(networks.testnet.contracts.registry).toBe('0xeE52d780A47F77E8a4a1cEb236e3C65A48FbD828');
    expect(networks.testnet.contracts.reputation).toBe('0x4A6374Fae37E19E69ba43E7cf6994AC15F63256e');
    expect(networks.testnet.contracts.usdc).toBe('0x317227efcA18D004E12CA8046AEf7E1597458F25');
  });

  it('resolveNetwork accepts a preset name', () => {
    const n = resolveNetwork('testnet');
    expect(n.chainId).toBe(16602);
    expect(n.name).toBe('0g-galileo-testnet');
  });

  it('resolveNetwork rejects unknown preset with ConfigError', () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional type escape to test runtime error path
    expect(() => resolveNetwork('nope' as any)).toThrow(ConfigError);
  });

  it('resolveNetwork passes through a custom network object', () => {
    const custom: Network = {
      name: 'localhost',
      chainId: 1337n,
      rpc: ['http://localhost:8545'],
      contracts: {
        escrow: '0x0000000000000000000000000000000000000001',
        registry: '0x0000000000000000000000000000000000000002',
        reputation: '0x0000000000000000000000000000000000000003',
        usdc: '0x0000000000000000000000000000000000000004',
      },
      indexer: '',
      broker: '',
    };
    const resolved = resolveNetwork(custom);
    expect(resolved).toBe(custom);
    expect(resolved.chainId).toBe(1337n);
  });
});
