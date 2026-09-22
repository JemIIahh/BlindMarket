import { ethers } from 'ethers';
import { config } from '../config.js';
import { baseProvider } from './chain.js';

/**
 * Circle CCTP V2 chain identifiers. Deliberately separate from the
 * settlement chain keys (SettlementChainKey, services/settlementChains.ts;
 * TaskChain in services/taskChain.ts) — that type
 * belongs to the unrelated internal 0G<->Base marketplace-signer relay
 * ("bridge"). CCTP never touches 0G (no native USDC, no CCTP domain there —
 * see CLAUDE.md) and covers a broader, growable set of EVM chains.
 */
export type CctpChainKey =
  | 'base' | 'base-sepolia'
  | 'ethereum' | 'ethereum-sepolia'
  | 'arbitrum' | 'arbitrum-sepolia'
  | 'optimism' | 'optimism-sepolia'
  | 'arc-testnet';

export interface CctpChainConfig {
  chainKey: CctpChainKey;
  chainId: number;
  /** Circle CCTP domain id (Base = 6, Ethereum = 0 — NOT the EVM chain id). */
  domain: number;
  rpc: ethers.JsonRpcProvider;
  tokenMessengerAddress: string;
  messageTransmitterAddress: string;
  usdcAddress: string;
  isTestnet: boolean;
  label: string;
  /** Whether Circle offers Fast Transfer when this chain is the SOURCE of a
   *  burn. False on chains whose own finality is already fast (Arc). */
  supportsFastTransfer: boolean;
  /** USDC (6-dec raw) a burn from this chain must leave behind for gas.
   *  Non-zero only where gas is paid in USDC (Arc); 0n on ETH-gas chains. */
  usdcGasReserveRaw: bigint;
}

// Network tier = the Base network this deployment settles on
// (config.cctp.mainnet), not NODE_ENV — see config.ts for why.
const MAINNET_TIER = config.cctp.mainnet;

let ethereumProvider: ethers.JsonRpcProvider | null = null;
function getEthereumProvider(): ethers.JsonRpcProvider {
  if (!ethereumProvider) {
    ethereumProvider = new ethers.JsonRpcProvider(config.cctp.ethereumRpcUrl, config.cctp.ethereumChainId, {
      batchMaxCount: 1,
      staticNetwork: true,
    });
  }
  return ethereumProvider;
}

let arbitrumProvider: ethers.JsonRpcProvider | null = null;
function getArbitrumProvider(): ethers.JsonRpcProvider {
  if (!arbitrumProvider) {
    arbitrumProvider = new ethers.JsonRpcProvider(config.cctp.arbitrumRpcUrl, config.cctp.arbitrumChainId, {
      batchMaxCount: 1,
      staticNetwork: true,
    });
  }
  return arbitrumProvider;
}

let optimismProvider: ethers.JsonRpcProvider | null = null;
function getOptimismProvider(): ethers.JsonRpcProvider {
  if (!optimismProvider) {
    optimismProvider = new ethers.JsonRpcProvider(config.cctp.optimismRpcUrl, config.cctp.optimismChainId, {
      batchMaxCount: 1,
      staticNetwork: true,
    });
  }
  return optimismProvider;
}

let arcProvider: ethers.JsonRpcProvider | null = null;
function getArcProvider(): ethers.JsonRpcProvider {
  if (!arcProvider) {
    arcProvider = new ethers.JsonRpcProvider(config.cctp.arcRpcUrl, config.cctp.arcChainId, {
      batchMaxCount: 1,
      staticNetwork: true,
    });
  }
  return arcProvider;
}

/**
 * Built lazily (not at module load) so tests can construct providers only
 * when CCTP is actually exercised, and so a bad CCTP_ETHEREUM_RPC_URL never
 * breaks an import of this module for chains that don't need it.
 */
function buildChains(): Record<CctpChainKey, CctpChainConfig> {
  const { tokenMessengerAddress, messageTransmitterAddress } = config.cctp;
  return {
    base: {
      chainKey: 'base',
      chainId: 8453,
      domain: 6,
      rpc: baseProvider,
      tokenMessengerAddress,
      messageTransmitterAddress,
      usdcAddress: config.baseUsdcAddress,
      isTestnet: false,
      label: 'Base',
      supportsFastTransfer: true,
      usdcGasReserveRaw: 0n,
    },
    'base-sepolia': {
      chainKey: 'base-sepolia',
      chainId: 84532,
      domain: 6,
      rpc: baseProvider,
      tokenMessengerAddress,
      messageTransmitterAddress,
      usdcAddress: config.baseUsdcAddress,
      isTestnet: true,
      label: 'Base Sepolia',
      supportsFastTransfer: true,
      usdcGasReserveRaw: 0n,
    },
    ethereum: {
      chainKey: 'ethereum',
      chainId: 1,
      domain: 0,
      rpc: getEthereumProvider(),
      tokenMessengerAddress,
      messageTransmitterAddress,
      usdcAddress: config.cctp.ethereumUsdcAddress,
      isTestnet: false,
      label: 'Ethereum',
      supportsFastTransfer: true,
      usdcGasReserveRaw: 0n,
    },
    'ethereum-sepolia': {
      chainKey: 'ethereum-sepolia',
      chainId: 11155111,
      domain: 0,
      rpc: getEthereumProvider(),
      tokenMessengerAddress,
      messageTransmitterAddress,
      usdcAddress: config.cctp.ethereumUsdcAddress,
      isTestnet: true,
      label: 'Ethereum Sepolia',
      supportsFastTransfer: true,
      usdcGasReserveRaw: 0n,
    },
    arbitrum: {
      chainKey: 'arbitrum',
      chainId: 42161,
      domain: 3,
      rpc: getArbitrumProvider(),
      tokenMessengerAddress,
      messageTransmitterAddress,
      usdcAddress: config.cctp.arbitrumUsdcAddress,
      isTestnet: false,
      label: 'Arbitrum',
      supportsFastTransfer: true,
      usdcGasReserveRaw: 0n,
    },
    'arbitrum-sepolia': {
      chainKey: 'arbitrum-sepolia',
      chainId: 421614,
      domain: 3,
      rpc: getArbitrumProvider(),
      tokenMessengerAddress,
      messageTransmitterAddress,
      usdcAddress: config.cctp.arbitrumUsdcAddress,
      isTestnet: true,
      label: 'Arbitrum Sepolia',
      supportsFastTransfer: true,
      usdcGasReserveRaw: 0n,
    },
    optimism: {
      chainKey: 'optimism',
      chainId: 10,
      domain: 2,
      rpc: getOptimismProvider(),
      tokenMessengerAddress,
      messageTransmitterAddress,
      usdcAddress: config.cctp.optimismUsdcAddress,
      isTestnet: false,
      label: 'Optimism',
      supportsFastTransfer: true,
      usdcGasReserveRaw: 0n,
    },
    'optimism-sepolia': {
      chainKey: 'optimism-sepolia',
      chainId: 11155420,
      domain: 2,
      rpc: getOptimismProvider(),
      tokenMessengerAddress,
      messageTransmitterAddress,
      usdcAddress: config.cctp.optimismUsdcAddress,
      isTestnet: true,
      label: 'Optimism Sepolia',
      supportsFastTransfer: true,
      usdcGasReserveRaw: 0n,
    },
    // Testnet only — there is no Arc mainnet entry until its CCTP addresses
    // are checked on-chain (see config.ts). Same shared messenger/transmitter
    // pair: verified deployed at those addresses on Arc testnet
    // (localDomain() = 26).
    'arc-testnet': {
      chainKey: 'arc-testnet',
      chainId: config.cctp.arcChainId,
      domain: 26,
      rpc: getArcProvider(),
      tokenMessengerAddress,
      messageTransmitterAddress,
      usdcAddress: config.cctp.arcUsdcAddress,
      isTestnet: true,
      label: 'Arc Testnet',
      supportsFastTransfer: false,
      usdcGasReserveRaw: config.cctp.arcGasReserveRaw,
    },
  };
}

let chainsCache: Record<CctpChainKey, CctpChainConfig> | null = null;
function chains(): Record<CctpChainKey, CctpChainConfig> {
  if (!chainsCache) chainsCache = buildChains();
  return chainsCache;
}

export function isCctpConfigured(): boolean {
  // Every CCTP route and the poller need the cctp_transfers table. Without a
  // DATABASE_URL, getPool() is a silent no-op (inserts return no row), so a
  // transfer would 500 mid-flow — after the user already switched chains.
  // Report CCTP as unavailable instead, so /cctp/config hides bridging.
  return config.cctp.enabled
    && !!config.cctp.tokenMessengerAddress
    && !!config.cctp.messageTransmitterAddress
    && !!config.databaseUrl;
}

export function getCctpChain(chainKey: CctpChainKey): CctpChainConfig | null {
  if (!isCctpConfigured()) return null;
  return chains()[chainKey] ?? null;
}

/**
 * Mainnet and testnet chains are never mixed on a single CCTP transfer — the
 * running backend is always on one network tier (MAINNET_TIER, from its Base
 * chain), so only that tier's chains are ever offered.
 */
export function supportedCctpChains(): CctpChainConfig[] {
  if (!isCctpConfigured()) return [];
  return Object.values(chains()).filter((c) => c.isTestnet === !MAINNET_TIER);
}

export function isSupportedCctpChain(chainKey: string): chainKey is CctpChainKey {
  return supportedCctpChains().some((c) => c.chainKey === chainKey);
}

/** The settlement leg of the bridge — the chain Phase A burns from and the
 *  chain Phase B mints into (the user's Arc wallet). Arc testnet only: Arc
 *  mainnet has no CCTP entry yet (see config.ts). */
export function getSettlementCctpChain(): CctpChainConfig | null {
  return getCctpChain('arc-testnet');
}
