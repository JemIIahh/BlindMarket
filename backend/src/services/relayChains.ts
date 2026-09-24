/**
 * The `chain` names POST /tx/relay-tx accepts, and the CAIP-2 id Privy signs
 * each one on.
 *
 * The fixed names predate the settlement chain registry and keep their
 * meaning: a client's 'base' is Base mainnet whatever this deployment settles
 * on, so they are never re-pointed from the registry (see relayCaip2 in
 * settlementChains.ts). A registry chain the relay serves is added under its
 * own key only where no fixed name already has that key.
 */
import { isSettlementChainKey, settlementChainConfigs, type SettlementChainConfig } from './settlementChains.js';

const FIXED_NAMES: ReadonlyArray<readonly [name: string, caip2: string]> = [
  ['base', 'eip155:8453'],
  ['base-mainnet', 'eip155:8453'],
  ['base-sepolia', 'eip155:84532'],
  // CCTP source chains. The fund-from-another-chain flow relays the
  // source-chain approve+burn through Privy (user-pays USDC gas via the
  // sponsorship ladder in routes/tx.ts) when the signer is the embedded
  // wallet. Names equal the CCTP chainKeys so clients pass them straight
  // through; whether Privy actually sponsors a chain is negotiated per
  // request (dashboard config), never assumed here.
  ['ethereum', 'eip155:1'],
  ['ethereum-sepolia', 'eip155:11155111'],
  ['arbitrum', 'eip155:42161'],
  ['arbitrum-sepolia', 'eip155:421614'],
  ['optimism-sepolia', 'eip155:11155420'],
  ['polygon', 'eip155:137'],
  ['polygon-amoy', 'eip155:80002'],
];

/**
 * The relay `chain` name for a chain key, or null when the relay doesn't
 * serve it. Every key present in the table IS a valid name (fixed names and
 * registry keys alike) — the CAIP-2 id it maps to must never be sent as
 * `chain`: POST /tx/relay-tx resolves names, and an id falls out as
 * INVALID_CHAIN. (Shipped the id once from /cctp/config `relayChain`;
 * base-sepolia bridges broke with exactly that error.)
 */
export function relayNameForKey(key: string): string | null {
  return relayChainTable().has(key) ? key : null;
}

/** Every name the relay accepts, in the order its error message lists them, with its CAIP-2 id. */
export function relayChainTable(): Map<string, string> {
  const table = new Map<string, string>(FIXED_NAMES);
  for (const { key, relayCaip2 } of settlementChainConfigs()) {
    if (relayCaip2 && !table.has(key)) table.set(key, relayCaip2);
  }
  return table;
}

/**
 * The `chain` a client sends to relay a transaction on this chain, or null
 * when the relay does not serve it. A fixed name that is not also a chain key
 * ('base-sepolia', 'base-mainnet') is preferred, because it names the same
 * chain on every deployment; the MCP sends those.
 */
export function relayChainName(entry: SettlementChainConfig): string | null {
  const { key, relayCaip2 } = entry;
  if (!relayCaip2) return null;
  const fixed = FIXED_NAMES.find(([name, caip2]) => caip2 === relayCaip2 && !isSettlementChainKey(name));
  if (fixed) return fixed[0];
  return relayChainTable().get(key) === relayCaip2 ? key : null;
}
