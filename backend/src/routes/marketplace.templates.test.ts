import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /marketplace/templates/:id serves a private template only to its creator
 * (security audit run 1, C14). Mounts the REAL marketplaceRouter and
 * templateStore over a fake pool that evaluates the by-id query.
 */

const CREATOR = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const OTHER = '0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const ROWS = [
  { id: 1, is_public: false, creator_address: CREATOR, name: 'Private brief', description: 'PRIVATE-FIXTURE' },
  { id: 2, is_public: true, creator_address: CREATOR, name: 'Public brief', description: 'public' },
];

vi.mock('../middleware/auth.js', () => {
  const attach = (req: any, _res: any, next: any) => {
    const addr = req.headers['x-test-address'];
    if (addr) req.user = { address: addr, addresses: [addr] };
    next();
  };
  return { requireAuth: attach, optionalAuth: attach, requireFounder: attach };
});
vi.mock('../services/redis.js', () => ({ redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() } }));
vi.mock('../services/neonDb.js', () => ({
  getPool: async () => ({
    query: async (sql: string, params: unknown[]) => {
      if (/FROM task_templates WHERE id = \$1 AND \(is_public = true OR creator_address = ANY\(\$2\)\)/.test(sql)) {
        const [id, viewers] = params as [number, string[]];
        return { rows: ROWS.filter((r) => r.id === id && (r.is_public || viewers.includes(r.creator_address))) };
      }
      // The unscoped by-id query the route used to send (kept so a revert of
      // the fix shows the leak instead of an error).
      if (sql === 'SELECT * FROM task_templates WHERE id = $1') {
        return { rows: ROWS.filter((r) => r.id === params[0]) };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  }),
}));

import { marketplaceRouter } from './marketplace.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';

function get(id: string, caller?: string) {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/marketplace', marketplaceRouter);
  a.use(globalErrorHandler);
  const r = request(a).get(`/api/v1/marketplace/templates/${id}`);
  return caller ? r.set('x-test-address', caller) : r;
}

describe('GET /marketplace/templates/:id', () => {
  it('hides a private template from anonymous callers and other users (404, like a missing id)', async () => {
    for (const res of [await get('1'), await get('1', OTHER)]) {
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('PRIVATE-FIXTURE');
    }
  });

  it('serves a private template to its creator, whatever the address casing', async () => {
    const res = await get('1', CREATOR.toUpperCase().replace('0X', '0x'));
    expect(res.status).toBe(200);
    expect(res.body.data.description).toBe('PRIVATE-FIXTURE');
  });

  it('serves a public template to anyone', async () => {
    expect((await get('2')).status).toBe(200);
  });

  it('answers 404 for a non-numeric or non-positive id without querying', async () => {
    for (const id of ['abc', '0', '-1', '1.5']) expect((await get(id)).status).toBe(404);
  });
});
