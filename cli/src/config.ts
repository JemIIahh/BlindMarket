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
  /**
   * The nonce each saved deploy fee was sent with, by its hash. A fee no node
   * has, whose sender's confirmed nonce is past this one, never landed.
   */
  feeNonces?: Record<string, number>;
  /**
   * Escrows funded but not yet listed, by task hash: the body POST
   * /a2a/tasks/index needs. `batch: true` marks a row that shares its funding
   * transaction with others, which lists through /a2a/tasks/index-batch.
   */
  pendingPosts?: Record<string, Record<string, unknown>>;
  /** Rows of task files `post-tasks` funded, per backend, wallet, chain id and file, by row fingerprint. */
  bulkPosts?: Record<string, Record<string, BulkRow>>;
  /**
   * The signed raw funding transactions of rows still funded and not listed,
   * by hash: once per transaction, however many rows it funds. While its
   * nonce is unused it is re-broadcast as is, so it can only ever land once.
   */
  fundingRaw?: Record<string, string>;
  /** Where each task file's results go, and in what token, by the same key as bulkPosts. */
  bulkFiles?: Record<string, BulkFile>;
}

/** What `finish-posts` needs to rewrite a task file's results. */
export interface BulkFile {
  file: string;
  resultsPath: string;
  symbol: string;
  decimals: number;
}

/**
 * A row of a task file that was funded: never fund it again, whatever
 * happens to its listing, unless its funding transaction provably never
 * landed (see funding.ts).
 */
export interface BulkRow {
  /** 'funded' the moment its transaction is sent; 'posted' once listed. */
  status: 'funded' | 'posted';
  taskHash: string;
  txHash?: string;
  /** The funding transaction's nonce and sender, and the chain it was sent on. */
  nonce?: number;
  from?: string;
  chain?: string;
  chainId?: number;
  taskId?: string;
  line?: number;
  at: string;
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

/** Save (or, with null, clear) the deploy fee in this slot, with the nonce it was sent with when known. */
export function setPendingFee(apiBase: string, address: string, chainId: number | undefined, hash: string | null, nonce?: number): void {
  const s = loadState();
  const key = feeKey(apiBase, address, chainId);
  const fees = { ...(s.pendingFees ?? {}) };
  const nonces = { ...(s.feeNonces ?? {}) };
  const before = fees[key];
  if (hash) fees[key] = hash;
  else delete fees[key];
  // A nonce belongs to its hash, and goes with it.
  if (before && before.toLowerCase() !== hash?.toLowerCase()) delete nonces[before.toLowerCase()];
  if (hash && nonce !== undefined) nonces[hash.toLowerCase()] = nonce;
  saveState({ ...s, pendingFees: fees, feeNonces: nonces });
}

/** The nonce the saved deploy fee `hash` was sent with, when it was saved with one. */
export function pendingFeeNonce(hash: string): number | undefined {
  return loadState().feeNonces?.[hash.toLowerCase()];
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

/**
 * Where a task file's funded rows are kept. The chain id is part of it for
 * the reason fees keep theirs, and the file's full path is too, so another
 * file's rows (or a copy of this one, to post it again) start fresh.
 */
export const bulkKey = (apiBase: string, address: string, chainId: number, file: string) =>
  `${apiBase}|${address.toLowerCase()}|${chainId}|${file}`;

export function bulkProgress(key: string): Record<string, BulkRow> {
  return loadState().bulkPosts?.[key] ?? {};
}

export function setBulkRow(key: string, fingerprint: string, row: BulkRow | null): void {
  const s = loadState();
  const all = { ...(s.bulkPosts ?? {}) };
  const rows = { ...(all[key] ?? {}) };
  if (row) rows[fingerprint] = row;
  else delete rows[fingerprint];
  all[key] = rows;
  saveState({ ...s, bulkPosts: all });
}

/** Keep only the raw transactions a funded, unlisted row still points at. */
function pruneRaw(s: State): Record<string, string> {
  const wanted = new Set<string>();
  for (const rows of Object.values(s.bulkPosts ?? {})) {
    for (const row of Object.values(rows)) if (row.status === 'funded' && row.txHash) wanted.add(row.txHash.toLowerCase());
  }
  return Object.fromEntries(Object.entries(s.fundingRaw ?? {}).filter(([hash]) => wanted.has(hash.toLowerCase())));
}

export function saveFundingRaw(txHash: string, raw: string): void {
  const s = loadState();
  saveState({ ...s, fundingRaw: { ...(s.fundingRaw ?? {}), [txHash.toLowerCase()]: raw } });
}

export function fundingRaw(txHash: string): string | undefined {
  return loadState().fundingRaw?.[txHash.toLowerCase()];
}

export function setBulkFile(key: string, meta: BulkFile): void {
  const s = loadState();
  saveState({ ...s, bulkFiles: { ...(s.bulkFiles ?? {}), [key]: meta } });
}

export function bulkFile(key: string): BulkFile | undefined {
  return loadState().bulkFiles?.[key];
}

/** The funded (not yet listed) row of any task file whose funding created `taskHash`, if one did. */
export function fundedBulkRow(taskHash: string): { key: string; fingerprint: string; row: BulkRow } | undefined {
  const all = loadState().bulkPosts ?? {};
  for (const [key, rows] of Object.entries(all)) {
    for (const [fingerprint, row] of Object.entries(rows)) {
      if (row.status === 'funded' && row.taskHash.toLowerCase() === taskHash.toLowerCase()) return { key, fingerprint, row };
    }
  }
  return undefined;
}

/**
 * A funded task is listed: its pending listing is done, and a task file's
 * row for it becomes 'posted' with its task id, so the file's next results
 * say so (finish-posts lists rows post-tasks funded).
 */
export function markListed(taskHash: string, taskId?: string): void {
  const s = loadState();
  const posts = { ...(s.pendingPosts ?? {}) };
  delete posts[taskHash];
  const all = { ...(s.bulkPosts ?? {}) };
  for (const [key, rows] of Object.entries(all)) {
    for (const [fingerprint, row] of Object.entries(rows)) {
      if (row.status === 'funded' && row.taskHash.toLowerCase() === taskHash.toLowerCase()) {
        all[key] = { ...all[key], [fingerprint]: { ...row, status: 'posted', ...(taskId ? { taskId } : {}), at: new Date().toISOString() } };
      }
    }
  }
  const next = { ...s, pendingPosts: posts, bulkPosts: all };
  saveState({ ...next, fundingRaw: pruneRaw(next) });
}

/**
 * A funding transaction that never landed (it reverted, or its nonce was used
 * by another transaction): nothing was escrowed, so its pending listing is
 * dropped and a task file's row for it is free to be posted again.
 */
export function forgetFunding(taskHash: string): void {
  const s = loadState();
  const posts = { ...(s.pendingPosts ?? {}) };
  delete posts[taskHash];
  const all = { ...(s.bulkPosts ?? {}) };
  for (const [key, rows] of Object.entries(all)) {
    const kept = Object.fromEntries(Object.entries(rows).filter(([, row]) => !(row.status === 'funded' && row.taskHash.toLowerCase() === taskHash.toLowerCase())));
    all[key] = kept;
  }
  const next = { ...s, pendingPosts: posts, bulkPosts: all };
  saveState({ ...next, fundingRaw: pruneRaw(next) });
}
