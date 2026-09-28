/**
 * The steps of posting a task, shared by PostTask (one task) and PostMany
 * (many). Each step is what PostTask did inline, moved here unchanged:
 * prepare the brief (encrypt, or plaintext for a public task), upload it,
 * wrap its key to the executors and seal it to key custody, send the funding
 * transaction, and list the task with retries.
 *
 * Money safety lives here too, so both pages keep it: a funding transaction
 * the wallet broadcast but could not confirm is never sent again (its hash
 * goes on to the listing), and a listing that fails leaves a pending entry
 * (lib/pendingIndex.ts) to retry, never a prompt to fund again.
 */
import { getAccessToken, getIdentityToken } from '@privy-io/react-auth';
import { aesEncrypt, eciesEncrypt, generateAesKey, sha256, toBase64, toBytes } from './crypto';
import { stashAesKey } from './keyStash';
import { authedGet, authedPost } from './api';
import { friendlyError } from './friendlyError';
import type { PendingIndex } from './pendingIndex';
import type { SentTx } from './txSigner';

export interface Executor {
  address: string;
  publicKey: string;
  capabilities?: string[];
  reputation?: number;
}

export interface KeyCustodyBlob {
  keyId: string;
  blob: string;
}

/** An identity token (it carries linked accounts, so the backend can derive
 *  the wallet), else the access token. Throws when neither is available. */
export async function postingToken(): Promise<string> {
  const idTok = await getIdentityToken();
  const accTok = await getAccessToken();
  const token = idTok || accTok;
  if (!token) throw new Error('No authentication token available. Please try logging out and back in.');
  return token;
}

/** The registered executors a private brief's key can be wrapped to. */
export async function fetchWrapTargets(token: string): Promise<Executor[]> {
  // authedGet unwraps to `body.data` (see api.ts), so T is the inner payload.
  const execResp = await authedGet<{ executors: Executor[] }>('/api/v1/a2a/executors', token);
  return execResp.executors ?? [];
}

export interface PreparedBrief {
  /** Base64 of what is uploaded: the ciphertext, or a public task's plaintext. */
  blob: string;
  /** 0x + sha256 of the uploaded bytes: the escrow's taskHash. */
  taskHash: string;
  /** The AES key. Generated either way; unused for a public task. */
  key: Uint8Array;
}

/**
 * Private: AES-encrypt the brief browser-side and hash the ciphertext.
 * Public: the poster opted out of blindness, so the blob is the plaintext
 * itself, hashed as-is (the same commitment scheme, no key).
 */
export async function prepareBrief(instructions: string, isPublic: boolean): Promise<PreparedBrief> {
  const plaintext = toBytes(instructions);
  const key = generateAesKey();
  if (isPublic) {
    return { blob: toBase64(plaintext), taskHash: '0x' + await sha256(plaintext), key };
  }
  const ciphertext = await aesEncrypt(plaintext, key);
  return { blob: toBase64(ciphertext), taskHash: '0x' + await sha256(ciphertext), key };
}

/** Upload one brief blob to storage; its rootHash is what executors fetch. */
export async function uploadBrief(blob: string, token: string, chainType?: string): Promise<string> {
  const uploadResp = await authedPost<{ rootHash: string; txHash?: string }>(
    '/api/v1/storage/upload',
    { data: blob, chainType },
    token,
  );
  const rootHash = uploadResp.rootHash;
  if (!rootHash) throw new Error('Storage upload returned no rootHash');
  return rootHash;
}

/** Upload several brief blobs in one request (POST /storage/upload-batch), in order. */
/**
 * Briefs per /storage/upload-batch request. The backend stores briefs on 0G
 * one at a time (20–40 s each) and answers within ~85 s, and prod sits behind
 * a ~100 s edge timeout, so a request carries two at most.
 */
const UPLOAD_GROUP = 2;

export async function uploadBriefs(blobs: string[], token: string): Promise<string[]> {
  const roots: string[] = [];
  for (let i = 0; i < blobs.length; i += UPLOAD_GROUP) {
    roots.push(...(await uploadGroup(blobs.slice(i, i + UPLOAD_GROUP), token)));
  }
  return roots;
}

/** A group, or its briefs one at a time when a slow storage node pushed the
 *  pair past the backend's deadline. Stored briefs come back at once on the
 *  second try. Anything else (a refused brief) fails the upload as is. */
async function uploadGroup(group: string[], token: string): Promise<string[]> {
  try {
    return await uploadBatchRequest(group, token);
  } catch (e) {
    if (group.length === 1 || !isTransientUploadError(e)) throw e;
    const roots: string[] = [];
    for (const blob of group) roots.push(...(await uploadBatchRequest([blob], token)));
    return roots;
  }
}

async function uploadBatchRequest(blobs: string[], token: string): Promise<string[]> {
  const resp = await authedPost<{ results: Array<{ rootHash: string; txHash?: string }> }>(
    '/api/v1/storage/upload-batch',
    { items: blobs.map((data) => ({ data })) },
    token,
  );
  const results = resp.results ?? [];
  if (results.length !== blobs.length || results.some((r) => !r?.rootHash)) {
    throw new Error(`Storage returned ${results.length} of ${blobs.length} uploads`);
  }
  return results.map((r) => r.rootHash);
}

/** Storage busy or unreachable, as opposed to a brief the backend refused or
 *  an answer that doesn't add up: a dropped connection (fetch's TypeError),
 *  the client's own timeout (ApiError TIMEOUT), 503 STORAGE_UNAVAILABLE, or a
 *  gateway giving up (502/504, Cloudflare's 524). */
function isTransientUploadError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const { code, status } = (e ?? {}) as { code?: unknown; status?: unknown };
  if (code === 'TIMEOUT') return true;
  return typeof status === 'number' && [502, 503, 504, 524].includes(status);
}

/** Lowercase hex, no 0x: how wrapped key blobs travel. */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * ECIES-wrap the AES key to each executor, keyed by lowercased address. An
 * executor with a malformed public key is skipped (logged) rather than
 * failing the post. The key is also stashed locally as a client-side
 * fallback for post-hoc bidders.
 */
export async function wrapKeyToExecutors(
  taskHash: string,
  key: Uint8Array,
  executors: Executor[],
  tag = '[PostTask]',
): Promise<Record<string, string>> {
  const wrappedKeys: Record<string, string> = {};
  stashAesKey(taskHash, key);
  for (const exec of executors) {
    try {
      wrappedKeys[exec.address.toLowerCase()] = bytesToHex(await eciesEncrypt(key, exec.publicKey));
    } catch (e) {
      console.warn(`${tag} Skipped ${exec.address} (wrap failed):`, (e as Error).message);
    }
  }
  return wrappedKeys;
}

/**
 * Seal the AES key to the platform key-custody key when custody is enabled,
 * so an agent that registers after the post can be served a re-wrapped slice
 * on /accept (docs/TEE-REWRAP-SPEC.md). Best-effort: undefined when custody
 * is off or anything fails; the wrapped keys remain the fallback.
 */
export async function sealToKeyCustody(key: Uint8Array, token: string, tag = '[PostTask]'): Promise<KeyCustodyBlob | undefined> {
  try {
    const custodyKey = await authedGet<{
      enabled: boolean;
      keyId: string | null;
      publicKey: string | null;
      attestation: string | null;
    }>('/api/v1/a2a/key-custody/pubkey', token);
    if (custodyKey && custodyKey.enabled && custodyKey.keyId && custodyKey.publicKey) {
      // The local (operator-trusted) backend returns attestation:null. When an
      // attested backend ships, VERIFY custodyKey.attestation before sealing.
      return { keyId: custodyKey.keyId, blob: bytesToHex(await eciesEncrypt(key, custodyKey.publicKey)) };
    }
  } catch (e) {
    console.warn(`${tag} key-custody seal skipped:`, (e as Error).message);
  }
  return undefined;
}

/** The auto-verify rubric PostTask posts when the poster adds no keywords. */
export function defaultAutoCriteria(): { min_length: number; pass_threshold: number } {
  return { min_length: 10, pass_threshold: 60 };
}

export interface FundingResult {
  sent: SentTx;
  /**
   * The wallet broadcast the transaction but the wait for it failed (ethers'
   * post-broadcast NETWORK_ERROR / BAD_DATA): it may have funded the escrow.
   * The caller lists from the hash and must never send it again.
   */
  unconfirmed: boolean;
}

/**
 * Send a funding transaction once. A failure that carries a broadcast hash
 * becomes an unconfirmed result instead of an error, so the caller goes on
 * to list the task rather than inviting a second payment. Any other failure
 * (the wallet refused, nothing was sent) throws.
 */
export async function sendFunding(send: () => Promise<SentTx>, tag = '[PostTask]'): Promise<FundingResult> {
  try {
    return { sent: await send(), unconfirmed: false };
  } catch (sendErr) {
    const broadcast = friendlyError(sendErr).txHash;
    if (!broadcast) throw sendErr;
    console.warn(`${tag} Task TX broadcast (${broadcast}) but not confirmed:`, (sendErr as Error).message);
    return { sent: { hash: broadcast, receipt: null }, unconfirmed: true };
  }
}

/**
 * POST a listing request, retrying (the backend needs the receipt, and a
 * user-op can take a few blocks). Returns the response, or null with the last
 * error when every attempt failed.
 */
export async function postWithRetry<T>(
  path: string,
  body: unknown,
  token: string,
  { attempts = 3, delayMs = 10_000, tag = '[PostTask]' }: { attempts?: number; delayMs?: number; tag?: string } = {},
): Promise<{ resp: T | null; lastErr: unknown }> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return { resp: await authedPost<T>(path, body, token), lastErr: null };
    } catch (e) {
      lastErr = e;
      console.warn(`${tag} ${path} attempt ${i + 1} failed:`, (e as Error).message);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return { resp: null, lastErr };
}

/** The route and body that list a pending entry: batch-funded tasks go
 *  through index-batch (their receipt holds several tasks), the rest through
 *  the single route with the body as first sent. */
export function pendingListingRequest(entry: Pick<PendingIndex, 'txHash' | 'body' | 'route'>): { path: string; body: Record<string, unknown> } {
  if (entry.route === 'batch') {
    const { txHash: _tx, isUserOp, ...task } = entry.body as Record<string, unknown> & { isUserOp?: boolean };
    return {
      path: '/api/v1/a2a/tasks/index-batch',
      body: { txHash: entry.txHash, ...(isUserOp !== undefined ? { isUserOp } : {}), tasks: [task] },
    };
  }
  return { path: '/api/v1/a2a/tasks/index', body: entry.body };
}

/**
 * List a funded escrow whose listing failed, with the same request as the
 * first attempt (re-listing is safe: the backend lets the poster who first
 * indexed a hash index it again). Throws when the backend still refuses; a
 * batch listing that answers with a per-task error throws that error.
 */
export async function retryPendingListing(entry: PendingIndex, token?: string): Promise<{ onChainTaskId?: string | null }> {
  const { path, body } = pendingListingRequest(entry);
  if (entry.route !== 'batch') {
    return authedPost<{ onChainTaskId?: string | null }>(path, body, token);
  }
  const resp = await authedPost<{ results: BatchIndexResult[] }>(path, body, token);
  const result = (resp.results ?? []).find((r) => r.taskHash?.toLowerCase() === entry.taskHash.toLowerCase());
  if (!result) throw new Error('The listing answer did not mention this task.');
  if ('error' in result && result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return { onChainTaskId: 'onChainTaskId' in result ? result.onChainTaskId ?? null : null };
}

/** One task's answer from POST /a2a/tasks/index-batch. */
export type BatchIndexResult =
  | { taskHash: string; onChainTaskId?: string | null; indexed: true }
  | { taskHash: string; error: { code: string; message: string } };
