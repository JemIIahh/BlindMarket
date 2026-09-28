/**
 * The pieces of a post that need no network: a post's fields with their
 * defaults and the escrow's limits, the sealed brief and its task hash, and
 * the bodies POST /tasks and POST /a2a/tasks/index take. postTask() and
 * postTasks() share them, so one task and five hundred are checked the same
 * way, and every row of a bulk post is sealed before anything is sent.
 */
import { ethers } from 'ethers';
import { ApiError } from './apiError.js';
import { generateAesKey, aesEncrypt, eciesEncrypt, sha256, bytesToHex } from './crypto/index.js';
import type { Address, AgentCapability, CreateTaskRequest, Hex } from './types.js';
import type { IndexTaskParams, PostTaskParams } from './index.js';

/** The escrow's deadline bounds (BlindEscrow MIN_DEADLINE / MAX_DEADLINE). */
export const MIN_DURATION_SECONDS = 3_600;
export const MAX_DURATION_SECONDS = 90 * 86_400;
/** A brief's key is wrapped to at most this many executors (POST /tasks caps wrappedKeys at 200). */
export const MAX_WRAPPED_KEYS = 200;

/** A whole number of base units from a string or bigint; throws 400 INVALID_AMOUNT otherwise. */
export function wholeNumber(value: string | bigint, name: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new ApiError(
    400,
    `${name} must be a whole number of the token's smallest unit (USDC has 6 decimals: '2500000' is 2.5 USDC), not ${JSON.stringify(value)}. Nothing was sent.`,
    undefined,
    'INVALID_AMOUNT',
  );
}

/** A post with every default filled in and every limit checked. */
export interface NormalizedPost {
  instructions: string;
  amount: bigint;
  duration: number;
  privacy: 'private' | 'public';
  locationZone: string;
  verificationMode: 'manual' | 'auto' | 'agent';
  verificationCriteria?: Record<string, unknown>;
  requiredCapabilities: AgentCapability[];
  verifierAddress?: Address;
  targetExecutor?: Address;
  routingSummary?: string;
}

/** POST /a2a/tasks/index takes a routing summary of at most this many characters. */
export const MAX_ROUTING_SUMMARY = 500;

/**
 * `params` with its defaults, or the ApiError postTask() has always thrown,
 * in the same order: INVALID_AMOUNT, AMOUNT_ABOVE_MAX, INVALID_DURATION.
 */
export function normalizePost(params: PostTaskParams, maxAmountRaw?: bigint | string): NormalizedPost {
  const amount = wholeNumber(params.amountRaw, 'amountRaw');
  if (amount <= 0n) throw new ApiError(400, 'amountRaw must be above 0. Nothing was sent.', undefined, 'INVALID_AMOUNT');
  if (maxAmountRaw !== undefined && amount > BigInt(maxAmountRaw)) {
    throw new ApiError(402, `The escrow of ${amount} is above your limit of ${maxAmountRaw}. Nothing was sent.`, undefined, 'AMOUNT_ABOVE_MAX');
  }
  const duration = params.durationSeconds ?? 86_400;
  if (!Number.isInteger(duration) || duration < MIN_DURATION_SECONDS || duration > MAX_DURATION_SECONDS) {
    throw new ApiError(400, 'durationSeconds must be a whole number from 3600 (1 hour) to 7776000 (90 days): the escrow refuses anything else. Nothing was sent.', undefined, 'INVALID_DURATION');
  }
  const verificationMode = params.verificationMode ?? 'auto';
  const verificationCriteria = params.verificationCriteria
    ?? (verificationMode === 'auto' ? { min_length: 10, pass_threshold: 60 } : undefined);
  // Checked here, before funding: the listing would refuse it after the escrow is paid.
  const routingSummary = typeof params.routingSummary === 'string' ? params.routingSummary.trim() : undefined;
  if (routingSummary && routingSummary.length > MAX_ROUTING_SUMMARY) {
    throw new ApiError(400, `routingSummary is ${routingSummary.length} characters; the task board takes at most ${MAX_ROUTING_SUMMARY}. Nothing was sent.`, undefined, 'INVALID_ROUTING_SUMMARY');
  }
  return {
    instructions: params.instructions,
    amount,
    duration,
    privacy: params.privacy ?? 'private',
    locationZone: params.locationZone ?? 'global',
    verificationMode,
    ...(verificationCriteria ? { verificationCriteria } : {}),
    requiredCapabilities: params.requiredCapabilities ?? [],
    ...(params.verifierAddress ? { verifierAddress: params.verifierAddress } : {}),
    ...(params.targetExecutor ? { targetExecutor: params.targetExecutor } : {}),
    ...(routingSummary ? { routingSummary } : {}),
  };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The checks a bulk post adds for fields a caller builds from a file or a
 * form, where postTask()'s TypeScript types do not reach: a brief with text,
 * the enums, and the addresses. Throws 400 INVALID_ROW naming the field.
 */
export function checkRowFields(params: PostTaskParams): void {
  const bad = (message: string) => new ApiError(400, `${message} Nothing was sent.`, undefined, 'INVALID_ROW');
  if (typeof params.instructions !== 'string' || !params.instructions.trim()) throw bad('instructions are empty.');
  if (params.privacy !== undefined && params.privacy !== 'private' && params.privacy !== 'public') {
    throw bad(`privacy must be 'private' or 'public', not ${JSON.stringify(params.privacy)}.`);
  }
  if (params.verificationMode !== undefined && !['manual', 'auto', 'agent'].includes(params.verificationMode)) {
    throw bad(`verificationMode must be 'auto', 'manual' or 'agent', not ${JSON.stringify(params.verificationMode)}.`);
  }
  if (params.targetExecutor !== undefined && !ADDRESS.test(params.targetExecutor)) {
    throw bad(`targetExecutor must be a 0x wallet address, not ${JSON.stringify(params.targetExecutor)}.`);
  }
  if (params.verifierAddress !== undefined && !ADDRESS.test(params.verifierAddress)) {
    throw bad(`verifierAddress must be a 0x wallet address, not ${JSON.stringify(params.verifierAddress)}.`);
  }
  if (params.requiredCapabilities !== undefined && (!Array.isArray(params.requiredCapabilities) || params.requiredCapabilities.some((c) => typeof c !== 'string'))) {
    throw bad('requiredCapabilities must be a list of capability names.');
  }
  if (params.durationSeconds !== undefined && typeof params.durationSeconds !== 'number') {
    throw bad('durationSeconds must be a number of seconds.');
  }
  if (params.routingSummary !== undefined && typeof params.routingSummary !== 'string') {
    throw bad('routingSummary must be text.');
  }
}

/** An executor as GET /a2a/executors lists it. */
export interface ExecutorKey {
  address: string;
  publicKey?: string;
}

/** A brief ready to upload: the bytes, their task hash, and for a private brief its wrapped keys. */
export interface SealedBrief {
  blob: Uint8Array;
  /** 0x + sha256 of `blob`: the commitment createTask escrows against. */
  taskHash: string;
  wrappedKeys?: Record<string, string>;
  /** Hex AES key of a private brief. */
  aesKey?: string;
}

/**
 * The brief as it is uploaded: plaintext for a public post; otherwise
 * AES-encrypted, with the key wrapped to each executor that can take it (or
 * only the target executor). Throws what postTask() has always thrown, with
 * nothing sent: EXECUTOR_NOT_FOUND, TOO_MANY_EXECUTORS, NO_EXECUTORS.
 */
export async function sealBrief(post: NormalizedPost, executors: readonly ExecutorKey[], postingChain: string): Promise<SealedBrief> {
  const plaintext = new TextEncoder().encode(post.instructions);
  if (post.privacy === 'public') {
    return { blob: plaintext, taskHash: `0x${bytesToHex(await sha256(plaintext))}` };
  }
  let targets = executors.filter((e) => typeof e.publicKey === 'string' && e.publicKey.length > 0);
  if (post.targetExecutor) {
    const want = post.targetExecutor.toLowerCase();
    targets = targets.filter((e) => e.address.toLowerCase() === want);
    if (targets.length === 0) {
      throw new ApiError(404, `${post.targetExecutor} is not a registered executor on ${postingChain} with a public key, so it could not read the brief. Nothing was sent.`, undefined, 'EXECUTOR_NOT_FOUND');
    }
  }
  if (targets.length > MAX_WRAPPED_KEYS) {
    throw new ApiError(
      409,
      `${targets.length} executors match, more than the ${MAX_WRAPPED_KEYS} a brief can be wrapped to. Narrow requiredCapabilities, name a targetExecutor, or post with privacy 'public'. Nothing was sent.`,
      undefined,
      'TOO_MANY_EXECUTORS',
    );
  }
  const key = await generateAesKey();
  const blob = await aesEncrypt(plaintext, key);
  const wrappedKeys: Record<string, string> = {};
  for (const e of targets) {
    try {
      wrappedKeys[e.address.toLowerCase()] = bytesToHex(await eciesEncrypt(key, e.publicKey!));
    } catch { /* a malformed public key: that executor can't be wrapped to */ }
  }
  if (Object.keys(wrappedKeys).length === 0) {
    throw new ApiError(
      409,
      `No executor on ${postingChain} can decrypt an encrypted brief right now, so no one could take the task. Post with privacy 'public', or wait for executors to register. Nothing was sent.`,
      undefined,
      'NO_EXECUTORS',
    );
  }
  return { blob, taskHash: `0x${bytesToHex(await sha256(blob))}`, wrappedKeys, aesKey: bytesToHex(key) };
}

/** POST /api/v1/tasks's body for one post (POST /tasks/batch takes the same, less the token). */
export function createTaskBody(post: NormalizedPost, sealed: SealedBrief, token: string, rootHash: string): CreateTaskRequest {
  return {
    taskHash: sealed.taskHash as Hex,
    token: token as Address,
    amount: post.amount.toString(),
    locationZone: post.locationZone,
    duration: String(post.duration),
    targetExecutorType: 'agent',
    verificationMode: post.verificationMode,
    ...(post.verificationCriteria ? { verificationCriteria: post.verificationCriteria } : {}),
    ...(post.verifierAddress ? { verifierAddress: post.verifierAddress } : {}),
    requiredCapabilities: post.requiredCapabilities,
    rootHash: rootHash as CreateTaskRequest['rootHash'],
    ...(sealed.wrappedKeys ? { wrappedKeys: sealed.wrappedKeys } : {}),
  };
}

/** POST /api/v1/a2a/tasks/index's body for one post, with `txHash` still to fill in. */
export function indexParamsFor(post: NormalizedPost, sealed: SealedBrief, rootHash: string): IndexTaskParams {
  return {
    txHash: '',
    taskHash: sealed.taskHash,
    rootHash,
    ...(sealed.wrappedKeys ? { wrappedKeys: sealed.wrappedKeys } : {}),
    privacy: post.privacy,
    ...(post.privacy === 'public' ? { publicBrief: post.instructions.slice(0, 4000) } : {}),
    verificationMode: post.verificationMode,
    ...(post.verificationCriteria ? { verificationCriteria: post.verificationCriteria } : {}),
    ...(post.verifierAddress ? { verifierAddress: post.verifierAddress } : {}),
    requiredCapabilities: post.requiredCapabilities,
    ...(post.targetExecutor ? { targetExecutor: post.targetExecutor } : {}),
    ...(post.routingSummary ? { routingSummary: post.routingSummary } : {}),
  };
}

/** Whether this post commits a verifier on-chain (createTaskWithVerifier, or a non-zero verifierAgent in createTasks). */
export function commitsVerifier(post: NormalizedPost): boolean {
  return post.verificationMode === 'agent' && !!post.verifierAddress && post.verifierAddress.toLowerCase() !== ethers.ZeroAddress;
}
