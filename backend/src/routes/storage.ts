import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import * as storageService from '../services/storage.js';
import * as cryptoService from '../services/crypto.js';
import type { AuthRequest, ApiResponse } from '../types.js';
import { STORAGE_ID_PATTERN } from '../services/storageId.js';

export const storageRouter = Router();

/**
 * POST /api/v1/storage/upload
 * Upload an already-encrypted blob to 0G Storage.
 * Client MUST encrypt before sending — backend never sees plaintext.
 * Body: { data: string (base64 of encrypted bytes) }
 */
storageRouter.post('/upload', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    // 0G storage upload can take 30-60s on testnet — extend the socket
    // timeout so Express doesn't kill the connection mid-upload.
    req.socket.setTimeout(120_000);

    const body = req.body as { data?: string; chainType?: string };
    if (!body.data) {
      throw new AppError(400, 'MISSING_DATA', 'Request body must include "data" (base64 encoded)');
    }

    const buffer = Buffer.from(body.data, 'base64');
    if (buffer.length === 0) {
      throw new AppError(400, 'EMPTY_DATA', 'Data must not be empty');
    }

    if (buffer.length > 10 * 1024 * 1024) {
      throw new AppError(400, 'DATA_TOO_LARGE', 'Maximum upload size is 10MB');
    }

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
