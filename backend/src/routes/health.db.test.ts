import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * GET /health/db — lets anyone confirm, without dashboard access, whether
 * production has a working Postgres. Production ran without DATABASE_URL in
 * Sep 2026 and the only outside signal was /api/v1/stats reading zero agents.
 */

vi.mock('../services/chain.js', () => ({
  escrow: {}, marketplaceSigner: null, provider: {}, baseEscrow: {}, baseMarketplaceSigner: null, baseProvider: {},
}));
vi.mock('../services/a2aSettlement.js', () => ({ isBridgeReady: vi.fn(() => false) }));
vi.mock('../services/redis.js', () => ({ redis: {}, redisSub: {} }));
vi.mock('../services/neonDb.js', () => ({
  getPool: vi.fn(),
  getSchemaStatus: vi.fn(),
  latestMigrationId: vi.fn(() => 30),
}));

import { healthRouter } from './health.js';
import { config } from '../config.js';
import { getPool, getSchemaStatus } from '../services/neonDb.js';

const app = express();
app.use('/health', healthRouter);
const cfg = config as { databaseUrl: string };
const original = cfg.databaseUrl;

beforeEach(() => {
  vi.mocked(getPool).mockReset();
  vi.mocked(getSchemaStatus).mockReset();
});
afterEach(() => { cfg.databaseUrl = original; });

describe('GET /health/db', () => {
  it('reports a missing DATABASE_URL without touching the pool', async () => {
    cfg.databaseUrl = '';
    const res = await request(app).get('/health/db');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ configured: false, reachable: null, schema: { latestExpected: 30 } });
    expect(res.body.data.warning).toMatch(/DATABASE_URL is not set/);
    expect(getPool).not.toHaveBeenCalled();
  });

  it('reports a reachable, fully migrated database', async () => {
    cfg.databaseUrl = 'postgres://configured';
    vi.mocked(getPool).mockResolvedValue({ query: vi.fn(async () => ({ rows: [{ '?column?': 1 }] })) } as never);
    vi.mocked(getSchemaStatus).mockResolvedValue({ latestExpected: 30, latestApplied: 30, missing: [], nameMismatch: [] });
    const res = await request(app).get('/health/db');
    expect(res.body.data).toMatchObject({ configured: true, reachable: true, schema: { upToDate: true } });
    expect(typeof res.body.data.latencyMs).toBe('number');
  });

  it('flags schema drift (an id applied under a different name)', async () => {
    cfg.databaseUrl = 'postgres://configured';
    vi.mocked(getPool).mockResolvedValue({ query: vi.fn(async () => ({ rows: [] })) } as never);
    vi.mocked(getSchemaStatus).mockResolvedValue({ latestExpected: 30, latestApplied: 30, missing: [], nameMismatch: [27] });
    const res = await request(app).get('/health/db');
    expect(res.body.data.schema).toMatchObject({ nameMismatch: [27], upToDate: false });
  });

  it('reports an unreachable database without leaking connection details', async () => {
    cfg.databaseUrl = 'postgres://user:secret@ep-hidden.neon.tech/db';
    vi.mocked(getPool).mockRejectedValue(new Error('getaddrinfo ENOTFOUND ep-hidden.neon.tech'));
    const res = await request(app).get('/health/db');
    expect(res.body.data).toMatchObject({ configured: true, reachable: false, error: 'connection_failed' });
    expect(JSON.stringify(res.body)).not.toMatch(/neon\.tech|secret/);
  });
});
