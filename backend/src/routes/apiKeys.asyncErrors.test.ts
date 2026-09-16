import '../middleware/asyncErrors.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Regression: an error thrown inside an async Express 4 handler used to escape
 * as an unhandledRejection and exit the process (Node 22). Reproduced on
 * production's code with POST /api/v1/api-keys — an empty body, and a missing
 * DATABASE_URL, each killed the API. With middleware/asyncErrors.ts loaded,
 * both must come back as normal error responses. (If the patch regresses,
 * vitest fails this file on the unhandled rejection.)
 */

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: '0x1111111111111111111111111111111111111111' };
    next();
  },
}));

vi.mock('../services/apiKeyStore.js', () => ({
  createApiKey: vi.fn(),
  listApiKeys: vi.fn(async () => []),
  revokeApiKey: vi.fn(),
}));

import { apiKeysRouter } from './apiKeys.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import { createApiKey } from '../services/apiKeyStore.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/api-keys', apiKeysRouter);
  a.use(globalErrorHandler);
  return a;
}

beforeEach(() => vi.mocked(createApiKey).mockReset());

describe('async route errors are answered, not fatal', () => {
  it('an AppError thrown for a missing name becomes a 400', async () => {
    const res = await request(app()).post('/api/v1/api-keys').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_NAME');
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it('a store failure (e.g. no database) becomes an error response with its reason', async () => {
    vi.mocked(createApiKey).mockRejectedValueOnce(new Error('Could not create the API key: the database is not configured on this server.'));
    const res = await request(app()).post('/api/v1/api-keys').send({ name: 'k' });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });

  it('the server keeps serving after a failed request', async () => {
    const a = app();
    await request(a).post('/api/v1/api-keys').send({});
    const res = await request(a).get('/api/v1/api-keys');
    expect(res.status).toBe(200);
  });
});
