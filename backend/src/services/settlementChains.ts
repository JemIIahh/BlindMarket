/**
 * The chains BlindMarket settles tasks on, as data.
 *
 * Each per-chain fact the backend used to hard-code as `chain === 'base'`
 * branches lives in one entry here: tier, settlement token and its decimals,
 * the env vars that configure the chain, withdraw gas numbers, and whether the
 * on-chain worker is an ERC-4337 account. A new settlement chain (Arc is next)
 * is a new key, its builder, and its providers and contracts in
 * chainRuntime.ts. Maps keyed by SettlementChainKey (the builders here,
 * chainRuntime.ts, taskChain.ts, escrowFingerprint.ts, disputeKeys.ts) fail
 * to compile until the new key has an entry in each.
 *
 * This module imports only config, so any module can read it without opening
 * RPC providers. Entries are built on every call, not at import, because tests
 * change `config` between cases.
 */
import { config } from '../config.js';

export const SETTLEMENT_CHAIN_KEYS = ['0g', 'base'] as const;
export type SettlementChainKey = (typeof SETTLEMENT_CHAIN_KEYS)[number];

export interface SettlementUnit {
  symbol: 'USDC' | '0G';
  decimals: 6 | 18;
}

export const USDC_UNIT: SettlementUnit = { symbol: 'USDC', decimals: 6 };
export const NATIVE_0G_UNIT: SettlementUnit = { symbol: '0G', decimals: 18 };

/** What an escrow task's `token` is when it is funded in the native coin. */
export const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface SettlementChainConfig {
  key: SettlementChainKey;
  /** The chain's name in logs and messages. */
  label: string;
  chainId: number;
  /** Each chain has its own tier: production pairs 0G mainnet with Base Sepolia. */
  tier: 'mainnet' | 'testnet';
  /** The contracts/ hardhat network that operates on this chain. */
  hardhatNetwork: string;
  /** This deployment's escrow, or null when it does not settle here (unset or the zero address). */
  escrowAddress: string | null;
  escrowEnv: string;
  signerEnv: string;
  /** Env var naming the block the indexer starts from on an empty Redis. */
  deploymentBlockEnv: string;
  /** The token tasks on this chain are paid in. */
  token: {
    kind: 'native' | 'erc20';
    /** NATIVE_TOKEN_ADDRESS for a native token; null when an ERC-20 is not configured. */
    address: string | null;
    unit: SettlementUnit;
  };
  gas: {
    /** The native coin, as the withdraw endpoint names it. */
    symbol: string;
    /**
     * True when the native gas coin is the same asset as an ERC-20 settlement
     * token (Arc: USDC is the gas coin, 18 decimals natively and 6 through its
     * ERC-20). address(0) must then never be booked as the settlement token.
     * False when the settlement token is the native coin itself (0G) or gas
     * is a different asset (Base: ETH).
     */
    nativeIsSettlementToken: boolean;
    /** Native balance a native withdraw leaves behind to pay its own gas. */
    withdrawReserveWei: bigint;
    /** Native balance needed before an ERC-20 withdraw is attempted. */
    withdrawMinWei: bigint;
  };
  /**
   * CAIP-2 id of this chain for the Privy relay, or null when the relay does
   * not serve the chain. routes/tx.ts keeps its own table keyed by the
   * `chain` string a client sends, which is not this deployment's chain.
   */
  relayCaip2: string | null;
  /** The escrow records an agent's ERC-4337 smart account as the worker, not its EOA. */
  aa: boolean;
}

const ZERO_G_MAINNET_CHAIN_ID = 16661;
const BASE_MAINNET_CHAIN_ID = 8453;

function isZeroAddress(address: string): boolean {
  return /^0x0{40}$/i.test(address);
}

/** A configured address, or null when it is unset or the zero address. */
function addressOrNull(address: string | undefined): string | null {
  return address && !isZeroAddress(address) ? address : null;
}

const BUILDERS: { readonly [K in SettlementChainKey]: () => SettlementChainConfig } = {
  '0g': () => {
    const mainnet = config.ogChainId === ZERO_G_MAINNET_CHAIN_ID;
    return {
      key: '0g',
      label: '0G',
      chainId: config.ogChainId,
      tier: mainnet ? 'mainnet' : 'testnet',
      hardhatNetwork: mainnet ? '0g-mainnet' : '0g-testnet',
      escrowAddress: addressOrNull(config.blindEscrowAddress),
      escrowEnv: 'BLIND_ESCROW_ADDRESS',
      signerEnv: 'MARKETPLACE_SIGNER_PRIVATE_KEY',
      deploymentBlockEnv: 'ESCROW_DEPLOYMENT_BLOCK',
      token: { kind: 'native', address: NATIVE_TOKEN_ADDRESS, unit: NATIVE_0G_UNIT },
      gas: {
        symbol: '0G',
        nativeIsSettlementToken: false,
        withdrawReserveWei: 1_000_000_000_000_000n, // 0.001 0G
        withdrawMinWei: 200_000_000_000_000n, // 0.0002 0G
      },
      relayCaip2: null,
      aa: false,
    };
  },
  base: () => {
    const mainnet = config.baseChainId === BASE_MAINNET_CHAIN_ID;
    return {
      key: 'base',
      label: 'Base',
      chainId: config.baseChainId,
      tier: mainnet ? 'mainnet' : 'testnet',
      hardhatNetwork: mainnet ? 'base' : 'base-sepolia',
      escrowAddress: addressOrNull(config.baseEscrowAddress),
      escrowEnv: 'BASE_ESCROW_ADDRESS',
      signerEnv: 'BASE_MARKETPLACE_SIGNER_PRIVATE_KEY',
      deploymentBlockEnv: 'BASE_ESCROW_DEPLOYMENT_BLOCK',
      token: { kind: 'erc20', address: config.baseUsdcAddress || null, unit: USDC_UNIT },
      // Not calibrated against observed Base gas costs yet; recheck before
      // Base mainnet.
      gas: {
        symbol: 'ETH',
        nativeIsSettlementToken: false,
        withdrawReserveWei: 300_000_000_000_000n, // 0.0003 ETH
        withdrawMinWei: 50_000_000_000_000n, // 0.00005 ETH
      },
      relayCaip2: `eip155:${config.baseChainId}`,
      aa: true,
    };
  },
};

export function isSettlementChainKey(value: unknown): value is SettlementChainKey {
  return typeof value === 'string' && (SETTLEMENT_CHAIN_KEYS as readonly string[]).includes(value);
}

/** The entry for `key`, built from the current config. Throws on a key this code does not know. */
export function settlementChainConfig(key: SettlementChainKey): SettlementChainConfig {
  if (!isSettlementChainKey(key)) throw new Error(`unknown settlement chain ${String(key)}`);
  return BUILDERS[key]();
}

/** Every chain this code knows, whether or not this deployment settles on it. */
export function settlementChainConfigs(): SettlementChainConfig[] {
  return SETTLEMENT_CHAIN_KEYS.map((key) => settlementChainConfig(key));
}

/** The chains this deployment has an escrow on. */
export function configuredChainKeys(): SettlementChainKey[] {
  return settlementChainConfigs()
    .filter((entry) => entry.escrowAddress !== null)
    .map((entry) => entry.key);
}

/** What is wrong with the entries; empty when they are consistent. */
export function registryProblems(entries: readonly SettlementChainConfig[]): string[] {
  const problems: string[] = [];
  for (const { key, token, gas } of entries) {
    const native = token.address !== null && isZeroAddress(token.address);
    if ((token.kind === 'native') !== native) {
      problems.push(
        `${key}: token kind is ${token.kind} but its address is ${token.address ?? 'unset'}; ` +
          `a native token is address(0) and only a native token is`,
      );
    }
    if (gas.nativeIsSettlementToken && (token.kind !== 'erc20' || token.address === null || native)) {
      problems.push(
        `${key}: the native gas coin is the settlement asset, so the settlement token must be its ERC-20 ` +
          `at a non-zero address, not ${token.address ?? 'unset'}`,
      );
    }
    if (token.unit.decimals !== 6 && token.unit.decimals !== 18) {
      problems.push(`${key}: settlement token decimals must be 6 or 18, not ${String(token.unit.decimals)}`);
    }
  }
  return problems;
}

/** Throws when the entries are inconsistent. Called at boot. */
export function assertRegistryInvariants(entries: readonly SettlementChainConfig[]): void {
  const problems = registryProblems(entries);
  if (problems.length > 0) {
    throw new Error(`Invalid settlement chain registry: ${problems.join('; ')}`);
  }
}
