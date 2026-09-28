import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * The OpenAPI document names the bulk-posting routes and the batchCreate
 * field clients detect them by (docs/BULK-POSTING.md).
 *
 * Run: npx vitest run src/routes/discovery.openapi.test.ts
 */

vi.mock('../services/agentStore.js', () => ({ getAgent: vi.fn() }));
vi.mock('../services/serviceStore.js', () => ({ listActiveServices: vi.fn() }));

const { openapiRouter } = await import('./discovery.js');
const app = express();
app.use('/api/v1/openapi.json', openapiRouter);

describe('GET /api/v1/openapi.json — bulk posting', () => {
  it('describes the batch routes, their per-item errors and the per-wallet limit', async () => {
    const { body } = await request(app).get('/api/v1/openapi.json');
    const batch = body.paths['/api/v1/tasks/batch'].post;
    expect(batch.requestBody.content['application/json'].schema.required).toEqual(['token', 'tasks']);
    expect(batch.responses['409'].description).toContain('BATCH_UNSUPPORTED');
    expect(batch.responses['400'].description).toContain('error.details.errors: [{ index, code, message }]');
    // People count from 1; the index clients read is 0-based.
    expect(batch.responses['400'].description).toContain('counting tasks from 1');
    expect(batch.responses['400'].description).toContain('0-based position in tasks');
    expect(body.paths['/api/v1/storage/upload'].post.responses['503'].description).toContain('STORAGE_UNAVAILABLE');
    expect(body.paths['/api/v1/storage/upload-batch'].post.responses['502'].description).toContain('error.details.index');
    const indexBatch = body.paths['/api/v1/a2a/tasks/index-batch'].post;
    expect(indexBatch.requestBody.content['application/json'].schema.required).toEqual(['txHash', 'tasks']);
    expect(indexBatch.responses['200'].description).toContain('NOT_IN_RECEIPT');
    for (const path of ['/api/v1/tasks', '/api/v1/tasks/batch', '/api/v1/a2a/tasks/index', '/api/v1/a2a/tasks/index-batch', '/api/v1/storage/upload', '/api/v1/storage/upload-batch']) {
      expect(body.paths[path].post.responses['429'].description, path).toContain('120 items a minute');
    }
  });

  it('describes batchCreate on /health/settlement', async () => {
    const { body } = await request(app).get('/api/v1/openapi.json');
    expect(body.paths['/api/v1/health/settlement'].get.responses['200'].description).toContain('batchCreate: { supported, maxBatch }');
  });
});
