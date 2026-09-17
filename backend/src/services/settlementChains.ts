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
import { chainTier, type SettlementTier } from './settlementTier.js';

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
  /**
   * The JSON-RPC endpoint this backend reads the chain through. A provider
   * URL can carry an API key: it may be logged, but no route returns it.
   */
  rpcUrl: string;
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
   * not serve the chain. The relay (relayChains.ts) is keyed by the `chain`
   * string a client sends, and its fixed names win: there 'base' means Base
   * mainnet (eip155:8453) whatever this deployment runs on, while this field
   * follows BASE_CHAIN_ID (eip155:84532 in production today). This id only
   * adds a chain's own key where no fixed name has it, and picks the name
   * /health/bridge tells clients to send.
   */
  relayCaip2: string | null;
  /** The escrow records an agent's ERC-4337 smart account as the worker, not its EOA. */
  aa: boolean;
  /**
   * The TaskRegistry (on 0G, keyed by 0G escrow ids) holds this chain's task
   * metadata. Reading it with another chain's id returns the meta of an
   * unrelated 0G task that shares the number.
   */
  hasTaskRegistry: boolean;
}

function isZeroAddress(address: string): boolean {
  return /^0x0{40}$/i.test(address);
}

/** A configured address, or null when it is unset or the zero address. */
function addressOrNull(address: string | undefined): string | null {
  return address && !isZeroAddress(address) ? address : null;
}

const BUILDERS: { readonly [K in SettlementChainKey]: () => SettlementChainConfig } = {
  '0g': () => {
    // Anything that is not the mainnet chain id is treated as a testnet, so a
    // local or forked chain is never mistaken for mainnet.
    const mainnet = chainTier('0g', config.ogChainId) === 'mainnet';
    return {
      key: '0g',
      label: '0G',
      chainId: config.ogChainId,
      rpcUrl: config.ogRpcUrl,
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
      hasTaskRegistry: true,
    };
  },
  base: () => {
    const mainnet = chainTier('base', config.baseChainId) === 'mainnet';
    return {
      key: 'base',
      label: 'Base',
      chainId: config.baseChainId,
      rpcUrl: config.baseRpcUrl,
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
      hasTaskRegistry: false,
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

/**
 * The chain POST /tasks funds new tasks on. POSTING_CHAIN names it; unset, it
 * is Base when this deployment has a Base escrow and 0G otherwise, the rule
 * from before the setting. Throws when POSTING_CHAIN names no chain this code
 * knows, which boot refuses first (assertPostingChain).
 */
export function postingChain(): SettlementChainKey {
  const named = config.postingChain;
  if (!named) return settlementChainConfig('base').escrowAddress !== null ? 'base' : '0g';
  if (!isSettlementChainKey(named)) {
    throw new Error(`POSTING_CHAIN="${named}" is not a settlement chain; use one of: ${SETTLEMENT_CHAIN_KEYS.join(', ')}`);
  }
  return named;
}

/**
 * The chains this deployment has an escrow on, the posting chain first. A
 * createTask receipt is looked for in this order: new tasks are funded on the
 * posting chain, and the poster picks the hash, so the same one can be
 * escrowed on more than one chain.
 */
export function receiptSearchOrder(): SettlementChainKey[] {
  const posting = postingChain();
  const keys = configuredChainKeys();
  return [...keys.filter((key) => key === posting), ...keys.filter((key) => key !== posting)];
}

/**
 * Throws when POSTING_CHAIN can't be used: it names no known chain, or a
 * chain with no escrow here, or a chain on the wrong network tier. An unset
 * POSTING_CHAIN keeps the default and is never fatal (production posts on
 * Base Sepolia today); if the default chain has no escrow, a warning is
 * returned for the caller to log. Called at boot.
 *
 * The tier rule has two forms. With SETTLEMENT_TIER set, the posting chain
 * must be on that tier — the stack said what it is, and posting elsewhere
 * would escrow real money on the other network. With no tier set, the older
 * stand-in applies: a testnet posting chain on a production backend needs
 * ALLOW_NONMAINNET_PROD, which is how production (0G mainnet + Base Sepolia)
 * runs until every chain shares a tier.
 */
export function assertPostingChain(opts: {
  production: boolean;
  allowNonMainnet: boolean;
  tier?: SettlementTier | null;
}): string[] {
  const entry = settlementChainConfig(postingChain());
  if (!config.postingChain) {
    return entry.escrowAddress === null
      ? [`POSTING_CHAIN is unset and the default, ${entry.label}, has no escrow (${entry.escrowEnv}), so POST /tasks refuses new tasks`]
      : [];
  }
  const problems: string[] = [];
  if (entry.escrowAddress === null) {
    problems.push(`POSTING_CHAIN=${entry.key} but ${entry.escrowEnv} is unset or the zero address`);
  }
  if (opts.tier) {
    // Unreachable through config today, which already refuses a contradicting
    // chain id at boot and defaults an unset one to the tier. Kept because it
    // is this function's own precondition, and a chain added later (Arc) is
    // one forgotten tier entry away from needing it.
    if (entry.tier !== opts.tier) {
      problems.push(
        `POSTING_CHAIN=${entry.key} is on ${entry.tier} (chain ${entry.chainId}) but SETTLEMENT_TIER=${opts.tier}`,
      );
    }
  } else if (opts.production && entry.tier !== 'mainnet' && !opts.allowNonMainnet) {
    problems.push(
      `POSTING_CHAIN=${entry.key} is a testnet (chain ${entry.chainId}) on a production backend; ` +
        `set ALLOW_NONMAINNET_PROD=true if this is a staging stack`,
    );
  }
  if (problems.length > 0) throw new Error(`Invalid POSTING_CHAIN: ${problems.join('; ')}`);
  return [];
}

/**
 * What is wrong with the entries. A token rule broken on a chain this
 * deployment settles on is fatal: its tasks would be booked in the wrong unit.
 * On a chain it doesn't settle on (no escrow, which a staging stack may mark
 * with the zero address, token included) it is only a warning. Decimals other
 * than 6 or 18 can only come from code, so they are always fatal.
 */
export function registryProblems(entries: readonly SettlementChainConfig[]): { fatal: string[]; warnings: string[] } {
  const fatal: string[] = [];
  const warnings: string[] = [];
  for (const { key, escrowAddress, token, gas } of entries) {
    const tokenProblems = escrowAddress !== null ? fatal : warnings;
    const native = token.address !== null && isZeroAddress(token.address);
    if ((token.kind === 'native') !== native) {
      tokenProblems.push(
        `${key}: token kind is ${token.kind} but its address is ${token.address ?? 'unset'}; ` +
          `a native token is address(0) and only a native token is`,
      );
    }
    if (gas.nativeIsSettlementToken && (token.kind !== 'erc20' || token.address === null || native)) {
      tokenProblems.push(
        `${key}: the native gas coin is the settlement asset, so the settlement token must be its ERC-20 ` +
          `at a non-zero address, not ${token.address ?? 'unset'}`,
      );
    }
    if (token.unit.decimals !== 6 && token.unit.decimals !== 18) {
      fatal.push(`${key}: settlement token decimals must be 6 or 18, not ${String(token.unit.decimals)}`);
    }
  }
  return { fatal, warnings };
}

/**
 * Throws when the entries are inconsistent for a chain this deployment
 * settles on. Returns the problems on chains it doesn't, for the caller to
 * log. Called at boot.
 */
export function assertRegistryInvariants(entries: readonly SettlementChainConfig[]): string[] {
  const { fatal, warnings } = registryProblems(entries);
  if (fatal.length > 0) {
    throw new Error(`Invalid settlement chain registry: ${fatal.join('; ')}`);
  }
  return warnings;
}
