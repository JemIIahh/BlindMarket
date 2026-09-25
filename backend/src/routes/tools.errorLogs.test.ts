import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * /api/v1/tools/error-logs — agents POST failures; owners GET and DELETE them.
 * GET and DELETE used to skip the owner check when agentId was missing, so any
 * signed-in user could read or wipe every agent's log. The web app's
 * "Clear all" also POSTed to the report route and silently got a 400.
 */

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { address: req.headers['x-test-address'] || '0xowner' };
    next();
  },
}));

const agents: Record<string, { id: string; name: string; walletAddress: string; ownerAddress: string; authorizedOwners?: string[] }> = {
  a1: { id: 'a1', name: 'Agent One', walletAddress: '0xA1Wallet', ownerAddress: '0xOwner' },
  a2: { id: 'a2', name: 'Agent Two', walletAddress: '0xA2Wallet', ownerAddress: '0xSomeoneElse', authorizedOwners: ['0xOWNER'] },
  a3: { id: 'a3', name: 'Agent Three', walletAddress: '0xA3Wallet', ownerAddress: '0xSomeoneElse' },
};
vi.mock('../services/agentRunner.js', () => ({ getAgent: vi.fn(async (id: string) => agents[id]) }));
vi.mock('../services/toolExecutor.js', () => ({ validateToolDefinition: vi.fn(), executeTool: vi.fn() }));
vi.mock('../services/mcpClient.js', () => ({ mcpConnect: vi.fn() }));
vi.mock('../services/openApiParser.js', () => ({ parseOpenApiSpec: vi.fn() }));

const { toolsRouter } = await import('./tools.js');
const { globalErrorHandler } = await import('../middleware/errorHandler.js');
const { reportToolError, clearToolErrorLogs, getToolErrorLogs } = await import('../services/toolErrorLog.js');

const app = express();
app.use(express.json());
app.use('/api/v1/tools', toolsRouter);
app.use(globalErrorHandler);

function seed(agentId: string, n = 2) {
  for (let i = 0; i < n; i++) {
    reportToolError({
      agentId, agentName: agentId, toolName: `t${i}`, toolType: 'http', url: 'https://x.test',
      method: 'GET', statusCode: 500, error: 'boom', requestInput: '', responseOutput: '', durationMs: 1,
    });
  }
}

beforeEach(() => {
  clearToolErrorLogs();
  seed('a1');
  seed('a3');
});

describe('GET /error-logs', () => {
  it('requires agentId instead of returning every agent\'s errors', async () => {
    const res = await request(app).get('/api/v1/tools/error-logs');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AGENT_ID_REQUIRED');
  });

  it('returns only the owner\'s agent', async () => {
    const res = await request(app).get('/api/v1/tools/error-logs?agentId=a1');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.entries.every((e: any) => e.agentId === 'a1')).toBe(true);
  });

  it('refuses a non-owner and an unknown agent', async () => {
    expect((await request(app).get('/api/v1/tools/error-logs?agentId=a3')).status).toBe(403);
    expect((await request(app).get('/api/v1/tools/error-logs?agentId=nope')).status).toBe(404);
  });
});

describe('DELETE /error-logs', () => {
  it('requires agentId and clears nothing without it', async () => {
    const res = await request(app).delete('/api/v1/tools/error-logs');
    expect(res.status).toBe(400);
    expect(getToolErrorLogs().total).toBe(4);
  });

  it('clears only the named agent (query string, as the web app sends it)', async () => {
    const res = await request(app).delete('/api/v1/tools/error-logs?agentId=a1');
    expect(res.status).toBe(200);
    expect(res.body.data.cleared).toBe(2);
    expect(getToolErrorLogs({ agentId: 'a1' }).total).toBe(0);
    expect(getToolErrorLogs({ agentId: 'a3' }).total).toBe(2);
  });

  it('still accepts agentId in the JSON body', async () => {
    const res = await request(app).delete('/api/v1/tools/error-logs').send({ agentId: 'a1' });
    expect(res.status).toBe(200);
    expect(res.body.data.cleared).toBe(2);
  });

  it('lets an authorized co-owner clear, and refuses anyone else', async () => {
    seed('a2', 1);
    expect((await request(app).delete('/api/v1/tools/error-logs?agentId=a2')).status).toBe(200);
    const denied = await request(app).delete('/api/v1/tools/error-logs?agentId=a3');
    expect(denied.status).toBe(403);
    expect(getToolErrorLogs({ agentId: 'a3' }).total).toBe(2);
  });
});

describe('POST /error-logs (agent reports)', () => {
  const report = (caller: string, agentId: string, extra: Record<string, unknown> = {}) =>
    request(app).post('/api/v1/tools/error-logs').set('x-test-address', caller).send({
      agentId, agentName: agentId, toolName: 'x', toolType: 'http', url: '', method: 'GET',
      statusCode: null, error: 'network', ...extra,
    });

  it("records a report from the agent's own worker and from its owner", async () => {
    expect((await report('0xa1wallet', 'a1')).status).toBe(200);
    expect((await report('0xOwner', 'a1')).status).toBe(200);
    expect(getToolErrorLogs({ agentId: 'a1' }).total).toBe(4);
  });

  it("refuses anyone else writing into an agent's log, and an unknown agent (audit run 1, C35)", async () => {
    const forged = await report('0xStranger', 'a1', { error: 'FORGED-BY-NON-OWNER' });
    expect(forged.status).toBe(403);
    expect((await report('0xStranger', 'nope')).status).toBe(404);
    expect(JSON.stringify(getToolErrorLogs({ agentId: 'a1' }))).not.toContain('FORGED');
  });

  it('takes the agent name from the record, not the body', async () => {
    await report('0xa1wallet', 'a1', { agentName: 'Spoofed' });
    expect(getToolErrorLogs({ agentId: 'a1' }).entries[0].agentName).toBe('Agent One');
  });

  it("one agent's reports can't flush another agent's entries", async () => {
    seed('a1', 300);
    expect(getToolErrorLogs({ agentId: 'a1' }).total).toBe(50);
    expect(getToolErrorLogs({ agentId: 'a3' }).total).toBe(2);
  });

  it('rejects the old "Clear all" call shape, which is why the button did nothing', async () => {
    const res = await request(app).post('/api/v1/tools/error-logs').send({ agentId: 'a1' });
    expect(res.status).toBe(400);
    expect(getToolErrorLogs({ agentId: 'a1' }).total).toBe(2);
  });
});
