import { BlindMarket, type SettlementChainInfo } from '@blindmarket/sdk';
import type { Wallet } from 'ethers';
import { resolveConfig, type Config } from './config.js';
import { loadSigner } from './keys.js';
import { CliError } from './errors.js';

/**
 * Public RPCs by chain id, for a chain with no BLINDMARKET_<CHAIN>_RPC_URL.
 * A wrong one cannot sign on the wrong network: the SDK checks the RPC's
 * chain id against the one the backend names before anything is sent.
 */
const PUBLIC_RPC: Readonly<Record<number, string>> = {
  5042002: 'https://rpc.testnet.arc.io',
  84532: 'https://sepolia.base.org',
  8453: 'https://mainnet.base.org',
  16602: 'https://evmrpc-testnet.0g.ai',
  16661: 'https://evmrpc.0g.ai',
};

export const rpcEnvName = (chain: string) => `BLINDMARKET_${chain.toUpperCase().replace(/-/g, '_')}_RPC_URL`;

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

function assertSdk(bb: BlindMarket): void {
  // A package manager can still pair this CLI with an older SDK (a pinned or
  // hoisted install): fail with the fix, not "postTask is not a function".
  if (typeof (bb as { postTask?: unknown }).postTask !== 'function') {
    throw new CliError('SDK_TOO_OLD', 'This CLI needs @blindmarket/sdk 0.7 or later. Reinstall @blindmarket/cli, or run `npm i @blindmarket/sdk@^0.7.0` beside it.');
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
  for (const c of chains) rpcUrls[c.chain] = process.env[rpcEnvName(c.chain)] ?? PUBLIC_RPC[c.chainId];
  const bb = new BlindMarket({ apiKey: cfg.apiKey!, apiBase: cfg.apiBase, executor: { privateKey: signer.privateKey, rpcUrls } });
  return { cfg, bb, signer, postingChain, chains };
}
