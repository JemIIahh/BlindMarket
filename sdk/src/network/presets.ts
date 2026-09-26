import type { Network } from '../chain/domain-types.js';

/**
 * Known-good network presets. Addresses pinned per SDK version so upgrading
 * the SDK cannot silently move contracts under a consumer.
 */

export type NetworkName =
  | 'testnet'       // deprecated alias → og-testnet
  | 'og-testnet'
  | 'og-mainnet';

export const networks = {
  // ── 0G EVM chains ─────────────────────────────────────────────────────

  'og-testnet': {
    name: '0g-galileo-testnet',
    chainType: 'evm' as const,
    chainId: 16602,
    rpc: ['https://evmrpc-testnet.0g.ai'],
    contracts: {
      escrow: '0xFd4F93F5A7BE144c405D1D8fbEC63Fb776207681',
      registry: '0xeE52d780A47F77E8a4a1cEb236e3C65A48FbD828',
      reputation: '0x4A6374Fae37E19E69ba43E7cf6994AC15F63256e',
      usdc: '0x317227efcA18D004E12CA8046AEf7E1597458F25',
    },
    indexer: 'https://indexer-storage-testnet-turbo.0g.ai',
    broker: 'https://broker.testnet.0g.ai',
    explorer: 'https://chainscan-galileo.0g.ai',
  },

  'og-mainnet': {
    name: '0g-mainnet',
    chainType: 'evm' as const,
    chainId: 16661,
    rpc: ['https://0g-rpc.publicnode.com'],
    contracts: {
      escrow: '0x3d0374963DaaD43e31d42373eb11156A8e8ce2Ff',
      registry: '0x9CCF9c196006B573FaA9C9c9CebDd1296dbd5cE0',
      reputation: '0x3af9232009C5da30AdA366B6E09849A040162A1a',
      usdc: '0x0000000000000000000000000000000000000000',
    },
    indexer: 'https://indexer-storage-turbo.0g.ai',
    broker: 'https://broker.0g.ai',
    explorer: 'https://chainscan.0g.ai',
  },

  // ── Backward-compat alias ──────────────────────────────────────────────
  // Kept so existing code referencing 'testnet' doesn't break.

  testnet: {
    name: '0g-galileo-testnet',
    chainType: 'evm' as const,
    chainId: 16602,
    rpc: ['https://evmrpc-testnet.0g.ai'],
    contracts: {
      escrow: '0xFd4F93F5A7BE144c405D1D8fbEC63Fb776207681',
      registry: '0xeE52d780A47F77E8a4a1cEb236e3C65A48FbD828',
      reputation: '0x4A6374Fae37E19E69ba43E7cf6994AC15F63256e',
      usdc: '0x317227efcA18D004E12CA8046AEf7E1597458F25',
    },
    indexer: 'https://indexer-storage-testnet-turbo.0g.ai',
    broker: 'https://broker.testnet.0g.ai',
    explorer: 'https://chainscan-galileo.0g.ai',
  },
} as const satisfies Record<NetworkName, Network>;