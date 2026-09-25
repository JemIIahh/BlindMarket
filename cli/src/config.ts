import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const DEFAULT_API_BASE = 'https://api.blindmarket.xyz';

/** ~/.blind, or BLIND_CONFIG_DIR. Holds a bearer token and possibly a keystore: owner-only. */
export function configDir(): string {
  return process.env.BLIND_CONFIG_DIR ?? join(homedir(), '.blind');
}

export interface Config {
  /** An sk_ API key (`blind login`), or the token `blind register` got. */
  apiKey?: string;
  /** The wallet the API key belongs to, as the backend reported it at login. */
  address?: string;
  /** Written by `blind register`: the wallet it generated, which the token acts as. */
  agentWallet?: string;
  agentName?: string;
  apiBase: string;
}

/** Write a file only its owner can read, in a directory only its owner can list. */
export function writePrivate(name: string, content: string): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  writeFileSync(path, content, { mode: 0o600 });
  // writeFileSync keeps an existing file's mode: tighten one written before this rule.
  chmodSync(path, 0o600);
}

function readJson<T>(name: string, fallback: T): T {
  const path = join(configDir(), name);
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

/** The saved config, as the file holds it. */
export function loadConfig(): Config {
  const saved = readJson<Partial<Config>>('config.json', {});
  return { ...saved, apiBase: saved.apiBase ?? DEFAULT_API_BASE };
}

/**
 * The config commands run with: the saved file, with BLINDMARKET_API_KEY and
 * BLINDMARKET_API_BASE taking precedence (the names the MCP server and the
 * SDK examples use), so a script or CI job needs no `blind login`.
 */
export function resolveConfig(): Config {
  const cfg = loadConfig();
  return {
    ...cfg,
    apiKey: process.env.BLINDMARKET_API_KEY ?? cfg.apiKey,
    apiBase: process.env.BLINDMARKET_API_BASE ?? cfg.apiBase,
  };
}

export function saveConfig(cfg: Config): void {
  writePrivate('config.json', JSON.stringify(cfg, null, 2));
}

// ── Spends in flight ────────────────────────────────────────────────────────
//
// A payment is saved the moment it is broadcast, so a crash, a closed
// terminal or a failed deploy never makes the next attempt pay again.

interface State {
  /** A deploy fee paid but not yet used, per backend, wallet and chain id. */
  pendingFees?: Record<string, string>;
  /** Escrows funded but not yet listed, by task hash: the body POST /a2a/tasks/index needs. */
  pendingPosts?: Record<string, Record<string, unknown>>;
}

const loadState = () => readJson<State>('state.json', {});
const saveState = (s: State) => writePrivate('state.json', JSON.stringify(s, null, 2));
// The chain id is part of the key: a backend can move a chain to another
// network under the same name (Arc Testnet 5042002, Arc mainnet 5042), and a
// fee paid on one never pays for a deploy on the other.
const feeKey = (apiBase: string, address: string, chainId?: number) =>
  `${apiBase}|${address.toLowerCase()}${chainId === undefined ? '' : `|${chainId}`}`;

export function pendingFee(apiBase: string, address: string, chainId?: number): string | undefined {
  return loadState().pendingFees?.[feeKey(apiBase, address, chainId)];
}

export function setPendingFee(apiBase: string, address: string, chainId: number | undefined, hash: string | null): void {
  const s = loadState();
  const fees = { ...(s.pendingFees ?? {}) };
  if (hash) fees[feeKey(apiBase, address, chainId)] = hash;
  else delete fees[feeKey(apiBase, address, chainId)];
  saveState({ ...s, pendingFees: fees });
}

export function pendingPosts(): Record<string, Record<string, unknown>> {
  return loadState().pendingPosts ?? {};
}

export function setPendingPost(taskHash: string, indexParams: Record<string, unknown> | null): void {
  const s = loadState();
  const posts = { ...(s.pendingPosts ?? {}) };
  if (indexParams) posts[taskHash] = indexParams;
  else delete posts[taskHash];
  saveState({ ...s, pendingPosts: posts });
}
