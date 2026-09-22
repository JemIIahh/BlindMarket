import '../middleware/asyncErrors.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Only a person mints API keys. A worker's platform token (typ
 * 'agent-platform') or a device-flow token (typ 'agent-registration')
 * authenticates as the AGENT's wallet; a key minted with one is owned by that
 * wallet, never expires, never shows in the human owner's key list, and
 * outlives POST /agents/:id/revoke-token. The legacy shared AGENT_API_KEY
 * ('agent') has no owner at all.
 */

const principal = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = principal.current;
    next();
  },
}));

vi.mock('../services/apiKeyStore.js', () => ({
  createApiKey: vi.fn(async () => ({ id: 1, rawKey: 'sk_new' })),
  listApiKeys: vi.fn(async () => []),
  revokeApiKey: vi.fn(),
}));

import { apiKeysRouter } from './apiKeys.js';
import { globalErrorHandler } from '../middleware/errorHandler.js';
import { createApiKey } from '../services/apiKeyStore.js';

const PERSON = '0x1111111111111111111111111111111111111111';
const AGENT_WALLET = '0x2222222222222222222222222222222222222222';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/api-keys', apiKeysRouter);
  a.use(globalErrorHandler);
  return a;
}

beforeEach(() => vi.mocked(createApiKey).mockClear());

describe('POST /api-keys refuses principals that are not a person', () => {
  it.each([
    ['a worker platform token', { address: AGENT_WALLET, ownerAddress: PERSON, typ: 'agent-platform' }],
    ['a device-flow registration token', { address: AGENT_WALLET, ownerAddress: PERSON, typ: 'agent-registration' }],
    ['the legacy shared agent key', { address: 'agent' }],
  ])('refuses %s', async (_label, user) => {
    principal.current = user;
    const res = await request(app()).post('/api/v1/api-keys').send({ name: 'persist' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it('still mints for a signed-in person, owned by their address', async () => {
    principal.current = { address: PERSON, addresses: [PERSON] };
    const res = await request(app()).post('/api/v1/api-keys').send({ name: 'mcp' });
    expect(res.status).toBe(200);
    expect(createApiKey).toHaveBeenCalledWith(expect.objectContaining({ ownerAddress: PERSON, name: 'mcp' }));
  });
});
