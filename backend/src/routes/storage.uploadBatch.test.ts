import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * POST /storage/upload-batch stores several brief blobs in one request
 * (docs/BULK-POSTING.md): 1–50 items, each with /upload's checks, results in
 * input order, a bounded number of uploads at a time, and all or nothing — a
 * failure is an error naming the item's index.
 *
 * Run: npx vitest run src/routes/storage.uploadBatch.test.ts
 */

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: '0x1111111111111111111111111111111111111111' };
    next();
  },
}));

const upload = vi.hoisted(() => vi.fn());
// The per-wallet and per-IP budgets have their own test (middleware/rateLimit.walletBudget.test.ts).
vi.mock('../middleware/rateLimit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/rateLimit.js')>()),
  createWalletBudget: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  postingIpBudget: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const uploadBatchLimit = vi.hoisted(() => vi.fn(() => 50));
vi.mock('../services/storage.js', () => ({ upload, download: vi.fn(), uploadBatchLimit, UPLOAD_BATCH_LIMIT_0G: 4 }));

const { storageRouter, UPLOAD_BATCH_CONCURRENCY } = await import('./storage.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');

function app() {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use('/api/v1/storage', storageRouter);
  a.use(globalErrorHandler);
  return a;
}

const b64 = (s: string) => Buffer.from(s).toString('base64');
const batch = (items: unknown[]) => request(app()).post('/api/v1/storage/upload-batch').send({ items });

beforeEach(() => {
  vi.clearAllMocks();
  uploadBatchLimit.mockReturnValue(50);
  upload.mockImplementation(async (buf: Buffer) => ({ rootHash: `root-${buf.toString()}`, txHash: `tx-${buf.toString()}` }));
});

describe('POST /storage/upload-batch', () => {
  it('stores every item and answers 201 with the results in input order', async () => {
    // Later items finish first; the answer keeps the order they were sent in.
    upload.mockImplementation(async (buf: Buffer) => {
      await new Promise((r) => setTimeout(r, 30 - Number(buf.toString()) * 5));
      return { rootHash: `root-${buf.toString()}`, txHash: `tx-${buf.toString()}` };
    });
    const res = await batch(['0', '1', '2', '3', '4'].map((s) => ({ data: b64(s) })));
    expect(res.status).toBe(201);
    expect(res.body.data.results).toEqual(['0', '1', '2', '3', '4'].map((s) => ({ rootHash: `root-${s}`, txHash: `tx-${s}` })));
    expect(upload).toHaveBeenCalledTimes(5);
  });

  it(`runs at most ${UPLOAD_BATCH_CONCURRENCY} uploads at a time`, async () => {
    let running = 0;
    let peak = 0;
    upload.mockImplementation(async (buf: Buffer) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { rootHash: `root-${buf.toString()}` };
    });
    const res = await batch(Array.from({ length: 12 }, (_, i) => ({ data: b64(String(i)) })));
    expect(res.status).toBe(201);
    expect(peak).toBe(UPLOAD_BATCH_CONCURRENCY);
  });

  it('takes 1 to 50 items', async () => {
    expect((await batch([])).status).toBe(400);
    expect((await request(app()).post('/api/v1/storage/upload-batch').send({})).status).toBe(400);
    expect((await batch(Array.from({ length: 51 }, () => ({ data: b64('x') })))).status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
    expect((await batch(Array.from({ length: 50 }, (_, i) => ({ data: b64(String(i)) })))).status).toBe(201);
  });

  it.each([
    ['no data', {}, 'MISSING_DATA'],
    ['empty data', { data: '' }, 'MISSING_DATA'],
    ['data that decodes to nothing', { data: '====' }, 'EMPTY_DATA'],
    ['data that is not a string', { data: [1, 2, 3] }, 'INVALID_DATA'],
  ])("refuses an item with %s before storing anything, naming its index", async (_label, item, code) => {
    const res = await batch([{ data: b64('a') }, { data: b64('b') }, item]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ITEMS');
    // The message counts briefs from 1; details.index stays 0-based.
    expect(res.body.error.message).toMatch(/^1 of 3 briefs is invalid: brief 3: /);
    expect(res.body.error.details).toEqual({ index: 2, errors: [{ index: 2, code, message: expect.any(String) }] });
    expect(upload).not.toHaveBeenCalled();
  });

  it('lists every refused item at once', async () => {
    const res = await batch([{}, { data: b64('ok') }, { data: '====' }]);
    expect(res.status).toBe(400);
    expect(res.body.error.details.errors.map((e: any) => [e.index, e.code])).toEqual([[0, 'MISSING_DATA'], [2, 'EMPTY_DATA']]);
    expect(res.body.error.details.index).toBe(0);
  });

  it('answers an error naming the failed index when an upload fails, and returns no root hash', async () => {
    upload.mockImplementation(async (buf: Buffer) => {
      if (buf.toString() === '3') throw new Error('storage node unreachable');
      return { rootHash: `root-${buf.toString()}` };
    });
    const res = await batch(['0', '1', '2', '3', '4', '5'].map((s) => ({ data: b64(s) })));
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('UPLOAD_FAILED');
    expect(res.body.error.details).toEqual({ index: 3 });
    // details.index is 0-based; the sentence counts briefs from 1.
    expect(res.body.error.message).toMatch(/^Brief 4 of 6 could not be stored/);
    expect(res.body.data).toBeUndefined();
  });

  it("answers 503 STORAGE_UNAVAILABLE, saying nothing was paid, when storage itself is down", async () => {
    const { AppError } = await import('../middleware/errorHandler.js');
    upload.mockImplementation(async (buf: Buffer) => {
      if (buf.toString() === '1') {
        throw new AppError(503, 'STORAGE_UNAVAILABLE', "Couldn't store the brief right now. Nothing was paid — try again in a minute.");
      }
      return { rootHash: `root-${buf.toString()}` };
    });
    const res = await batch(['0', '1', '2'].map((s) => ({ data: b64(s) })));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STORAGE_UNAVAILABLE');
    expect(res.body.error.details).toEqual({ index: 1 });
    expect(res.body.error.message).toMatch(/^Brief 2 of 3 couldn't be stored right now\. Nothing was paid/);
    expect(res.body.data).toBeUndefined();
  });

  it('starts no new upload after one fails', async () => {
    upload.mockImplementation(async (buf: Buffer) => {
      if (buf.toString() === '0') throw new Error('boom');
      await new Promise((r) => setTimeout(r, 10));
      return { rootHash: `root-${buf.toString()}` };
    });
    const res = await batch(Array.from({ length: 20 }, (_, i) => ({ data: b64(String(i)) })));
    expect(res.status).toBe(502);
    expect(res.body.error.details.index).toBe(0);
    // Item 0 failed at once; only the uploads already running went on.
    expect(upload.mock.calls.length).toBeLessThanOrEqual(UPLOAD_BATCH_CONCURRENCY);
  });

  it('names the lowest index when uploads running together fail together', async () => {
    upload.mockImplementation(async (buf: Buffer) => {
      const i = Number(buf.toString());
      await new Promise((r) => setTimeout(r, 20 - i * 5));
      if (i === 1 || i === 2) throw new Error(`fail ${i}`);
      return { rootHash: `root-${i}` };
    });
    const res = await batch(['0', '1', '2', '3'].map((s) => ({ data: b64(s) })));
    expect(res.status).toBe(502);
    expect(res.body.error.details.index).toBe(1);
  });
});

// On 0G every upload runs one at a time, so a large batch would outlast a
// proxy's timeout: it is refused at once instead (security review).
describe('POST /storage/upload-batch on a 0G server', () => {
  beforeEach(() => uploadBatchLimit.mockReturnValue(4));

  it('refuses more than 4 briefs with a clear 400, storing nothing', async () => {
    const res = await batch(Array.from({ length: 5 }, (_, i) => ({ data: b64(String(i)) })));
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: 'BATCH_TOO_LARGE', message: 'At most 4 briefs per request on this server — send them in smaller groups' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('takes 4, all started at once', async () => {
    expect(UPLOAD_BATCH_CONCURRENCY).toBeGreaterThanOrEqual(4);
    const res = await batch(Array.from({ length: 4 }, (_, i) => ({ data: b64(String(i)) })));
    expect(res.status).toBe(201);
    expect(res.body.data.results).toHaveLength(4);
  });
});

describe('POST /storage/upload keeps its checks', () => {
  const single = (body: unknown) => request(app()).post('/api/v1/storage/upload').send(body as object);

  it('stores one blob as before', async () => {
    const res = await single({ data: b64('x') });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ rootHash: 'root-x', txHash: 'tx-x' });
  });

  it.each([
    [{}, 'MISSING_DATA'],
    [{ data: '====' }, 'EMPTY_DATA'],
    [{ data: 5 }, 'INVALID_DATA'],
  ])('refuses %j with %s', async (body, code) => {
    const res = await single(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(code);
    expect(upload).not.toHaveBeenCalled();
  });
});
