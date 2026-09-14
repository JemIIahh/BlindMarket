import { ethers } from 'ethers';
import { config } from '../config.js';
import { baseProvider } from './chain.js';

/**
 * Circle CCTP V2 chain identifiers. Deliberately separate from the existing
 * `'0g' | 'base'` TaskChain union (services/a2aSettlement.ts) — that type
 * belongs to the unrelated internal 0G<->Base marketplace-signer relay
 * ("bridge"). CCTP never touches 0G (no native USDC, no CCTP domain there —
 * see CLAUDE.md) and covers a broader, growable set of EVM chains.
 */
export type CctpChainKey =
  | 'base' | 'base-sepolia'
  | 'ethereum' | 'ethereum-sepolia'
  | 'arbitrum' | 'arbitrum-sepolia'
  | 'optimism' | 'optimism-sepolia';

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
}

const IS_PROD = config.nodeEnv === 'production';

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
    },
  };
}

let chainsCache: Record<CctpChainKey, CctpChainConfig> | null = null;
function chains(): Record<CctpChainKey, CctpChainConfig> {
  if (!chainsCache) chainsCache = buildChains();
  return chainsCache;
}

export function isCctpConfigured(): boolean {
  return config.cctp.enabled && !!config.cctp.tokenMessengerAddress && !!config.cctp.messageTransmitterAddress;
}

export function getCctpChain(chainKey: CctpChainKey): CctpChainConfig | null {
  if (!isCctpConfigured()) return null;
  return chains()[chainKey] ?? null;
}

/**
 * Mainnet and testnet chains are never mixed on a single CCTP transfer — the
 * running backend is always on one network tier (IS_PROD), so only that
 * tier's chains are ever offered.
 */
export function supportedCctpChains(): CctpChainConfig[] {
  if (!isCctpConfigured()) return [];
  return Object.values(chains()).filter((c) => c.isTestnet === !IS_PROD);
}

export function isSupportedCctpChain(chainKey: string): chainKey is CctpChainKey {
  return supportedCctpChains().some((c) => c.chainKey === chainKey);
}

/** Base leg for the running network tier — Phase A's source chain and the
 *  chain Phase B ultimately mints into (the user's Base Privy wallet). */
export function getBaseCctpChain(): CctpChainConfig | null {
  return getCctpChain(IS_PROD ? 'base' : 'base-sepolia');
}
