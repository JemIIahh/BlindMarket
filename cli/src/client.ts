import { readFileSync } from 'fs';
import { BlindMarket, type SettlementChainInfo } from '@blindmarket/sdk';
import type { Wallet } from 'ethers';
import { resolveConfig, type Config } from './config.js';
import { loadSigner } from './keys.js';
import { CliError } from './errors.js';

/**
 * Public RPCs by chain id, for a chain with no BLINDMARKET_<CHAIN>_RPC_URL.
 * A wrong one cannot sign on the wrong network: the SDK checks the RPC's
 * chain id against the one the backend names before anything is sent. Arc
 * Testnet and Arc mainnet are both the chain `arc`: the id picks the RPC.
 */
const PUBLIC_RPC: Readonly<Record<number, string>> = {
  5042002: 'https://rpc.testnet.arc.io',
  5042: 'https://rpc.mainnet.arc.io',
  84532: 'https://base-sepolia-rpc.publicnode.com',
  8453: 'https://base-rpc.publicnode.com',
  16602: 'https://evmrpc-testnet.0g.ai',
  16661: 'https://0g-rpc.publicnode.com',
};

export const rpcEnvName = (chain: string) => `BLINDMARKET_${chain.toUpperCase().replace(/-/g, '_')}_RPC_URL`;

/** The RPC for `chain`: BLINDMARKET_<CHAIN>_RPC_URL, else the public one for `chainId`, the id the backend names. */
export const rpcUrlFor = (chain: string, chainId: number): string | undefined => process.env[rpcEnvName(chain)] ?? PUBLIC_RPC[chainId];

export interface Client {
  cfg: Config;
  bb: BlindMarket;
}

export interface SigningClient extends Client {
  signer: Wallet;
  postingChain: string | null;
  chains: SettlementChainInfo[];
}

function loggedIn(): Config {
  const cfg = resolveConfig();
  if (!cfg.apiKey) {
    throw new CliError('NOT_LOGGED_IN', 'No API key. Mint one in the web app (Settings → API keys), then run `blind login`, or set BLINDMARKET_API_KEY.');
  }
  return cfg;
}

/** The installed @blindmarket/sdk's version, from its package.json; null when that cannot be read. */
export function sdkVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@blindmarket/sdk')), 'utf-8')) as { name?: string; version?: string };
    return pkg.name === '@blindmarket/sdk' ? pkg.version ?? null : null;
  } catch {
    return null;
  }
}

export function assertSdk(bb: BlindMarket, version = sdkVersion()): void {
  // A package manager can still pair this CLI with an older SDK (a pinned or
  // hoisted install): fail with the fix, not "postTask is not a function", or
  // a timeout claim that went to review reported as a refund (0.7 has no outcome).
  const [major, minor] = (version ?? '').split('.').map(Number);
  if (typeof (bb as { postTask?: unknown }).postTask !== 'function' || (major === 0 && minor < 8)) {
    throw new CliError('SDK_TOO_OLD', 'This CLI needs @blindmarket/sdk 0.8 or later. Reinstall @blindmarket/cli, or run `npm i @blindmarket/sdk@^0.8.0` beside it.');
  }
}

/** A client that reads and calls the backend, and signs nothing. */
export function client(): Client {
  const cfg = loggedIn();
  const bb = new BlindMarket({ apiKey: cfg.apiKey!, apiBase: cfg.apiBase });
  assertSdk(bb);
  return { cfg, bb };
}

/**
 * A client that can sign, with the owner wallet's key and an RPC for every
 * chain the backend settles on. Which chain a call signs on is the SDK's
 * decision (the posting chain, the fee's chain, the task's chain), checked
 * against the RPC before anything is sent.
 */
export async function signingClient(): Promise<SigningClient> {
  const { cfg, bb: reader } = client();
  const signer = await loadSigner();
  const { postingChain, chains } = await reader.getSettlement();
  const rpcUrls: Record<string, string | undefined> = {};
  for (const c of chains) rpcUrls[c.chain] = rpcUrlFor(c.chain, c.chainId);
  const bb = new BlindMarket({ apiKey: cfg.apiKey!, apiBase: cfg.apiBase, executor: { privateKey: signer.privateKey, rpcUrls } });
  return { cfg, bb, signer, postingChain, chains };
}
