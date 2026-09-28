import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { AppError, clientErrorMessage } from '../middleware/errorHandler.js';
import * as storageService from '../services/storage.js';
import * as cryptoService from '../services/crypto.js';
import type { AuthRequest, ApiResponse } from '../types.js';
import { STORAGE_ID_PATTERN } from '../services/storageId.js';
import { MAX_BATCH_REQUEST, WALLET_POSTING_BUDGET_PER_MIN } from '../constants.js';
import { batchWeight, createWalletBudget, postingIpBudget } from '../middleware/rateLimit.js';
import { invalidRows, zodIssuesText, type RowError } from '../middleware/batchErrors.js';

export const storageRouter = Router();

/** Each wallet's uploads, POST /upload and /upload-batch together (middleware/rateLimit.ts). */
const uploadBudget = createWalletBudget({ name: 'uploads', perMinute: WALLET_POSTING_BUDGET_PER_MIN, weight: batchWeight('items') });

/**
 * Uploads one POST /upload-batch starts at a time. At least the 0G batch
 * limit (storageService.UPLOAD_BATCH_LIMIT_0G), so every brief of a 0G batch
 * starts at once and the request ends within one upload deadline.
 */
export const UPLOAD_BATCH_CONCURRENCY = 4;

/**
 * The bytes of one upload's `data` (base64), or the 400 that refuses it:
 * the checks POST /upload applies, shared with each item of /upload-batch.
 */
function decodeUpload(data: unknown): Buffer {
  if (!data) {
    throw new AppError(400, 'MISSING_DATA', 'Request body must include "data" (base64 encoded)');
  }
  // Buffer.from reads an array as raw bytes and throws on a number (a 500).
  if (typeof data !== 'string') {
    throw new AppError(400, 'INVALID_DATA', '"data" must be a base64 string');
  }

  const buffer = Buffer.from(data, 'base64');
  if (buffer.length === 0) {
    throw new AppError(400, 'EMPTY_DATA', 'Data must not be empty');
  }

  if (buffer.length > 10 * 1024 * 1024) {
    throw new AppError(400, 'DATA_TOO_LARGE', 'Maximum upload size is 10MB');
  }
  return buffer;
}

/**
 * POST /api/v1/storage/upload
 * Upload an already-encrypted blob to 0G Storage.
 * Client MUST encrypt before sending — backend never sees plaintext.
 * Body: { data: string (base64 of encrypted bytes) }
 */
storageRouter.post('/upload', requireAuth, uploadBudget, postingIpBudget, async (req: AuthRequest, res, next) => {
  try {
    // 0G storage upload can take 30-60s on testnet — extend the socket
    // timeout so Express doesn't kill the connection mid-upload.
    req.socket.setTimeout(120_000);

    const body = req.body as { data?: unknown; chainType?: string };
    const buffer = decodeUpload(body.data);

    const { rootHash, txHash } = await storageService.upload(buffer);

    const result: ApiResponse = {
      success: true,
      data: { rootHash, txHash },
    };
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

const uploadBatchSchema = z.object({
  items: z.array(z.object({ data: z.unknown() }).passthrough()).min(1).max(MAX_BATCH_REQUEST),
});

/**
 * POST /api/v1/storage/upload-batch
 * Several already-encrypted blobs in one request (docs/BULK-POSTING.md).
 * Body: { items: [{ data: base64 }] }, 1–50 items; the whole body is bounded
 * by the 2 MB JSON limit, about 1.5 MB of blobs. Each item gets /upload's
 * checks, all before anything is stored: 400 INVALID_ITEMS lists every item
 * refused in error.details.errors (middleware/batchErrors.ts).
 * 201 { results: [{ rootHash, txHash }] }, in input order.
 *
 * All or nothing: the first item that fails to store stops the rest from
 * starting, and the answer is 502 UPLOAD_FAILED naming its index
 * (error.details.index). Blobs stored before that stay stored (storage is
 * content-addressed, so sending the batch again gets the same root hashes),
 * but none is returned.
 */
storageRouter.post('/upload-batch', requireAuth, uploadBudget, postingIpBudget, async (req: AuthRequest, res, next) => {
  try {
    const request = uploadBatchSchema.safeParse(req.body);
    if (!request.success) throw new AppError(400, 'VALIDATION_ERROR', zodIssuesText(request.error));
    const { items } = request.data;
    // On 0G, a few per request, so the request answers before a proxy's
    // timeout cuts it off (storageService.UPLOAD_BATCH_LIMIT_0G).
    const limit = storageService.uploadBatchLimit();
    if (items.length > limit) {
      throw new AppError(400, 'BATCH_TOO_LARGE', `At most ${limit} briefs per request on this server — send them in smaller groups`);
    }
    const errors: RowError[] = [];
    const buffers = items.map((item, index) => {
      try {
        return decodeUpload(item.data);
      } catch (err) {
        const { code, message } = err as AppError;
        errors.push({ index, code, message });
        return Buffer.alloc(0);
      }
    });
    if (errors.length > 0) throw invalidRows('INVALID_ITEMS', 'brief', items.length, errors, { index: errors[0].index });

    // Each 0G upload can take 30–60 s, and a batch runs in waves of
    // UPLOAD_BATCH_CONCURRENCY: extend the socket timeout as /upload does.
    req.socket.setTimeout(Math.ceil(buffers.length / UPLOAD_BATCH_CONCURRENCY) * 120_000);

    const results: Array<{ rootHash: string; txHash?: string }> = new Array(buffers.length);
    const run: { next: number; failed: { index: number; err: unknown } | null } = { next: 0, failed: null };
    // Items in flight together can fail together: name the lowest.
    const fail = (index: number, err: unknown) => {
      if (!run.failed || index < run.failed.index) run.failed = { index, err };
    };
    const worker = async () => {
      while (!run.failed && run.next < buffers.length) {
        const index = run.next++;
        try {
          const { rootHash, txHash } = await storageService.upload(buffers[index]);
          results[index] = { rootHash, txHash };
        } catch (err) {
          fail(index, err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_BATCH_CONCURRENCY, buffers.length) }, worker));

    const { failed } = run;
    if (failed) {
      console.error(`[storage] upload-batch: item ${failed.index} failed:`, failed.err);
      // Storage down (services/storage.ts): nothing is paid before the briefs
      // are stored, so say so with the same code a single upload answers.
      if (failed.err instanceof AppError && failed.err.code === 'STORAGE_UNAVAILABLE') {
        throw new AppError(
          503,
          'STORAGE_UNAVAILABLE',
          `Brief ${failed.index + 1} of ${buffers.length} couldn't be stored right now. Nothing was paid — send the batch again in a minute.`,
          undefined,
          { index: failed.index },
        );
      }
      throw new AppError(
        502,
        'UPLOAD_FAILED',
        `Brief ${failed.index + 1} of ${buffers.length} could not be stored (${clientErrorMessage(failed.err, 'storage upload failed')}). ` +
          'No root hash is returned for this batch: send it again.',
        undefined,
        { index: failed.index },
      );
    }

    const body: ApiResponse = { success: true, data: { results } };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/storage/:rootHash
 * Download an encrypted blob by root hash from 0G Storage.
 * Security model: anyone can download, but only the keyholder can decrypt.
 * Access control is enforced by encryption, not by download restrictions.
 */
storageRouter.get('/:rootHash', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const rootHash = req.params.rootHash as string;
    // Accept both raw hex (0G), 0x-prefixed, and URL-safe Base64 (Walrus blob ID)
    if (!STORAGE_ID_PATTERN.test(rootHash)) {
      throw new AppError(400, 'INVALID_HASH', 'Root hash must be a 64-char hex string or a valid Walrus blob ID');
    }

    const data = await storageService.download(rootHash);
    if (!data) {
      throw new AppError(404, 'NOT_FOUND', 'Blob not found');
    }

    const result: ApiResponse = {
      success: true,
      data: { rootHash, blob: data.toString('base64') },
    };
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/storage/crypto/hash
 * Compute SHA-256 hash of base64-encoded data (for on-chain taskHash/evidenceHash).
 * NOTE: Only send already-encrypted data here. The backend is blind — it should
 * never see plaintext. Prefer computing hashes client-side when possible.
 */
storageRouter.post('/crypto/hash', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = req.body as { data?: string };
    if (!body.data) {
      throw new AppError(400, 'MISSING_DATA', 'Request body must include "data" (base64 encoded)');
    }

    const buffer = Buffer.from(body.data, 'base64');
    const hash = '0x' + cryptoService.sha256(buffer);

    const result: ApiResponse = {
      success: true,
      data: { hash },
    };
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// NOTE: Keypair generation intentionally NOT exposed as an endpoint.
// Private keys must NEVER leave the client. Agents and workers generate
// keypairs locally in the browser using the Web Crypto API or ethers.js.
