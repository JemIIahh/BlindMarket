import { Indexer, MemData, StorageNode as ESMStorageNode } from '@0gfoundation/0g-storage-ts-sdk';
import { ethers } from 'ethers';
import { createHash, randomBytes } from 'crypto';
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { config } from '../config.js';
import { createRequire } from 'module';

// Monkey-patch both ESM and CJS StorageNode.prototype.getStatus to handle cases where a testnet
// storage node returns the mainnet Flow contract address (0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526)
// which causes estimateGas to revert on the testnet RPC since no code is deployed there.
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
        console.warn(`[0G Storage Patch] Overriding incorrect mainnet flow address ${flowAddress} with testnet flow address on node ${this.url}`);
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
 * Falls back to local file storage when 0G Storage is not configured
 * (OG_STORAGE_INDEXER_RPC is empty). Local fallback is for development
 * only — not production-safe (no replication, no merkle proofs, no dedup).
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

// ── Local fallback ──

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
 * Upload an encrypted blob to 0G Storage (or local fallback).
 * Returns the root hash.
 */
export async function upload(data: Buffer): Promise<{ rootHash: string; txHash?: string }> {
  if (!is0gConfigured()) {
    return uploadLocal(data);
  }
  return upload0g(data);
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

  // Upload to 0G Storage network with retry (2 attempts).
  // The SDK submits a chain tx AND waits for the storage node to index it.
  // On testnet the node is often slow — a single timeout is common. A second
  // attempt usually succeeds because the first tx already landed on-chain.
  let lastErr: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`[0G Storage] upload attempt ${attempt}/2 (rootHash=${rootHash.slice(0, 16)}…)`);
    // Cast signer to `any` — 0G SDK pins ethers 6.13.1 CJS types,
    // our project uses ethers 6.x ESM. Runtime is identical.
    const [tx, uploadErr] = await idx.upload(memData, config.ogRpcUrl, sgn as any);
    if (uploadErr === null) {
      let txHash: string | undefined;
      if (typeof tx === 'object' && tx !== null && 'txHash' in tx) {
        txHash = (tx as any).txHash;
      }
      console.log(`[0G Storage] upload success (attempt ${attempt}, txHash=${txHash ?? 'n/a'})`);
      return { rootHash, txHash };
    }
    lastErr = String(uploadErr);
    console.warn(`[0G Storage] upload attempt ${attempt} failed: ${lastErr}`);
    // Brief pause before retry — the chain tx may already be in-flight
    if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
  }

  // All attempts failed — fall back to local storage so the task is not
  // lost.  The rootHash is deterministic (from the merkle tree), so the
  // blob can later be re-uploaded to 0G if the node recovers.
  console.warn(`[0G Storage] all upload attempts failed — falling back to local storage`);
  return uploadLocal(data);
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