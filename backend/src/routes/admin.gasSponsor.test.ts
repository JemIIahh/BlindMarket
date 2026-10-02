import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * The founder's switches for sponsored gas: pause (no new reservations) and
 * kill (no sends at all), applied without a restart, and the status report.
 */

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => { req.user = { address: '0xF0' }; next(); },
  requireFounder: (req: any, res: any, next: any) =>
    (req.headers['x-founder'] === 'yes' ? next() : res.status(403).json({ success: false, error: { code: 'FORBIDDEN' } })),
}));
vi.mock('../services/a2aStore.js', () => ({}));
vi.mock('../services/semanticMatch.js', () => ({ shadowReport: vi.fn() }));
vi.mock('../services/agentEmbedding.js', () => ({ backfillAgentEmbeddings: vi.fn() }));
vi.mock('../services/neonDb.js', () => ({ getPool: vi.fn() }));
vi.mock('../services/embeddingService.js', () => ({ embeddingModelId: vi.fn(), embeddingsConfigured: vi.fn() }));
vi.mock('../services/stuckTasks.js', () => ({ diagnoseStuckTasks: vi.fn(), forceReleaseTask: vi.fn(), rewindSubmittedTask: vi.fn() }));
const s = vi.hoisted(() => ({ enabled: true, setControls: vi.fn(), report: vi.fn() }));
vi.mock('../services/gasSponsorConfig.js', () => ({ gasSponsorSettings: () => (s.enabled ? { enabled: true, chainId: 5042 } : { enabled: false, reason: 'off' }) }));
vi.mock('../services/gasSponsorStore.js', () => ({ setControls: s.setControls }));
vi.mock('../services/gasSponsorRelayer.js', () => ({ gasSponsorReport: s.report }));

const { adminRouter } = await import('./admin.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');
const app = express();
app.use(express.json());
app.use('/api/v1/admin', adminRouter);
app.use(globalErrorHandler);

beforeEach(() => {
  vi.clearAllMocks();
  s.enabled = true;
  s.setControls.mockImplementation(async (_c: number, change: any, reason: string, by: string) => ({ paused: false, killed: false, ...change, reason, updatedBy: by }));
  s.report.mockResolvedValue({ enabled: true, sponsorBalance: '1.5' });
});

const controls = (body: Record<string, unknown>, founder = true) =>
  request(app).post('/api/v1/admin/gas-sponsor/controls').set('x-founder', founder ? 'yes' : 'no').send(body);

describe('POST /admin/gas-sponsor/controls', () => {
  it('pauses and kills, recording who and why', async () => {
    const paused = await controls({ paused: true, reason: 'budget review' });
    expect(paused.status).toBe(200);
    expect(s.setControls).toHaveBeenCalledWith(5042, { paused: true, killed: undefined }, 'budget review', '0xF0');
    expect((await controls({ killed: true, reason: 'leaked key' })).body.data).toMatchObject({ killed: true, reason: 'leaked key' });
  });

  it('is the founders\' alone', async () => {
    expect((await controls({ paused: true, reason: 'x' }, false)).status).toBe(403);
    expect(s.setControls).not.toHaveBeenCalled();
  });

  it('needs a reason and a switch', async () => {
    expect((await controls({ paused: true })).status).toBe(400);
    expect((await controls({ reason: 'nothing to switch' })).status).toBe(400);
  });

  it('refuses where sponsorship does not run', async () => {
    s.enabled = false;
    expect((await controls({ paused: true, reason: 'x' })).body.error.code).toBe('GAS_SPONSOR_OFF');
  });
});

describe('GET /admin/gas-sponsor', () => {
  it('reports to founders only', async () => {
    expect((await request(app).get('/api/v1/admin/gas-sponsor').set('x-founder', 'yes')).body.data).toEqual({ enabled: true, sponsorBalance: '1.5' });
    expect((await request(app).get('/api/v1/admin/gas-sponsor').set('x-founder', 'no')).status).toBe(403);
  });
});
