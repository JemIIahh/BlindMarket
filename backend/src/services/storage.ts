import { Indexer, MemData, StorageNode as ESMStorageNode } from '@0gfoundation/0g-storage-ts-sdk';
import { ethers } from 'ethers';
import { createHash, randomBytes } from 'crypto';
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { config } from '../config.js';
import { MAX_BATCH_REQUEST } from '../constants.js';
import { AppError } from '../middleware/errorHandler.js';
import { createRequire } from 'module';

// Monkey-patch both ESM and CJS StorageNode.prototype.getStatus to handle cases where a testnet
// storage node returns the mainnet Flow contract address (0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526)
// which causes estimateGas to revert on the testnet RPC since no code is deployed there.
// The SDK polls node status, so warn once per node: the override still applies on every call.
const warnedFlowOverrides = new Set<string>();
const patchStorageNode = (StorageNodeClass: any) => {
  if (!StorageNodeClass || !StorageNodeClass.prototype) return;
  const originalGetStatus = StorageNodeClass.prototype.getStatus;
  StorageNodeClass.prototype.getStatus = async function () {
    const status = await originalGetStatus.apply(this);
    if (status && status.networkIdentity) {
      const chainId = status.networkIdentity.chainId;
      const flowAddress = status.networkIdentity.flowAddress;
      // If the chain is 0G Testnet (16602) but the node returns the mainnet Flow address
      if ((chainId === 16602 || config.ogChainId === 16602) && flowAddress && flowAddress.toLowerCase() === '0x62d4144db0f0a6fbbaeb6296c785c71b3d57c526') {
        const overrideKey = `${this.url}|${flowAddress.toLowerCase()}`;
        if (!warnedFlowOverrides.has(overrideKey)) {
          warnedFlowOverrides.add(overrideKey);
          console.warn(`[0G Storage Patch] Overriding incorrect mainnet flow address ${flowAddress} with testnet flow address on node ${this.url}`);
        }
        status.networkIdentity.flowAddress = '0x22e03a6a89b950f1c82ec5e74f8eca321a105296';
      }
    }
    return status;
  };
};

patchStorageNode(ESMStorageNode);

try {
  const require = createRequire(import.meta.url);
  const CJSStorageNode = require('@0gfoundation/0g-storage-ts-sdk').StorageNode;
  patchStorageNode(CJSStorageNode);
} catch (e) {
  // Fallback if require is not supported/fails
}


/**
 * 0G Storage service — upload/download encrypted blobs.
 *
 * Encryption happens CLIENT-SIDE. This service is "blind":
 * it only sees encrypted bytes and root hashes.
 *
 * Uses local file storage when 0G Storage is not configured
 * (OG_STORAGE_INDEXER_RPC or OG_STORAGE_PRIVATE_KEY empty). Local storage is
 * for development only — not production-safe (no replication, no merkle
 * proofs, no dedup). A backend that IS configured for 0G never falls back to
 * it: download() only asks 0G there, so a brief stored locally could never be
 * read again. A failed 0G upload answers 503 STORAGE_UNAVAILABLE instead.
 */

// ── 0G SDK setup ──

let indexer: InstanceType<typeof Indexer> | null = null;
let signer: ethers.Wallet | null = null;

function is0gConfigured(): boolean {
  return !!(config.ogStorageIndexerRpc && config.ogStoragePrivateKey);
}

function getIndexer(): InstanceType<typeof Indexer> {
  if (!indexer) {
    indexer = new Indexer(config.ogStorageIndexerRpc);
  }
  return indexer;
}

function getSigner(): ethers.Wallet {
  if (!signer) {
    const provider = new ethers.JsonRpcProvider(config.ogRpcUrl, config.ogChainId);
    signer = new ethers.Wallet(config.ogStoragePrivateKey, provider);
  }
  return signer;
}

// ── Local storage (development: no 0G configured) ──

const LOCAL_DIR = resolve(process.cwd(), '.storage');

function ensureLocalDir() {
  if (!existsSync(LOCAL_DIR)) {
    mkdirSync(LOCAL_DIR, { recursive: true });
  }
}

/** Validate path stays inside LOCAL_DIR (prevent traversal) */
function safePath(rootHash: string): string | null {
  const target = resolve(LOCAL_DIR, rootHash);
  if (!target.startsWith(LOCAL_DIR + '/') && target !== LOCAL_DIR) {
    return null;
  }
  return target;
}

// ── Public API ──

/**
 * Upload an encrypted blob to 0G Storage, or to the local directory when 0G
 * is not configured. Returns the root hash. On 0G it answers within
 * UPLOAD_DEADLINE_MS, and throws 503 STORAGE_UNAVAILABLE when the blob could
 * not be stored.
 */
export async function upload(data: Buffer): Promise<{ rootHash: string; txHash?: string }> {
  if (!is0gConfigured()) {
    return uploadLocal(data);
  }
  return upload0g(data);
}

// ── 0G upload turns and time limits ──
//
// Every 0G upload sends a flow transaction from the one storage wallet, and
// the SDK picks its nonce itself: two uploads in flight at once (a bulk post,
// or two posters at the same moment) can take the same nonce and fail. So a
// process runs its 0G upload attempts one after another. The turn is held
// for one attempt, not across the pause before a retry, so other uploads go
// meanwhile.
//
// Prod sits behind Cloudflare, which cuts a request off after about 100 s. One
// upload() — its waits for a turn, its attempts and the pause — ends within
// UPLOAD_DEADLINE_MS (85 s), with 503 STORAGE_UNAVAILABLE ("nothing was paid")
// if it hasn't stored the blob by then, instead of the edge's own error. An
// attempt gets at most UPLOAD_ATTEMPT_MS (40 s): two attempts and the 5 s pause
// fit in 85 s, and 40 s covers the 20-40 s an upload usually takes
// (agents/worker.js). A slower upload's second attempt builds on the first:
// the SDK returns at once for a file already finalized, and one whose segments
// are all stored.
//
// The SDK waits for the storage node without a limit (Uploader.waitForLogEntry)
// and can't be cancelled, so an attempt past its limit gives up its turn and
// is left running. It sent its one transaction before those waits, so it can't
// take the next upload's nonce.
const UPLOAD_ATTEMPTS = 2;
const UPLOAD_ATTEMPT_MS = 40_000;
const UPLOAD_RETRY_PAUSE_MS = 5_000;
const UPLOAD_DEADLINE_MS = 85_000;
/** An attempt with less time than this before the deadline is not started: it would only pay for a transaction. */
const MIN_ATTEMPT_MS = 10_000;

let uploadTurn: Promise<void> = Promise.resolve();

/** Run `attempt` once every 0G upload attempt queued before it has finished or given up. */
function inUploadTurn<T>(attempt: () => Promise<T>): Promise<T> {
  const run = uploadTurn.then(attempt);
  uploadTurn = run.then(() => undefined, () => undefined);
  return run;
}

/** `attempt`, or a rejection once `ms` have passed. */
function withinLimit<T>(attempt: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from 0G Storage within ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([attempt, limit]).finally(() => clearTimeout(timer));
}

/**
 * The most blobs one POST /storage/upload-batch takes on 0G. The route starts
 * this many uploads at once (UPLOAD_BATCH_CONCURRENCY), each answers within
 * UPLOAD_DEADLINE_MS, so the whole request answers within about 85 s, inside
 * Cloudflare's ~100 s; a larger batch could run past it and fail at the edge
 * with the work half done. Clients send 2 at a time.
 */
export const UPLOAD_BATCH_LIMIT_0G = 4;

/** The most blobs one POST /storage/upload-batch takes here: UPLOAD_BATCH_LIMIT_0G on 0G, else the request limit. */
export function uploadBatchLimit(): number {
  return is0gConfigured() ? UPLOAD_BATCH_LIMIT_0G : MAX_BATCH_REQUEST;
}

/**
 * Download an encrypted blob by root hash.
 * Returns the raw encrypted bytes or null if not found.
 */
export async function download(rootHash: string): Promise<Buffer | null> {
  if (!is0gConfigured()) {
    return downloadLocal(rootHash);
  }
  return download0g(rootHash);
}

// ── 0G Storage implementation ──

async function upload0g(data: Buffer): Promise<{ rootHash: string; txHash?: string }> {
  const idx = getIndexer();
  const sgn = getSigner();

  const memData = new MemData(new Uint8Array(data));

  // Compute merkle tree to get root hash BEFORE upload
  const [tree, treeErr] = await memData.merkleTree();
  if (treeErr !== null || !tree) {
    console.error('0G merkle tree error:', treeErr);
    throw new Error('Storage upload failed: merkle tree computation error');
  }
  const rootHash = tree.rootHash() as string;

  // Upload to 0G Storage network with retry (UPLOAD_ATTEMPTS attempts).
  // The SDK submits a chain tx AND waits for the storage node to index it.
  // On testnet the node is often slow — a single timeout is common. A second
  // attempt usually succeeds because the first tx already landed on-chain.
  // A returned error, a thrown one and the time limit all fail the attempt.
  const deadline = Date.now() + UPLOAD_DEADLINE_MS;
  let lastErr: string | null = null;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      if (deadline - Date.now() < UPLOAD_RETRY_PAUSE_MS + MIN_ATTEMPT_MS) break;
      // Brief pause before retry — the chain tx may already be in-flight
      await new Promise((r) => setTimeout(r, UPLOAD_RETRY_PAUSE_MS));
    }
    try {
      const txHash = await inUploadTurn(async () => {
        const budget = Math.min(UPLOAD_ATTEMPT_MS, deadline - Date.now());
        if (budget < MIN_ATTEMPT_MS) throw new Error('its turn came too close to the deadline');
        console.log(`[0G Storage] upload attempt ${attempt}/${UPLOAD_ATTEMPTS} (rootHash=${rootHash.slice(0, 16)}…)`);
        // Cast signer to `any` — 0G SDK pins ethers 6.13.1 CJS types,
        // our project uses ethers 6.x ESM. Runtime is identical.
        const [tx, uploadErr] = await withinLimit(idx.upload(memData, config.ogRpcUrl, sgn as any), budget);
        if (uploadErr !== null) throw new Error(String(uploadErr));
        return typeof tx === 'object' && tx !== null && 'txHash' in tx ? ((tx as any).txHash as string | undefined) : undefined;
      });
      console.log(`[0G Storage] upload success (attempt ${attempt}, txHash=${txHash ?? 'n/a'})`);
      return { rootHash, txHash };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      console.warn(`[0G Storage] upload attempt ${attempt} failed: ${lastErr}`);
    }
  }

  // All attempts failed. No local fallback here: download() on a 0G backend
  // only asks 0G, so a brief kept on this server's disk (ephemeral on the
  // host, and under a different id) could never be read, and the task would
  // be paid for with no brief. Every client uploads BEFORE funding, so
  // failing now costs the poster nothing: they retry later.
  console.warn(`[0G Storage] all upload attempts failed (${lastErr ?? 'unknown error'})`);
  throw new AppError(
    503,
    'STORAGE_UNAVAILABLE',
    "Couldn't store the brief right now. Nothing was paid — try again in a minute.",
  );
}

async function download0g(rootHash: string): Promise<Buffer | null> {
  const idx = getIndexer();

  // SDK downloads to a file — use a temp file with random suffix to avoid races
  const rand = randomBytes(8).toString('hex');
  const tmpPath = join(tmpdir(), `0g-${rootHash}-${rand}`);

  try {
    const err = await idx.download(rootHash, tmpPath, true);
    if (err !== null) {
      console.error(`0G download error for ${rootHash}:`, err);
      return null;
    }
    return readFileSync(tmpPath);
  } catch (e) {
    console.error(`0G download exception for ${rootHash}:`, e);
    return null;
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
  }
}

// ── Local fallback implementation (development only) ──

async function uploadLocal(data: Buffer): Promise<{ rootHash: string }> {
  ensureLocalDir();
  const rootHash = createHash('sha256').update(data).digest('hex');
  const target = safePath(rootHash);
  if (!target) throw new Error('Invalid hash');
  writeFileSync(target, data);
  return { rootHash };
}

async function downloadLocal(rootHash: string): Promise<Buffer | null> {
  ensureLocalDir();
  const target = safePath(rootHash);
  if (!target) return null;
  if (!existsSync(target)) return null;
  return readFileSync(target);
}