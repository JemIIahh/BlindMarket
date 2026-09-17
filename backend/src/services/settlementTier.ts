/**
 * The network tier a deployment runs on: mainnet or testnet, for every chain
 * at once.
 *
 * Until SETTLEMENT_TIER, each chain picked its own tier from its own default:
 * 0G from NODE_ENV, Base from BASE_CHAIN_ID, CCTP from Base. Production ended
 * up mixed (0G mainnet + Base Sepolia) and nothing said so. One setting names
 * the tier, every chain id defaults from it, and a chain id that contradicts
 * it is refused at boot.
 *
 * This module is pure: no config, no env read of its own, no I/O. config.ts
 * imports it while building `config`, so it must not import config.ts back.
 */

export const SETTLEMENT_TIERS = ['mainnet', 'testnet'] as const;
export type SettlementTier = (typeof SETTLEMENT_TIERS)[number];

/**
 * Chain ids per tier for each settlement chain, with the env var that sets it.
 * The registry reads these to say which tier a chain is on; Phase 2 adds arc
 * (mainnet 5042, testnet 5042002).
 */
export const TIER_CHAIN_IDS = {
  '0g': { mainnet: 16661, testnet: 16602, env: 'OG_CHAIN_ID' },
  base: { mainnet: 8453, testnet: 84532, env: 'BASE_CHAIN_ID' },
} as const;

/**
 * CCTP's other legs. Not settlement chains — nothing is escrowed there — but
 * a tier pins them too, so a testnet stack can't be pointed at Ethereum
 * mainnet by a stray env var. Values match config.ts's own defaults.
 */
const CCTP_TIER_CHAIN_IDS = {
  CCTP_ETHEREUM_CHAIN_ID: { mainnet: 1, testnet: 11155111 },
  CCTP_ARBITRUM_CHAIN_ID: { mainnet: 42161, testnet: 421614 },
  CCTP_OPTIMISM_CHAIN_ID: { mainnet: 10, testnet: 11155420 },
} as const;

function isTier(value: string): value is SettlementTier {
  return (SETTLEMENT_TIERS as readonly string[]).includes(value);
}

/**
 * SETTLEMENT_TIER as a tier, or null when it is unset (every chain keeps its
 * own default). Throws on any other value: a typo like "main" must not be
 * read as "unset" and silently hand a mainnet stack testnet defaults.
 */
export function readSettlementTier(env: NodeJS.ProcessEnv): SettlementTier | null {
  const raw = (env.SETTLEMENT_TIER ?? '').trim();
  if (raw === '') return null;
  const value = raw.toLowerCase();
  if (!isTier(value)) {
    throw new Error(
      `SETTLEMENT_TIER="${raw}" is not a network tier. Use ${SETTLEMENT_TIERS.join(' or ')}, or leave it unset to keep each chain's own default.`,
    );
  }
  return value;
}

/** Which tier a chain id is on, or null when it is not a chain id this code knows. */
export function chainTier(key: keyof typeof TIER_CHAIN_IDS, chainId: number): SettlementTier | null {
  const ids = TIER_CHAIN_IDS[key];
  if (chainId === ids.mainnet) return 'mainnet';
  if (chainId === ids.testnet) return 'testnet';
  return null;
}

/**
 * What contradicts `tier` in the environment, one message per setting. Only
 * explicitly-set chain ids are checked: an unset one takes the tier's own
 * default and cannot disagree. An id belonging to no known tier is reported
 * too — under an explicit tier, an unrecognised chain is exactly the mistake
 * this check exists to catch.
 */
export function tierMismatches(env: NodeJS.ProcessEnv, tier: SettlementTier): string[] {
  const problems: string[] = [];
  const check = (name: string, ids: { readonly mainnet: number; readonly testnet: number }) => {
    const raw = (env[name] ?? '').trim();
    if (raw === '') return;
    const chainId = Number(raw);
    if (chainId === ids[tier]) return;
    const other = tier === 'mainnet' ? 'testnet' : 'mainnet';
    const what = chainId === ids[other] ? `is ${other}` : 'is not a chain this tier knows';
    problems.push(`${name}=${raw} ${what}, but SETTLEMENT_TIER=${tier} expects ${ids[tier]}`);
  };
  for (const { env: name, ...ids } of Object.values(TIER_CHAIN_IDS)) check(name, ids);
  for (const [name, ids] of Object.entries(CCTP_TIER_CHAIN_IDS)) check(name, ids);
  return problems;
}
